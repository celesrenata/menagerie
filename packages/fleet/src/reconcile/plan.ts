// Reconciler — Change_Plan builder and connection-id resolution (design §3
// "Reconciler", Requirements 9.1, 9.2).
//
// READ-ONLY / DRY-RUN. `plan()` NEVER writes to OmniRoute. It issues only the
// two reads it needs — `listCombos()` and `listConnections()` (the latter is
// `GET /api/providers`) — and produces an ordered Change_Plan that WOULD make
// the Live_Route_State equal the compiled Desired_Route_State. The apply path
// (task 6.2) is the only writer; this module is the preview it confirms against
// (Requirement 9.1).
//
// Ordering (Requirement 9.2): combo creates are ordered so a combo is created
// BEFORE every op that adds a reference to it (a Public_Route combo-refs its
// Internal_Pool, so the pool is created first), and combo deletes are ordered
// so a combo is deleted AFTER every op that removes a reference to it (the
// referencing route is deleted before the pool it referenced). This is a
// topological ordering over the combo-ref dependency graph: creates/updates in
// dependency-first order, deletes in the reverse.
//
// Connection-id resolution (design §3): the inventory names endpoints, not live
// OmniRoute connection UUIDs. At plan time this module reads `GET /api/providers`
// and maps each declared endpoint (by provider + address host:port, per design
// §3) to its live connection id, then FILLS `connectionId` on every local-slot
// target ref of every desired combo. A declared-ACTIVE endpoint with no matching
// live connection is a PLAN ERROR that names the endpoint — never a silent
// provider-default target (the connectionless targets in the findings were a
// drift symptom). Plan errors are carried on the returned `ChangePlan.errors`.
//
// Credential safety (Requirement 22.4-22.6): the plan carries no secret value,
// no request/response body, and no tokenized URL path segment. Combo before/
// after values are drawn from the compiled Desired_Route_State and the live
// combos, neither of which carries a credential; any string that could carry a
// tokenized segment is passed through `redactTokenizedSegments` before it enters
// the plan.

import type { FleetInventory } from "@roo-code/types"

import { compile, type DesiredRouteState, type Revision, type RoutingSetting } from "../compile/compiler.js"
import type { Combo, ComboModelRef, Connection, OmniRouteClient } from "../omniroute/client.js"
import { redactTokenizedSegments } from "../omniroute/redact.js"

// ---------------------------------------------------------------------------
// Public types (design §3 ChangePlan / ChangeOp)
// ---------------------------------------------------------------------------

/** One op of a Change_Plan: a combo or Routing_Setting create/update/delete. */
export type ChangeOp = {
	readonly kind: "combo" | "setting"
	readonly op: "create" | "update" | "delete"
	/** The object identifier (combo name / Routing_Setting name). */
	readonly id: string
	/** The complete before value, absent for a create (Requirement 9.2). */
	readonly before?: unknown
	/** The complete after value, absent for a delete (Requirement 9.2). */
	readonly after?: unknown
}

/**
 * One plan error (Requirement 9.2 connection-id resolution): a declared-active
 * endpoint whose live connection could not be resolved. Names the endpoint and,
 * for diagnostics, the provider and the host:port it looked for (both
 * credential-free). A plan carrying errors must not be applied as-is.
 */
export interface PlanError {
	readonly kind: "missing-connection"
	readonly endpointId: string
	readonly provider: string
	/** The host:port the resolver looked for, or undefined when the declared address was unparseable. */
	readonly hostPort?: string
	readonly message: string
}

/**
 * The ordered Change_Plan for one Managed_Instance (design §3). `ops` is ordered
 * per Requirement 9.2. `errors` is empty for a clean plan; a non-empty `errors`
 * means the inventory referenced an endpoint with no live connection, so the
 * plan is not safe to apply until the connection exists.
 */
export interface ChangePlan {
	readonly instanceId: string
	readonly revision: Revision
	/** The plan creation time in UTC (ISO-8601). */
	readonly createdAt: string
	readonly ops: readonly ChangeOp[]
	readonly errors: readonly PlanError[]
}

/** Injectable clock + compiled-state override for determinism in tests. */
export interface PlanOptions {
	/** UTC ISO clock; defaults to the wall clock. Injected for deterministic tests. */
	readonly clock?: () => string
}

const defaultClock = (): string => new Date().toISOString()

// ---------------------------------------------------------------------------
// Bookkeeping / provenance fields excluded from the value comparison (Req 8.2)
// ---------------------------------------------------------------------------
//
// Reused from drift's comparison semantics: a combo's before/after must ignore
// OmniRoute-owned bookkeeping and the `fleetRevision` provenance key, so a
// revision bump or a usage-count change never fabricates an update op.

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the dry-run Change_Plan for one Managed_Instance. Reads the live combos
 * and connections (no writes), compiles the Desired_Route_State, resolves each
 * declared endpoint to its live connection id, fills `connectionId` on every
 * local-slot target ref, and emits the ordered create/update/delete ops that
 * would reconcile live to desired (Requirements 9.1, 9.2).
 *
 * A validated inventory is expected. If compilation fails this throws (the
 * Reconciler compiles the same model drift did; a compile failure is a caller
 * error, not an operator-facing plan error, which is reserved for an
 * unresolvable connection).
 */
export async function plan(
	model: FleetInventory,
	rev: Revision,
	instanceId: string,
	client: OmniRouteClient,
	options: PlanOptions = {},
): Promise<ChangePlan> {
	const clock = options.clock ?? defaultClock
	const createdAt = clock()

	// Compile the Desired_Route_State. A validated inventory is expected; a
	// compile failure is a caller error (the Reconciler compiles the same model
	// drift did), so it throws rather than masquerading as a plan error.
	const compiled = compile(model, rev)
	if (!compiled.ok) {
		throw new Error(
			`plan: inventory failed to compile for instance '${instanceId}': ${compiled.failures
				.map((f) => f.message)
				.join("; ")}`,
		)
	}

	// A `retired` instance compiles to no Desired_Route_State; its plan would
	// delete every managed combo, but that is drift's/decommissioning's concern.
	// For a declared-but-uncompiled instance the desired set is empty.
	const desired: DesiredRouteState = compiled.states.get(instanceId) ?? {
		combos: [],
		routingSettings: [],
		publishedMetadata: {
			kinds: {},
			contextWindows: {},
			capacities: [],
			capabilityLaneRoutes: {},
			swapLatencies: [],
		},
	}

	// --- Reads (dry-run: ONLY these two reads, never a write) -----------------
	const liveConnections = await client.listConnections()
	const liveCombos = await client.listCombos()

	// --- Connection-id resolution (design §3) ---------------------------------
	const resolution = resolveConnections(model, instanceId, desired, liveConnections)

	// --- Build ordered combo ops ----------------------------------------------
	const comboOps = buildComboOps(resolution.desiredCombos, liveCombos)

	// --- Build Routing_Setting ops --------------------------------------------
	const settingOps = buildSettingOps(desired.routingSettings)

	return {
		instanceId,
		revision: rev,
		createdAt,
		ops: [...comboOps, ...settingOps],
		errors: resolution.errors,
	}
}

// ---------------------------------------------------------------------------
// Connection-id resolution (design §3)
// ---------------------------------------------------------------------------

interface ResolutionResult {
	/** The desired combos with every resolvable local-slot `connectionId` filled. */
	readonly desiredCombos: readonly Combo[]
	readonly errors: readonly PlanError[]
}

/**
 * Resolve each declared endpoint to its live connection id by provider + address
 * host:port on THIS instance (design §3), fill `connectionId` on every local-slot
 * target ref, and report a declared-active endpoint with no live connection as a
 * plan error (Requirement 9.2).
 *
 * A local-slot target ref carries the Target_Identifier
 * `t:<deviceId>:<endpointId>:<modelId>:<slotIndex>` as its `id`; the endpoint id
 * is the second `:`-segment. A combo-ref (`comboName`) and a cloud ref (carries
 * `providerId`, Target_Identifier `c:<provider>:<modelId>`) are left untouched —
 * cloud targets dispatch by provider+model, not a managed connection.
 */
function resolveConnections(
	model: FleetInventory,
	instanceId: string,
	desired: DesiredRouteState,
	liveConnections: readonly Connection[],
): ResolutionResult {
	// provider + host:port → live connection id, from GET /api/providers.
	const connectionByKey = new Map<string, string>()
	for (const connection of liveConnections) {
		const key = providerHostKey(connection.provider, hostPort(connection.address))
		if (key && !connectionByKey.has(key)) {
			connectionByKey.set(key, connection.id)
		}
	}

	// endpointId → { provider, host:port on this instance }, from the inventory.
	const endpointAddressKey = new Map<string, { provider: string; key: string | undefined }>()
	for (const endpoint of model.endpoints) {
		const address = endpoint.addresses.find((a) => a.instanceId === instanceId)
		endpointAddressKey.set(endpoint.id, {
			provider: endpoint.provider,
			key: address ? providerHostKey(endpoint.provider, hostPort(address.url)) : undefined,
		})
	}

	// Which endpoints does the Desired_Route_State actually reference? Only an
	// endpoint whose slot targets are compiled into a route is "declared-active"
	// for this instance; an endpoint absent from every lane raises no plan error.
	const referencedEndpoints = new Set<string>()
	for (const combo of desired.combos) {
		for (const ref of combo.models) {
			const endpointId = slotEndpointId(ref)
			if (endpointId) {
				referencedEndpoints.add(endpointId)
			}
		}
	}

	const errors: PlanError[] = []
	const resolvedConnectionId = new Map<string, string>()
	for (const endpointId of referencedEndpoints) {
		const addr = endpointAddressKey.get(endpointId)
		const connectionId = addr?.key ? connectionByKey.get(addr.key) : undefined
		if (connectionId) {
			resolvedConnectionId.set(endpointId, connectionId)
			continue
		}
		// A declared-active endpoint with no live connection is a plan error that
		// names the endpoint (design §3; never a silent provider-default target).
		const provider = addr?.provider ?? "unknown"
		const hp = addr?.key ? addr.key.split("\u0000")[1] : undefined
		errors.push({
			kind: "missing-connection",
			endpointId,
			provider,
			hostPort: hp,
			message: `no live connection resolves endpoint '${endpointId}' (provider '${provider}'${
				hp ? `, address '${hp}'` : ", address unparseable or not declared for this instance"
			}) on instance '${instanceId}'`,
		})
	}

	// Fill connectionId on every resolvable local-slot ref.
	const desiredCombos = desired.combos.map((combo) => fillConnectionIds(combo, resolvedConnectionId))

	return { desiredCombos, errors }
}

/** Rebuild a combo with each local-slot ref's `connectionId` set when resolved. */
function fillConnectionIds(combo: Combo, resolvedConnectionId: ReadonlyMap<string, string>): Combo {
	let changed = false
	const models = combo.models.map((ref): ComboModelRef => {
		const endpointId = slotEndpointId(ref)
		if (!endpointId) {
			return ref
		}
		const connectionId = resolvedConnectionId.get(endpointId)
		if (!connectionId || ref.connectionId === connectionId) {
			return ref
		}
		changed = true
		return { ...ref, connectionId }
	})
	return changed ? { ...combo, models } : combo
}

/**
 * The endpoint id of a local-slot target ref, or undefined for a cloud ref or a
 * combo-ref. A slot id is `t:<deviceId>:<endpointId>:<modelId>:<slotIndex>`; a
 * combo-ref has `kind: "combo-ref"`; a cloud id starts `c:`.
 */
function slotEndpointId(ref: ComboModelRef): string | undefined {
	if (ref.kind !== "model") {
		return undefined
	}
	if (!ref.id.startsWith("t:")) {
		return undefined // cloud (`c:`) or any non-slot id.
	}
	const segments = ref.id.split(":")
	// t : deviceId : endpointId : modelId : slotIndex
	return segments.length >= 3 ? segments[2] : undefined
}

/** The composite resolution key: provider + host:port (NUL-separated). */
function providerHostKey(provider: string, hp: string | undefined): string | undefined {
	return hp ? `${provider}\u0000${hp}` : undefined
}

/** The lowercased `host:port` of a URL, or undefined when it cannot be parsed. */
function hostPort(url: string): string | undefined {
	try {
		return new URL(url).host.toLowerCase()
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Combo op ordering (Requirement 9.2)
// ---------------------------------------------------------------------------

/**
 * Build the ordered combo ops. Matching desired vs live by name:
 *   - CREATE — desired, not live.
 *   - UPDATE — both, differing on a non-bookkeeping field (reuses drift's
 *     ignore-bookkeeping / fleetRevision comparison).
 *   - DELETE — live, carries a `fleetRevision` provenance key (ours, now
 *     unwanted), not desired. An `unmanaged` live combo (no provenance key) is
 *     left alone, exactly as drift distinguishes `extra` from `unmanaged`.
 *
 * Ordering (Requirement 9.2): creates/updates in dependency-first order (a
 * referenced Internal_Pool before the Public_Route that combo-refs it), deletes
 * in the reverse of the live dependency order (the referencing route before the
 * pool it referenced).
 */
function buildComboOps(desired: readonly Combo[], live: readonly Combo[]): ChangeOp[] {
	const liveByName = new Map(live.map((c) => [c.name, c]))
	const desiredByName = new Map(desired.map((c) => [c.name, c]))

	// Dependency-first order over the desired combo-ref graph.
	const desiredOrder = topoOrder(desired)

	const creates: ChangeOp[] = []
	const updates: ChangeOp[] = []
	for (const combo of desiredOrder) {
		const liveCombo = liveByName.get(combo.name)
		if (!liveCombo) {
			creates.push({ kind: "combo", op: "create", id: combo.name, after: redactCombo(combo) })
			continue
		}
		if (combosDiffer(combo, liveCombo)) {
			updates.push({
				kind: "combo",
				op: "update",
				id: combo.name,
				before: redactCombo(liveCombo),
				after: redactCombo(combo),
			})
		}
	}

	// Deletes: live combos that carry our provenance key and are not desired,
	// ordered in the reverse of the live dependency order so a referencing combo
	// is deleted before the combo it referenced (Requirement 9.2).
	const liveOrder = topoOrder(live)
	const deletes: ChangeOp[] = []
	for (let i = liveOrder.length - 1; i >= 0; i--) {
		const combo = liveOrder[i]!
		if (desiredByName.has(combo.name)) {
			continue
		}
		if (!hasFleetRevision(combo)) {
			continue // `unmanaged` (hand-made): not ours to delete.
		}
		deletes.push({ kind: "combo", op: "delete", id: combo.name, before: redactCombo(combo) })
	}

	// Creates (pools first) → updates → deletes (referencers first). A create of
	// a pool thus precedes the create/update of any route that refs it, and a
	// delete of a route precedes the delete of the pool it refs.
	return [...creates, ...updates, ...deletes]
}

/**
 * A dependency-first topological order of combos by combo-ref: a combo appears
 * AFTER every combo it references (so a referenced Internal_Pool precedes the
 * Public_Route that refs it). Edges to unknown names are ignored; a cycle (not
 * expected — the compiler forbids self/mutual combo-refs, Requirement 5.11) is
 * broken by emitting remaining combos in their input order, keeping the function
 * total.
 */
function topoOrder(combos: readonly Combo[]): Combo[] {
	const byName = new Map(combos.map((c) => [c.name, c]))
	const visited = new Set<string>()
	const inProgress = new Set<string>()
	const order: Combo[] = []

	const visit = (combo: Combo): void => {
		if (visited.has(combo.name) || inProgress.has(combo.name)) {
			return
		}
		inProgress.add(combo.name)
		for (const ref of combo.models) {
			if (ref.kind === "combo-ref" && ref.comboName) {
				const dep = byName.get(ref.comboName)
				if (dep) {
					visit(dep)
				}
			}
		}
		inProgress.delete(combo.name)
		visited.add(combo.name)
		order.push(combo)
	}

	for (const combo of combos) {
		visit(combo)
	}
	return order
}

// ---------------------------------------------------------------------------
// Routing_Setting ops
// ---------------------------------------------------------------------------

/**
 * Build the Routing_Setting ops. The management surface exposes no live
 * Routing_Setting read (drift leaves them unread to avoid false positives), so
 * the plan proposes each compiled setting as an `update` with the desired value
 * as `after` and the before left absent (unknown live value). Settings carry no
 * credential, but are redacted defensively before entering the plan.
 */
function buildSettingOps(settings: readonly RoutingSetting[]): ChangeOp[] {
	return settings.map((setting) => ({
		kind: "setting" as const,
		op: "update" as const,
		id: setting.name,
		after: redactUnknown(setting.value),
	}))
}

// ---------------------------------------------------------------------------
// Comparison + redaction helpers (reuse drift semantics)
// ---------------------------------------------------------------------------

/** Does a live combo record a producing Fleet_Inventory_Revision (drift §8.1)? */
function hasFleetRevision(combo: Combo): boolean {
	const value = (combo.config as Record<string, unknown>)[FLEET_REVISION_KEY]
	return typeof value === "string" && value.length > 0
}

/**
 * Do two combos differ on any field that matters, ignoring OmniRoute bookkeeping
 * and the `fleetRevision` provenance key (reuses drift's Requirement 8.2
 * comparison)? Combo-list order IS significant (a reordered `models[]` differs).
 */
function combosDiffer(desired: Combo, live: Combo): boolean {
	if (
		desired.strategy !== live.strategy ||
		desired.context_length !== live.context_length ||
		desired.isHidden !== live.isHidden
	) {
		return true
	}
	if (!deepEqual(desired.models, live.models)) {
		return true
	}
	return configDiffers(desired.config, live.config)
}

/** Compare two combo config maps, ignoring bookkeeping and `fleetRevision`. */
function configDiffers(
	desired: Readonly<Record<string, unknown>>,
	live: Readonly<Record<string, unknown>>,
): boolean {
	const keys = new Set<string>([...Object.keys(desired), ...Object.keys(live)])
	for (const key of keys) {
		if (key === FLEET_REVISION_KEY || COMBO_BOOKKEEPING_FIELDS.has(key)) {
			continue
		}
		const dHas = Object.prototype.hasOwnProperty.call(desired, key)
		const lHas = Object.prototype.hasOwnProperty.call(live, key)
		if (!dHas || !lHas || !deepEqual(desired[key], live[key])) {
			return true
		}
	}
	return false
}

/**
 * A credential-free copy of a combo for the plan's before/after. A combo carries
 * no secret, body, or token, but any string field is passed through
 * `redactTokenizedSegments` defensively so a tokenized URL path segment that
 * slipped into a config value can never enter the plan (Requirement 22.4-22.6).
 */
function redactCombo(combo: Combo): Combo {
	return redactUnknown(combo) as Combo
}

/**
 * Recursively redact tokenized URL path segments from every string in a value,
 * returning a fresh, structurally-identical value. Used so no plan field can
 * carry a tokenized segment (Requirement 22.5).
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
