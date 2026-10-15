// Route_Compiler — capacity, concurrency, and tier ceiling (design §2, steps 7 and 8).
//
// Third module of the pure Route_Compiler. Like targets.ts it is a pure function
// of the validated `FleetInventory` model plus a resolved Device_Allocation: no
// I/O, no clock, no env, no secrets. compiler.ts (task 3.4) calls these helpers
// to populate each combo's `config.concurrencyPerModel`, each local connection's
// `maxConcurrent`, the `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` Routing_Setting,
// and each Public_Route's `tierRouting.maximumTier`.
//
// Device_Allocation note (Requirement 1.4, 1.11): the `@roo-code/types`
// `FleetInventory` schema does NOT model per-device slot allocations as a typed
// field — the Inventory_Validator reads an optional `allocations` map off the
// loose, pre-validation device entry. The validated typed `Device` therefore
// carries only `slotCeiling` and `hostPreemption`. This compiler module accepts
// the Device_Allocation as a RESOLVED input: callers pass an allocation lookup
// (`DeviceAllocationLookup`) that answers "how many Slots does instance I hold on
// device D?". `resolveDeviceAllocation` provides the Requirement 1.11 default
// (ceiling → the single primary instance, 0 → every other instance) for the
// common case where the inventory declares no explicit allocation.

import type { Device, FleetInventory, Instance, Lane, ModelOffering, SpendClass } from "@roo-code/types"

/**
 * The resolved Device_Allocation lookup the capacity helpers depend on: for a
 * given device id and instance id, the number of that Device's Slots allocated
 * to that OmniRoute_Instance (Requirement 1.4, 1.11). 0 is a valid answer (the
 * instance holds no Slots on the device). An unknown device/instance pair
 * resolves to 0.
 */
export type DeviceAllocationLookup = (deviceId: string, instanceId: string) => number

/**
 * Resolve the Device_Allocation for one (device, instance) pair, applying the
 * Requirement 1.11 default. Because the validated typed `Device` does not model
 * explicit per-device allocations, this function implements ONLY the default:
 * the device allocates its full `slotCeiling` to the single `primary`
 * OmniRoute_Instance and 0 Slots to every other instance.
 *
 * When the inventory declares explicit `allocations` (read off the loose device
 * by the Inventory_Validator, Requirement 1.4), the caller should build a
 * `DeviceAllocationLookup` from those declared values instead of calling this;
 * compiler.ts (task 3.4) owns that wiring once the explicit allocations are
 * threaded through. Until then this default matches the validator's own
 * `resolveAllocations` fallback branch.
 *
 * The device id is validated against the inventory so a typo resolves to 0
 * rather than silently handing out a ceiling to a non-existent device.
 */
export function resolveDeviceAllocation(inventory: FleetInventory, deviceId: string, instanceId: string): number {
	const device = inventory.devices.find((d) => d.id === deviceId)
	if (!device) return 0
	const primaryId = primaryInstanceId(inventory)
	return instanceId === primaryId ? device.slotCeiling : 0
}

/**
 * Build a `DeviceAllocationLookup` closed over an inventory, applying the
 * Requirement 1.11 default for every (device, instance) pair. Convenience for
 * compiler.ts and tests so a single lookup can be passed to the per-offering and
 * per-device helpers.
 */
export function defaultAllocationLookup(inventory: FleetInventory): DeviceAllocationLookup {
	return (deviceId, instanceId) => resolveDeviceAllocation(inventory, deviceId, instanceId)
}

/** The id of the single `primary` OmniRoute_Instance, or undefined if not exactly one. */
function primaryInstanceId(inventory: FleetInventory): string | undefined {
	const primaries = inventory.instances.filter((inst) => inst.role === "primary")
	return primaries.length === 1 ? primaries[0]!.id : undefined
}

/**
 * The per-(Model_Offering, OmniRoute_Instance) concurrency bound: the OmniRoute
 * instance may never have more in-flight attempts on a Model_Offering than the
 * lesser of the offering's slot count and the instance's Device_Allocation on
 * the offering's Device (Requirement 7.2). An allocation of 0 bounds the
 * offering to 0 in-flight attempts on that instance.
 */
export function offeringConcurrency(offering: ModelOffering, allocation: number): number {
	return Math.min(offering.slots, Math.max(0, allocation))
}

/**
 * `concurrencyPerModel` for a local target (a compiled Slot of a Model_Offering),
 * written into the combo config. It is bounded by the same rule as
 * `offeringConcurrency`: min(slot count, Device_Allocation) for the compiling
 * instance (Requirements 7.1, 7.2). Design §2 step 7 describes this as "the Slot
 * count", which holds when the instance's Device_Allocation covers every Slot
 * (the Requirement 1.11 primary default); the min() keeps a partially-allocated
 * secondary within its share.
 */
export function concurrencyPerModel(offering: ModelOffering, allocation: number): number {
	return offeringConcurrency(offering, allocation)
}

/**
 * The per-Device concurrency bound for one OmniRoute_Instance: the instance may
 * never have more in-flight attempts on a Device than its Device_Allocation,
 * counted across every Model_Offering and Serving_Endpoint on the Device
 * (Requirement 7.3). This is simply the Device_Allocation (clamped to be
 * non-negative); the per-offering bounds live under it.
 */
export function deviceConcurrency(allocation: number): number {
	return Math.max(0, allocation)
}

/**
 * The `maxConcurrent` of a local OmniRoute connection to a Serving_Endpoint for
 * one OmniRoute_Instance (Requirements 7.1, 7.3). A connection to a Serving_
 * Endpoint carries at most the sum, over the endpoint's bound Devices, of each
 * Device's per-instance bound — the lesser of the Slots the endpoint's offerings
 * declare on that Device and the instance's Device_Allocation there. This keeps
 * one connection from admitting more concurrent generations than the Devices it
 * fronts can serve for this instance.
 *
 * `offerings` are the Model_Offerings served by this endpoint (compiler.ts filters
 * them by `endpointId`); `allocationFor(deviceId)` returns the instance's
 * Device_Allocation on each Device the endpoint is bound to.
 */
export function connectionMaxConcurrent(
	offerings: readonly ModelOffering[],
	allocationFor: (deviceId: string) => number,
): number {
	// Sum of per-offering bounds, but a Device's contribution can never exceed its
	// own Device_Allocation (Requirement 7.3), so cap the per-device sum.
	const perDeviceSlotDemand = new Map<string, number>()
	for (const offering of offerings) {
		perDeviceSlotDemand.set(offering.deviceId, (perDeviceSlotDemand.get(offering.deviceId) ?? 0) + offering.slots)
	}
	let total = 0
	for (const [deviceId, slotDemand] of perDeviceSlotDemand) {
		total += Math.min(slotDemand, deviceConcurrency(allocationFor(deviceId)))
	}
	return total
}

/**
 * The provider name of a local Serving_Endpoint (e.g. `vllm`, `ollama-local`,
 * `llama-cpp`, `ovms-arc`). Local providers are everything that serves a
 * Model_Offering — i.e. every provider named on a declared endpoint, as opposed
 * to a Cloud_Target's provider.
 */
export const OMNIROUTE_HARD_CONCURRENCY_PROVIDERS_SETTING = "OMNIROUTE_HARD_CONCURRENCY_PROVIDERS" as const

/**
 * Every local provider of the Fleet_Inventory, de-duplicated and sorted for a
 * stable, order-insensitive Routing_Setting value (Requirements 7.5, 7.6). The
 * compiler lists these in the `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` Routing_
 * Setting so OmniRoute's `connectionConcurrencyGate` treats a saturated local
 * target as a hard cap and skips to the next ordered target instead of queuing.
 *
 * Providers are collected from the inventory's Serving_Endpoints only; Cloud_
 * Target providers are never hard-concurrency providers (their concurrency is a
 * soft, rate-limited cap, not a slot cap).
 */
export function localProviders(inventory: FleetInventory): string[] {
	const providers = new Set<string>()
	for (const endpoint of inventory.endpoints) {
		providers.add(endpoint.provider)
	}
	return [...providers].sort()
}

/**
 * The `OMNIROUTE_HARD_CONCURRENCY_PROVIDERS` Routing_Setting entry: the setting
 * name and its value (the sorted, de-duplicated local provider list). compiler.ts
 * (task 3.4) folds this into each Managed_Instance's `routingSettings`.
 */
export interface HardConcurrencyProvidersSetting {
	readonly name: typeof OMNIROUTE_HARD_CONCURRENCY_PROVIDERS_SETTING
	readonly providers: readonly string[]
}

/** Build the hard-concurrency-providers Routing_Setting for an inventory. */
export function hardConcurrencyProvidersSetting(inventory: FleetInventory): HardConcurrencyProvidersSetting {
	return { name: OMNIROUTE_HARD_CONCURRENCY_PROVIDERS_SETTING, providers: localProviders(inventory) }
}

/**
 * The `tierRouting.maximumTier` ceiling of a Public_Route (Requirements 6.8, 7).
 * It encodes which target tiers the route may ever dispatch to, mirroring the
 * `X-OmniRoute-Tier` request-header contract:
 *
 *   - 1 → local Slots only;
 *   - 2 → local Slots + `free` Cloud_Targets;
 *   - 3 → local Slots + `free` + `low-budget` Cloud_Targets;
 *   - 4/5/absent/invalid → every target compiled into the route.
 *
 * We represent "absent / all tiers permitted" as `undefined` so a route with no
 * ceiling omits `maximumTier` entirely, matching the live FEAT-005 behavior
 * where 4, 5, an absent header, or any non-1..5 value permits all targets.
 */
export type MaximumTier = 1 | 2 | 3 | undefined

/** The `tierRouting` block written into a Public_Route's combo config. */
export interface TierRouting {
	readonly maximumTier: MaximumTier
}

/**
 * Map a lane's spend ceiling (`maxSpend`) to the Public_Route's `maximumTier`
 * (Requirements 6.8, 7). A lane that admits no cloud spill (`maxSpend` is `free`
 * but the lane declares no spill tiers) still maps by its spend ceiling: the
 * tier ceiling bounds what the route MAY dispatch to, independent of whether the
 * lane actually configured spill.
 *
 *   - maxSpend `free`       → maximumTier 2 (local + free);
 *   - maxSpend `low-budget` → maximumTier 3 (local + free + low-budget);
 *   - maxSpend `paid`       → undefined     (all tiers; no ceiling).
 *
 * A local-only lane — one with no spill tiers — is capped at tier 1 regardless
 * of `maxSpend`, since no Cloud_Target can be reached. This yields the
 * value-1-local-only end of the contract.
 */
export function laneMaximumTier(lane: Lane): MaximumTier {
	if (lane.spillTiers.length === 0) return 1
	switch (lane.maxSpend) {
		case "free":
			return 2
		case "low-budget":
			return 3
		case "paid":
			return undefined
	}
}

/**
 * Build the `tierRouting` block for a lane's Public_Route. Returned so compiler.ts
 * can spread it into the combo config; a route with no ceiling (`maximumTier`
 * undefined) still carries the block, letting the compiler decide whether to omit
 * the key when it serializes the live combo config.
 */
export function laneTierRouting(lane: Lane): TierRouting {
	return { maximumTier: laneMaximumTier(lane) }
}

/**
 * Classify a Spend_Class to the `X-OmniRoute-Tier` value that first admits it:
 * `free` is first admitted at tier 2, `low-budget` at tier 3, `paid` only when
 * no ceiling applies (all tiers). Exposed for compiler.ts/tests that reason about
 * the ceiling→Spend_Class mapping; the inverse of the tier→permitted-spend table
 * in Requirement 6.8.
 */
export function spendClassFirstTier(spend: SpendClass): 2 | 3 | undefined {
	switch (spend) {
		case "free":
			return 2
		case "low-budget":
			return 3
		case "paid":
			return undefined
	}
}

// Re-export the typed inputs these helpers operate on, so compiler.ts can import
// capacity's view of the model without reaching back into @roo-code/types.
export type { Device, Instance, ModelOffering }
