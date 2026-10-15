// Reconciler — rollback to a Route_Backup (design §3 "Apply, backup, readback,
// rollback", Requirement 9 criteria 7, 8, 16, and Requirement 10 criterion 5).
//
// Rollback is one of only two writer paths to OmniRoute (the other is apply,
// task 6.2). It takes a backup id and a per-invocation operator confirmation and
// drives the careful reverse of an apply, each step mapping onto a Requirement:
//
//   rollback(backupId, confirm, deps):
//     guard: confirm present + target.kind "backup" + capturedAt matches backup  [22.7]
//     guard: another apply/rollback not already running on this instance          [9.15]
//     guard: instance is not `retired` and IS declared, before any write          [10.5]
//     load + checksum-verify the Route_Backup                                     [9.7, 9.8]
//     confirm every apply-written object still equals its recorded post-apply
//        value OR its Route_Backup value; else refuse and report the drifted      [9.7, 9.8]
//     restore each apply-written object that differs from its backup value, in
//        the REVERSE of the apply's write order, deleting objects absent from
//        the backup (the apply created them); read back each restore ≤30 s        [9.5]
//     stop and report on a restore write error / timeout / readback mismatch      [9.16]
//     audit a "rollback" entry whatever the outcome                               [8.1 shape]
//
// Design interface (design §3):
//   rollback(backupId: string, confirm: OperatorConfirmation): Promise<RollbackResult>
// The stores/clock/deadlines and the instance-role lookup are supplied through
// `RollbackDeps` so the sequence stays deterministic and testable (an in-memory
// backup store + audit log, a small/0 deadline, a scripted fake client, and a
// map of instance roles). The design signature carries no inventory, so the
// `retired`/undeclared check (Requirement 10.5) is served by an injected
// instance-role lookup rather than a re-read of the model.
//
// Credential safety (22.4-22.6): the Route_Backup is already redacted (apply.ts
// built it through `redactUnknown`); every value this module places on a report
// or audit entry is passed through the same `redactTokenizedSegments` so no
// tokenized URL path segment can leak.

import { createHash } from "node:crypto"

import type { ReconcilerAuditEntry } from "../observe/attribution.js"
import type { Combo, ComboInput, OmniRouteClient } from "../omniroute/client.js"
import { redactTokenizedSegments } from "../omniroute/redact.js"
import type {
	AuditLog,
	BackupStore,
	InstanceLocks,
	OperatorConfirmation,
	PostApplyRecord,
	RouteBackup,
} from "./apply.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The terminal outcome of a rollback (Requirement 9.12 outcome vocabulary). */
export type RollbackOutcome =
	| "succeeded" // every apply-written object equals its Route_Backup value again.
	| "no-changes" // every object already equalled its backup value; no write issued.
	| "aborted" // a guard refused the rollback before the first write (10.5, 9.15, 22.7).
	| "refused" // the backup was missing/corrupt or an object drifted (9.7, 9.8); no write.
	| "failed-unrestored" // a restore write failed; objects were left unrestored (9.16).

/** The role an instance holds in a Fleet_Inventory_Revision (Requirement 10.1). */
export type InstanceRole = "primary" | "secondary" | "retired"

/**
 * Looks up the role an instance holds in the latest committed
 * Fleet_Inventory_Revision (and/or the revision the rolled-back apply used), for
 * the Requirement 10.5 guard. Returns the role, or `undefined` when the revision
 * does not declare the instance at all. Injected so rollback stays decoupled
 * from version control: a test supplies a map, production supplies a reader
 * backed by the committed inventory.
 */
export interface InstanceRoleLookup {
	roleOf(instanceId: string): InstanceRole | undefined
}

/**
 * One object that drifted since the apply (Requirement 9.8): it equals neither
 * its recorded post-apply value nor its Route_Backup value, so the rollback
 * cannot safely proceed. All values are credential-free.
 */
export interface DriftedSinceApply {
	readonly kind: PostApplyRecord["kind"]
	readonly id: string
	/** The object's current live value (credential-free), or undefined when absent. */
	readonly current: unknown
	/** The value the apply recorded as this object's post-apply value. */
	readonly postApplyValue: unknown
	/** The object's Route_Backup value, or undefined when it was absent from the backup. */
	readonly backupValue: unknown
}

/**
 * The restore result of one object during a rollback (Requirement 9.16). A
 * `restored` object matched its Route_Backup value on readback; an unrestored
 * object (after a halt) carries its current and Route_Backup values.
 */
export interface RollbackRestore {
	readonly kind: PostApplyRecord["kind"]
	readonly id: string
	readonly restored: boolean
	/** For an unrestored object: its current value (credential-free). */
	readonly current?: unknown
	/** For an unrestored object: its Route_Backup value (undefined when absent). */
	readonly backupValue?: unknown
	/** The failure cause when the restore write itself failed. */
	readonly reason?: string
}

/**
 * The result of a rollback invocation. `drifted` is set for a 9.8 refusal;
 * `refuseReason` carries a human-readable cause for a missing/corrupt backup or
 * a guard abort; `restores` is set once writes began (success or 9.16 halt). All
 * values are credential-free.
 */
export interface RollbackResult {
	readonly outcome: RollbackOutcome
	readonly instanceId: string
	readonly backupId: string
	readonly revision: RouteBackup["revision"]
	readonly startedAt: string
	readonly endedAt: string
	readonly backupLocation?: string
	/** For an `aborted`/`refused` outcome: the human-readable cause. */
	readonly refuseReason?: string
	/** For a 9.8 refusal: each object that drifted away from both recorded values. */
	readonly drifted?: readonly DriftedSinceApply[]
	/** Once restore writes began: the restore result of every apply-written object. */
	readonly restores?: readonly RollbackRestore[]
	/** The count of objects whose live value already equalled the backup (no write needed). */
	readonly alreadyAtBackup?: number
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** The dependencies and injectable deadlines of a rollback (design §3). */
export interface RollbackDeps {
	readonly client: OmniRouteClient
	readonly backups: BackupStore
	readonly audit: AuditLog
	/** The shared per-instance lock registry (Requirement 9.15), shared with apply. */
	readonly locks: InstanceLocks
	/** The instance-role lookup for the Requirement 10.5 guard. */
	readonly roles: InstanceRoleLookup
	/** UTC ISO clock; defaults to the wall clock. */
	readonly clock?: () => string
	/**
	 * Deadline wrapper for a single restore write/readback step (Requirement 9.5,
	 * 9.16, ≤30 s). Defaults to a 30 000 ms real timeout; tests pass a small/0
	 * deadline or wrap the fake's never-settling timeout.
	 */
	readonly withWriteDeadline?: <T>(work: Promise<T>) => Promise<T>
	/**
	 * The start time of the apply this rollback reverses, if known, for the audit
	 * entry's `rolledBackApplyStartedAt` (consumed by attribution, task 8.1). The
	 * Route_Backup carries no apply start time, so it is supplied here when the
	 * caller has it (the apply's `ApplyResult.startedAt`).
	 */
	readonly rolledBackApplyStartedAt?: string
}

const DEFAULT_WRITE_DEADLINE_MS = 30_000

const defaultClock = (): string => new Date().toISOString()

/** The default real-timer deadline wrapper. Rejects after `ms` if `work` is slow. */
function deadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	if (ms <= 0) {
		return work
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new RollbackTimeoutError(label, ms)), ms)
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

/** A restore deadline overrun during a rollback (Requirement 9.16 timeout case). */
export class RollbackTimeoutError extends Error {
	readonly label: string
	readonly ms: number
	constructor(label: string, ms: number) {
		super(`rollback: '${label}' did not complete within ${ms} ms`)
		this.name = "RollbackTimeoutError"
		this.label = label
		this.ms = ms
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Roll an OmniRoute_Instance back to a captured Route_Backup (design §3). Runs
 * the guard → load+verify → drift-check → reverse-restore sequence and writes
 * exactly one audit entry whatever the outcome. Never throws for an expected
 * failure (a guard refusal, a missing/corrupt backup, a drifted object, a halted
 * restore); the outcome is carried on the returned `RollbackResult`.
 * Infrastructure failures of the stores/clock propagate.
 */
export async function rollback(
	backupId: string,
	confirm: OperatorConfirmation,
	deps: RollbackDeps,
): Promise<RollbackResult> {
	const clock = deps.clock ?? defaultClock
	const startedAt = clock()
	const writeDeadline =
		deps.withWriteDeadline ?? ((work) => deadline(work, DEFAULT_WRITE_DEADLINE_MS, "restore write/readback"))

	// --- Guard: confirmation present + a backup target (operator, 22.7) --------
	// The capturedAt match is checked after the backup loads (it names the
	// Route_Backup by its capture time). Operator presence and the target KIND
	// are checked up front so a malformed confirmation never reaches a store.
	const confirmShapeError = checkConfirmationShape(confirm)
	if (confirmShapeError) {
		return abort(backupId, confirm.instanceId, undefined, startedAt, clock, deps, confirmShapeError)
	}

	// --- Guard: instance not `retired` / undeclared (10.5), before any write ---
	// Done before touching the backup store or taking the lock: a request for a
	// retired or undeclared instance is refused outright.
	const role = deps.roles.roleOf(confirm.instanceId)
	if (role === undefined) {
		return abort(
			backupId,
			confirm.instanceId,
			undefined,
			startedAt,
			clock,
			deps,
			`the latest committed Fleet_Inventory_Revision does not declare instance '${confirm.instanceId}'; a rollback is refused`,
		)
	}
	if (role === "retired") {
		return abort(
			backupId,
			confirm.instanceId,
			undefined,
			startedAt,
			clock,
			deps,
			`instance '${confirm.instanceId}' is declared 'retired'; a rollback is refused`,
		)
	}

	// --- Guard: no concurrent apply/rollback on this instance (9.15) -----------
	if (deps.locks.has(confirm.instanceId)) {
		return abort(
			backupId,
			confirm.instanceId,
			undefined,
			startedAt,
			clock,
			deps,
			`another apply or rollback is already in progress on instance '${confirm.instanceId}'`,
		)
	}

	// --- Load + checksum-verify the Route_Backup (9.7, 9.8) --------------------
	const backup = await deps.backups.load(backupId)
	if (!backup) {
		return refuse(backupId, confirm.instanceId, undefined, undefined, startedAt, clock, deps, {
			reason: `the Route_Backup '${backupId}' is missing`,
		})
	}
	// The confirmation must name THIS backup by its capture time (22.7).
	if (confirm.target.kind === "backup" && confirm.target.capturedAt !== backup.capturedAt) {
		return abort(
			backupId,
			backup.instanceId,
			backup,
			startedAt,
			clock,
			deps,
			`the confirmation names Route_Backup capture time '${confirm.target.capturedAt}', not the backup's capture time '${backup.capturedAt}'`,
		)
	}
	if (!checksumMatches(backup)) {
		return refuse(backupId, backup.instanceId, backup.revision, backup.location, startedAt, clock, deps, {
			reason: `the Route_Backup '${backupId}' failed checksum verification`,
		})
	}

	// --- Confirm no apply-written object drifted away from BOTH values (9.8) ---
	const liveCombos = await deps.client.listCombos()
	const liveByName = new Map(liveCombos.map((c) => [c.name, c]))
	const backupByName = new Map(backup.snapshot.combos.map((c) => [c.name, c]))
	const drifted = detectDriftSinceApply(backup, liveByName, backupByName)
	if (drifted.length > 0) {
		return refuse(backupId, backup.instanceId, backup.revision, backup.location, startedAt, clock, deps, {
			drifted,
		})
	}

	// --- Restore in REVERSE write order; stop on a restore failure (9.16) ------
	// Take the lock for the write-bearing portion; always release it.
	deps.locks.add(backup.instanceId)
	try {
		return await runRestore(backup, deps, { startedAt, clock, writeDeadline, liveByName, backupByName })
	} finally {
		deps.locks.delete(backup.instanceId)
	}
}

interface RestoreContext {
	readonly startedAt: string
	readonly clock: () => string
	readonly writeDeadline: <T>(work: Promise<T>) => Promise<T>
	readonly liveByName: ReadonlyMap<string, Combo>
	readonly backupByName: ReadonlyMap<string, Combo>
}

/**
 * The guard-passing, lock-held body of a rollback: restore each apply-written
 * object that differs from its Route_Backup value, in the reverse of the apply's
 * write order, deleting objects absent from the backup (Requirement 9.5, 9.16).
 */
async function runRestore(backup: RouteBackup, deps: RollbackDeps, ctx: RestoreContext): Promise<RollbackResult> {
	const restores: RollbackRestore[] = []
	let halted = false
	let alreadyAtBackup = 0
	let wrote = false

	// `postApply` is in the apply's write order; restore in REVERSE (9.6/9.16).
	for (let i = backup.postApply.length - 1; i >= 0; i--) {
		const record = backup.postApply[i]!
		if (halted) {
			restores.push(unrestored(record, ctx.backupByName))
			continue
		}
		if (record.kind === "setting") {
			// Routing_Settings have no live read/restore surface in v1 (as apply's
			// restore sweep treats them); nothing durable to roll back.
			restores.push({ kind: "setting", id: record.id, restored: true })
			continue
		}

		const backupValue = ctx.backupByName.get(record.id)
		const live = ctx.liveByName.get(record.id)

		// Already at the backup value: no write needed (round-trip no-op, 9.10).
		if (comboEqualsBackup(live, backupValue)) {
			alreadyAtBackup += 1
			restores.push({ kind: "combo", id: record.id, restored: true })
			continue
		}

		try {
			await restoreCombo(record, live, backupValue, deps, ctx)
			wrote = true
			restores.push({ kind: "combo", id: record.id, restored: true })
		} catch (error) {
			halted = true
			restores.push({
				kind: "combo",
				id: record.id,
				restored: false,
				current: live ? redactUnknown(live) : undefined,
				backupValue: backupValue ? redactUnknown(backupValue) : undefined,
				reason: messageOf(error),
			})
		}
	}

	// `restores` is in reverse-write order; present it in that order (the order
	// restores were attempted), which is what Requirement 9.16 reporting expects.
	const endedAt = ctx.clock()
	const outcome: RollbackOutcome = halted ? "failed-unrestored" : wrote ? "succeeded" : "no-changes"
	await deps.audit.write(auditEntry(backup, outcome, ctx.startedAt, endedAt, deps.rolledBackApplyStartedAt))
	return {
		outcome,
		instanceId: backup.instanceId,
		backupId: backup.id,
		revision: backup.revision,
		startedAt: ctx.startedAt,
		endedAt,
		backupLocation: backup.location,
		restores,
		alreadyAtBackup,
	}
}

// ---------------------------------------------------------------------------
// Restore one object (Requirement 9.5, 9.16)
// ---------------------------------------------------------------------------

/**
 * Restore one combo to its Route_Backup value within the deadline, reading it
 * back and comparing to the backup value (Requirement 9.5, 9.16):
 *   - absent from the backup (the apply created it) ⇒ delete it;
 *   - present in the backup ⇒ update it in place, or recreate it when the apply
 *     had deleted it (it is absent live).
 */
async function restoreCombo(
	record: PostApplyRecord,
	live: Combo | undefined,
	backupValue: Combo | undefined,
	deps: RollbackDeps,
	ctx: RestoreContext,
): Promise<void> {
	if (!backupValue) {
		// Not in the backup: the apply created it ⇒ delete it to restore.
		const omniRouteId = live?.id ?? record.omniRouteId
		if (omniRouteId !== undefined) {
			await ctx.writeDeadline(deps.client.deleteCombo(omniRouteId))
			const readback = await ctx.writeDeadline(readCombo(deps.client, omniRouteId))
			if (readback !== undefined) {
				throw new Error(`restore delete of created combo '${record.id}' did not remove it`)
			}
		}
		return
	}

	// In the backup and present live: update it in place to the backup value.
	if (live !== undefined) {
		await ctx.writeDeadline(deps.client.updateCombo(live.id, toComboInput(backupValue)))
		const readback = await ctx.writeDeadline(readCombo(deps.client, live.id))
		if (!comboEqualsBackup(readback, backupValue)) {
			throw new Error(`restore of combo '${record.id}' read back a value that differs from the Route_Backup`)
		}
		return
	}

	// In the backup but absent live (the apply deleted it) ⇒ recreate it.
	const created = await ctx.writeDeadline(deps.client.createCombo(toComboInput(backupValue)))
	const readback = await ctx.writeDeadline(readCombo(deps.client, created.id))
	if (!comboEqualsBackup(readback, backupValue)) {
		throw new Error(`restore recreate of combo '${record.id}' read back a value that differs from the Route_Backup`)
	}
}

/** A not-yet-restored object report (Requirement 9.16). */
function unrestored(record: PostApplyRecord, backupByName: ReadonlyMap<string, Combo>): RollbackRestore {
	const backupValue = backupByName.get(record.id)
	return {
		kind: record.kind,
		id: record.id,
		restored: false,
		backupValue: backupValue ? redactUnknown(backupValue) : undefined,
	}
}

/** Read one combo by its live OmniRoute id, or `undefined` when it is gone. */
async function readCombo(client: OmniRouteClient, omniRouteId: string): Promise<Combo | undefined> {
	const combos = await client.listCombos()
	return combos.find((c) => c.id === omniRouteId)
}

// ---------------------------------------------------------------------------
// Drift-since-apply detection (Requirement 9.7, 9.8)
// ---------------------------------------------------------------------------

/**
 * For every object the apply WROTE (backup.postApply), confirm its current live
 * value equals EITHER its recorded post-apply value OR its Route_Backup value.
 * An object that equals neither has drifted since the apply and the rollback
 * cannot safely proceed (Requirement 9.8); it is reported with its current,
 * recorded post-apply, and Route_Backup values (all credential-free). An object
 * that still equals one of the two is restorable. Settings have no live-read
 * surface and are not drift-checked.
 */
function detectDriftSinceApply(
	backup: RouteBackup,
	liveByName: ReadonlyMap<string, Combo>,
	backupByName: ReadonlyMap<string, Combo>,
): DriftedSinceApply[] {
	const drifted: DriftedSinceApply[] = []
	for (const record of backup.postApply) {
		if (record.kind === "setting") {
			continue
		}
		const live = liveByName.get(record.id)
		const backupValue = backupByName.get(record.id)
		const liveValue = live === undefined ? undefined : redactUnknown(live)

		// Equals the recorded post-apply value? (The apply's readback is already
		// redacted, so compare the redacted live value against it.)
		if (valuesEqualIgnoringId(liveValue, record.postApplyValue)) {
			continue
		}
		// Equals the Route_Backup value? (A rollback that has partially run, or an
		// object the operator restored by hand, is still safe to roll back.)
		if (comboEqualsBackup(live, backupValue)) {
			continue
		}
		drifted.push({
			kind: record.kind,
			id: record.id,
			current: liveValue,
			postApplyValue: record.postApplyValue,
			backupValue: backupValue ? redactUnknown(backupValue) : undefined,
		})
	}
	return drifted
}

// ---------------------------------------------------------------------------
// Guards + audit + helpers
// ---------------------------------------------------------------------------

/**
 * Validate the confirmation's shape for a rollback (Requirement 22.7): the
 * operator is present and the target identifies a Route_Backup (not a plan). The
 * capturedAt match is deferred until the backup loads. Returns a human-readable
 * cause when the shape is wrong, else `undefined`.
 */
function checkConfirmationShape(confirm: OperatorConfirmation): string | undefined {
	if (typeof confirm.operator !== "string" || confirm.operator.trim().length === 0) {
		return "the rollback confirmation names no operator"
	}
	if (confirm.target.kind !== "backup") {
		return "the confirmation does not identify a Route_Backup (its target is a Change_Plan)"
	}
	return undefined
}

/** A guard-abort result: no writes, one `aborted` audit entry (10.5, 9.15, 22.7). */
async function abort(
	backupId: string,
	instanceId: string,
	backup: RouteBackup | undefined,
	startedAt: string,
	clock: () => string,
	deps: RollbackDeps,
	reason: string,
): Promise<RollbackResult> {
	const endedAt = clock()
	await deps.audit.write(abortAuditEntry(instanceId, backup, "aborted", startedAt, endedAt))
	return {
		outcome: "aborted",
		instanceId,
		backupId,
		revision: backup?.revision ?? UNKNOWN_REVISION,
		startedAt,
		endedAt,
		backupLocation: backup?.location,
		refuseReason: reason,
	}
}

/** A refusal result (Requirement 9.8): no writes, one `refused` audit entry. */
async function refuse(
	backupId: string,
	instanceId: string,
	revision: RouteBackup["revision"] | undefined,
	backupLocation: string | undefined,
	startedAt: string,
	clock: () => string,
	deps: RollbackDeps,
	detail: { reason?: string; drifted?: readonly DriftedSinceApply[] },
): Promise<RollbackResult> {
	const endedAt = clock()
	await deps.audit.write({
		kind: "rollback",
		instanceId,
		outcome: "aborted", // the shared audit vocabulary collapses "refused" to "aborted" (refused before the first write).
		revision: revision ?? UNKNOWN_REVISION,
		startedAt,
		endedAt,
	})
	return {
		outcome: "refused",
		instanceId,
		backupId,
		revision: revision ?? UNKNOWN_REVISION,
		startedAt,
		endedAt,
		backupLocation,
		refuseReason: detail.reason,
		drifted: detail.drifted,
	}
}

/** A placeholder revision for an abort/refusal before the backup's revision is known. */
const UNKNOWN_REVISION: RouteBackup["revision"] = { commit: "unknown", uncommitted: false }

/**
 * The `ReconcilerAuditEntry` for this rollback (Requirement 8.1 shape, consumed
 * by attribution). `revision` is the backup's revision — the revision the apply
 * published and that this rollback reverses. The shared audit vocabulary knows
 * `succeeded`/`no-changes`/`failed`/`aborted`; the richer rollback outcomes map
 * onto them.
 */
function auditEntry(
	backup: RouteBackup,
	outcome: RollbackOutcome,
	startedAt: string,
	endedAt: string,
	rolledBackApplyStartedAt: string | undefined,
): ReconcilerAuditEntry {
	return {
		kind: "rollback",
		instanceId: backup.instanceId,
		outcome: toAuditOutcome(outcome),
		revision: backup.revision,
		startedAt,
		endedAt,
		rolledBackApplyStartedAt,
	}
}

/** An audit entry for a guard abort, before the backup's revision may be known. */
function abortAuditEntry(
	instanceId: string,
	backup: RouteBackup | undefined,
	outcome: RollbackOutcome,
	startedAt: string,
	endedAt: string,
): ReconcilerAuditEntry {
	return {
		kind: "rollback",
		instanceId,
		outcome: toAuditOutcome(outcome),
		revision: backup?.revision ?? UNKNOWN_REVISION,
		startedAt,
		endedAt,
	}
}

function toAuditOutcome(outcome: RollbackOutcome): ReconcilerAuditEntry["outcome"] {
	switch (outcome) {
		case "succeeded":
			return "succeeded"
		case "no-changes":
			return "no-changes"
		case "aborted":
		case "refused":
			return "aborted"
		default:
			return "failed"
	}
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return redactTokenizedSegments(error.message)
	}
	return redactTokenizedSegments(String(error))
}

// ---------------------------------------------------------------------------
// Checksum + comparison + redaction (kept in step with apply.ts)
// ---------------------------------------------------------------------------

/** A SHA-256 over the stable-serialized, redacted snapshot (Requirement 9.3). */
function checksumOf(snapshot: RouteBackup["snapshot"]): string {
	return createHash("sha256").update(stableStringify(snapshot)).digest("hex")
}

/** Re-verify a loaded backup's checksum against its own snapshot (Requirement 9.7). */
function checksumMatches(backup: RouteBackup): boolean {
	return backup.checksum === checksumOf(backup.snapshot)
}

/** Drop the OmniRoute-assigned id to form a create/update payload (ComboInput). */
function toComboInput(combo: Combo): ComboInput {
	const { id: _ignored, ...rest } = combo
	void _ignored
	return rest
}

/**
 * Does a live combo equal its Route_Backup value, ignoring the OmniRoute-assigned
 * id (ids differ across a delete→recreate)? Both are redacted before comparison
 * so the comparison matches the checksum/snapshot semantics. A live-absent object
 * equals a backup-absent object.
 */
function comboEqualsBackup(live: Combo | undefined, backupValue: Combo | undefined): boolean {
	if (live === undefined || backupValue === undefined) {
		return live === undefined && backupValue === undefined
	}
	return deepEqual(stripId(redactUnknown(live)), stripId(redactUnknown(backupValue)))
}

/** Compare two already-redacted values ignoring an `id` key (post-apply vs live). */
function valuesEqualIgnoringId(a: unknown, b: unknown): boolean {
	if (a === undefined || b === undefined) {
		return a === undefined && b === undefined
	}
	return deepEqual(stripId(a), stripId(b))
}

/** A value without its OmniRoute-assigned id (ids differ across recreate). */
function stripId(value: unknown): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const out: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (key === "id") {
				continue
			}
			out[key] = entry
		}
		return out
	}
	return value
}

/**
 * Recursively redact tokenized URL path segments from every string in a value,
 * returning a fresh, structurally-identical value (Requirement 22.5). The backup
 * is already redacted; this is applied defensively to the live snapshot and
 * every reported value so no tokenized segment can leak.
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
