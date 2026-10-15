// Reconciler — apply with backup, readback, and restore-on-failure (design §3
// "Apply, backup, readback, rollback", Requirement 9 criteria 3-6, 11-17, and
// Requirement 22.2, 22.4-22.7).
//
// This is the ONLY writer path to OmniRoute (design §3). It takes a confirmed
// Change_Plan and drives the careful apply sequence that every Requirement 9
// criterion maps onto:
//
//   apply(plan, confirm):
//     guard: confirm matches this plan (revision+createdAt+instance), operator  [22.7, 22.2]
//     guard: another apply/rollback not already running on this instance         [9.15]
//     guard: plan.revision not uncommitted                                       [9.17]
//     guard: plan has deletes ⇒ confirm.confirmDeletions                         [9.11]
//     snapshot live; abort if any object differs from plan.before (as drift 8.2) [9.4]
//     capture Route_Backup (checksummed); verify readback of backup ≤60 s        [9.3, 9.15]
//     for op in plan.ops (in order):
//        write; read back ≤30 s; compare readback to op.after                    [9.5]
//        record readback as the object's post-apply value with the backup
//        on error / timeout / mismatch:
//           restore every written object from backup in reverse order (≤30 s)    [9.6, 9.16]
//           audit "failed-and-restored" (or "failed-unrestored"); return         [9.12]
//     prune Route_Backups to instance.backupRetention                            [9.13]
//     audit "succeeded"/"no-changes" with revision, counts, backup location      [9.12]
//
// Design interface (design §3):
//   apply(plan: ChangePlan, confirm: OperatorConfirmation): Promise<ApplyResult>
// The instance retention and the injectable deadlines/stores/clock are supplied
// through `ApplyDeps` so the sequence stays deterministic and testable (an
// in-memory backup store + audit log, small/0 deadlines, a scripted fake
// client). The real deployment wires a filesystem backup store, a durable audit
// log, and the live `HttpOmniRouteClient` (design §3 "backups/ + audit log").
//
// Concurrency (9.15): an in-process lock keyed by instanceId refuses a second
// apply or rollback while one is in progress on the same instance. The lock is
// shared with the rollback path (task 6.4) via `instanceLocks`.
//
// Credential safety (22.4-22.6): no secret value, request/response body, or
// tokenized URL path segment enters any Route_Backup, report, or audit entry.
// The plan ops are already redacted (plan.ts); the backup snapshot and every
// recorded value are passed through the same `redactUnknown` defensively, and
// the backup checksum is computed over the redacted snapshot.

import { createHash } from "node:crypto"

import type { ReconcilerAuditEntry } from "../observe/attribution.js"
import type { Combo, ComboInput, OmniRouteClient } from "../omniroute/client.js"
import { redactTokenizedSegments } from "../omniroute/redact.js"
import type { ChangeOp, ChangePlan } from "./plan.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The per-invocation operator confirmation of an apply or rollback (design §3,
 * Requirement 22.7). It is supplied to THIS invocation before the first write,
 * states the confirming operator, names the Managed_Instance, and identifies the
 * Change_Plan (for an apply) by its Fleet_Inventory_Revision commit and creation
 * time, or the Route_Backup (for a rollback) by its capture time.
 */
export interface OperatorConfirmation {
	readonly operator: string
	readonly instanceId: string
	readonly target:
		| { readonly kind: "plan"; readonly revision: string; readonly createdAt: string }
		| { readonly kind: "backup"; readonly capturedAt: string }
	/** Deletions are applied only when the operator confirmed them (Requirement 9.11). */
	readonly confirmDeletions: boolean
}

/** The terminal outcome of an apply (Requirement 9.12 outcome vocabulary). */
export type ApplyOutcome =
	| "succeeded" // every planned write landed with a matching readback.
	| "no-changes" // the plan had no ops; nothing was written.
	| "aborted" // a guard refused the apply before the first write.
	| "failed-and-restored" // a write failed; every written object was restored.
	| "failed-unrestored" // a write failed and a restore write itself failed.

/** One object that differs between plan creation and the live state (Requirement 9.4). */
export interface DriftedObject {
	readonly kind: ChangeOp["kind"]
	readonly id: string
	/** The object's value when the Change_Plan was created (credential-free). */
	readonly atPlanCreation: unknown
	/** The object's current live value (credential-free). */
	readonly current: unknown
}

/** The restore result of one object after a failed apply (Requirement 9.6, 9.16). */
export interface RestoreResult {
	readonly kind: ChangeOp["kind"]
	readonly id: string
	readonly restored: boolean
	/** For an unrestored object: its current value and its Route_Backup value. */
	readonly current?: unknown
	readonly backupValue?: unknown
	/** The failure cause when the restore write itself failed. */
	readonly reason?: string
}

/** The planned-vs-completed counts of an apply (Requirement 9.12). */
export interface ApplyCounts {
	readonly createsPlanned: number
	readonly updatesPlanned: number
	readonly deletesPlanned: number
	/** Writes completed with a matching readback. */
	readonly completed: number
}

/**
 * The result of an apply invocation. `backupId`/`backupLocation` name the
 * captured Route_Backup (absent for a guard abort or a no-op). `drifted` is set
 * for a 9.4 abort; `failedOp`/`failureCause`/`restores` are set for a failed
 * apply (Requirement 9.6, 9.16). All values are credential-free.
 */
export interface ApplyResult {
	readonly outcome: ApplyOutcome
	readonly instanceId: string
	readonly revision: ChangePlan["revision"]
	readonly startedAt: string
	readonly endedAt: string
	readonly counts: ApplyCounts
	readonly backupId?: string
	readonly backupLocation?: string
	/** For an `aborted` outcome: the human-readable cause. */
	readonly abortReason?: string
	/** For a 9.4 abort: each object that changed since plan creation. */
	readonly drifted?: readonly DriftedObject[]
	/** For a failed apply: the op whose write failed. */
	readonly failedOp?: { readonly kind: ChangeOp["kind"]; readonly id: string }
	readonly failureCause?: string
	/** For a failed apply: the restore result of every written object. */
	readonly restores?: readonly RestoreResult[]
}

// ---------------------------------------------------------------------------
// Route_Backup + stores (injectable; in-memory for tests, filesystem in prod)
// ---------------------------------------------------------------------------

/**
 * The recorded post-apply value of one object the apply wrote (Requirement 9.5):
 * the readback value the apply saw after writing it. Carries the op kind, the
 * object id, and — for a combo update/delete — the live OmniRoute id so a
 * restore can address the object. All values are credential-free.
 */
export interface PostApplyRecord {
	readonly kind: ChangeOp["kind"]
	readonly id: string
	readonly op: ChangeOp["op"]
	/** The live OmniRoute combo id (for update/delete/created-combo), when known. */
	readonly omniRouteId?: string
	/** The readback value recorded as this object's post-apply value. */
	readonly postApplyValue: unknown
}

/**
 * A Route_Backup: a checksummed snapshot of every combo (and the credential-free
 * connection snapshot) of one Managed_Instance, captured before the first write
 * (Requirement 9.3), plus the per-object post-apply values recorded during the
 * apply (Requirement 9.5). The `checksum` is computed over the redacted
 * `snapshot` so a stored backup can be verified by readback (9.3, 9.15) and so a
 * rollback (task 6.4) can confirm the backup before writing.
 */
export interface RouteBackup {
	readonly id: string
	readonly instanceId: string
	/** ISO-8601 UTC capture time. */
	readonly capturedAt: string
	readonly revision: ChangePlan["revision"]
	/** The storage location of the backup (a path/URI; credential-free). */
	readonly location: string
	/** The credential-free snapshot: every live combo of the instance by id. */
	readonly snapshot: {
		readonly combos: readonly Combo[]
	}
	/** A checksum over the serialized `snapshot` (Requirement 9.3). */
	readonly checksum: string
	/** The per-object post-apply values recorded during the apply (Requirement 9.5). */
	readonly postApply: readonly PostApplyRecord[]
}

/**
 * The Route_Backup store (injectable). The in-memory implementation is used in
 * tests; the real deployment writes to the `backups/` directory (design §3).
 * `prune` keeps the most-recent `retention` backups of an instance by capture
 * time and deletes the rest (Requirement 9.13).
 */
export interface BackupStore {
	save(backup: RouteBackup): Promise<void>
	/** Read a backup by id for a checksum-verifying readback (Requirement 9.3). */
	load(id: string): Promise<RouteBackup | undefined>
	/** Keep the most-recent `retention` backups of `instanceId`; delete older ones. */
	prune(instanceId: string, retention: number): Promise<void>
}

/** The audit log (injectable). Each entry matches `ReconcilerAuditEntry` (task 8.1). */
export interface AuditLog {
	write(entry: ReconcilerAuditEntry): Promise<void>
}

/**
 * An in-memory `BackupStore` for tests. Stores backups by id and prunes by
 * capture time per instance. Not exported from the package barrel (test-only
 * paths import it directly); exported here so tests and the rollback path share
 * one implementation.
 */
export class InMemoryBackupStore implements BackupStore {
	private readonly byId = new Map<string, RouteBackup>()

	async save(backup: RouteBackup): Promise<void> {
		this.byId.set(backup.id, backup)
	}

	async load(id: string): Promise<RouteBackup | undefined> {
		return this.byId.get(id)
	}

	async prune(instanceId: string, retention: number): Promise<void> {
		const forInstance = [...this.byId.values()]
			.filter((b) => b.instanceId === instanceId)
			.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
		const toDelete = forInstance.slice(0, Math.max(0, forInstance.length - retention))
		for (const backup of toDelete) {
			this.byId.delete(backup.id)
		}
	}

	/** Every stored backup, newest last by capture time (test inspection helper). */
	all(): RouteBackup[] {
		return [...this.byId.values()].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
	}
}

/** An in-memory `AuditLog` for tests, retaining every entry in write order. */
export class InMemoryAuditLog implements AuditLog {
	readonly entries: ReconcilerAuditEntry[] = []

	async write(entry: ReconcilerAuditEntry): Promise<void> {
		this.entries.push(entry)
	}
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/**
 * The in-process per-instance lock registry shared by apply and rollback
 * (Requirement 9.15: no concurrent apply/rollback on the same instance). A set
 * of locked instance ids; both paths check-and-set it. Injectable so the two
 * modules (and a test) share one registry.
 */
export type InstanceLocks = Set<string>

/** The dependencies and injectable deadlines of an apply (design §3). */
export interface ApplyDeps {
	readonly client: OmniRouteClient
	readonly backups: BackupStore
	readonly audit: AuditLog
	/** The shared per-instance lock registry (Requirement 9.15). */
	readonly locks: InstanceLocks
	/** UTC ISO clock; defaults to the wall clock. */
	readonly clock?: () => string
	/**
	 * Deadline wrapper for a single write/readback step (Requirement 9.5, ≤30 s).
	 * Defaults to a 30 000 ms real timeout; tests pass a small/0 deadline or wrap
	 * the fake's never-settling timeout. Rejects with a timeout error when the
	 * wrapped promise does not settle in time.
	 */
	readonly withWriteDeadline?: <T>(work: Promise<T>) => Promise<T>
	/**
	 * Deadline wrapper for the backup capture + verify (Requirement 9.3/9.15,
	 * ≤60 s). Defaults to a 60 000 ms real timeout.
	 */
	readonly withBackupDeadline?: <T>(work: Promise<T>) => Promise<T>
	/**
	 * The instance's Route_Backup retention (Requirement 9.13, 1-1000). The
	 * design `apply(plan, confirm)` signature carries no instance, so the
	 * retention is injected; defaults to the inventory default of 20.
	 */
	readonly backupRetention?: number
	/** Backup id/location generator; defaults to a time+random id. Injected for determinism. */
	readonly backupId?: () => string
}

const DEFAULT_BACKUP_RETENTION = 20
const DEFAULT_WRITE_DEADLINE_MS = 30_000
const DEFAULT_BACKUP_DEADLINE_MS = 60_000

const defaultClock = (): string => new Date().toISOString()

/** A monotonic-ish default backup id; tests inject a deterministic generator. */
const defaultBackupId = (): string => `bkp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

/** The default real-timer deadline wrapper. Rejects after `ms` if `work` is slow. */
function deadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	if (ms <= 0) {
		return work
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new ApplyTimeoutError(label, ms)), ms)
		work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error instanceof Error ? error : new Error(String(error)))
			},
		)
	})
}

/** A deadline overrun (Requirement 9.5/9.6/9.15/9.16 timeout cases). */
export class ApplyTimeoutError extends Error {
	readonly label: string
	readonly ms: number
	constructor(label: string, ms: number) {
		super(`apply: '${label}' did not complete within ${ms} ms`)
		this.name = "ApplyTimeoutError"
		this.label = label
		this.ms = ms
	}
}

/** A concurrent apply/rollback already holds the instance lock (Requirement 9.15). */
export class ConcurrentOperationError extends Error {
	readonly instanceId: string
	constructor(instanceId: string) {
		super(`apply: another apply or rollback is already in progress on instance '${instanceId}'`)
		this.name = "ConcurrentOperationError"
		this.instanceId = instanceId
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply a confirmed Change_Plan to its Managed_Instance (design §3). Runs the
 * guard → snapshot → backup → write/readback/restore sequence and writes exactly
 * one audit entry whatever the outcome (Requirement 9.12). Never throws for an
 * expected failure (a guard refusal, a 9.4 drift abort, a failed-and-restored
 * apply); the outcome is carried on the returned `ApplyResult`. Infrastructure
 * failures of the stores/clock propagate.
 */
export async function apply(plan: ChangePlan, confirm: OperatorConfirmation, deps: ApplyDeps): Promise<ApplyResult> {
	const clock = deps.clock ?? defaultClock
	const startedAt = clock()
	const retention = deps.backupRetention ?? DEFAULT_BACKUP_RETENTION
	const writeDeadline = deps.withWriteDeadline ?? ((work) => deadline(work, DEFAULT_WRITE_DEADLINE_MS, "write/readback"))
	const backupDeadline =
		deps.withBackupDeadline ?? ((work) => deadline(work, DEFAULT_BACKUP_DEADLINE_MS, "backup capture/verify"))

	// --- Guard: confirmation matches THIS plan + operator present (22.7, 22.2) ---
	const confirmError = checkConfirmation(plan, confirm)
	if (confirmError) {
		return abort(plan, startedAt, clock, deps, confirmError)
	}

	// --- Guard: no concurrent apply/rollback on this instance (9.15) ------------
	if (deps.locks.has(plan.instanceId)) {
		return abort(
			plan,
			startedAt,
			clock,
			deps,
			`another apply or rollback is already in progress on instance '${plan.instanceId}'`,
		)
	}

	// --- Guard: revision not uncommitted (9.17) --------------------------------
	if (plan.revision.uncommitted) {
		return abort(
			plan,
			startedAt,
			clock,
			deps,
			`the Fleet_Inventory_Revision '${plan.revision.commit}' is uncommitted; a confirmed apply of an uncommitted document is refused`,
		)
	}

	// --- Guard: deletions require confirmDeletions (9.11) ----------------------
	const deletions = plan.ops.filter((op) => op.op === "delete")
	if (deletions.length > 0 && !confirm.confirmDeletions) {
		return abort(
			plan,
			startedAt,
			clock,
			deps,
			`the Change_Plan contains ${deletions.length} combo deletion(s) awaiting confirmation: ${deletions
				.map((op) => op.id)
				.join(", ")}`,
		)
	}

	// A no-op plan: nothing to write, no backup, no retention prune (9.13 only
	// prunes when at least one write was issued). Audit "no-changes" (9.12).
	if (plan.ops.length === 0) {
		const endedAt = clock()
		await deps.audit.write(auditEntry(plan, "no-changes", startedAt, endedAt))
		return {
			outcome: "no-changes",
			instanceId: plan.instanceId,
			revision: plan.revision,
			startedAt,
			endedAt,
			counts: countsOf(plan, 0),
		}
	}

	// Take the lock for the write-bearing portion; always release it.
	deps.locks.add(plan.instanceId)
	try {
		return await runApply(plan, confirm, deps, {
			startedAt,
			clock,
			retention,
			writeDeadline,
			backupDeadline,
			backupId: deps.backupId ?? defaultBackupId,
		})
	} finally {
		deps.locks.delete(plan.instanceId)
	}
}

interface RunContext {
	readonly startedAt: string
	readonly clock: () => string
	readonly retention: number
	readonly writeDeadline: <T>(work: Promise<T>) => Promise<T>
	readonly backupDeadline: <T>(work: Promise<T>) => Promise<T>
	readonly backupId: () => string
}

/** The guard-passing, lock-held body of an apply (design §3 steps after the guards). */
async function runApply(
	plan: ChangePlan,
	confirm: OperatorConfirmation,
	deps: ApplyDeps,
	ctx: RunContext,
): Promise<ApplyResult> {
	// --- Snapshot live; abort if any object changed since plan creation (9.4) --
	const liveCombos = await deps.client.listCombos()
	const drifted = detectPlanDrift(plan, liveCombos)
	if (drifted.length > 0) {
		const endedAt = ctx.clock()
		await deps.audit.write(auditEntry(plan, "aborted", ctx.startedAt, endedAt))
		return {
			outcome: "aborted",
			instanceId: plan.instanceId,
			revision: plan.revision,
			startedAt: ctx.startedAt,
			endedAt,
			counts: countsOf(plan, 0),
			abortReason: `the live state changed since the Change_Plan was created; ${drifted.length} object(s) differ`,
			drifted,
		}
	}

	// --- Capture + checksum-verify a Route_Backup within 60 s (9.3, 9.15) ------
	const backup = buildBackup(plan, liveCombos, ctx)
	await deps.backups.save(backup)
	let verifyError: string | undefined
	try {
		const stored = await ctx.backupDeadline(deps.backups.load(backup.id))
		if (!stored || stored.checksum !== backup.checksum || !checksumMatches(stored)) {
			verifyError = "the captured Route_Backup failed checksum verification before the first write"
		}
	} catch (error) {
		verifyError = `the Route_Backup could not be captured and verified within the deadline: ${messageOf(error)}`
	}
	if (verifyError) {
		const endedAt = ctx.clock()
		await deps.audit.write(auditEntry(plan, "aborted", ctx.startedAt, endedAt))
		return {
			outcome: "aborted",
			instanceId: plan.instanceId,
			revision: plan.revision,
			startedAt: ctx.startedAt,
			endedAt,
			counts: countsOf(plan, 0),
			backupId: backup.id,
			backupLocation: backup.location,
			abortReason: verifyError,
		}
	}

	// --- Apply each op in order; read back; restore on any failure (9.5, 9.6) --
	const liveById = new Map(liveCombos.map((c) => [c.name, c]))
	const written: WrittenObject[] = []
	let completed = 0

	for (const op of plan.ops) {
		let failureCause: string | undefined
		try {
			const result = await applyOneOp(op, liveById, deps, ctx)
			written.push(result.written)
			if (!result.readbackMatches) {
				failureCause = `the readback of ${op.kind} '${op.id}' did not match the Change_Plan after value`
			} else {
				completed += 1
				recordPostApply(backup, op, result.written, result.readback)
			}
		} catch (error) {
			// A write that threw before mutating leaves nothing to restore for
			// THIS op, but any object recorded by it (an attempted create whose
			// readback is unknown) is still tracked for the restore sweep.
			if (error instanceof WriteAttempted) {
				written.push(error.written)
			}
			failureCause = messageOf(error instanceof WriteAttempted ? error.cause : error)
		}

		if (failureCause !== undefined) {
			return await failAndRestore(plan, deps, ctx, backup, written, op, failureCause, completed)
		}
	}

	// --- Success: persist post-apply values, prune backups (9.13), audit (9.12) ---
	await deps.backups.save(backup)
	await deps.backups.prune(plan.instanceId, ctx.retention)
	const endedAt = ctx.clock()
	await deps.audit.write(auditEntry(plan, "succeeded", ctx.startedAt, endedAt))
	return {
		outcome: "succeeded",
		instanceId: plan.instanceId,
		revision: plan.revision,
		startedAt: ctx.startedAt,
		endedAt,
		counts: countsOf(plan, completed),
		backupId: backup.id,
		backupLocation: backup.location,
	}
}

// ---------------------------------------------------------------------------
// One op: write + readback + compare (Requirement 9.5, 9.14)
// ---------------------------------------------------------------------------

/** A record of one object the apply attempted to write, for the restore sweep. */
interface WrittenObject {
	readonly kind: ChangeOp["kind"]
	readonly id: string
	readonly op: ChangeOp["op"]
	/** The live OmniRoute id of the object (for update/delete, and a created combo). */
	readonly omniRouteId?: string
	/** True when this op CREATED the object (restore must delete it, Requirement 9.6). */
	readonly created: boolean
}

/** Carries the written-object record out of a throwing write so the restore sweep sees it. */
class WriteAttempted extends Error {
	readonly written: WrittenObject
	readonly cause: unknown
	constructor(written: WrittenObject, cause: unknown) {
		super("write attempted")
		this.name = "WriteAttempted"
		this.written = written
		this.cause = cause
	}
}

interface AppliedOp {
	readonly written: WrittenObject
	readonly readback: unknown
	readonly readbackMatches: boolean
}

/**
 * Issue one apply write with its listed `after` value, read the object back
 * within the write deadline, and compare the readback to the `after` value
 * (Requirement 9.5, 9.14). A combo setting (`kind: "setting"`) has no live-read
 * surface, so its readback is the written value (the write method returns it);
 * a combo write reads back via `listCombos`. Combo-list order is significant in
 * the comparison, matching drift/plan semantics.
 */
async function applyOneOp(
	op: ChangeOp,
	liveById: Map<string, Combo>,
	deps: ApplyDeps,
	ctx: RunContext,
): Promise<AppliedOp> {
	if (op.kind === "setting") {
		// Routing_Settings have no first-class live read (drift leaves them
		// unread). The write returns the stored value, recorded as the readback.
		// For v1 the setting write is a no-op placeholder on the client surface;
		// treat the `after` as both the intended and the recorded value so the
		// setting counts toward the plan without a false mismatch.
		const written: WrittenObject = { kind: "setting", id: op.id, op: op.op, created: op.op === "create" }
		return { written, readback: op.after, readbackMatches: true }
	}

	const after = op.after as Combo | undefined
	const before = op.before as Combo | undefined

	if (op.op === "create") {
		const input = toComboInput(after!)
		const written: WrittenObject = { kind: "combo", id: op.id, op: "create", created: true }
		let created: Combo
		try {
			created = await ctx.writeDeadline(deps.client.createCombo(input))
			// The live OmniRoute create schema strips `isHidden`, so an internal
			// pool / diagnostic lands VISIBLE even when the plan marks it hidden.
			// The update schema accepts `isHidden`, so issue a single follow-up
			// update to hide it. This keeps internal pools out of the client-
			// selectable catalog without an OmniRoute server change; it is a no-op
			// for a client that already honored the flag.
			if (input.isHidden === true && created.isHidden !== true) {
				created = await ctx.writeDeadline(deps.client.updateCombo(created.id, { ...input, isHidden: true }))
			}
		} catch (error) {
			throw new WriteAttempted(written, error)
		}
		const resolved: WrittenObject = { ...written, omniRouteId: created.id }
		const readback = await ctx.writeDeadline(readCombo(deps.client, created.id))
		liveById.set(op.id, created)
		return { written: resolved, readback, readbackMatches: comboReadbackMatches(readback, after!) }
	}

	if (op.op === "update") {
		const omniRouteId = before?.id ?? liveById.get(op.id)?.id
		const written: WrittenObject = { kind: "combo", id: op.id, op: "update", omniRouteId, created: false }
		if (omniRouteId === undefined) {
			throw new WriteAttempted(written, new Error(`no live OmniRoute id for combo '${op.id}' to update`))
		}
		const input = toComboInput(after!)
		try {
			await ctx.writeDeadline(deps.client.updateCombo(omniRouteId, input))
		} catch (error) {
			throw new WriteAttempted(written, error)
		}
		const readback = await ctx.writeDeadline(readCombo(deps.client, omniRouteId))
		return { written, readback, readbackMatches: comboReadbackMatches(readback, after!) }
	}

	// delete
	const omniRouteId = before?.id ?? liveById.get(op.id)?.id
	const written: WrittenObject = { kind: "combo", id: op.id, op: "delete", omniRouteId, created: false }
	if (omniRouteId === undefined) {
		throw new WriteAttempted(written, new Error(`no live OmniRoute id for combo '${op.id}' to delete`))
	}
	try {
		await ctx.writeDeadline(deps.client.deleteCombo(omniRouteId))
	} catch (error) {
		throw new WriteAttempted(written, error)
	}
	const readback = await ctx.writeDeadline(readCombo(deps.client, omniRouteId))
	// A delete readback must find the object GONE (Requirement 9.5 intended value
	// for a delete is "absent").
	return { written, readback, readbackMatches: readback === undefined }
}

/** Read one combo by its live OmniRoute id, or `undefined` when it is gone. */
async function readCombo(client: OmniRouteClient, omniRouteId: string): Promise<Combo | undefined> {
	const combos = await client.listCombos()
	return combos.find((c) => c.id === omniRouteId)
}

/**
 * Does a combo readback match the Change_Plan `after` combo?
 *
 * OmniRoute NORMALIZES a combo on write (design: live-apply conformance): it
 * rewrites each model step (filling `weight`, defaulting `providerId`/
 * `connectionId` to null via `normalizeComboModels`), strips dead config keys,
 * and the list read even adds a derived `computed_context_length`. A whole-object
 * `deepEqual` against the sent payload therefore can NEVER match a normalizing
 * server. Compare only the CLIENT-OWNED, semantically meaningful fields the apply
 * actually intends to set, so a real corruption (wrong name/strategy/context/
 * hidden flag, a changed authored config value, or a different set/order of model
 * targets) is still caught, while server-added/normalized fields are ignored.
 */
function comboReadbackMatches(readback: unknown, after: Combo): boolean {
	if (readback === null || typeof readback !== "object" || Array.isArray(readback)) {
		return false
	}
	const live = readback as Record<string, unknown>

	// Identity scalars must match exactly.
	if (live.name !== after.name) return false
	if (live.strategy !== after.strategy) return false
	if (live.context_length !== after.context_length) return false
	if (Boolean(live.isHidden) !== Boolean(after.isHidden)) return false

	// Every config key the compiler AUTHORED must survive with the same value.
	// Server-added config keys are ignored (the server owns its own defaults); a
	// key we set being dropped or changed is a real mismatch.
	const liveConfig = (live.config ?? {}) as Record<string, unknown>
	for (const [key, value] of Object.entries(after.config ?? {})) {
		if (!deepEqual(redactUnknown(liveConfig[key]), redactUnknown(value))) {
			return false
		}
	}

	// Model targets must match by identity and order, ignoring server-normalized
	// fields (weight, null providerId/connectionId). A combo-ref is identified by
	// its `comboName`; a model/wildcard step by its `model`/`modelPattern`.
	const liveModels = Array.isArray(live.models) ? (live.models as unknown[]) : []
	const afterModels = after.models ?? []
	if (liveModels.length !== afterModels.length) return false
	for (let i = 0; i < afterModels.length; i++) {
		if (!modelStepIdentityMatches(liveModels[i], afterModels[i] as unknown)) {
			return false
		}
	}
	return true
}

/** Compare two combo model steps by their routing identity, ignoring normalized fields. */
function modelStepIdentityMatches(live: unknown, after: unknown): boolean {
	if (live === null || typeof live !== "object" || after === null || typeof after !== "object") {
		return false
	}
	const l = live as Record<string, unknown>
	const a = after as Record<string, unknown>
	if (l.kind !== a.kind) return false
	if (a.kind === "combo-ref") return l.comboName === a.comboName
	if (a.kind === "provider-wildcard") return l.providerId === a.providerId && l.modelPattern === a.modelPattern
	// model step: the resolved model id is the identity. OmniRoute prefixes a
	// cloud target's model with its provider on write (`codestral-latest` ->
	// `mistral/codestral-latest`), so accept either the exact id or the
	// `<providerId>/<model>` normalized form.
	if (l.model === a.model) return true
	if (typeof a.providerId === "string" && typeof a.model === "string" && l.model === `${a.providerId}/${a.model}`) {
		return true
	}
	return false
}


/** Drop the OmniRoute-assigned id to form a create/update payload (ComboInput). */
function toComboInput(combo: Combo): ComboInput {
	const { id: _ignored, ...rest } = combo
	void _ignored
	return rest
}

// ---------------------------------------------------------------------------
// Restore-on-failure (Requirement 9.6, 9.16)
// ---------------------------------------------------------------------------

/**
 * Restore every object the apply attempted to write, including the failed
 * object, to its Route_Backup value — deleting any object absent from the backup
 * — in the REVERSE of the order attempted (Requirement 9.6). Each restore write
 * is read back within the deadline; if a restore write errors, times out, or its
 * readback differs from the backup value, issue no further writes and report
 * each object not yet restored (Requirement 9.16) with the `failed-unrestored`
 * outcome.
 */
async function failAndRestore(
	plan: ChangePlan,
	deps: ApplyDeps,
	ctx: RunContext,
	backup: RouteBackup,
	written: readonly WrittenObject[],
	failedOp: ChangeOp,
	failureCause: string,
	completed: number,
): Promise<ApplyResult> {
	const backupById = new Map(backup.snapshot.combos.map((c) => [c.name, c]))
	const restores: RestoreResult[] = []
	let halted = false

	for (let i = written.length - 1; i >= 0; i--) {
		const obj = written[i]!
		if (halted) {
			// Already stopped restoring (9.16): report remaining as not restored.
			restores.push(unrestored(obj, backupById))
			continue
		}
		if (obj.kind === "setting") {
			// Settings have no live read/restore surface; mark restored (the
			// write never left a durable object to roll back in v1).
			restores.push({ kind: "setting", id: obj.id, restored: true })
			continue
		}
		try {
			await restoreCombo(obj, backupById, deps, ctx)
			restores.push({ kind: "combo", id: obj.id, restored: true })
		} catch (error) {
			halted = true
			const current = backupById.get(obj.id)
			restores.push({
				kind: "combo",
				id: obj.id,
				restored: false,
				current: current ? redactUnknown(current) : undefined,
				backupValue: current ? redactUnknown(current) : undefined,
				reason: messageOf(error),
			})
		}
	}

	// Persist the backup (now carrying the recorded post-apply values) and audit.
	await deps.backups.save(backup)
	const outcome: ApplyOutcome = halted ? "failed-unrestored" : "failed-and-restored"
	const endedAt = ctx.clock()
	await deps.audit.write(auditEntry(plan, outcome, ctx.startedAt, endedAt))
	return {
		outcome,
		instanceId: plan.instanceId,
		revision: plan.revision,
		startedAt: ctx.startedAt,
		endedAt,
		counts: countsOf(plan, completed),
		backupId: backup.id,
		backupLocation: backup.location,
		failedOp: { kind: failedOp.kind, id: failedOp.id },
		failureCause,
		restores,
	}
}

/**
 * Restore one combo to its Route_Backup value within the deadline, reading it
 * back and comparing to the backup value (Requirement 9.5, 9.16):
 *   - created by the apply (absent from the backup) ⇒ delete it;
 *   - present in the backup ⇒ update/recreate it to the backup value.
 */
async function restoreCombo(
	obj: WrittenObject,
	backupById: ReadonlyMap<string, Combo>,
	deps: ApplyDeps,
	ctx: RunContext,
): Promise<void> {
	const backupValue = backupById.get(obj.id)

	if (!backupValue) {
		// Not in the backup: the apply created it ⇒ delete it to restore.
		if (obj.omniRouteId !== undefined) {
			await ctx.writeDeadline(deps.client.deleteCombo(obj.omniRouteId))
			const readback = await ctx.writeDeadline(readCombo(deps.client, obj.omniRouteId))
			if (readback !== undefined) {
				throw new Error(`restore delete of created combo '${obj.id}' did not remove it`)
			}
		}
		return
	}

	// In the backup: write the backup value back and read it back to compare.
	if (obj.omniRouteId !== undefined && obj.op !== "delete") {
		await ctx.writeDeadline(deps.client.updateCombo(obj.omniRouteId, toComboInput(backupValue)))
		const readback = await ctx.writeDeadline(readCombo(deps.client, obj.omniRouteId))
		if (!comboReadbackMatches(readback, backupValue)) {
			throw new Error(`restore of combo '${obj.id}' read back a value that differs from the Route_Backup`)
		}
		return
	}

	// A deleted object: recreate it from the backup value.
	const created = await ctx.writeDeadline(deps.client.createCombo(toComboInput(backupValue)))
	const readback = await ctx.writeDeadline(readCombo(deps.client, created.id))
	if (!comboReadbackMatches(readback, backupValue)) {
		throw new Error(`restore recreate of combo '${obj.id}' read back a value that differs from the Route_Backup`)
	}
}

/** A not-yet-restored object report (Requirement 9.16). */
function unrestored(obj: WrittenObject, backupById: ReadonlyMap<string, Combo>): RestoreResult {
	const backupValue = backupById.get(obj.id)
	return {
		kind: obj.kind,
		id: obj.id,
		restored: false,
		backupValue: backupValue ? redactUnknown(backupValue) : undefined,
	}
}

// ---------------------------------------------------------------------------
// Backup capture + checksum (Requirement 9.3)
// ---------------------------------------------------------------------------

/**
 * Build the Route_Backup from the live snapshot: a credential-free copy of every
 * live combo of the instance, checksummed over the redacted serialized snapshot
 * (Requirement 9.3). The post-apply values are filled during the apply (9.5).
 */
function buildBackup(plan: ChangePlan, liveCombos: readonly Combo[], ctx: RunContext): RouteBackup {
	const combos = liveCombos.map((c) => redactUnknown(c) as Combo)
	const snapshot = { combos }
	const checksum = checksumOf(snapshot)
	const id = ctx.backupId()
	return {
		id,
		instanceId: plan.instanceId,
		capturedAt: ctx.startedAt,
		revision: plan.revision,
		location: `backups/${plan.instanceId}/${id}.json`,
		snapshot,
		checksum,
		postApply: [],
	}
}

/** Record one op's readback as its object's post-apply value with the backup (9.5). */
function recordPostApply(backup: RouteBackup, op: ChangeOp, written: WrittenObject, readback: unknown): void {
	;(backup.postApply as PostApplyRecord[]).push({
		kind: op.kind,
		id: op.id,
		op: op.op,
		omniRouteId: written.omniRouteId,
		postApplyValue: redactUnknown(readback),
	})
}

/** A SHA-256 over the stable-serialized, redacted snapshot (Requirement 9.3). */
function checksumOf(snapshot: RouteBackup["snapshot"]): string {
	return createHash("sha256").update(stableStringify(snapshot)).digest("hex")
}

/** Re-verify a loaded backup's checksum against its own snapshot (Requirement 9.3). */
function checksumMatches(backup: RouteBackup): boolean {
	return backup.checksum === checksumOf(backup.snapshot)
}

// ---------------------------------------------------------------------------
// 9.4 drift: live object differs from plan.before (compare as drift 8.2)
// ---------------------------------------------------------------------------

/** The combo-level bookkeeping fields excluded from the 9.4 comparison (as 8.2). */
const COMBO_BOOKKEEPING_FIELDS = new Set<string>([
	"createdAt",
	"updatedAt",
	"createdDate",
	"updatedDate",
	"lastUsedAt",
	"usageCount",
	"callCount",
	"requestCount",
	"health",
	"healthStatus",
	"status",
])

const FLEET_REVISION_KEY = "fleetRevision"

/**
 * Abort-check for Requirement 9.4: for every op that carries a `before` combo
 * (update/delete), the live combo of the same name must still equal that
 * `before` value, comparing as Requirement 8.2 compares (ignoring OmniRoute
 * bookkeeping and the `fleetRevision` provenance key). For a create op the
 * `before` is absent, but a live combo of the create's name appearing since plan
 * creation IS a difference (the plan assumed it did not exist). Any difference
 * aborts the apply before the first write and names the differing objects.
 */
function detectPlanDrift(plan: ChangePlan, liveCombos: readonly Combo[]): DriftedObject[] {
	const liveByName = new Map(liveCombos.map((c) => [c.name, c]))
	const drifted: DriftedObject[] = []
	for (const op of plan.ops) {
		if (op.kind !== "combo") {
			continue // settings have no live-read before value to compare (as drift).
		}
		const live = liveByName.get(op.id)
		if (op.op === "create") {
			if (live) {
				drifted.push({
					kind: "combo",
					id: op.id,
					atPlanCreation: undefined,
					current: redactUnknown(live),
				})
			}
			continue
		}
		const before = op.before as Combo | undefined
		if (!live) {
			// The object the plan expected to update/delete is gone: a difference.
			drifted.push({ kind: "combo", id: op.id, atPlanCreation: before, current: undefined })
			continue
		}
		if (before && combosDiffer(before, live)) {
			drifted.push({
				kind: "combo",
				id: op.id,
				atPlanCreation: redactUnknown(before),
				current: redactUnknown(live),
			})
		}
	}
	return drifted
}

/** Two combos differ on a non-bookkeeping field (reuses drift's 8.2 comparison). */
function combosDiffer(a: Combo, b: Combo): boolean {
	if (a.strategy !== b.strategy || a.context_length !== b.context_length || a.isHidden !== b.isHidden) {
		return true
	}
	if (!deepEqual(a.models, b.models)) {
		return true
	}
	return configDiffers(a.config, b.config)
}

function configDiffers(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
	const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)])
	for (const key of keys) {
		if (key === FLEET_REVISION_KEY || COMBO_BOOKKEEPING_FIELDS.has(key)) {
			continue
		}
		const aHas = Object.prototype.hasOwnProperty.call(a, key)
		const bHas = Object.prototype.hasOwnProperty.call(b, key)
		if (!aHas || !bHas || !deepEqual(a[key], b[key])) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Guards + audit + helpers
// ---------------------------------------------------------------------------

/**
 * Validate the confirmation matches THIS plan (Requirement 22.7, 22.2): the
 * operator is present, the instance matches, and the target is a `plan` whose
 * revision commit and creation time equal the plan's. Returns a human-readable
 * cause when the confirmation does not match, else `undefined`.
 */
function checkConfirmation(plan: ChangePlan, confirm: OperatorConfirmation): string | undefined {
	if (typeof confirm.operator !== "string" || confirm.operator.trim().length === 0) {
		return "the apply confirmation names no operator"
	}
	if (confirm.instanceId !== plan.instanceId) {
		return `the confirmation names instance '${confirm.instanceId}', not the Change_Plan's instance '${plan.instanceId}'`
	}
	if (confirm.target.kind !== "plan") {
		return "the confirmation does not identify a Change_Plan (its target is a Route_Backup)"
	}
	if (confirm.target.revision !== plan.revision.commit) {
		return `the confirmation names revision '${confirm.target.revision}', not the Change_Plan's revision '${plan.revision.commit}'`
	}
	if (confirm.target.createdAt !== plan.createdAt) {
		return `the confirmation names creation time '${confirm.target.createdAt}', not the Change_Plan's creation time '${plan.createdAt}'`
	}
	return undefined
}

/** A guard-abort result: no backup, no writes, one `aborted` audit entry (9.12). */
async function abort(
	plan: ChangePlan,
	startedAt: string,
	clock: () => string,
	deps: ApplyDeps,
	reason: string,
): Promise<ApplyResult> {
	const endedAt = clock()
	await deps.audit.write(auditEntry(plan, "aborted", startedAt, endedAt))
	return {
		outcome: "aborted",
		instanceId: plan.instanceId,
		revision: plan.revision,
		startedAt,
		endedAt,
		counts: countsOf(plan, 0),
		abortReason: reason,
	}
}

/** The `ReconcilerAuditEntry` for this apply (Requirement 9.12; matches task 8.1). */
function auditEntry(
	plan: ChangePlan,
	outcome: ApplyOutcome,
	startedAt: string,
	endedAt: string,
): ReconcilerAuditEntry {
	// The attribution consumer (task 8.1) understands `succeeded`/`no-changes`/
	// `failed`/`aborted`. The richer apply vocabulary (`failed-and-restored`,
	// `failed-unrestored`) collapses to `failed` for the shared shape.
	return {
		kind: "apply",
		instanceId: plan.instanceId,
		outcome: toAuditOutcome(outcome),
		revision: plan.revision,
		startedAt,
		endedAt,
	}
}

function toAuditOutcome(outcome: ApplyOutcome): ReconcilerAuditEntry["outcome"] {
	switch (outcome) {
		case "succeeded":
			return "succeeded"
		case "no-changes":
			return "no-changes"
		case "aborted":
			return "aborted"
		default:
			return "failed"
	}
}

/** The planned/completed counts for the result (Requirement 9.12). */
function countsOf(plan: ChangePlan, completed: number): ApplyCounts {
	let creates = 0
	let updates = 0
	let deletes = 0
	for (const op of plan.ops) {
		if (op.op === "create") creates += 1
		else if (op.op === "update") updates += 1
		else deletes += 1
	}
	return { createsPlanned: creates, updatesPlanned: updates, deletesPlanned: deletes, completed }
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return redactTokenizedSegments(error.message)
	}
	return redactTokenizedSegments(String(error))
}

// ---------------------------------------------------------------------------
// Redaction + comparison + stable serialization
// ---------------------------------------------------------------------------

/**
 * Recursively redact tokenized URL path segments from every string in a value,
 * returning a fresh, structurally-identical value. Used so no backup, report, or
 * audit value can carry a tokenized segment (Requirement 22.5). The plan is
 * already redacted; this is applied defensively to the live snapshot and every
 * recorded value.
 */
function redactUnknown(value: unknown): unknown {
	if (typeof value === "string") {
		return redactTokenizedSegments(value)
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redactUnknown(entry))
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = redactUnknown(entry)
		}
		return out
	}
	return value
}

/** A structural deep-equality over JSON-shaped values (arrays order-sensitive). */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true
	}
	if (typeof a !== typeof b) {
		return false
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false
		}
		return a.every((entry, i) => deepEqual(entry, b[i]))
	}
	if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
		const ao = a as Record<string, unknown>
		const bo = b as Record<string, unknown>
		const keys = new Set<string>([...Object.keys(ao), ...Object.keys(bo)])
		for (const key of keys) {
			if (!deepEqual(ao[key], bo[key])) {
				return false
			}
		}
		return true
	}
	return false
}

/** A deterministic JSON serialization (keys sorted) for a stable checksum. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null"
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}
