// TEST DOUBLE — in-memory OmniRoute management-API fake.
//
// `FakeOmniRouteClient` implements the same `OmniRouteClient` interface as the
// HTTP client (task 4.1) over in-memory Maps of combos/connections/context
// overrides, per-connection advertised models, combo traces, and call-log
// records. Each read returns the current stored object (per-object readback),
// so the Reconciler's apply → readback → compare and rollback cycles can be
// exercised without a live OmniRoute server (Requirement 9, criteria 5 and 6 —
// tasks 9.5/9.6).
//
// This is a test utility. It is imported directly by test files (e.g. task 7.3)
// via a relative path and is intentionally NOT re-exported from the package
// barrel `index.ts`, so no test-only code ships in the production surface.
//
// Determinism: created-combo ids are assigned from a seeded counter
// (`cmb-fake-1`, `cmb-fake-2`, …) so apply/rollback round-trip assertions are
// reproducible. The seed/constructor API preloads a complete Live_Route_State
// for drift/plan/apply tests.

import type {
	AdvertisedModel,
	CallLogQuery,
	CallLogRecord,
	Combo,
	ComboInput,
	ComboTrace,
	Connection,
	ConnectionPatch,
	ContextOverride,
	ContextOverridePatch,
	OmniRouteClient,
} from "./client.js"
import { OmniRouteApiError } from "./client.js"

// ---------------------------------------------------------------------------
// Scripted-failure configuration
// ---------------------------------------------------------------------------

// The write/read operations a failure can be scripted against. These are the
// `OmniRouteClient` method names.
export type FakeOperation =
	| "listCombos"
	| "listConnections"
	| "getAdvertisedModels"
	| "getContextOverrides"
	| "getComboTrace"
	| "readCallLogs"
	| "createCombo"
	| "updateCombo"
	| "deleteCombo"
	| "patchConnection"
	| "patchContextOverrides"
	| "syncModels"

// How a scripted failure manifests:
// - `writeError`   — the operation throws an OmniRouteApiError before the store
//                    is mutated, modelling a 5xx/4xx write rejection.
// - `readbackMismatch` — the write mutates the store but the method RETURNS a
//                    value that differs from what was written, so the caller's
//                    apply readback-compare detects the mismatch. The returned
//                    object is produced by `mutate` applied to the real result.
// - `timeout`      — the operation never settles (the returned promise neither
//                    resolves nor rejects), modelling a request that exceeds the
//                    caller's 30 s readback/write deadline. An optional
//                    `rejectAfterMs` makes it reject with a timeout-style error
//                    instead, for tests that cannot await a never-settling
//                    promise.
export type FakeFailureKind = "writeError" | "readbackMismatch" | "timeout"

export interface ScriptedFailure {
	// Which operation this failure targets.
	readonly operation: FakeOperation
	readonly kind: FakeFailureKind
	// Restrict the failure to a specific object id (combo id, connection id, or
	// advertised-models connection id). When omitted the failure applies to any
	// id for the operation.
	readonly objectId?: string
	// Restrict the failure to the Nth matching call (1-based). When omitted the
	// failure applies on every matching call.
	readonly onCall?: number
	// For `writeError`: the HTTP status to report (default 500).
	readonly status?: number
	// For `readbackMismatch`: transform the real result into the mismatched
	// value the method returns. Required for `readbackMismatch`.
	readonly mutate?: (real: unknown) => unknown
	// For `timeout`: when set, reject after this many ms instead of hanging
	// forever. When omitted the promise never settles.
	readonly rejectAfterMs?: number
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export interface FakeSeed {
	readonly combos?: readonly Combo[]
	readonly connections?: readonly Connection[]
	readonly contextOverrides?: readonly ContextOverride[]
	// Advertised models keyed by connection id.
	readonly advertisedModels?: Readonly<Record<string, readonly AdvertisedModel[]>>
	// Combo traces keyed by request/trace id.
	readonly comboTraces?: Readonly<Record<string, ComboTrace>>
	readonly callLogs?: readonly CallLogRecord[]
	// Starting value for the created-combo id counter (default 1).
	readonly nextComboIdSeq?: number
	// Prefix for assigned combo ids (default "cmb-fake-").
	readonly comboIdPrefix?: string
	// When true, createCombo/updateCombo validate the payload against the LIVE
	// OmniRoute combo schema (context_length >= 1000, numeric
	// config.concurrencyPerModel, numeric config.tierRouting.defaultTier) and
	// reject a non-conforming payload exactly as the real server does (HTTP 400).
	// Default OFF so write-mechanics tests may use small sentinel context values;
	// the compiler-conformance test turns it ON to prove the compiler emits
	// live-valid payloads. (default false)
	readonly strictComboSchema?: boolean
}

// A recorded invocation, for tests that assert the fake was driven as expected
// (e.g. "no write issued by a read-only command").
export interface FakeCall {
	readonly operation: FakeOperation
	readonly objectId?: string
}

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

export class FakeOmniRouteClient implements OmniRouteClient {
	private readonly combos = new Map<string, Combo>()
	private readonly connections = new Map<string, Connection>()
	// Context overrides keyed by model id (the override's identity).
	private readonly contextOverrides = new Map<string, ContextOverride>()
	private readonly advertisedModels = new Map<string, AdvertisedModel[]>()
	private readonly comboTraces = new Map<string, ComboTrace>()
	private readonly callLogs: CallLogRecord[] = []

	private readonly failures: ScriptedFailure[] = []
	private readonly callCounts = new Map<FakeOperation, number>()
	private readonly callLog: FakeCall[] = []

	private nextComboIdSeq: number
	private readonly comboIdPrefix: string
	private readonly strictComboSchema: boolean

	constructor(seed: FakeSeed = {}) {
		for (const combo of seed.combos ?? []) this.combos.set(combo.id, deepFreeze(clone(combo)))
		for (const connection of seed.connections ?? [])
			this.connections.set(connection.id, deepFreeze(clone(connection)))
		for (const override of seed.contextOverrides ?? [])
			this.contextOverrides.set(override.model, deepFreeze(clone(override)))
		for (const [connectionId, models] of Object.entries(seed.advertisedModels ?? {}))
			this.advertisedModels.set(connectionId, models.map((m) => deepFreeze(clone(m))))
		for (const [id, trace] of Object.entries(seed.comboTraces ?? {}))
			this.comboTraces.set(id, deepFreeze(clone(trace)))
		for (const record of seed.callLogs ?? []) this.callLogs.push(deepFreeze(clone(record)))

		this.nextComboIdSeq = seed.nextComboIdSeq ?? 1
		this.comboIdPrefix = seed.comboIdPrefix ?? "cmb-fake-"
		this.strictComboSchema = seed.strictComboSchema ?? false
	}

	// --- scripted-failure control -------------------------------------------

	// Arm a scripted failure. Multiple failures may be armed; the first matching
	// (by operation, optional object id, and optional call index) applies.
	scriptFailure(failure: ScriptedFailure): this {
		if (failure.kind === "readbackMismatch" && failure.mutate === undefined) {
			throw new Error("scriptFailure: a readbackMismatch requires a `mutate` function")
		}
		this.failures.push(failure)
		return this
	}

	// Remove every armed failure.
	clearFailures(): this {
		this.failures.length = 0
		return this
	}

	// The ordered list of invocations the fake has seen, for call-site
	// assertions (defensive copy).
	calls(): FakeCall[] {
		return this.callLog.map((c) => ({ ...c }))
	}

	// --- reads ---------------------------------------------------------------

	listCombos(): Promise<Combo[]> {
		return this.run("listCombos", undefined, () => [...this.combos.values()].map(clone))
	}

	listConnections(): Promise<Connection[]> {
		return this.run("listConnections", undefined, () => [...this.connections.values()].map(clone))
	}

	getAdvertisedModels(connectionId: string): Promise<AdvertisedModel[]> {
		return this.run("getAdvertisedModels", connectionId, () =>
			(this.advertisedModels.get(connectionId) ?? []).map(clone),
		)
	}

	getContextOverrides(): Promise<ContextOverride[]> {
		return this.run("getContextOverrides", undefined, () => [...this.contextOverrides.values()].map(clone))
	}

	getComboTrace(id: string): Promise<ComboTrace> {
		return this.run("getComboTrace", id, () => {
			const trace = this.comboTraces.get(id)
			if (!trace) throw this.notFound("getComboTrace", id)
			return clone(trace)
		})
	}

	readCallLogs(params: CallLogQuery): Promise<CallLogRecord[]> {
		return this.run("readCallLogs", undefined, () => filterCallLogs(this.callLogs, params).map(clone))
	}

	// --- writes --------------------------------------------------------------

	createCombo(combo: ComboInput): Promise<Combo> {
		return this.run("createCombo", undefined, () => {
			if (this.strictComboSchema) assertValidComboPayload(combo)
			const id = `${this.comboIdPrefix}${this.nextComboIdSeq++}`
			const created: Combo = deepFreeze({ ...clone(combo), id })
			this.combos.set(id, created)
			return clone(created)
		})
	}

	updateCombo(id: string, combo: ComboInput): Promise<Combo> {
		return this.run("updateCombo", id, () => {
			if (!this.combos.has(id)) throw this.notFound("updateCombo", id)
			if (this.strictComboSchema) assertValidComboPayload(combo)
			const updated: Combo = deepFreeze({ ...clone(combo), id })
			this.combos.set(id, updated)
			return clone(updated)
		})
	}

	deleteCombo(id: string): Promise<void> {
		return this.run("deleteCombo", id, () => {
			this.combos.delete(id)
			return undefined
		})
	}

	patchConnection(id: string, patch: ConnectionPatch): Promise<Connection> {
		return this.run("patchConnection", id, () => {
			const existing = this.connections.get(id)
			if (!existing) throw this.notFound("patchConnection", id)
			const merged: Connection = deepFreeze({ ...clone(existing), ...clone(patch) })
			this.connections.set(id, merged)
			return clone(merged)
		})
	}

	patchContextOverrides(patch: ContextOverridePatch): Promise<ContextOverride[]> {
		return this.run("patchContextOverrides", undefined, () => {
			for (const upsert of patch.upserts ?? []) this.contextOverrides.set(upsert.model, deepFreeze(clone(upsert)))
			for (const model of patch.removes ?? []) this.contextOverrides.delete(model)
			return [...this.contextOverrides.values()].map(clone)
		})
	}

	syncModels(connectionId: string): Promise<void> {
		return this.run("syncModels", connectionId, () => undefined)
	}

	// --- internals -----------------------------------------------------------

	// Run an operation under the scripted-failure gate. `effect` performs the
	// real store read/mutation and returns the real result; the gate decides
	// whether to short-circuit with a scripted failure before or after it runs.
	private run<T>(operation: FakeOperation, objectId: string | undefined, effect: () => T): Promise<T> {
		const count = (this.callCounts.get(operation) ?? 0) + 1
		this.callCounts.set(operation, count)
		this.callLog.push({ operation, objectId })

		const failure = this.matchFailure(operation, objectId, count)

		if (failure?.kind === "writeError") {
			// Fail before mutating: the store is left untouched (fail-closed).
			return Promise.reject(this.apiError(operation, failure.status ?? 500))
		}

		if (failure?.kind === "timeout") {
			if (failure.rejectAfterMs !== undefined) {
				return new Promise<T>((_resolve, reject) => {
					setTimeout(
						() => reject(this.apiError(operation, 504)),
						failure.rejectAfterMs,
					)
				})
			}
			// Never settles: models a request exceeding the caller's deadline.
			return new Promise<T>(() => {})
		}

		let real: T
		try {
			real = effect()
		} catch (error) {
			return Promise.reject(error)
		}

		if (failure?.kind === "readbackMismatch") {
			// The write landed in the store, but the method returns a value that
			// differs from what was written so the caller's readback-compare fails.
			const mismatched = failure.mutate ? failure.mutate(real) : real
			return Promise.resolve(mismatched as T)
		}

		return Promise.resolve(real)
	}

	// Find the first armed failure matching this call. A failure with no
	// `objectId` matches any id; a failure with no `onCall` matches every call.
	private matchFailure(
		operation: FakeOperation,
		objectId: string | undefined,
		count: number,
	): ScriptedFailure | undefined {
		return this.failures.find(
			(f) =>
				f.operation === operation &&
				(f.objectId === undefined || f.objectId === objectId) &&
				(f.onCall === undefined || f.onCall === count),
		)
	}

	private apiError(operation: FakeOperation, status: number): OmniRouteApiError {
		return new OmniRouteApiError({
			operation,
			method: writeMethod(operation),
			status,
			redactedUrl: `fake://omniroute/${operation}`,
			redactedBody: `scripted ${status} failure`,
		})
	}

	private notFound(operation: FakeOperation, id: string): OmniRouteApiError {
		return new OmniRouteApiError({
			operation,
			method: writeMethod(operation),
			status: 404,
			redactedUrl: `fake://omniroute/${operation}/${encodeURIComponent(id)}`,
			redactedBody: "not found",
		})
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A structural clone so stored objects and returned objects never share
// references: a caller mutating a returned value cannot corrupt the store, and
// the per-object readback always reflects only what the store holds.
const clone = <T>(value: T): T => structuredClone(value)

// Deep-freeze a stored object so an accidental in-place mutation of the store
// surfaces loudly in tests rather than silently corrupting state.
const deepFreeze = <T>(value: T): T => {
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value as Record<string, unknown>)) {
			deepFreeze((value as Record<string, unknown>)[key])
		}
		Object.freeze(value)
	}
	return value
}

// The HTTP method the real client uses for an operation, so a scripted error
// carries a representative method for assertions/log parity.
/**
 * Validate a combo payload the way the LIVE OmniRoute `/api/combos` endpoint does,
 * so the in-memory fake rejects exactly what the real server rejects (it returned
 * HTTP 400 for `context_length < 1000`, a non-numeric `config.concurrencyPerModel`,
 * and a missing `config.tierRouting.defaultTier`). Keeping the fake in lockstep
 * with the live schema is what makes the compiler's payload-shape fixes
 * regression-testable without a live cluster. Throws a plain Error (surfaced as a
 * failed write) listing the offending fields; a valid payload passes silently.
 */
function assertValidComboPayload(combo: ComboInput): void {
	const problems: string[] = []
	if (typeof combo.context_length !== "number" || combo.context_length < 1000) {
		problems.push(`context_length: expected number >= 1000, got ${String(combo.context_length)}`)
	}
	const config = (combo.config ?? {}) as Record<string, unknown>
	if ("concurrencyPerModel" in config) {
		const c = config.concurrencyPerModel
		if (typeof c !== "number" || !Number.isFinite(c)) {
			problems.push(`config.concurrencyPerModel: expected number, got ${String(c)}`)
		}
	}
	const tierRouting = config.tierRouting as Record<string, unknown> | undefined
	if (tierRouting !== undefined) {
		if (typeof tierRouting.defaultTier !== "number") {
			problems.push(`config.tierRouting.defaultTier: expected number, got ${String(tierRouting.defaultTier)}`)
		}
	}
	if (problems.length > 0) {
		throw new Error(`Invalid combo payload '${combo.name}': ${problems.join("; ")}`)
	}
}

const writeMethod = (operation: FakeOperation): string => {
	switch (operation) {
		case "createCombo":
		case "syncModels":
			return "POST"
		case "updateCombo":
			return "PUT"
		case "deleteCombo":
			return "DELETE"
		case "patchConnection":
		case "patchContextOverrides":
			return "PATCH"
		default:
			return "GET"
	}
}

// Apply the same filtering the HTTP call-log query expresses: exact matches on
// the provided fields, then offset/limit windowing.
const filterCallLogs = (records: readonly CallLogRecord[], query: CallLogQuery): CallLogRecord[] => {
	let out = records.filter((r) => {
		if (query.status !== undefined && r.status !== query.status) return false
		if (query.model !== undefined && r.model !== query.model) return false
		if (query.provider !== undefined && r.provider !== query.provider) return false
		if (query.combo !== undefined && r.comboName !== query.combo) return false
		if (query.correlationId !== undefined && r.correlationId !== query.correlationId) return false
		return true
	})
	const offset = query.offset ?? 0
	if (offset > 0) out = out.slice(offset)
	if (query.limit !== undefined) out = out.slice(0, query.limit)
	return out
}
