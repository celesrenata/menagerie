// Reconciler — decommissioning and model-replacement plan (design §3
// "Onboarding and decommissioning", Requirements 12.1-12.6).
//
// Decommissioning is driven by an inventory edit: dropping a Model_Offering,
// Cloud_Target, Device, or Serving_Endpoint from the Fleet_Inventory. The NEW
// (post-drop) inventory recompiles to a Desired_Route_State that no longer
// references the dropped entries, so the base Change_Plan from `plan()`
// (task 6.1) already DELETES/UPDATES the combos that stopped referencing them
// (Requirement 12.1) and the compiler already places a same-tag REPLACEMENT in
// every eligible lane when the edit substitutes an offering with the same
// capability tags (Requirement 12.2). This module composes ON TOP of that base
// plan and adds the ops the compiler/base plan cannot express because they need
// the OLD inventory and the live state:
//
//   1. Connection deactivations (Requirement 12.3): every OmniRoute connection
//      on this instance whose base URL points at a dropped Serving_Endpoint, or
//      at an endpoint ALL of whose Devices the new revision drops, is
//      deactivated (patchConnection isActive:false) WITHOUT deletion. These ops
//      are ordered AFTER every combo op that removes a target using the
//      connection (Requirement 12.3). A connection whose endpoint still serves a
//      SURVIVING Device is kept active (Requirement 12.4).
//   2. Context-override removals (Requirement 12.4-as-numbered-12.4-in-text,
//      i.e. Req 12.4 criterion): each per-model context override for a dropped
//      model id is removed (patchContextOverrides removes), unless another
//      Model_Offering in the NEW revision still declares that model id.
//   3. Stale-reference report (Requirement 12.4 criterion / text 12.5): each
//      target that resolves to a dropped Model_Offering in a combo the compiler
//      did NOT generate (an unmanaged / hand-made combo) is reported, naming the
//      combo and the model id. These are NOT auto-removed — the toolkit does not
//      delete unmanaged combos.
//   4. Per-route local-Slot loss report (Requirement 12.6): each Public_Route
//      whose count of local Slots usable on this instance decreased, with the
//      Live_Route_State count and the Desired_Route_State count.
//
// Op ordering of the composed plan (extends plan.ts's Requirement 9.2 order):
//
//   [base combo creates] → [base combo updates] → [base combo deletes]
//     → [connection deactivations]            (Requirement 12.3: after combo ops)
//     → [context-override removals]
//     → [base setting ops]
//
// Placing the connection deactivations after ALL base combo ops (creates,
// updates, and deletes) satisfies Requirement 12.3's "ordered after every combo
// update that removes a target using that connection": by the time a connection
// is deactivated, no live combo op that still references it remains ahead of it.
// Context-override removals follow, then the Routing_Setting ops the base plan
// placed last are re-appended so settings remain the final writes.
//
// READ-ONLY / DRY-RUN. Like `plan()`, this module NEVER writes to OmniRoute. It
// issues the reads `plan()` issues (`listCombos`, `listConnections`) plus
// `getContextOverrides` (to know which overrides exist to remove). The returned
// `DecommissionPlan` is a preview the apply path confirms against.
//
// Credential safety (Requirement 22.4-22.6): every value that enters the plan is
// drawn from the compiled Desired_Route_State, the live combos/connections/
// overrides, or the inventory — none of which carries a credential — and every
// string is passed through `redactTokenizedSegments` before it enters an op or a
// report entry, exactly as `plan()` does.

import type { CloudTarget, Endpoint, FleetInventory, ModelOffering } from "@roo-code/types"

import { compile, type DesiredRouteState, type Revision } from "../compile/compiler.js"
import { eligibleOfferingSlots, slotTargetId } from "../compile/targets.js"
import type { Combo, ComboModelRef, Connection, ContextOverride, OmniRouteClient } from "../omniroute/client.js"
import { redactTokenizedSegments } from "../omniroute/redact.js"
import { plan, type ChangeOp, type ChangePlan, type PlanError, type PlanOptions } from "./plan.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One connection-deactivation op (Requirement 12.3). The op is a
 * `patchConnection` with `isActive:false`; it is modeled as its own op kind so
 * the apply path can issue the PATCH and the preview can order it after the
 * combo ops. Carries the redacted connection id and the dropped endpoint it
 * resolved to, both credential-free.
 */
export interface ConnectionDeactivation {
	readonly kind: "connection-deactivation"
	readonly connectionId: string
	readonly endpointId: string
	/** The declared Devices of the dropped endpoint (all removed by the edit). */
	readonly removedDevices: readonly string[]
}

/**
 * One context-override removal op (Requirement 12.4 criterion). The apply path
 * issues it as `patchContextOverrides({ removes: [modelId] })`.
 */
export interface ContextOverrideRemoval {
	readonly kind: "context-override-removal"
	readonly modelId: string
}

/**
 * One stale reference found in an un-generated (unmanaged) combo (Requirement
 * 12.4 criterion / design-text 12.5): a target resolving to a dropped
 * Model_Offering in a combo the Route_Compiler did not generate. Reported, never
 * auto-removed.
 */
export interface StaleReference {
	readonly comboName: string
	readonly modelId: string
	/** The Target_Identifier of the stale target ref, if it carries one. */
	readonly targetId: string
}

/**
 * One per-route local-Slot loss entry (Requirement 12.6): a Public_Route whose
 * count of local Slots usable on this instance decreased, with the live count
 * and the desired count.
 */
export interface RouteSlotLoss {
	readonly route: string
	readonly liveLocalSlots: number
	readonly desiredLocalSlots: number
}

/**
 * The composed decommission plan for one Managed_Instance. `base` is the
 * underlying `plan()` Change_Plan (combo creates/updates/deletes + setting ops);
 * `ops` is the FULL ordered op list (base combo ops → connection deactivations →
 * context-override removals → base setting ops). `errors` carries the base
 * plan's connection-resolution errors (Requirement 9.2). The reports are the
 * decommission-specific findings of Requirements 12.4-12.6.
 */
export interface DecommissionPlan {
	readonly instanceId: string
	readonly revision: Revision
	readonly createdAt: string
	readonly base: ChangePlan
	readonly ops: readonly ChangeOp[]
	readonly connectionDeactivations: readonly ConnectionDeactivation[]
	readonly contextOverrideRemovals: readonly ContextOverrideRemoval[]
	readonly staleReferences: readonly StaleReference[]
	readonly routeSlotLosses: readonly RouteSlotLoss[]
	readonly errors: readonly PlanError[]
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the dry-run decommission plan for one Managed_Instance, given the OLD
 * inventory (the revision last successfully applied) and the NEW inventory (the
 * revision that drops entries). Reads the live state (no writes), composes the
 * base `plan()` Change_Plan from the NEW inventory, and layers on the connection
 * deactivations, context-override removals, stale-reference report, and per-route
 * local-Slot loss report of Requirements 12.1-12.6.
 *
 * The NEW inventory is expected to validate and compile (the compiler enforces
 * lane non-emptiness, Requirement 5.7); a compile failure throws, like `plan()`.
 */
export async function decommission(
	oldModel: FleetInventory,
	newModel: FleetInventory,
	rev: Revision,
	instanceId: string,
	client: OmniRouteClient,
	options: PlanOptions = {},
): Promise<DecommissionPlan> {
	// The base plan from the NEW inventory. It already drops every target that
	// resolved to a dropped offering/cloud (Requirement 12.1) and already places
	// a same-tag replacement in every eligible lane (Requirement 12.2), because
	// those are properties of the recompiled Desired_Route_State.
	const base = await plan(newModel, rev, instanceId, client, options)

	// Reads for the decommission-specific layers. `plan()` already read combos
	// and connections; we re-read here (the fake/HTTP client is cheap and the
	// re-read keeps this module independent of plan() internals) and add the
	// context-override read plan() does not need.
	const liveCombos = await client.listCombos()
	const liveConnections = await client.listConnections()
	const liveOverrides = await client.getContextOverrides()

	// What did the edit drop? Everything present in OLD and absent in NEW.
	const drop = computeDropped(oldModel, newModel, instanceId)

	// --- (12.3 / 12.4) connection deactivations vs kept-active ---------------
	const connectionDeactivations = buildConnectionDeactivations(
		drop,
		oldModel,
		newModel,
		instanceId,
		liveConnections,
	)

	// --- (12.4 criterion) context-override removals --------------------------
	const contextOverrideRemovals = buildContextOverrideRemovals(drop, newModel, liveOverrides)

	// --- (12.4 criterion / 12.5) stale references in unmanaged combos --------
	const staleReferences = buildStaleReferences(drop, liveCombos)

	// --- (12.6) per-route local-Slot loss ------------------------------------
	const routeSlotLosses = buildRouteSlotLosses(oldModel, newModel, rev, instanceId)

	// --- compose the ordered op list -----------------------------------------
	const comboOps = base.ops.filter((op) => op.kind === "combo")
	const settingOps = base.ops.filter((op) => op.kind === "setting")
	const deactivationOps = connectionDeactivations.map(toDeactivationOp)
	const overrideRemovalOps = contextOverrideRemovals.map(toContextOverrideOp)

	// base combo ops → connection deactivations (after combo ops, Req 12.3)
	// → context-override removals → base setting ops (settings stay last).
	const ops: ChangeOp[] = [...comboOps, ...deactivationOps, ...overrideRemovalOps, ...settingOps]

	return {
		instanceId,
		revision: rev,
		createdAt: base.createdAt,
		base,
		ops,
		connectionDeactivations,
		contextOverrideRemovals,
		staleReferences,
		routeSlotLosses,
		errors: base.errors,
	}
}

// ---------------------------------------------------------------------------
// Dropped-entry computation
// ---------------------------------------------------------------------------

interface Dropped {
	/** Model_Offerings present in OLD, absent in NEW (by id). */
	readonly offerings: readonly ModelOffering[]
	/** Cloud_Targets present in OLD, absent in NEW (by id). */
	readonly clouds: readonly CloudTarget[]
	/** Endpoints present in OLD, absent in NEW (by id). */
	readonly endpoints: readonly Endpoint[]
	/** Device ids present in OLD, absent in NEW. */
	readonly deviceIds: ReadonlySet<string>
	/** model ids that no surviving (NEW) Model_Offering declares. */
	readonly droppedModelIds: ReadonlySet<string>
}

/**
 * Everything the edit dropped from OLD → NEW. An entry is "dropped" when its id
 * is present in the OLD inventory and absent from the NEW inventory. A dropped
 * model id is one that at least one OLD offering declared and no NEW offering
 * declares (so a replaced offering that reuses the model id is NOT a dropped
 * model id — its override and catalog entry stay).
 */
function computeDropped(oldModel: FleetInventory, newModel: FleetInventory, _instanceId: string): Dropped {
	const newOfferingIds = new Set(newModel.offerings.map((o) => o.id))
	const newCloudIds = new Set(newModel.clouds.map((c) => c.id))
	const newEndpointIds = new Set(newModel.endpoints.map((e) => e.id))
	const newDeviceIds = new Set(newModel.devices.map((d) => d.id))
	const newModelIds = new Set(newModel.offerings.map((o) => o.modelId))

	const offerings = oldModel.offerings.filter((o) => !newOfferingIds.has(o.id))
	const clouds = oldModel.clouds.filter((c) => !newCloudIds.has(c.id))
	const endpoints = oldModel.endpoints.filter((e) => !newEndpointIds.has(e.id))

	const deviceIds = new Set<string>()
	for (const device of oldModel.devices) {
		if (!newDeviceIds.has(device.id)) {
			deviceIds.add(device.id)
		}
	}

	// A dropped model id: declared by a dropped offering and by no surviving one.
	const droppedModelIds = new Set<string>()
	for (const offering of offerings) {
		if (!newModelIds.has(offering.modelId)) {
			droppedModelIds.add(offering.modelId)
		}
	}

	return { offerings, clouds, endpoints, deviceIds, droppedModelIds }
}

// ---------------------------------------------------------------------------
// (12.3 / 12.4) Connection deactivations
// ---------------------------------------------------------------------------

/**
 * Build the connection-deactivation ops (Requirement 12.3) and respect the
 * keep-active rule (Requirement 12.4). A live connection on this instance is
 * deactivated when the endpoint it resolves to is itself dropped, OR when every
 * Device of that endpoint is dropped by the new revision. A connection whose
 * endpoint still serves at least one Device the new revision declares is kept
 * active (no op emitted for it).
 *
 * Endpoint resolution reuses the same host:port-by-OLD-address mapping `plan()`
 * uses: a live connection resolves to the OLD endpoint whose address on this
 * instance shares its host:port. (We resolve against the OLD inventory because a
 * dropped endpoint is, by definition, absent from the NEW inventory.)
 */
function buildConnectionDeactivations(
	drop: Dropped,
	oldModel: FleetInventory,
	newModel: FleetInventory,
	instanceId: string,
	liveConnections: readonly Connection[],
): ConnectionDeactivation[] {
	// host:port on THIS instance → OLD endpoint.
	const hostPortToEndpoint = new Map<string, Endpoint>()
	for (const endpoint of oldModel.endpoints) {
		for (const addr of endpoint.addresses) {
			if (addr.instanceId !== instanceId) {
				continue
			}
			const key = hostPort(addr.url)
			if (key && !hostPortToEndpoint.has(key)) {
				hostPortToEndpoint.set(key, endpoint)
			}
		}
	}

	const droppedEndpointIds = new Set(drop.endpoints.map((e) => e.id))
	const newDeviceIds = new Set(newModel.devices.map((d) => d.id))

	const out: ConnectionDeactivation[] = []
	for (const connection of liveConnections) {
		if (!connection.isActive) {
			continue // already inactive — nothing to deactivate.
		}
		const key = hostPort(connection.address)
		const endpoint = key ? hostPortToEndpoint.get(key) : undefined
		if (!endpoint) {
			continue // off-inventory / already-removed-endpoint connection; not ours to govern here.
		}

		const endpointDropped = droppedEndpointIds.has(endpoint.id)
		// Does the endpoint still serve a Device the NEW revision declares?
		const sharesSurvivingDevice = endpoint.deviceIds.some((deviceId) => newDeviceIds.has(deviceId))
		const allDevicesDropped = endpoint.deviceIds.every((deviceId) => drop.deviceIds.has(deviceId))

		// Keep active when the endpoint survives AND still serves a surviving
		// Device (Requirement 12.4). Deactivate when the endpoint is dropped, or
		// when every one of its Devices is dropped (Requirement 12.3).
		if (!endpointDropped && !allDevicesDropped) {
			continue
		}
		if (!endpointDropped && sharesSurvivingDevice) {
			continue // endpoint survives and still serves a declared Device.
		}

		out.push({
			kind: "connection-deactivation",
			connectionId: redactTokenizedSegments(connection.id),
			endpointId: endpoint.id,
			removedDevices: endpoint.deviceIds.filter((deviceId) => !newDeviceIds.has(deviceId)),
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// (12.4 criterion) Context-override removals
// ---------------------------------------------------------------------------

/**
 * Build the per-model context-override removal ops (Requirement 12.4 criterion):
 * for each dropped model id that a live context override targets, emit a removal
 * — unless a surviving NEW Model_Offering still declares that model id (handled
 * already by `droppedModelIds`, which excludes reused ids).
 */
function buildContextOverrideRemovals(
	drop: Dropped,
	_newModel: FleetInventory,
	liveOverrides: readonly ContextOverride[],
): ContextOverrideRemoval[] {
	const liveOverrideModels = new Set(liveOverrides.map((o) => o.model))
	const out: ContextOverrideRemoval[] = []
	for (const modelId of drop.droppedModelIds) {
		if (liveOverrideModels.has(modelId)) {
			out.push({ kind: "context-override-removal", modelId })
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// (12.4 criterion / 12.5) Stale references in unmanaged combos
// ---------------------------------------------------------------------------

/**
 * Report each target that resolves to a dropped Model_Offering in a combo the
 * Route_Compiler did NOT generate (an unmanaged combo — one without the
 * `fleetRevision` provenance key), naming the combo and the model id
 * (Requirement 12.4 criterion / design-text 12.5). Managed combos are handled by
 * the base plan's delete/update ops, so they are skipped here.
 *
 * A target resolves to a dropped offering when it names a dropped model id. The
 * local-slot id form `t:<deviceId>:<endpointId>:<modelId>:<slotIndex>` and the
 * ref's `model` field are both checked.
 */
function buildStaleReferences(drop: Dropped, liveCombos: readonly Combo[]): StaleReference[] {
	const out: StaleReference[] = []
	for (const combo of liveCombos) {
		if (isManaged(combo)) {
			continue // a generated combo — the base plan already deletes/updates it.
		}
		for (const ref of combo.models) {
			const modelId = refModelId(ref)
			if (modelId && drop.droppedModelIds.has(modelId)) {
				out.push({
					comboName: redactTokenizedSegments(combo.name),
					modelId,
					targetId: redactTokenizedSegments(ref.id),
				})
			}
		}
	}
	return out
}

/** A combo is managed (compiler-generated) iff it carries a `fleetRevision` key. */
function isManaged(combo: Combo): boolean {
	const value = (combo.config as Record<string, unknown>)["fleetRevision"]
	return typeof value === "string" && value.length > 0
}

/**
 * The model id a combo-model ref names: the ref's `model` field, else the
 * `<modelId>` segment of a local-slot id `t:<deviceId>:<endpointId>:<modelId>:
 * <slotIndex>` or a cloud id `c:<provider>:<modelId>`.
 */
function refModelId(ref: ComboModelRef): string | undefined {
	if (ref.model) {
		return ref.model
	}
	if (ref.id.startsWith("t:")) {
		const segments = ref.id.split(":")
		// t : deviceId : endpointId : modelId : slotIndex
		return segments.length >= 4 ? segments[3] : undefined
	}
	if (ref.id.startsWith("c:")) {
		const segments = ref.id.split(":")
		// c : provider : modelId
		return segments.length >= 3 ? segments[2] : undefined
	}
	return undefined
}

// ---------------------------------------------------------------------------
// (12.6) Per-route local-Slot loss
// ---------------------------------------------------------------------------

/**
 * Report each Public_Route whose count of local Slots usable on this instance
 * decreased from the OLD revision to the NEW revision (Requirement 12.6), giving
 * the live (OLD) count and the desired (NEW) count. The count is the number of
 * distinct local-slot Target_Identifiers compiled, directly or through an
 * Internal_Pool, into the Public_Route combo on this instance.
 *
 * We compile BOTH revisions (the OLD = Live_Route_State, the NEW =
 * Desired_Route_State) and compare per Public_Route. Compiling the OLD inventory
 * is the faithful source of its local-Slot counts (the compiler is pure, so this
 * is deterministic and credential-free). A route present in OLD but absent in NEW
 * has a desired count of 0 and is reported when its OLD count was positive.
 */
function buildRouteSlotLosses(
	oldModel: FleetInventory,
	newModel: FleetInventory,
	rev: Revision,
	instanceId: string,
): RouteSlotLoss[] {
	const oldCounts = localSlotCountsByRoute(oldModel, rev, instanceId)
	const newCounts = localSlotCountsByRoute(newModel, rev, instanceId)

	const out: RouteSlotLoss[] = []
	for (const [route, liveLocalSlots] of oldCounts) {
		const desiredLocalSlots = newCounts.get(route) ?? 0
		if (desiredLocalSlots < liveLocalSlots) {
			out.push({ route, liveLocalSlots, desiredLocalSlots })
		}
	}
	// A route that only appears in NEW cannot have LOST slots, so NEW-only routes
	// are not reported.
	return out
}

/**
 * The count of distinct local-slot Target_Identifiers reachable from each
 * Public_Route combo on this instance, computed from a compiled
 * Desired_Route_State. A Public_Route is a non-hidden combo whose name is a
 * declared lane name; its reachable local slots are the `t:`-prefixed refs of
 * the route combo plus the `t:`-prefixed refs of every Internal_Pool it combo-
 * refs (transitively).
 */
function localSlotCountsByRoute(model: FleetInventory, rev: Revision, instanceId: string): Map<string, number> {
	const compiled = compile(model, rev)
	if (!compiled.ok) {
		// A non-compiling revision contributes no counts; the NEW inventory is
		// expected to compile (the base `plan()` would have thrown first), and an
		// OLD inventory that does not compile simply yields no "live" baseline.
		return new Map()
	}
	const state: DesiredRouteState | undefined = compiled.states.get(instanceId)
	if (!state) {
		return new Map()
	}

	const byName = new Map(state.combos.map((c) => [c.name, c]))
	const publicRouteNames = new Set<string>()
	for (const lane of model.lanes) {
		// names[0] is the Public_Route (Requirement 1.7); its aliases share its lane
		// and therefore its slot set, but Requirement 12.6 reports per Public_Route.
		publicRouteNames.add(lane.names[0]!)
	}

	const counts = new Map<string, number>()
	for (const route of publicRouteNames) {
		const combo = byName.get(route)
		if (!combo) {
			continue
		}
		counts.set(route, countLocalSlots(combo, byName))
	}
	return counts
}

/** Distinct `t:` Target_Identifiers reachable from a combo through combo-refs. */
function countLocalSlots(root: Combo, byName: ReadonlyMap<string, Combo>): number {
	const slotIds = new Set<string>()
	const seen = new Set<string>()
	const stack: Combo[] = [root]
	while (stack.length > 0) {
		const combo = stack.pop()!
		if (seen.has(combo.name)) {
			continue
		}
		seen.add(combo.name)
		for (const ref of combo.models) {
			if (ref.kind === "combo-ref" && ref.comboName) {
				const dep = byName.get(ref.comboName)
				if (dep) {
					stack.push(dep)
				}
			} else if (ref.id.startsWith("t:")) {
				slotIds.add(ref.id)
			}
		}
	}
	return slotIds.size
}

// ---------------------------------------------------------------------------
// Op projection
// ---------------------------------------------------------------------------

/**
 * Project a connection deactivation / context-override removal into the ordered
 * `ops` list. `ChangeOp.kind` is `"combo" | "setting"`, so a deactivation and an
 * override removal (neither a combo) are carried as `setting`-kinded ops whose
 * `id` namespaces the object (`connection:…` / `context-override:…`) and whose
 * `before`/`after` records the intended patch. This gives the apply path a single
 * ordered list to walk; the plan's typed `connectionDeactivations` and
 * `contextOverrideRemovals` arrays remain the authoritative, well-typed source
 * and preserve the connection/endpoint/model detail the projected op elides.
 */
function toDeactivationOp(deactivation: ConnectionDeactivation): ChangeOp {
	return {
		kind: "setting",
		op: "update",
		id: `connection:${deactivation.connectionId}`,
		after: { isActive: false, endpointId: deactivation.endpointId },
	}
}

function toContextOverrideOp(removal: ContextOverrideRemoval): ChangeOp {
	return {
		kind: "setting",
		op: "delete",
		id: `context-override:${removal.modelId}`,
		before: { model: removal.modelId },
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The lowercased `host:port` of a URL, or undefined when it cannot be parsed. */
function hostPort(url: string): string | undefined {
	try {
		return new URL(url).host.toLowerCase()
	} catch {
		return undefined
	}
}

/**
 * Verify Requirement 12.2 for a reporting/test caller: given the OLD offering
 * that was dropped and the NEW offering that replaces it (same capability tags),
 * return the lanes in which the replacement is eligible. The compiler places the
 * replacement into exactly these lanes; a caller compares this set against the
 * lanes the old offering occupied to confirm the substitution covered every
 * eligible lane. Pure; reads only the inventory.
 */
export function replacementEligibleLanes(
	newModel: FleetInventory,
	replacement: ModelOffering,
): readonly string[] {
	const lanes: string[] = []
	for (const lane of newModel.lanes) {
		if (eligibleOfferingSlots(replacement, lane).length > 0) {
			lanes.push(lane.id)
		}
	}
	return lanes
}

/** Identity helper so tests can assert on a dropped offering's slot Target_Identifier. */
export function offeringSlotTargetId(offering: ModelOffering, slotIndex: number): string {
	return slotTargetId({ offering, slotIndex, rank: offering.ranks[slotIndex]! })
}
