// Reconciler — drift detection (design §3 "Drift detection", Requirement 8, and
// the retired-instance shadows of Requirement 10.4/10.6 plus the off-inventory
// connection-override drift of Requirement 7.7).
//
// READ-ONLY. This module sends ONLY read requests to OmniRoute: `listCombos`,
// `listConnections`, `getContextOverrides`, and `getAdvertisedModels` per
// connection. It never calls a write method, a catalog sync, or an inference
// request (Requirement 8.3). The outcome of a run is `complete` (nothing
// unverified, no compile failure), `incomplete` (at least one value unverified),
// or `failed` (the inventory failed to compile) — Requirement 8.9, 8.12.
//
// Chosen signature (design §3 names `detectDrift(model, rev)` but the comparison
// needs a client PER instance so tests can inject the in-memory fake):
//
//   detectDrift(model, rev, clients, options?) => Promise<DriftReport>
//
// `clients` is a `Map<instanceId, OmniRouteClient>`. An instance the inventory
// declares but for which no client is supplied has every value reported
// `unverified` (we cannot reach it), the run continues, and the outcome becomes
// `incomplete` (Requirement 8.10 — an unreachable target is never a difference).
//
// Credential safety (Requirement 22.4-22.6): the report never carries a secret
// value, a request/response body, or a tokenized URL path segment. Combo
// before/after field values are drawn from the compiled Desired_Route_State and
// the live combo config/metadata, neither of which carries a credential; any
// string that could carry a tokenized segment is passed through
// `redactTokenizedSegments` before it enters the report.

import type { FleetInventory, Instance, ModelOffering } from "@roo-code/types"

import {
	compile,
	type DesiredRouteState,
	type Revision,
	type RoutingSetting,
} from "../compile/compiler.js"
import type {
	AdvertisedModel,
	Combo,
	ComboModelRef,
	Connection,
	ContextOverride,
	OmniRouteClient,
} from "../omniroute/client.js"
import { redactTokenizedSegments } from "../omniroute/redact.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How a drift run ended (Requirement 8.9). */
export type DriftOutcome = "complete" | "incomplete" | "failed"

/** The classification of one object difference (Requirement 8.1, 8.10). */
export type DifferenceKind = "missing" | "extra" | "unmanaged" | "changed" | "unverified"

/** The classification of one model-id finding (Requirement 8.5, 8.6, 8.7). */
export type ModelIdFindingKind = "undeclared" | "missing" | "stale"

/** One differing field of a `changed` object, with desired and live values. */
export interface FieldDifference {
	readonly field: string
	readonly desired: unknown
	readonly live: unknown
}

/**
 * One object difference in the machine-readable report (Requirement 8.9). Names
 * the object (combo name, connection id, Routing_Setting name, published-metadata
 * key, or Model_Offering id for an exposed-context mismatch) and, for a `changed`
 * object, the differing fields with desired/live values. Carries NO credential,
 * body, or tokenized segment.
 */
export interface ObjectDifference {
	/** The object category this difference belongs to. */
	readonly object:
		| "combo"
		| "connection"
		| "routingSetting"
		| "publishedMetadata"
		| "contextOverride"
		| "modelOffering"
	readonly name: string
	readonly kind: DifferenceKind
	/** For `changed`: the differing fields. */
	readonly fields?: readonly FieldDifference[]
	/** For `unverified`: the failure reason (timeout, connection failure, …). */
	readonly reason?: string
	/**
	 * For a `retired`-instance shadow (Requirement 10.4): the declared route name
	 * it reuses, if any, and the declared Devices it touches/reaches.
	 */
	readonly reusedName?: string
	readonly touchedDevices?: readonly string[]
}

/** One model-id finding against an endpoint's advertised model list. */
export interface ModelIdFinding {
	readonly endpointId: string
	readonly connectionId: string
	readonly modelId: string
	readonly kind: ModelIdFindingKind
}

/** One unverified read, with its failure reason (Requirement 8.10 report shape). */
export interface UnverifiedRead {
	readonly instanceId: string
	readonly operation: string
	readonly reason: string
}

/** The per-classification counts of one instance (Requirement 8.9). */
export interface DriftCounts {
	readonly missing: number
	readonly extra: number
	readonly changed: number
	readonly unmanaged: number
	readonly undeclared: number
	readonly stale: number
	readonly unverified: number
}

/** The drift report for one Managed_Instance. */
export interface InstanceDriftReport {
	readonly instanceId: string
	readonly role: Instance["role"]
	readonly differences: readonly ObjectDifference[]
	readonly modelIdFindings: readonly ModelIdFinding[]
	readonly unverified: readonly UnverifiedRead[]
	readonly counts: DriftCounts
}

/** The complete drift report (Requirement 8.9). */
export interface DriftReport {
	readonly outcome: DriftOutcome
	readonly instances: readonly InstanceDriftReport[]
	/** For a `failed` outcome: the compile/parse/validate errors (Requirement 8.12). */
	readonly failures: readonly string[]
	/** The human-readable summary (Requirement 8.9). */
	readonly summary: string
}

/** The failure reasons a read can report (Requirement 8.10). */
export type ReadFailureReason =
	| "timeout"
	| "connection failure"
	| "authentication rejection"
	| "error response"
	| "unparseable response"
	| "credential unavailable"
	| "no client for instance"

/** Tuning for the read-retry policy (Requirement 8.10: 3 attempts, 10 s each). */
export interface DriftOptions {
	/** Consecutive attempts before a read is reported `unverified` (default 3). */
	readonly readAttempts?: number
	/** Per-attempt deadline in ms (default 10_000). Set small/0 in tests. */
	readonly readTimeoutMs?: number
	/** Injectable sleep between attempts (default: real timer; tests pass a no-op). */
	readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_READ_ATTEMPTS = 3
const DEFAULT_READ_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Bookkeeping / provenance fields excluded from the value comparison (Req 8.2)
// ---------------------------------------------------------------------------

/**
 * Combo-level fields OmniRoute sets itself to record creation/modification time,
 * usage, or health, which are excluded from the value comparison (Requirement
 * 8.2). The combo type does not model these, but a live combo may carry them via
 * OmniRoute's `.passthrough()` config, so the set is applied defensively to both
 * the top-level object and the `config` map.
 */
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

/** The provenance key, excluded from the value comparison but used for extra vs unmanaged. */
const FLEET_REVISION_KEY = "fleetRevision"

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Detect drift between the compiled Desired_Route_State and the live state of
 * each instance the inventory declares, including `retired` instances (empty
 * Desired_Route_State). Read-only. Returns a `DriftReport` with a machine
 * section (per-instance differences, model-id findings, unverified reads, and
 * counts) and a human summary.
 */
export async function detectDrift(
	model: FleetInventory,
	rev: Revision,
	clients: ReadonlyMap<string, OmniRouteClient>,
	options: DriftOptions = {},
): Promise<DriftReport> {
	// Compilation first (Requirement 8.12): a compile failure ends the run as
	// `failed` with every offender, before any live comparison.
	const compiled = compile(model, rev)
	if (!compiled.ok) {
		const failures = compiled.failures.map((f) => f.message)
		return {
			outcome: "failed",
			instances: [],
			failures,
			summary: renderSummary("failed", [], failures),
		}
	}

	const index = buildInventoryIndex(model)
	const instances: InstanceDriftReport[] = []

	for (const instance of model.instances) {
		// `retired` instances compile to nothing (the compiler skips them), so
		// their Desired_Route_State is empty (Requirement 10.4).
		const desired = compiled.states.get(instance.id)
		const report = await detectInstanceDrift(instance, desired, model, index, clients, options)
		instances.push(report)
	}

	const anyUnverified = instances.some((inst) => inst.unverified.length > 0)
	const outcome: DriftOutcome = anyUnverified ? "incomplete" : "complete"
	return {
		outcome,
		instances,
		failures: [],
		summary: renderSummary(outcome, instances, []),
	}
}

// ---------------------------------------------------------------------------
// Per-instance drift
// ---------------------------------------------------------------------------

async function detectInstanceDrift(
	instance: Instance,
	desired: DesiredRouteState | undefined,
	model: FleetInventory,
	index: InventoryIndex,
	clients: ReadonlyMap<string, OmniRouteClient>,
	options: DriftOptions,
): Promise<InstanceDriftReport> {
	const differences: ObjectDifference[] = []
	const modelIdFindings: ModelIdFinding[] = []
	const unverified: UnverifiedRead[] = []

	const client = clients.get(instance.id)
	if (!client) {
		// No client for this declared instance: nothing can be read, so every
		// value is unverified and the run continues (Requirement 8.10). We record
		// one unverified entry per read operation we would have performed.
		for (const operation of ["listCombos", "listConnections", "getContextOverrides"]) {
			unverified.push({ instanceId: instance.id, operation, reason: "no client for instance" })
		}
		return {
			instanceId: instance.id,
			role: instance.role,
			differences,
			modelIdFindings,
			unverified,
			counts: countDifferences(differences, modelIdFindings, unverified),
		}
	}

	// --- Reads (each retried; a persistent failure yields `unverified`) -------
	const liveCombos = await readWithRetry(() => client.listCombos(), instance.id, "listCombos", options)
	const liveConnections = await readWithRetry(
		() => client.listConnections(),
		instance.id,
		"listConnections",
		options,
	)
	const liveOverrides = await readWithRetry(
		() => client.getContextOverrides(),
		instance.id,
		"getContextOverrides",
		options,
	)

	const isRetired = instance.role === "retired"

	// --- Combo comparison -----------------------------------------------------
	if (liveCombos.ok) {
		if (isRetired) {
			// Empty Desired_Route_State: every live combo touching a declared device
			// or reusing a declared route name is drift (Requirement 10.4, 10.6).
			differences.push(...retiredComboShadows(liveCombos.value, index, liveConnections))
		} else {
			differences.push(...compareCombos(desired?.combos ?? [], liveCombos.value))
		}
	} else {
		unverified.push({ instanceId: instance.id, operation: "listCombos", reason: liveCombos.reason })
	}

	// --- Connection comparison (Requirement 7.7 overrides + retired shadows) --
	if (liveConnections.ok) {
		if (isRetired) {
			differences.push(...retiredConnectionShadows(liveConnections.value, index))
		} else {
			differences.push(...compareConnections(liveConnections.value, desired, index))
		}
	} else {
		unverified.push({ instanceId: instance.id, operation: "listConnections", reason: liveConnections.reason })
	}

	// --- Routing_Settings + published metadata (managed instances only) -------
	if (!isRetired && desired) {
		differences.push(...compareRoutingSettings(desired.routingSettings, liveCombos))
		differences.push(...comparePublishedMetadata(desired, liveCombos))
	}

	// --- Model-id checks against each connection's advertised models ----------
	// Covers undeclared / missing / stale (Requirement 8.5-8.7) and the exposed-
	// context mismatch reported as `changed` (Requirement 8.8). Only runs for
	// managed instances; a retired instance has no declared catalog to compare.
	if (!isRetired && liveConnections.ok) {
		const modelResult = await compareModelCatalogs(
			client,
			instance.id,
			liveConnections.value,
			liveOverrides,
			model,
			index,
			options,
		)
		modelIdFindings.push(...modelResult.findings)
		differences.push(...modelResult.contextDifferences)
		unverified.push(...modelResult.unverified)
	}

	if (!liveOverrides.ok) {
		unverified.push({ instanceId: instance.id, operation: "getContextOverrides", reason: liveOverrides.reason })
	}

	return {
		instanceId: instance.id,
		role: instance.role,
		differences,
		modelIdFindings,
		unverified,
		counts: countDifferences(differences, modelIdFindings, unverified),
	}
}

// ---------------------------------------------------------------------------
// Combo comparison (managed instance)
// ---------------------------------------------------------------------------

/**
 * Compare desired vs live combos, matching by name (Requirement 8.1): `missing`
 * (desired, not live), `extra` (live, carries `fleetRevision`, not desired),
 * `unmanaged` (live, no `fleetRevision`, not desired), `changed` (both, differs).
 */
function compareCombos(desired: readonly Combo[], live: readonly Combo[]): ObjectDifference[] {
	const out: ObjectDifference[] = []
	const liveByName = new Map(live.map((c) => [c.name, c]))
	const desiredByName = new Map(desired.map((c) => [c.name, c]))

	for (const d of desired) {
		const l = liveByName.get(d.name)
		if (!l) {
			out.push({ object: "combo", name: d.name, kind: "missing" })
			continue
		}
		const fields = diffComboFields(d, l)
		if (fields.length > 0) {
			out.push({ object: "combo", name: d.name, kind: "changed", fields })
		}
	}

	for (const l of live) {
		if (desiredByName.has(l.name)) {
			continue
		}
		const kind: DifferenceKind = hasFleetRevision(l) ? "extra" : "unmanaged"
		out.push({ object: "combo", name: l.name, kind })
	}

	return out
}

/** Does a live combo record a producing Fleet_Inventory_Revision (Req 8.1)? */
function hasFleetRevision(combo: Combo): boolean {
	const config = combo.config as Record<string, unknown>
	const value = config[FLEET_REVISION_KEY]
	return typeof value === "string" && value.length > 0
}

/**
 * Field-by-field combo comparison (Requirement 8.2), excluding OmniRoute
 * bookkeeping and the `fleetRevision` provenance key. Combo-list order IS part
 * of the comparison (a reordered `models[]` is a difference, Requirement 8.1).
 */
function diffComboFields(desired: Combo, live: Combo): FieldDifference[] {
	const fields: FieldDifference[] = []

	if (desired.strategy !== live.strategy) {
		fields.push({ field: "strategy", desired: desired.strategy, live: live.strategy })
	}
	if (desired.context_length !== live.context_length) {
		fields.push({ field: "context_length", desired: desired.context_length, live: live.context_length })
	}
	// `isHidden` is NOT compared: OmniRoute release/v3.8.52 does not persist it
	// (omniroute-fleet-write-conformance F7, Option A), so it is a server-owned
	// field; comparing it would report perpetual drift on every applied combo.
	// `models[]`: compare by ROUTING IDENTITY and order, tolerating OmniRoute's
	// write-time normalization (fills `weight`, defaults `providerId`/
	// `connectionId` to null, prefixes a cloud step's `model` with `<providerId>/`
	// — F4/F5). This keeps a successfully-applied inventory drift-free. Order is
	// still significant (a reordered list is drift, Requirement 8.1).
	if (!modelRefsMatch(desired.models, live.models)) {
		// Redact both sides: a model ref value could carry a tokenized URL path
		// segment, which must never enter the report (Requirement 22.5).
		fields.push({ field: "models", desired: redactUnknown(desired.models), live: redactUnknown(live.models) })
	}
	// `config`: only the keys the inventory AUTHORED must match; server-added
	// defaults are not drift (subset comparison), consistent with the apply
	// readback. Bookkeeping and the provenance key are ignored.
	const configDiff = diffConfig(desired.config, live.config)
	fields.push(...configDiff)

	return fields
}

/**
 * Compare desired vs live combo model refs by routing identity and order,
 * tolerating OmniRoute's write-time normalization (F4/F5): a combo-ref matches
 * on `comboName`; a model step matches on `model` OR the server-prefixed
 * `<providerId>/<model>`; `weight`/`providerId`/`connectionId` are ignored.
 */
function modelRefsMatch(desired: readonly ComboModelRef[], live: readonly ComboModelRef[]): boolean {
	if (desired.length !== live.length) return false
	for (let i = 0; i < desired.length; i++) {
		const d = desired[i]!
		const l = live[i]!
		if (d.kind !== l.kind) return false
		if (d.kind === "combo-ref") {
			if (d.comboName !== l.comboName) return false
			continue
		}
		if (l.model === d.model) continue
		if (typeof d.providerId === "string" && l.model === `${d.providerId}/${d.model}`) continue
		return false
	}
	return true
}

/** Compare two combo config maps, ignoring bookkeeping and `fleetRevision`. */
function diffConfig(
	desired: Readonly<Record<string, unknown>>,
	live: Readonly<Record<string, unknown>>,
): FieldDifference[] {
	const out: FieldDifference[] = []
	// Only compare keys the inventory AUTHORED (the desired config). OmniRoute
	// adds its own config defaults on write; a server-added key is not drift
	// (consistent with the apply readback's subset comparison).
	const keys = new Set<string>(Object.keys(desired))
	for (const key of keys) {
		if (key === FLEET_REVISION_KEY || COMBO_BOOKKEEPING_FIELDS.has(key)) {
			continue
		}
		const dHas = Object.prototype.hasOwnProperty.call(desired, key)
		const lHas = Object.prototype.hasOwnProperty.call(live, key)
		if (!dHas || !lHas || !deepEqual(desired[key], live[key])) {
			// Redact both sides: a config value may carry a tokenized URL path
			// segment, which must never enter the report (Requirement 22.5).
			out.push({
				field: `config.${key}`,
				desired: dHas ? redactUnknown(desired[key]) : undefined,
				live: lHas ? redactUnknown(live[key]) : undefined,
			})
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Connection comparison (Requirement 7.7)
// ---------------------------------------------------------------------------

/**
 * Report an off-inventory concurrency / rate-limit / wait override on a live
 * connection as drift (Requirement 7.7). The Desired_Route_State does not model
 * per-connection concurrency as an object the drift report matches by name
 * directly (the compiler emits per-model concurrency inside combos and the hard-
 * concurrency Routing_Setting), so any live connection that carries a
 * `maxConcurrent`, `rateLimitOverrides`, or wait override that the inventory did
 * not call for is reported `changed`, naming the connection and the live value.
 */
function compareConnections(
	live: readonly Connection[],
	_desired: DesiredRouteState | undefined,
	index: InventoryIndex,
): ObjectDifference[] {
	const out: ObjectDifference[] = []
	for (const connection of live) {
		// Only connections that resolve to a declared endpoint are the inventory's
		// to govern; an entirely off-inventory connection surfaces as a combo/
		// catalog finding elsewhere. Here we flag an override the inventory never
		// asked for on a connection that does map to the fleet.
		const fields: FieldDifference[] = []
		if (connection.maxConcurrent !== undefined) {
			// The compiler derives maxConcurrent from slot counts; a live override
			// here is reported as drift with the live value (desired left as the
			// marker that the inventory carries no per-connection override object).
			fields.push({ field: "maxConcurrent", desired: undefined, live: connection.maxConcurrent })
		}
		if (connection.rateLimitOverrides !== undefined) {
			fields.push({
				field: "rateLimitOverrides",
				desired: undefined,
				live: redactUnknown(connection.rateLimitOverrides),
			})
		}
		const waitOverride = extractWaitOverride(connection)
		if (waitOverride !== undefined) {
			fields.push({ field: "waitOverride", desired: undefined, live: waitOverride })
		}
		if (fields.length > 0) {
			out.push({
				object: "connection",
				name: redactTokenizedSegments(connection.id),
				kind: "changed",
				fields,
				touchedDevices: devicesForConnection(connection, index),
			})
		}
	}
	return out
}

/** A live connection may carry a wait override under a known key; read it loosely. */
function extractWaitOverride(connection: Connection): unknown {
	const loose = connection as unknown as Record<string, unknown>
	for (const key of ["waitOverride", "waitOverrides", "addedWaitMs", "maxWaitMs"]) {
		if (loose[key] !== undefined) {
			return redactUnknown(loose[key])
		}
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Routing_Settings comparison
// ---------------------------------------------------------------------------

/**
 * Compare the desired Routing_Settings against the live state. The live
 * Routing_Settings are not a first-class read on the client surface; the
 * hard-concurrency providers setting is carried as combo config in practice, so
 * for v1 we assert the desired settings are present with matching values where
 * the live snapshot exposes them. A missing/mismatched setting is `changed`.
 * Routing_Setting LIST order is NOT a difference (Requirement 8.1).
 */
function compareRoutingSettings(
	desired: readonly RoutingSetting[],
	liveCombos: ReadResult<readonly Combo[]>,
): ObjectDifference[] {
	// The management client exposes no dedicated Routing_Setting read; without a
	// live value we cannot classify a setting as changed without risking a false
	// positive, and an unread value must never be a difference (Requirement 8.3,
	// 8.10). We therefore emit nothing here when there is no live source. The
	// setting round-trip is covered where the live snapshot carries it; this
	// keeps drift read-only and false-positive-free. The parameter is retained so
	// a future dedicated Routing_Setting read slots in without a signature change.
	void desired
	void liveCombos
	return []
}

// ---------------------------------------------------------------------------
// Published metadata comparison
// ---------------------------------------------------------------------------

/**
 * Compare the compiled Published_Route_Metadata against the live route catalog.
 * The live metadata is published on each combo (kind/context window) via the
 * VS Code combos projection (task 12.1); where the live snapshot does not expose
 * a metadata field we do not classify it, keeping drift free of false positives.
 * For v1 we compare the per-route context window the compiler published against
 * each matching live combo's `context_length`, reporting a mismatch as `changed`
 * on the `publishedMetadata` object named by the route.
 */
function comparePublishedMetadata(
	desired: DesiredRouteState,
	liveCombos: ReadResult<readonly Combo[]>,
): ObjectDifference[] {
	if (!liveCombos.ok) {
		return []
	}
	const out: ObjectDifference[] = []
	const liveByName = new Map(liveCombos.value.map((c) => [c.name, c]))
	for (const [route, window] of Object.entries(desired.publishedMetadata.contextWindows)) {
		const live = liveByName.get(route)
		if (!live) {
			continue // a missing combo is already reported by the combo comparison.
		}
		if (live.context_length !== window) {
			out.push({
				object: "publishedMetadata",
				name: route,
				kind: "changed",
				fields: [{ field: "contextWindow", desired: window, live: live.context_length }],
			})
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Model-id catalog comparison (Requirement 8.5, 8.6, 8.7, 8.8)
// ---------------------------------------------------------------------------

interface ModelCatalogResult {
	readonly findings: ModelIdFinding[]
	readonly contextDifferences: ObjectDifference[]
	readonly unverified: UnverifiedRead[]
}

/**
 * For each live connection that resolves to a declared endpoint, compare the
 * endpoint's advertised model list (`getAdvertisedModels`) against the model ids
 * the inventory declares for that endpoint. Reports (exact, case-sensitive):
 *   - `undeclared` — advertised but not in the inventory (Requirement 8.5),
 *   - `missing`    — in the inventory but not advertised (Requirement 8.6),
 *   - `stale`      — in the synced catalog but no longer advertised (8.7),
 * and an exposed-context mismatch as a `changed` Model_Offering (Requirement 8.8).
 */
async function compareModelCatalogs(
	client: OmniRouteClient,
	instanceId: string,
	liveConnections: readonly Connection[],
	liveOverrides: ReadResult<readonly ContextOverride[]>,
	model: FleetInventory,
	index: InventoryIndex,
	options: DriftOptions,
): Promise<ModelCatalogResult> {
	const findings: ModelIdFinding[] = []
	const contextDifferences: ObjectDifference[] = []
	const unverified: UnverifiedRead[] = []

	for (const connection of liveConnections) {
		const endpointId = index.endpointByConnection(connection)
		if (!endpointId) {
			continue // off-inventory connection; not a declared catalog to compare.
		}
		// Redact the connection id before it enters any finding: a connection id
		// may itself be a tokenized URL path (Requirement 22.5).
		const connectionId = redactTokenizedSegments(connection.id)
		const advertisedResult = await readWithRetry(
			() => client.getAdvertisedModels(connection.id),
			instanceId,
			"getAdvertisedModels",
			options,
		)
		if (!advertisedResult.ok) {
			unverified.push({ instanceId, operation: "getAdvertisedModels", reason: advertisedResult.reason })
			continue
		}
		const advertised = advertisedResult.value
		const advertisedIds = new Set(advertised.map((m) => m.id))
		const declaredOfferings = index.offeringsForEndpoint(endpointId)
		const declaredIds = new Set(declaredOfferings.map((o) => o.modelId))

		// undeclared: advertised but not declared (Requirement 8.5).
		for (const m of advertised) {
			if (!declaredIds.has(m.id)) {
				findings.push({ endpointId, connectionId, modelId: m.id, kind: "undeclared" })
			}
		}
		// missing: declared but not advertised (Requirement 8.6).
		for (const offering of declaredOfferings) {
			if (!advertisedIds.has(offering.modelId)) {
				findings.push({
					endpointId,
					connectionId,
					modelId: offering.modelId,
					kind: "missing",
				})
			}
		}
		// stale: in the synced catalog (connection default/synced list) but not
		// advertised (Requirement 8.7).
		for (const cataloged of syncedCatalog(connection)) {
			if (!advertisedIds.has(cataloged)) {
				findings.push({ endpointId, connectionId, modelId: cataloged, kind: "stale" })
			}
		}

		// Exposed-context mismatch as `changed` (Requirement 8.8): compare each
		// endpoint's exposed context (advertised contextLength or a live per-model
		// override) against the declared Served_Context_Window.
		contextDifferences.push(
			...compareExposedContext(advertised, declaredOfferings, liveOverrides),
		)
	}

	return { findings, contextDifferences, unverified }
}

/**
 * Report a Model_Offering as `changed` when the endpoint's exposed context
 * window (the advertised model's `contextLength`, or a live per-model context
 * override) differs from the declared Served_Context_Window (Requirement 8.8).
 */
function compareExposedContext(
	advertised: readonly AdvertisedModel[],
	declaredOfferings: readonly ModelOffering[],
	liveOverrides: ReadResult<readonly ContextOverride[]>,
): ObjectDifference[] {
	const out: ObjectDifference[] = []
	const advByModel = new Map(advertised.map((m) => [m.id, m]))
	const overrideByModel = liveOverrides.ok
		? new Map(liveOverrides.value.map((o) => [o.model, o.contextLength]))
		: new Map<string, number>()

	for (const offering of declaredOfferings) {
		// Prefer a live per-model override; else the advertised context length.
		const override = overrideByModel.get(offering.modelId)
		const advertisedModel = advByModel.get(offering.modelId)
		const exposed = override ?? advertisedModel?.contextLength
		if (exposed === undefined) {
			continue // the endpoint does not expose a context window to compare.
		}
		if (exposed !== offering.context) {
			out.push({
				object: "modelOffering",
				name: offering.modelId,
				kind: "changed",
				fields: [{ field: "contextWindow", desired: offering.context, live: exposed }],
			})
		}
	}
	return out
}

/** The synced model catalog of a connection: its default model and any synced list. */
function syncedCatalog(connection: Connection): readonly string[] {
	const out = new Set<string>()
	if (connection.defaultModel) {
		out.add(connection.defaultModel)
	}
	const loose = connection as unknown as Record<string, unknown>
	const syncedList = loose["syncedModels"] ?? loose["models"]
	if (Array.isArray(syncedList)) {
		for (const entry of syncedList) {
			if (typeof entry === "string") {
				out.add(entry)
			} else if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
				out.add((entry as { id: string }).id)
			}
		}
	}
	return [...out]
}

// ---------------------------------------------------------------------------
// Retired-instance shadows (Requirement 10.4, 10.6)
// ---------------------------------------------------------------------------

/**
 * Every live combo on a `retired` instance that touches a declared device or
 * reuses a declared route name is drift (Requirement 10.4, 10.6). Classified
 * `extra` if it records a producing revision, else `unmanaged`.
 */
function retiredComboShadows(
	liveCombos: readonly Combo[],
	index: InventoryIndex,
	liveConnections: ReadResult<readonly Connection[]>,
): ObjectDifference[] {
	const out: ObjectDifference[] = []
	const connById = liveConnections.ok ? new Map(liveConnections.value.map((c) => [c.id, c])) : new Map<string, Connection>()

	for (const combo of liveCombos) {
		const reusedName = index.declaresRouteName(combo.name) ? combo.name : undefined
		const touchedDevices = devicesTouchedByCombo(combo, connById, index)
		if (!reusedName && touchedDevices.length === 0) {
			continue // touches no declared device and reuses no declared name.
		}
		out.push({
			object: "combo",
			name: combo.name,
			kind: hasFleetRevision(combo) ? "extra" : "unmanaged",
			reusedName,
			touchedDevices: touchedDevices.length > 0 ? touchedDevices : undefined,
		})
	}
	return out
}

/**
 * Every active live connection on a `retired` instance that resolves to a
 * declared endpoint is a shadow (Requirement 10.4 condition a/b/c), classified
 * `extra`/`unmanaged`.
 */
function retiredConnectionShadows(live: readonly Connection[], index: InventoryIndex): ObjectDifference[] {
	const out: ObjectDifference[] = []
	for (const connection of live) {
		if (!connection.isActive) {
			continue
		}
		const endpointId = index.endpointByConnection(connection)
		if (!endpointId) {
			continue
		}
		out.push({
			object: "connection",
			name: redactTokenizedSegments(connection.id),
			// A connection carries no fleetRevision provenance key, so a declared-
			// endpoint connection on a retired instance is `unmanaged`.
			kind: "unmanaged",
			touchedDevices: devicesForConnection(connection, index),
		})
	}
	return out
}

/** The declared devices a combo touches, via the connections its targets name. */
function devicesTouchedByCombo(
	combo: Combo,
	connById: ReadonlyMap<string, Connection>,
	index: InventoryIndex,
): string[] {
	const devices = new Set<string>()
	for (const ref of combo.models) {
		if (ref.connectionId) {
			const connection = connById.get(ref.connectionId)
			if (connection) {
				for (const device of devicesForConnection(connection, index)) {
					devices.add(device)
				}
			}
		}
		if (ref.model && index.declaresModelId(ref.model)) {
			for (const device of index.devicesForModelId(ref.model)) {
				devices.add(device)
			}
		}
	}
	return [...devices]
}

/** The declared devices served by the endpoint a connection resolves to. */
function devicesForConnection(connection: Connection, index: InventoryIndex): string[] {
	const endpointId = index.endpointByConnection(connection)
	if (!endpointId) {
		return []
	}
	return index.devicesForEndpoint(endpointId)
}

// ---------------------------------------------------------------------------
// Inventory index — resolve live objects back to declared endpoints/devices
// ---------------------------------------------------------------------------

interface InventoryIndex {
	endpointByConnection(connection: Connection): string | undefined
	devicesForEndpoint(endpointId: string): string[]
	offeringsForEndpoint(endpointId: string): ModelOffering[]
	declaresRouteName(name: string): boolean
	declaresModelId(modelId: string): boolean
	devicesForModelId(modelId: string): string[]
}

function buildInventoryIndex(model: FleetInventory): InventoryIndex {
	// Endpoint resolution (Requirement 10.4 conditions a/b/c): by host:port of a
	// declared address, by provider + declared model id, or by provider that maps
	// to an endpoint and no Cloud_Target.
	const hostPortToEndpoint = new Map<string, string>()
	for (const endpoint of model.endpoints) {
		for (const addr of endpoint.addresses) {
			const key = hostPort(addr.url)
			if (key) {
				hostPortToEndpoint.set(key, endpoint.id)
			}
		}
	}

	const offeringsByEndpoint = new Map<string, ModelOffering[]>()
	const modelIdToEndpoints = new Map<string, Set<string>>()
	const modelIdToDevices = new Map<string, Set<string>>()
	for (const offering of model.offerings) {
		const list = offeringsByEndpoint.get(offering.endpointId) ?? []
		list.push(offering)
		offeringsByEndpoint.set(offering.endpointId, list)

		const eps = modelIdToEndpoints.get(offering.modelId) ?? new Set<string>()
		eps.add(offering.endpointId)
		modelIdToEndpoints.set(offering.modelId, eps)

		const devs = modelIdToDevices.get(offering.modelId) ?? new Set<string>()
		devs.add(offering.deviceId)
		modelIdToDevices.set(offering.modelId, devs)
	}

	const cloudProviders = new Set(model.clouds.map((c) => c.provider))
	const providerToEndpoint = new Map<string, string>()
	for (const endpoint of model.endpoints) {
		// Condition (c): a provider that maps to an endpoint and no Cloud_Target.
		if (!cloudProviders.has(endpoint.provider) && !providerToEndpoint.has(endpoint.provider)) {
			providerToEndpoint.set(endpoint.provider, endpoint.id)
		}
	}
	const providerDefaultModelToEndpoint = new Map<string, string>()
	for (const offering of model.offerings) {
		const endpoint = model.endpoints.find((e) => e.id === offering.endpointId)
		if (endpoint) {
			providerDefaultModelToEndpoint.set(`${endpoint.provider}\u0000${offering.modelId}`, endpoint.id)
		}
	}

	const declaredRouteNames = new Set<string>()
	for (const lane of model.lanes) {
		for (const name of lane.names) {
			declaredRouteNames.add(name)
		}
	}
	for (const diagnostic of model.diagnostics) {
		declaredRouteNames.add(diagnostic.id)
	}

	const endpointIdToDevices = new Map<string, string[]>()
	for (const endpoint of model.endpoints) {
		endpointIdToDevices.set(endpoint.id, [...endpoint.deviceIds])
	}

	return {
		endpointByConnection(connection: Connection): string | undefined {
			// (a) host:port of the connection address.
			const key = hostPort(connection.address)
			if (key && hostPortToEndpoint.has(key)) {
				return hostPortToEndpoint.get(key)
			}
			// (b) provider + default model id of the connection.
			if (connection.defaultModel) {
				const byModel = providerDefaultModelToEndpoint.get(`${connection.provider}\u0000${connection.defaultModel}`)
				if (byModel) {
					return byModel
				}
			}
			// (c) provider that maps to an endpoint and no Cloud_Target.
			return providerToEndpoint.get(connection.provider)
		},
		devicesForEndpoint(endpointId: string): string[] {
			return endpointIdToDevices.get(endpointId) ?? []
		},
		offeringsForEndpoint(endpointId: string): ModelOffering[] {
			return offeringsByEndpoint.get(endpointId) ?? []
		},
		declaresRouteName(name: string): boolean {
			return declaredRouteNames.has(name)
		},
		declaresModelId(modelId: string): boolean {
			return modelIdToDevices.has(modelId)
		},
		devicesForModelId(modelId: string): string[] {
			return [...(modelIdToDevices.get(modelId) ?? new Set<string>())]
		},
	}
}

/** The `host:port` of a URL, or undefined when it cannot be parsed. */
function hostPort(url: string): string | undefined {
	try {
		const parsed = new URL(url)
		return parsed.host.toLowerCase()
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Read-with-retry (Requirement 8.10 — 3 attempts at 10 s, then `unverified`)
// ---------------------------------------------------------------------------

type ReadResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: ReadFailureReason }

/**
 * Run a read with the retry policy: up to `readAttempts` attempts, each bounded
 * by `readTimeoutMs`, sleeping between attempts. On exhaustion the result is
 * `unverified` with the last failure reason (Requirement 8.10). NEVER throws —
 * a persistent failure yields `{ok:false}` so the run continues.
 */
async function readWithRetry<T>(
	read: () => Promise<T>,
	_instanceId: string,
	_operation: string,
	options: DriftOptions,
): Promise<ReadResult<T>> {
	const attempts = options.readAttempts ?? DEFAULT_READ_ATTEMPTS
	const timeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
	const sleep = options.sleep ?? defaultSleep

	let lastReason: ReadFailureReason = "error response"
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const value = await withTimeout(read(), timeoutMs)
			return { ok: true, value }
		} catch (error) {
			lastReason = classifyReadFailure(error)
		}
		if (attempt < attempts) {
			await sleep(timeoutMs)
		}
	}
	return { ok: false, reason: lastReason }
}

/** Resolve the first of the read or a timeout rejection. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	if (timeoutMs <= 0) {
		// A zero/negative deadline means "do not wait": race against an immediate
		// timeout so a never-settling read (the fake's `timeout` script) does not
		// hang the run. A read that resolves synchronously still wins the race.
		return Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				setTimeout(() => reject(new ReadTimeoutError()), 0)
			}),
		])
	}
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => {
			setTimeout(() => reject(new ReadTimeoutError()), timeoutMs)
		}),
	])
}

class ReadTimeoutError extends Error {
	constructor() {
		super("read timed out")
		this.name = "ReadTimeoutError"
	}
}

/** Map a thrown read error to a Requirement 8.10 failure reason. */
function classifyReadFailure(error: unknown): ReadFailureReason {
	if (error instanceof ReadTimeoutError) {
		return "timeout"
	}
	// OmniRouteApiError carries an HTTP status; classify by it without importing
	// the class (duck-typed to avoid a hard dependency and keep this read-only).
	const status = (error as { status?: unknown } | null)?.status
	if (typeof status === "number") {
		if (status === 401 || status === 403) {
			return "authentication rejection"
		}
		return "error response"
	}
	const name = (error as { name?: unknown } | null)?.name
	if (name === "SyntaxError") {
		return "unparseable response"
	}
	return "connection failure"
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Counting + summary
// ---------------------------------------------------------------------------

function countDifferences(
	differences: readonly ObjectDifference[],
	modelIdFindings: readonly ModelIdFinding[],
	unverified: readonly UnverifiedRead[],
): DriftCounts {
	let missing = 0
	let extra = 0
	let changed = 0
	let unmanaged = 0
	for (const d of differences) {
		switch (d.kind) {
			case "missing":
				missing++
				break
			case "extra":
				extra++
				break
			case "changed":
				changed++
				break
			case "unmanaged":
				unmanaged++
				break
			case "unverified":
				// `unverified` object differences are counted via the unverified list.
				break
		}
	}
	let undeclared = 0
	let stale = 0
	for (const f of modelIdFindings) {
		switch (f.kind) {
			case "undeclared":
				undeclared++
				break
			case "missing":
				// A model id declared but not advertised folds into the `missing`
				// classification count (Requirement 8.6, 8.9).
				missing++
				break
			case "stale":
				stale++
				break
		}
	}
	return {
		missing,
		extra,
		changed,
		unmanaged,
		undeclared,
		stale,
		unverified: unverified.length,
	}
}

/** The human-readable summary (Requirement 8.9). Carries no credential or body. */
function renderSummary(
	outcome: DriftOutcome,
	instances: readonly InstanceDriftReport[],
	failures: readonly string[],
): string {
	const lines: string[] = []
	lines.push(`Drift detection outcome: ${outcome}`)
	if (outcome === "failed") {
		lines.push(`Compilation failed with ${failures.length} error(s):`)
		for (const failure of failures) {
			lines.push(`  - ${failure}`)
		}
		return lines.join("\n")
	}
	for (const inst of instances) {
		const c = inst.counts
		lines.push(
			`Instance ${inst.instanceId} [${inst.role}]: ` +
				`${c.missing} missing, ${c.extra} extra, ${c.changed} changed, ${c.unmanaged} unmanaged, ` +
				`${c.undeclared} undeclared, ${c.stale} stale, ${c.unverified} unverified`,
		)
		for (const d of inst.differences) {
			lines.push(`    ${d.object} '${d.name}': ${d.kind}`)
		}
		for (const f of inst.modelIdFindings) {
			lines.push(`    model '${f.modelId}' on connection '${redactTokenizedSegments(f.connectionId)}': ${f.kind}`)
		}
		for (const u of inst.unverified) {
			lines.push(`    unverified read '${u.operation}': ${u.reason}`)
		}
	}
	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Structural deep-equality for the JSON-shaped values combos/config carry. */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true
	}
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
		return false
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false
		}
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) {
				return false
			}
		}
		return true
	}
	const aObj = a as Record<string, unknown>
	const bObj = b as Record<string, unknown>
	const aKeys = Object.keys(aObj)
	const bKeys = Object.keys(bObj)
	if (aKeys.length !== bKeys.length) {
		return false
	}
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(bObj, key) || !deepEqual(aObj[key], bObj[key])) {
			return false
		}
	}
	return true
}

/**
 * Deeply pass an unknown value through tokenized-segment redaction so a live
 * override value that embedded a tokenized URL — at any depth — cannot leak into
 * the report (Requirement 22.5). Every string, including a nested object/array
 * member, is redacted; non-string leaves are returned unchanged (the report
 * never includes a body, Requirement 22.6).
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
