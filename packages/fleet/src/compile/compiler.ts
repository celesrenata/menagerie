// Route_Compiler — assemble the Desired_Route_State and Published_Route_Metadata
// (design §2, steps 4-9). This is the keystone module: it composes the three
// sibling modules (targets.ts, order.ts, capacity.ts) into one pure function
// from a validated `FleetInventory` plus a `Revision` to a map of
// `instanceId → DesiredRouteState`.
//
// Purity / determinism (Requirement 5.2): the output depends ONLY on the model
// and the revision. There is no clock, locale, environment, secret, or
// live-OmniRoute-state input, and nothing in this module reads any of those.
// `crypto.createHash` reached through order.ts's `poolName` is a pure transform
// of its input, so it does not compromise determinism. The one piece of
// mutable identity — the OmniRoute `connectionId` — is deliberately left empty:
// the inventory names endpoints, not live connection UUIDs, and the Reconciler
// resolves `connectionId`s at plan time against the live `GET /api/providers`
// (design §3). Leaving it empty here keeps compilation independent of live
// state (Requirement 5.2) and is documented on `ComboModelRef.connectionId`.
//
// The compiler reuses the live combo shape from `../omniroute/client.ts`
// (`Combo`, `ComboModelRef`) rather than redefining it, so the compiler's
// output and the client's `listCombos()` result are the SAME type. Drift
// detection (task 5.1) compares `DesiredRouteState.combos` against live combos
// field-by-field, so sharing the type is what makes that comparison sound.

import type { FleetInventory, Instance, Lane, ModelOffering } from "@roo-code/types"

import type { Combo, ComboModelRef } from "../omniroute/client.js"
import {
	concurrencyPerModel,
	defaultAllocationLookup,
	hardConcurrencyProvidersSetting,
	laneTierRouting,
	type DeviceAllocationLookup,
	type MaximumTier,
} from "./capacity.js"
import {
	dedupPools,
	orderLaneTargets,
	poolName,
	reachablePools,
	type DispatchConfig,
	type InternalPool,
	type OrderedLaneTargets,
	type PoolIdentity,
} from "./order.js"
import {
	cloudTargetId,
	slotTargetId,
	type Slot,
} from "./targets.js"

// ---------------------------------------------------------------------------
// Public types (design §2 interfaces)
// ---------------------------------------------------------------------------

/**
 * The Fleet_Inventory_Revision of the compiled document (Requirement 5.6, 5.10).
 * `commit` is the version-control commit id; `uncommitted` is set by the caller
 * when the document is dirty or not under version control. The compiler never
 * discovers either value itself (that would read the environment and break
 * determinism); it only records what the caller supplies.
 */
export type Revision = { readonly commit: string; readonly uncommitted: boolean }

/** The per-name route kind published in the metadata (Requirement 4.11). */
export type RouteKind = "public" | "alias" | "internal" | "diagnostic"

/**
 * One RouteCapacity record (Requirement 14.1), shaped to the elastic-parallel-
 * execution RouteCapacity contract: a Public_Route name and the number of
 * distinct local Slots compiled as its targets on the primary instance, each
 * Device capped at its Device_Allocation on the primary.
 */
export interface RouteCapacity {
	readonly route: string
	readonly capacity: number
}

/** The published Model_Swap_Load_Latency of one Residency_Group (Requirement 14.3). */
export interface ResidencySwapLatency {
	readonly residencyGroup: string
	readonly swapLatencyMs: number
	/** Public_Routes whose compiled targets include a Slot of this Residency_Group. */
	readonly routes: readonly string[]
}

/**
 * The Published_Route_Metadata of one Managed_Instance (Requirements 4.11, 13.1,
 * 14.1, 14.2, 14.3).
 */
export interface PublishedRouteMetadata {
	/** The kind of every combo name in the Desired_Route_State (Requirement 4.11). */
	readonly kinds: Readonly<Record<string, RouteKind>>
	/** Route context window = lane minContext, per Public_Route and Route_Alias (Requirement 13.1). */
	readonly contextWindows: Readonly<Record<string, number>>
	/** One RouteCapacity record per Public_Route (Requirement 14.1). */
	readonly capacities: readonly RouteCapacity[]
	/** Capability_Lane → Public_Route name (Requirement 14.2). */
	readonly capabilityLaneRoutes: Readonly<Record<string, string>>
	/** Per-Residency_Group swap latency for groups with >1 Model_Offering (Requirement 14.3). */
	readonly swapLatencies: readonly ResidencySwapLatency[]
}

/** A Routing_Setting entry of a Desired_Route_State. */
export interface RoutingSetting {
	readonly name: string
	readonly value: unknown
}

/** The complete Desired_Route_State of one Managed_Instance (design §2). */
export interface DesiredRouteState {
	readonly combos: Combo[]
	readonly routingSettings: RoutingSetting[]
	readonly publishedMetadata: PublishedRouteMetadata
}

/** One compilation failure, naming the offender(s) (Requirements 5.7, 5.9, 13.6). */
export interface CompileFailure {
	readonly code: "lane-no-eligible-target" | "target-below-lane-minimum"
	readonly message: string
	readonly laneId: string
	readonly instanceId: string
	/** For `target-below-lane-minimum`: the offending targets with their context. */
	readonly offenders?: readonly { readonly targetId: string; readonly context: number }[]
}

export type CompileResult =
	| { readonly ok: true; readonly states: Map<string, DesiredRouteState> }
	| { readonly ok: false; readonly failures: CompileFailure[] }

export interface RouteCompiler {
	compile(model: FleetInventory, revision: Revision): CompileResult
}

// ---------------------------------------------------------------------------
// Live combo config
// ---------------------------------------------------------------------------

/**
 * The live-snapshot combo config keys the compiler is allowed to emit (design §2
 * "Mapping onto the live combo schema"). Any key NOT in this set — plus the
 * compiler-added `fleetRevision` provenance key — is stripped, which is how the
 * three dead config keys OmniRoute strips (`stripDeadComboConfigKeys`) are kept
 * out of generated combos.
 *
 * The design names the live-snapshot key set but does not spell out the three
 * dead key names, so the compiler implements the stripping boundary rather than
 * a hard-coded dead-key list: it emits only these allowed keys plus
 * `fleetRevision`, and nothing else can appear. If OmniRoute later adds a live
 * key, add it here.
 */
const ALLOWED_CONFIG_KEYS = [
	"maxRetries",
	"targetTimeoutMs",
	"concurrencyPerModel",
	"queueTimeoutMs",
	"nestedComboMode",
	"tierRouting",
	"failoverBeforeRetry",
	"trackMetrics",
	"dispatchSequence",
] as const

/** The provenance key the compiler adds beyond the live-snapshot keys (design §2). */
const FLEET_REVISION_KEY = "fleetRevision" as const

/**
 * Strip any config key that is neither an allowed live-snapshot key nor the
 * `fleetRevision` provenance key (design §2 `stripDeadComboConfigKeys`). This is
 * the stripping boundary: the output can only ever contain the allowed keys plus
 * `fleetRevision`, so a dead key can never leak into a generated combo.
 */
function stripDeadComboConfigKeys(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const allowed = new Set<string>([...ALLOWED_CONFIG_KEYS, FLEET_REVISION_KEY])
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(config)) {
		if (allowed.has(key)) {
			out[key] = config[key]
		}
	}
	return out
}

/** The revision string recorded in `config.fleetRevision` (Requirement 5.6, 5.10). */
function revisionString(revision: Revision): string {
	return revision.uncommitted ? `${revision.commit}-dirty` : revision.commit
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile a validated `FleetInventory` at a `Revision` into one
 * `DesiredRouteState` per Managed_Instance (none for `retired`), or a failure
 * result that names every offender (Requirement 5.1, 5.7, 5.9, 13.6). No partial
 * output: if any instance fails, the whole result is a failure.
 */
export function compile(model: FleetInventory, revision: Revision): CompileResult {
	const allocationLookup = defaultAllocationLookup(model)
	const primary = model.instances.find((inst) => inst.role === "primary")

	// Pre-order the lane targets of the primary once; the per-instance capacity
	// is derived from each instance's Device_Allocation, but target ELIGIBILITY
	// and ORDER are instance-independent (they depend only on offering/cloud
	// identity and the lane). RouteCapacity (Requirement 14.1) is always measured
	// against the primary, so we keep the primary's ordered targets for it.
	const primaryOrdered = primary ? orderLanesForInstance(model) : new Map<string, OrderedLaneTargets>()

	const states = new Map<string, DesiredRouteState>()
	const failures: CompileFailure[] = []

	for (const instance of model.instances) {
		if (instance.role === "retired") {
			continue // Requirement 5.1 — nothing compiled for a retired instance.
		}
		const result = compileInstance(model, revision, instance, allocationLookup, primaryOrdered)
		if (result.ok) {
			states.set(instance.id, result.state)
		} else {
			failures.push(...result.failures)
		}
	}

	// No partial output (Requirement 5.7, 5.9): a single offender fails the run.
	if (failures.length > 0) {
		return { ok: false, failures }
	}
	return { ok: true, states }
}

/** The default `RouteCompiler` implementation. */
export const routeCompiler: RouteCompiler = { compile }

// ---------------------------------------------------------------------------
// Per-instance compilation
// ---------------------------------------------------------------------------

type InstanceResult =
	| { readonly ok: true; readonly state: DesiredRouteState }
	| { readonly ok: false; readonly failures: CompileFailure[] }

function compileInstance(
	model: FleetInventory,
	revision: Revision,
	instance: Instance,
	allocationLookup: DeviceAllocationLookup,
	primaryOrdered: ReadonlyMap<string, OrderedLaneTargets>,
): InstanceResult {
	const rev = revisionString(revision)
	const failures: CompileFailure[] = []

	// Order every lane's targets for THIS instance. Eligibility/order are
	// instance-independent, so this matches the primary's ordering; the primary's
	// pre-computed map is reused when present to avoid recomputation.
	const orderedByLane = orderLanesForInstance(model)

	// --- Validate eligibility and lane-minimum per lane (Req 5.7, 13.6) -------
	for (const lane of model.lanes) {
		const ordered = orderedByLane.get(lane.id)!
		const hasLocal = ordered.localSlots.length > 0
		const hasCloud = ordered.spill.tiers.some((tier) => tier.clouds.length > 0)
		if (!hasLocal && !hasCloud) {
			failures.push({
				code: "lane-no-eligible-target",
				laneId: lane.id,
				instanceId: instance.id,
				message: `Lane '${lane.id}' has no eligible target on instance '${instance.id}'`,
			})
			continue
		}
		// Requirement 13.6: a compiled target below the lane minimum stops
		// compilation. Eligibility already excludes short-context targets, so this
		// is a defensive guard that names any offender that slipped through.
		const offenders = collectBelowMinimum(ordered, lane)
		if (offenders.length > 0) {
			failures.push({
				code: "target-below-lane-minimum",
				laneId: lane.id,
				instanceId: instance.id,
				message: `Lane '${lane.id}' on instance '${instance.id}' has target(s) below the lane minimum context ${lane.minContext}`,
				offenders,
			})
		}
	}

	if (failures.length > 0) {
		return { ok: false, failures }
	}

	// --- Build Internal_Pools, Public_Routes, aliases, diagnostics ------------
	const combos: Combo[] = []
	const kinds: Record<string, RouteKind> = {}
	const contextWindows: Record<string, number> = {}

	// Collect pool identities first, then dedup so shared (targets, config)
	// collapse to one Internal_Pool (Requirement 5.4). Map each lane to the pool
	// name its Public_Route references.
	const poolIdentityByLane = new Map<string, PoolIdentity>()
	const poolIdentities: PoolIdentity[] = []
	for (const lane of model.lanes) {
		const ordered = orderedByLane.get(lane.id)!
		const identity = poolIdentityForLane(ordered, lane, instance, allocationLookup)
		poolIdentityByLane.set(lane.id, identity)
		poolIdentities.push(identity)
	}

	// Diagnostic pools: one per declared diagnostic, pinned to its device's slots
	// on this instance (Requirement 4.5). Only emitted on an instance that serves
	// the device (i.e. holds a non-zero allocation / has an offering on it).
	const diagnosticPoolByName = new Map<string, PoolIdentity>()
	for (const diagnostic of model.diagnostics) {
		const slots = deviceSlots(model, diagnostic.deviceId)
		if (slots.length === 0) {
			continue
		}
		const identity: PoolIdentity = {
			targetIds: slots.map((slot) => slotTargetId(slot)),
			config: diagnosticDispatchConfig(),
		}
		diagnosticPoolByName.set(diagnostic.id, identity)
		poolIdentities.push(identity)
	}

	const pools = dedupPools(poolIdentities)

	// Root pool names referenced directly by a Public_Route or Diagnostic_Route.
	const rootPoolNames = new Set<string>()
	for (const identity of poolIdentityByLane.values()) {
		rootPoolNames.add(poolName(identity))
	}
	for (const identity of diagnosticPoolByName.values()) {
		rootPoolNames.add(poolName(identity))
	}

	// Internal_Pools are flat here (no pool nests another), so references() is
	// empty for every pool. reachablePools still drops any empty / unreferenced
	// pool (Requirement 5.5).
	const reachable = reachablePools(pools, [...rootPoolNames], () => [])

	// Emit the reachable Internal_Pool combos.
	for (const pool of reachable) {
		combos.push(internalPoolCombo(pool, rev))
		kinds[pool.name] = "internal"
	}

	// Emit one Public_Route per lane, plus aliases (Requirement 4.1, 4.3, 4.6).
	for (const lane of model.lanes) {
		const identity = poolIdentityByLane.get(lane.id)!
		const pName = poolName(identity)
		const [publicName, ...aliasNames] = lane.names
		// Public_Route: a combo-ref to the lane's Internal_Pool (Requirement 5.11 —
		// a combo-ref never references itself; the pool name is content-hashed and
		// distinct from the Public_Route name).
		combos.push(publicRouteCombo(publicName!, pName, lane, rev))
		kinds[publicName!] = "public"
		contextWindows[publicName!] = lane.minContext
		// Route_Aliases: each further name is an alias combo that refs the SAME pool.
		for (const alias of aliasNames) {
			combos.push(aliasCombo(alias, pName, lane, rev))
			kinds[alias] = "alias"
			contextWindows[alias] = lane.minContext
		}
	}

	// Emit Diagnostic_Routes (Requirement 4.5) — kind `diagnostic`, outside the
	// client-selectable catalog.
	for (const diagnostic of model.diagnostics) {
		const identity = diagnosticPoolByName.get(diagnostic.id)
		if (!identity) {
			continue
		}
		const pName = poolName(identity)
		combos.push(diagnosticCombo(diagnostic.id, pName, rev))
		kinds[diagnostic.id] = "diagnostic"
	}

	// --- Routing_Settings -----------------------------------------------------
	const hardConcurrency = hardConcurrencyProvidersSetting(model)
	const routingSettings: RoutingSetting[] = [
		{ name: hardConcurrency.name, value: [...hardConcurrency.providers] },
	]

	// --- Published metadata (Requirements 4.11, 13.1, 14.1, 14.2, 14.3) -------
	const publishedMetadata: PublishedRouteMetadata = {
		kinds,
		contextWindows,
		capacities: buildRouteCapacities(model, primaryOrdered),
		capabilityLaneRoutes: buildCapabilityLaneRoutes(model),
		swapLatencies: buildSwapLatencies(model, orderedByLane),
	}

	return {
		ok: true,
		state: { combos, routingSettings, publishedMetadata },
	}
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Order every lane's targets (instance-independent eligibility + fill-first order). */
function orderLanesForInstance(model: FleetInventory): Map<string, OrderedLaneTargets> {
	const byLane = new Map<string, OrderedLaneTargets>()
	for (const lane of model.lanes) {
		byLane.set(lane.id, orderLaneTargets(model.offerings, model.clouds, lane))
	}
	return byLane
}

/** Targets compiled into a lane whose context is below the lane minimum (Req 13.6). */
function collectBelowMinimum(ordered: OrderedLaneTargets, lane: Lane): { targetId: string; context: number }[] {
	const offenders: { targetId: string; context: number }[] = []
	for (const slot of ordered.localSlots) {
		if (slot.offering.context < lane.minContext) {
			offenders.push({ targetId: slotTargetId(slot), context: slot.offering.context })
		}
	}
	for (const tier of ordered.spill.tiers) {
		for (const cloud of tier.clouds) {
			if (cloud.context < lane.minContext) {
				offenders.push({ targetId: cloudTargetId(cloud), context: cloud.context })
			}
		}
	}
	return offenders
}

// ---------------------------------------------------------------------------
// Pool identity + combo construction
// ---------------------------------------------------------------------------

/** The ordered Target_Identifiers of a lane: local slots first, then cloud tiers. */
function laneTargetIds(ordered: OrderedLaneTargets): string[] {
	const ids: string[] = ordered.localSlots.map((slot) => slotTargetId(slot))
	for (const tier of ordered.spill.tiers) {
		for (const cloud of tier.clouds) {
			ids.push(cloudTargetId(cloud))
		}
	}
	return ids
}

/**
 * The dispatch-affecting config of a lane's Internal_Pool (Requirement 5.4). It
 * carries only keys that change how OmniRoute dispatches — NOT `fleetRevision`
 * (a revision bump must not fork a pool). The `concurrencyPerModel` map is the
 * per-local-target bound derived from slot counts and this instance's Device_
 * Allocation (Requirement 7.1, 7.2).
 */
function poolIdentityForLane(
	ordered: OrderedLaneTargets,
	lane: Lane,
	instance: Instance,
	allocationLookup: DeviceAllocationLookup,
): PoolIdentity {
	const tier = laneTierRouting(lane)
	const concurrency = buildConcurrencyPerModel(ordered.localSlots, instance, allocationLookup)
	const config: DispatchConfig = {
		tierRouting: tierRoutingConfig(tier.maximumTier),
		concurrencyPerModel: concurrency,
		nestedComboMode: "execute",
		failClosedWhenExhausted: ordered.spill.tiers.some((t) => t.failClosedWhenExhausted),
	}
	return { targetIds: laneTargetIds(ordered), config }
}

/** Per-model concurrency map, keyed by model id, bounded by min(slots, allocation). */
function buildConcurrencyPerModel(
	localSlots: readonly Slot[],
	instance: Instance,
	allocationLookup: DeviceAllocationLookup,
): Readonly<Record<string, number>> {
	const byModel: Record<string, number> = {}
	const seenOfferings = new Set<string>()
	for (const slot of localSlots) {
		const offering = slot.offering
		if (seenOfferings.has(offering.id)) {
			continue
		}
		seenOfferings.add(offering.id)
		const allocation = allocationLookup(offering.deviceId, instance.id)
		byModel[offering.modelId] = concurrencyPerModel(offering, allocation)
	}
	return byModel
}

/** Serialize a MaximumTier to the tierRouting config block (omit when undefined). */
function tierRoutingConfig(maximumTier: MaximumTier): Readonly<Record<string, unknown>> {
	return maximumTier === undefined ? {} : { maximumTier }
}

/** The dispatch config of a Diagnostic_Route's Internal_Pool (local-only, tier 1). */
function diagnosticDispatchConfig(): DispatchConfig {
	return {
		tierRouting: { maximumTier: 1 },
		nestedComboMode: "execute",
	}
}

/** All Slots of every Model_Offering on a Device (used for Diagnostic_Routes). */
function deviceSlots(model: FleetInventory, deviceId: string): Slot[] {
	const slots: Slot[] = []
	for (const offering of model.offerings) {
		if (offering.deviceId !== deviceId) {
			continue
		}
		for (let slotIndex = 0; slotIndex < offering.slots; slotIndex++) {
			slots.push({ offering, slotIndex, rank: offering.ranks[slotIndex]! })
		}
	}
	return slots
}

/**
 * The combo config of a Public_Route / alias / diagnostic. Built from the pool's
 * dispatch config, with `fleetRevision` added, then stripped to the allowed key
 * set. The config is passed through `stripDeadComboConfigKeys` so only live-
 * snapshot keys plus `fleetRevision` survive.
 */
function comboConfig(dispatchConfig: Readonly<Record<string, unknown>>, rev: string): Readonly<Record<string, unknown>> {
	return stripDeadComboConfigKeys({ ...dispatchConfig, [FLEET_REVISION_KEY]: rev })
}

/** Model refs that resolve each Target_Identifier of a pool to a combo model ref. */
function poolModelRefs(pool: InternalPool): ComboModelRef[] {
	return pool.targetIds.map((targetId) => targetRef(targetId))
}

/**
 * One combo model ref for a Target_Identifier. `connectionId` is deliberately
 * left unset: the inventory names endpoints, not live OmniRoute connection
 * UUIDs, so the Reconciler resolves `connectionId` at plan time against the live
 * `GET /api/providers` (design §3). `providerId` is likewise unresolved here.
 * The ref carries the Target_Identifier as its stable `id` and the model id (the
 * last `:`-segment for a slot, the provider+model for a cloud) as `model`.
 */
function targetRef(targetId: string): ComboModelRef {
	// Slot:  t:<deviceId>:<endpointId>:<modelId>:<slotIndex>
	// Cloud: c:<provider>:<modelId>
	if (targetId.startsWith("c:")) {
		const rest = targetId.slice(2)
		const sep = rest.indexOf(":")
		const provider = sep >= 0 ? rest.slice(0, sep) : rest
		const modelId = sep >= 0 ? rest.slice(sep + 1) : ""
		return { id: targetId, kind: "model", model: modelId, providerId: provider }
	}
	// Slot id: strip the trailing ":<slotIndex>", then take the model id segment.
	const rest = targetId.slice(2)
	const lastColon = rest.lastIndexOf(":")
	const withoutSlot = lastColon >= 0 ? rest.slice(0, lastColon) : rest
	const modelColon = withoutSlot.lastIndexOf(":")
	const modelId = modelColon >= 0 ? withoutSlot.slice(modelColon + 1) : withoutSlot
	return { id: targetId, kind: "model", model: modelId }
}

/** An Internal_Pool combo (strategy priority, hidden, model refs = its targets). */
function internalPoolCombo(pool: InternalPool, rev: string): Combo {
	return {
		id: pool.name,
		name: pool.name,
		strategy: "priority",
		models: poolModelRefs(pool),
		config: comboConfig(pool.config, rev),
		context_length: 0, // internal pools carry no published context window
		isHidden: true,
	}
}

/** A Public_Route combo: a single combo-ref to the lane's Internal_Pool. */
function publicRouteCombo(name: string, poolRefName: string, lane: Lane, rev: string): Combo {
	return {
		id: name,
		name,
		strategy: "priority",
		models: [{ id: `${name}->${poolRefName}`, kind: "combo-ref", comboName: poolRefName }],
		config: comboConfig(laneDispatchConfig(lane), rev),
		context_length: lane.minContext,
		isHidden: false,
	}
}

/** A Route_Alias combo: identical to its Public_Route, a combo-ref to the pool. */
function aliasCombo(name: string, poolRefName: string, lane: Lane, rev: string): Combo {
	return {
		id: name,
		name,
		strategy: "priority",
		models: [{ id: `${name}->${poolRefName}`, kind: "combo-ref", comboName: poolRefName }],
		config: comboConfig(laneDispatchConfig(lane), rev),
		context_length: lane.minContext,
		isHidden: false,
	}
}

/** A Diagnostic_Route combo: a combo-ref to the device-pinned Internal_Pool. */
function diagnosticCombo(name: string, poolRefName: string, rev: string): Combo {
	return {
		id: name,
		name,
		strategy: "priority",
		models: [{ id: `${name}->${poolRefName}`, kind: "combo-ref", comboName: poolRefName }],
		config: comboConfig(diagnosticDispatchConfig(), rev),
		context_length: 0,
		isHidden: true,
	}
}

/** The dispatch config written on a Public_Route / alias combo (tier ceiling). */
function laneDispatchConfig(lane: Lane): Readonly<Record<string, unknown>> {
	const tier = laneTierRouting(lane)
	return {
		tierRouting: tierRoutingConfig(tier.maximumTier),
		nestedComboMode: "execute",
	}
}

// ---------------------------------------------------------------------------
// Published metadata builders
// ---------------------------------------------------------------------------

/**
 * RouteCapacity per Public_Route (Requirement 14.1): the number of distinct
 * local Slots compiled as its targets in the PRIMARY instance's Desired_Route_
 * State, each Device capped at its Device_Allocation on the primary (the
 * Device_Slot_Ceiling where no allocation is recorded — the Requirement 1.11
 * default the allocation lookup applies).
 */
function buildRouteCapacities(
	model: FleetInventory,
	primaryOrdered: ReadonlyMap<string, OrderedLaneTargets>,
): RouteCapacity[] {
	const primary = model.instances.find((inst) => inst.role === "primary")
	const allocationLookup = defaultAllocationLookup(model)
	const capacities: RouteCapacity[] = []
	for (const lane of model.lanes) {
		const ordered = primaryOrdered.get(lane.id)
		const publicName = lane.names[0]!
		if (!primary || !ordered) {
			capacities.push({ route: publicName, capacity: 0 })
			continue
		}
		capacities.push({ route: publicName, capacity: countDistinctLocalSlots(ordered.localSlots, primary, allocationLookup) })
	}
	return capacities
}

/**
 * Count distinct local Slots, capping each Device's contribution at the primary's
 * Device_Allocation on that Device (Requirement 14.1). Distinct Slots are counted
 * by Target_Identifier so a Slot shared across lanes within a route is counted
 * once; here the input is one lane's ordered slots, already distinct.
 */
function countDistinctLocalSlots(
	localSlots: readonly Slot[],
	primary: Instance,
	allocationLookup: DeviceAllocationLookup,
): number {
	const slotsByDevice = new Map<string, Set<string>>()
	for (const slot of localSlots) {
		const device = slot.offering.deviceId
		let set = slotsByDevice.get(device)
		if (!set) {
			set = new Set<string>()
			slotsByDevice.set(device, set)
		}
		set.add(slotTargetId(slot))
	}
	let total = 0
	for (const [deviceId, ids] of slotsByDevice) {
		const allocation = allocationLookup(deviceId, primary.id)
		total += Math.min(ids.size, Math.max(0, allocation))
	}
	return total
}

/**
 * Capability_Lane → Public_Route map (Requirement 14.2): each declared
 * Capability_Lane is assigned the Public_Route (own name, not an alias) of the
 * Lane_Definition that declares it.
 */
function buildCapabilityLaneRoutes(model: FleetInventory): Record<string, string> {
	const map: Record<string, string> = {}
	for (const lane of model.lanes) {
		for (const capabilityLane of lane.capabilityLanes) {
			map[capabilityLane] = lane.names[0]!
		}
	}
	return map
}

/**
 * Per-Residency_Group swap latency (Requirement 14.3): for each Residency_Group
 * that contains more than one Model_Offering, the declared swap latency and the
 * Public_Routes whose compiled targets include a Slot of that group.
 */
function buildSwapLatencies(
	model: FleetInventory,
	orderedByLane: ReadonlyMap<string, OrderedLaneTargets>,
): ResidencySwapLatency[] {
	// Group offerings by Residency_Group.
	const offeringsByGroup = new Map<string, ModelOffering[]>()
	for (const offering of model.offerings) {
		const list = offeringsByGroup.get(offering.residencyGroup) ?? []
		list.push(offering)
		offeringsByGroup.set(offering.residencyGroup, list)
	}

	const out: ResidencySwapLatency[] = []
	for (const group of model.residencyGroups) {
		const members = offeringsByGroup.get(group.id) ?? []
		if (members.length <= 1) {
			continue // only groups with >1 Model_Offering publish a swap latency.
		}
		const memberOfferingIds = new Set(members.map((o) => o.id))
		const routes: string[] = []
		for (const lane of model.lanes) {
			const ordered = orderedByLane.get(lane.id)
			if (!ordered) {
				continue
			}
			const touches = ordered.localSlots.some((slot) => memberOfferingIds.has(slot.offering.id))
			if (touches) {
				routes.push(lane.names[0]!)
			}
		}
		out.push({ residencyGroup: group.id, swapLatencyMs: group.swapLatencyMs, routes })
	}
	return out
}
