// fleetctl — command handlers (task 10.1).
//
// Each handler is a plain async function that takes its arguments plus the
// injectable `CliDeps`, so task 10.2 can call them directly against a fake
// client, a scripted confirmation provider, and a captured output sink. The
// handlers return a numeric exit code (0 = success); the commander wiring in
// `index.ts` sets `process.exitCode` from it.
//
// Read-only by default (Requirement 22.1): `validate`, `compile`, `drift`,
// `plan`, `metrics`, `estimate`, and `evaluate` issue only reads. `apply` and
// `rollback` are the only writers (Requirement 22.2), and each demands the
// interactive per-invocation operator confirmation (Requirement 22.7) before any
// write. No handler ever prints a management key or any resolved secret.

import type { FleetInventory } from "@roo-code/types"

import { compile, type DesiredRouteState } from "../compile/compiler.js"
import { detectDrift } from "../reconcile/drift.js"
import { plan as buildPlan, type ChangePlan } from "../reconcile/plan.js"
import {
	apply,
	InMemoryAuditLog,
	InMemoryBackupStore,
	type ApplyDeps,
	type AuditLog,
	type BackupStore,
	type InstanceLocks,
} from "../reconcile/apply.js"
import { rollback, type InstanceRoleLookup, type RollbackDeps } from "../reconcile/rollback.js"
import type { OmniRouteClient } from "../omniroute/client.js"
import { metrics, attributorFn, type MetricsWindow } from "../observe/metrics.js"
import { Attributor, type RevisionResolver, type ReconcilerAuditEntry } from "../observe/attribution.js"
import { InMemoryObserverStore, type ObserverStore } from "../observe/copy.js"
import { estimateFreeLocalSlots, INITIAL_BASELINE_LOCAL_DEMAND } from "../evaluate/estimate.js"
import { evaluate } from "../evaluate/evaluate.js"

import {
	findInstance,
	loadInventory,
	primaryInstance,
	printViolations,
	revisionOf,
	type CliDeps,
	type ConfirmationRequest,
} from "./shared.js"

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

/** Options common to the inventory-reading commands. */
export interface InventoryCommandOptions {
	/** The Fleet_Inventory_Revision commit; marked uncommitted when absent. */
	readonly revision?: string
	/** Target one Managed_Instance (defaults to the primary). */
	readonly instance?: string
}

/** Options for the metrics/estimate/evaluate reads over an observer store. */
export interface ObserverCommandOptions extends InventoryCommandOptions {
	/**
	 * An observer store to read (injected by tests). The production CLI passes a
	 * store opened from a file path, or an empty in-memory store when none is
	 * configured; the read stays read-only either way.
	 */
	readonly store?: ObserverStore
	/** The Reconciler audit history for attribution (defaults to empty). */
	readonly audit?: readonly ReconcilerAuditEntry[]
	/** The revision resolver for attribution (defaults to the loaded inventory). */
	readonly revisionResolver?: RevisionResolver
}

/** Options for `apply`. */
export interface ApplyCommandOptions extends InventoryCommandOptions {
	/** Confirm the plan's deletions (Requirement 9.11 / 22.7). */
	readonly confirmDeletions?: boolean
	/** The shared per-instance lock registry (shared with rollback); defaults to a fresh set. */
	readonly locks?: InstanceLocks
	readonly backups?: BackupStore
	readonly audit?: AuditLog
}

/** Options for `rollback`. */
export interface RollbackCommandOptions {
	readonly instance: string
	readonly locks?: InstanceLocks
	readonly backups?: BackupStore
	readonly audit?: AuditLog
}

// ---------------------------------------------------------------------------
// validate (read-only)
// ---------------------------------------------------------------------------

/**
 * `validate <file>` — parse → adapt → validate; print violations with field
 * paths and exit non-zero on rejection (Requirement 22.1 read-only).
 */
export async function validateCommand(file: string, deps: CliDeps): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	deps.sink.out(
		`inventory accepted: ${loaded.model.instances.length} instance(s), ${loaded.model.lanes.length} lane(s), ${loaded.model.offerings.length} offering(s)`,
	)
	return 0
}

// ---------------------------------------------------------------------------
// compile (read-only)
// ---------------------------------------------------------------------------

/**
 * `compile <file>` — validate then compile; print the Desired_Route_State per
 * instance (combo count, routing-setting count, published route kinds). The
 * compiler is pure; no OmniRoute request is issued (Requirement 22.1).
 */
export async function compileCommand(
	file: string,
	options: InventoryCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const rev = revisionOf(options.revision)
	const compiled = compile(loaded.model, rev)
	if (!compiled.ok) {
		deps.sink.err(`compile failed (${compiled.failures.length} failure(s)):`)
		for (const f of compiled.failures) {
			deps.sink.err(`  [${f.code}] instance=${f.instanceId} lane=${f.laneId}: ${f.message}`)
		}
		return 1
	}
	printDesiredStates(compiled.states, deps)
	return 0
}

function printDesiredStates(states: Map<string, DesiredRouteState>, deps: CliDeps): void {
	for (const [instanceId, state] of states) {
		deps.sink.out(`instance '${instanceId}': ${state.combos.length} combo(s), ${state.routingSettings.length} routing setting(s)`)
		for (const combo of state.combos) {
			const kind = state.publishedMetadata.kinds[combo.name] ?? "unknown"
			deps.sink.out(`  ${kind.padEnd(10)} ${combo.name}`)
		}
	}
}

// ---------------------------------------------------------------------------
// drift (read-only)
// ---------------------------------------------------------------------------

/**
 * `drift <file>` — compile + detect drift of the Desired_Route_State against the
 * live instance(s) through a read-only client (Requirement 22.1 / 8.3). Prints
 * the human report. Builds one client per declared instance via the injected
 * factory; the live reads carry the management key only inside the client, never
 * through the CLI.
 */
export async function driftCommand(
	file: string,
	options: InventoryCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const rev = revisionOf(options.revision)
	const clients = buildClients(loaded.model, options.instance, deps)
	const report = await detectDrift(loaded.model, rev, clients)
	deps.sink.out(report.summary)
	return report.outcome === "failed" ? 1 : 0
}

/** One read-only client per targeted instance, keyed by instance id. */
function buildClients(
	model: FleetInventory,
	instanceId: string | undefined,
	deps: CliDeps,
): ReadonlyMap<string, OmniRouteClient> {
	const clients = new Map<string, OmniRouteClient>()
	const targets = instanceId
		? model.instances.filter((inst) => inst.id === instanceId)
		: model.instances
	for (const instance of targets) {
		clients.set(instance.id, deps.clientFactory(instance, deps.secretResolver))
	}
	return clients
}

// ---------------------------------------------------------------------------
// plan (read-only / dry-run)
// ---------------------------------------------------------------------------

/**
 * `plan <file>` — build the dry-run Change_Plan for one Managed_Instance and
 * print it (Requirement 9.1 dry-run, 22.1 read-only). `plan()` issues only reads
 * (listCombos + listConnections) and NEVER writes.
 */
export async function planCommand(
	file: string,
	options: InventoryCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const instance = targetInstance(loaded.model, options.instance, deps)
	if (!instance) {
		return 1
	}
	const rev = revisionOf(options.revision)
	const client = deps.clientFactory(instance, deps.secretResolver)
	const changePlan = await buildPlan(loaded.model, rev, instance.id, client, { clock: deps.clock })
	printChangePlan(changePlan, deps)
	return changePlan.errors.length > 0 ? 1 : 0
}

function printChangePlan(changePlan: ChangePlan, deps: CliDeps): void {
	deps.sink.out(`Change_Plan for instance '${changePlan.instanceId}'`)
	deps.sink.out(`  revision:  ${changePlan.revision.commit}${changePlan.revision.uncommitted ? " (uncommitted)" : ""}`)
	deps.sink.out(`  createdAt: ${changePlan.createdAt}`)
	deps.sink.out(`  ops:       ${changePlan.ops.length}`)
	for (const op of changePlan.ops) {
		deps.sink.out(`    ${op.op.padEnd(6)} ${op.kind.padEnd(7)} ${op.id}`)
	}
	if (changePlan.errors.length > 0) {
		deps.sink.err(`  errors (${changePlan.errors.length}):`)
		for (const e of changePlan.errors) {
			deps.sink.err(`    [${e.kind}] endpoint=${e.endpointId} provider=${e.provider}: ${e.message}`)
		}
	}
}

// ---------------------------------------------------------------------------
// apply (WRITER — Requirement 22.2, 22.7)
// ---------------------------------------------------------------------------

/**
 * `apply <file>` — the only writer besides `rollback`. Builds the dry-run plan,
 * then DEMANDS the interactive per-invocation operator confirmation
 * (Requirement 22.7) naming the instance, the plan's revision commit, and the
 * plan's createdAt, plus an explicit `--confirm-deletions` flag when the plan
 * deletes. Only after a confirmation is obtained does it call `apply`, the sole
 * write path. A declined confirmation performs NO write and exits non-zero.
 */
export async function applyCommand(
	file: string,
	options: ApplyCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const instance = targetInstance(loaded.model, options.instance, deps)
	if (!instance) {
		return 1
	}
	const rev = revisionOf(options.revision)
	const client = deps.clientFactory(instance, deps.secretResolver)

	// Build the dry-run plan first so the confirmation can name its revision and
	// createdAt (Requirement 22.7). `plan()` is read-only.
	const changePlan = await buildPlan(loaded.model, rev, instance.id, client, { clock: deps.clock })
	printChangePlan(changePlan, deps)
	if (changePlan.errors.length > 0) {
		deps.sink.err("plan has unresolved connections; refusing to apply")
		return 1
	}
	if (changePlan.ops.length === 0) {
		deps.sink.out("no changes to apply")
		return 0
	}

	const hasDeletions = changePlan.ops.some((op) => op.op === "delete")
	if (hasDeletions && !options.confirmDeletions) {
		deps.sink.err("plan contains deletions; re-run with --confirm-deletions to apply them")
		return 1
	}

	// Obtain the per-invocation operator confirmation BEFORE the first write
	// (Requirement 22.7). A declined confirmation performs no write.
	const request: ConfirmationRequest = {
		action: "apply",
		instanceId: instance.id,
		plan: { revision: changePlan.revision.commit, createdAt: changePlan.createdAt },
		deletionsRequested: options.confirmDeletions === true,
	}
	const confirmation = await deps.confirmation.confirm(request)
	if (!confirmation) {
		deps.sink.err("apply not confirmed; no write performed")
		return 1
	}

	const applyDeps: ApplyDeps = {
		client,
		backups: options.backups ?? new InMemoryBackupStore(),
		audit: options.audit ?? new InMemoryAuditLog(),
		locks: options.locks ?? new Set<string>(),
		clock: deps.clock,
		backupRetention: instance.backupRetention,
	}
	const result = await apply(changePlan, confirmation, applyDeps)
	deps.sink.out(`apply outcome: ${result.outcome}`)
	deps.sink.out(
		`  completed ${result.counts.completed} of ${result.counts.createsPlanned + result.counts.updatesPlanned + result.counts.deletesPlanned} planned write(s)`,
	)
	if (result.abortReason) {
		deps.sink.err(`  aborted: ${result.abortReason}`)
	}
	if (result.failureCause) {
		deps.sink.err(`  failure: ${result.failureCause}`)
	}
	return result.outcome === "succeeded" || result.outcome === "no-changes" ? 0 : 1
}

// ---------------------------------------------------------------------------
// rollback (WRITER — Requirement 22.2, 22.7)
// ---------------------------------------------------------------------------

/**
 * `rollback <backupId>` — the second writer. Loads the backup, then DEMANDS the
 * interactive per-invocation operator confirmation (Requirement 22.7) naming the
 * instance and the Route_Backup by its capture time (target kind `backup`).
 * Only after a confirmation is obtained does it call `rollback`. A declined
 * confirmation performs NO write.
 */
export async function rollbackCommand(
	backupId: string,
	file: string,
	options: RollbackCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const instance = findInstance(loaded.model, options.instance)
	if (!instance) {
		deps.sink.err(`inventory does not declare instance '${options.instance}'`)
		return 1
	}
	const backups = options.backups ?? new InMemoryBackupStore()
	const backup = await backups.load(backupId)
	if (!backup) {
		deps.sink.err(`no backup found with id '${backupId}'`)
		return 1
	}

	const confirmation = await deps.confirmation.confirm({
		action: "rollback",
		instanceId: instance.id,
		backup: { capturedAt: backup.capturedAt },
		deletionsRequested: false,
	})
	if (!confirmation) {
		deps.sink.err("rollback not confirmed; no write performed")
		return 1
	}

	const roles: InstanceRoleLookup = {
		roleOf: (id: string) => loaded.model.instances.find((inst) => inst.id === id)?.role,
	}
	const rollbackDeps: RollbackDeps = {
		client: deps.clientFactory(instance, deps.secretResolver),
		backups,
		audit: options.audit ?? new InMemoryAuditLog(),
		locks: options.locks ?? new Set<string>(),
		roles,
		clock: deps.clock,
	}
	const result = await rollback(backupId, confirmation, rollbackDeps)
	deps.sink.out(`rollback outcome: ${result.outcome}`)
	if (result.refuseReason) {
		deps.sink.err(`  refused: ${result.refuseReason}`)
	}
	return result.outcome === "succeeded" || result.outcome === "no-changes" ? 0 : 1
}

// ---------------------------------------------------------------------------
// metrics (read-only)
// ---------------------------------------------------------------------------

/**
 * `metrics <1h|24h|7d>` — read the body-free observer store and print the
 * metrics report (Requirement 22.1 read-only; the store is the observer's own
 * copy, never OmniRoute). Pure computation over the stored rows.
 */
export async function metricsCommand(
	windowArg: string,
	file: string,
	options: ObserverCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const window = parseWindow(windowArg, deps)
	if (!window) {
		return 1
	}
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const store = options.store ?? new InMemoryObserverStore()
	const attribute = attributorFn(
		new Attributor(options.audit ?? [], options.revisionResolver ?? resolverFor(loaded.model, options.revision)),
	)
	const report = metrics(window, {
		rows: store.all(),
		attribute,
		inventory: loaded.model,
		nowMs: Date.parse(deps.clock()),
	})
	deps.sink.out(report.human)
	return 0
}

function parseWindow(arg: string, deps: CliDeps): MetricsWindow | undefined {
	if (arg === "1h" || arg === "24h" || arg === "7d") {
		return arg
	}
	deps.sink.err(`invalid window '${arg}'; expected one of 1h, 24h, 7d`)
	return undefined
}

// ---------------------------------------------------------------------------
// estimate (read-only)
// ---------------------------------------------------------------------------

/**
 * `estimate <revision>` — run the Requirement 21 free-local-slot replay over the
 * observer store for a candidate revision and print the per-route fractions
 * (Requirement 22.1 read-only). Pure computation over the stored copy.
 */
export async function estimateCommand(
	revisionArg: string,
	file: string,
	options: ObserverCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const store = options.store ?? new InMemoryObserverStore()
	const records = store.all().map((row) => row.fields)
	const nowMs = Date.parse(deps.clock())
	const outcome = estimateFreeLocalSlots({
		inventory: loaded.model,
		revision: revisionOf(revisionArg),
		records,
		window: { startMs: nowMs - 7 * 24 * 60 * 60 * 1000, endMs: nowMs },
		localDemand: INITIAL_BASELINE_LOCAL_DEMAND,
	})
	if (!outcome.ok) {
		deps.sink.err(`estimate failed to compile revision '${revisionArg}' (${outcome.failures.length} failure(s)):`)
		for (const f of outcome.failures) {
			deps.sink.err(`  [${f.code}] instance=${f.instanceId} lane=${f.laneId}: ${f.message}`)
		}
		return 1
	}
	deps.sink.out(`estimate (revision '${revisionArg}', completeness ${outcome.estimate.completeness}):`)
	deps.sink.out(`  distinct local slots (non-embed/rerank): ${outcome.estimate.distinctLocalSlots}`)
	for (const route of outcome.estimate.routes) {
		deps.sink.out(`  ${route.route}: capacity ${route.capacity}`)
	}
	return 0
}

// ---------------------------------------------------------------------------
// evaluate (read-only)
// ---------------------------------------------------------------------------

/**
 * `evaluate <file>` — run the post-deployment Arrangement_Evaluator over the
 * observer store and audit history and print its report (Requirement 22.1
 * read-only). Pure computation over the stored copy; it recommends but never
 * performs a rollback.
 */
export async function evaluateCommand(
	file: string,
	options: ObserverCommandOptions,
	deps: CliDeps,
): Promise<number> {
	const loaded = await loadInventory(file, deps)
	if (!loaded.ok) {
		if ("parseError" in loaded) {
			deps.sink.err(loaded.parseError)
		} else {
			printViolations(deps.sink, loaded.violations)
		}
		return 1
	}
	const rev = revisionOf(options.revision)
	const store = options.store ?? new InMemoryObserverStore()
	const audit = options.audit ?? []
	const attribute = attributorFn(new Attributor(audit, options.revisionResolver ?? resolverFor(loaded.model, options.revision)))
	const nowMs = Date.parse(deps.clock())
	const report = evaluate({
		inventory: loaded.model,
		revision: rev,
		window: { startMs: nowMs - 7 * 24 * 60 * 60 * 1000, endMs: nowMs },
		audit,
		rows: store.all(),
		attribute,
	})
	deps.sink.out(report.human)
	return 0
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the target instance (by `--instance`, else the primary); report if absent. */
function targetInstance(model: FleetInventory, instanceId: string | undefined, deps: CliDeps) {
	if (instanceId) {
		const found = findInstance(model, instanceId)
		if (!found) {
			deps.sink.err(`inventory does not declare instance '${instanceId}'`)
		}
		return found
	}
	const primary = primaryInstance(model)
	if (!primary) {
		deps.sink.err("inventory declares no primary instance")
	}
	return primary
}

/**
 * A `RevisionResolver` that returns the loaded inventory for the one revision the
 * CLI knows (the loaded document). Attribution of attempts recorded under other
 * revisions returns unattributed, which is the correct read-only behavior when
 * the CLI holds only the current inventory.
 */
function resolverFor(model: FleetInventory, commit: string | undefined): RevisionResolver {
	const rev = revisionOf(commit)
	return {
		resolve: (c: string): FleetInventory | undefined => (c === rev.commit ? model : undefined),
	}
}
