// Route_Compiler — target identity and lane eligibility (design §2, step 1 and 4).
//
// This is the first module of the pure Route_Compiler. It is a pure function of
// the validated `FleetInventory` model: no I/O, no clock, no env, no secrets.
// Later modules (order.ts, capacity.ts, compiler.ts) build on the Target and the
// eligibility predicates defined here.
//
// A Target is one dispatchable endpoint a Public_Route can route to: either a
// Slot (one slot index of a Model_Offering served on one Device via one
// Endpoint) or a Cloud_Target (one cloud model at a Spend_Class).

import { spendClass, type CloudTarget, type Lane, type ModelOffering, type SpendClass } from "@roo-code/types"

/**
 * A Slot: one serving slot of a Model_Offering. The compiler enumerates one Slot
 * per slot index of an offering. `slotIndex` is 0-based: it ranges from 0 to
 * `offering.slots - 1`, and indexes directly into `offering.ranks` so each Slot
 * carries its own Performance_Rank (`offering.ranks[slotIndex]`).
 */
export interface Slot {
	readonly offering: ModelOffering
	/** 0-based slot index, 0 ≤ slotIndex < offering.slots. */
	readonly slotIndex: number
	/** Performance_Rank for this slot, i.e. offering.ranks[slotIndex] (1 = best). */
	readonly rank: number
}

/** A compiler target is either a local Slot or a Cloud_Target. */
export type Target = { readonly kind: "slot"; readonly slot: Slot } | { readonly kind: "cloud"; readonly cloud: CloudTarget }

/**
 * The stable Target_Identifier (Requirement 5.3). Derived ONLY from identity, so
 * that changing a Slot's rank, context, tags, or lane membership leaves the id
 * unchanged — this keeps metrics comparable across route regenerations
 * (Requirement 17.6).
 *
 *   - Slot:         `t:<deviceId>:<endpointId>:<modelId>:<slotIndex>`  (slotIndex 0-based)
 *   - Cloud_Target: `c:<provider>:<modelId>`
 *
 * Note: rank/context/tags/lane membership are deliberately NOT part of the id.
 */
export function targetId(target: Target): string {
	if (target.kind === "slot") {
		const { offering, slotIndex } = target.slot
		return `t:${offering.deviceId}:${offering.endpointId}:${offering.modelId}:${slotIndex}`
	}
	const { provider, modelId } = target.cloud
	return `c:${provider}:${modelId}`
}

/** Convenience: the Target_Identifier of a Slot without wrapping it in a Target. */
export function slotTargetId(slot: Slot): string {
	return targetId({ kind: "slot", slot })
}

/** Convenience: the Target_Identifier of a Cloud_Target without wrapping it. */
export function cloudTargetId(cloud: CloudTarget): string {
	return targetId({ kind: "cloud", cloud })
}

/**
 * Enumerate the Slots of a Model_Offering: one Slot per slot index, each carrying
 * its Performance_Rank from `offering.ranks[slotIndex]` (0-based). The validator
 * guarantees `offering.ranks.length === offering.slots` (Requirement 2.11); this
 * function trusts that invariant and does not re-check it.
 */
export function offeringSlots(offering: ModelOffering): Slot[] {
	const slots: Slot[] = []
	for (let slotIndex = 0; slotIndex < offering.slots; slotIndex++) {
		slots.push({ offering, slotIndex, rank: offering.ranks[slotIndex]! })
	}
	return slots
}

/**
 * True iff every capability tag the lane requires is present on `tags`, using an
 * EXACT, case-sensitive string match (Requirements 6.1, 6.2, 6.9). A lane tag
 * `"code"` is not satisfied by an offering tag `"Code"` or `"coder"`.
 */
function carriesAllTags(tags: readonly string[], lane: Lane): boolean {
	const have = new Set(tags)
	return lane.capabilities.every((required) => have.has(required))
}

/**
 * Spend_Class rank: the index of a Spend_Class in the ordered enum
 * `["free", "low-budget", "paid"]` (free < low-budget < paid). A smaller rank is
 * cheaper. Used to exclude Cloud_Targets above a lane's max-spend.
 */
export function spendRank(spend: SpendClass): number {
	return spendClass.options.indexOf(spend)
}

/**
 * A Slot is eligible for a lane when its offering carries every required
 * capability tag (exact, case-sensitive) AND the offering's context window is at
 * least the lane minimum (Requirements 6.1, 6.2, 6.9). Eligibility is a property
 * of the Model_Offering, so all slots of an offering share the same verdict;
 * this takes the offering directly.
 */
export function slotEligibleForLane(offering: ModelOffering, lane: Lane): boolean {
	return carriesAllTags(offering.tags, lane) && offering.context >= lane.minContext
}

/**
 * A Cloud_Target is eligible for a lane when it carries every required capability
 * tag (exact, case-sensitive), its context ≥ the lane minimum, AND its
 * Spend_Class is not above the lane's `maxSpend` (Requirements 6.1, 6.2, 6.9,
 * 6.11). "Above" uses the Spend_Class order free < low-budget < paid.
 */
export function cloudEligibleForLane(cloud: CloudTarget, lane: Lane): boolean {
	return (
		carriesAllTags(cloud.tags, lane) &&
		cloud.context >= lane.minContext &&
		spendRank(cloud.spend) <= spendRank(lane.maxSpend)
	)
}

/**
 * The eligible Slots of a Model_Offering for a lane: empty when the offering is
 * ineligible, otherwise all of its slots (slot eligibility is an offering-level
 * property). Convenience for order.ts, which flattens eligible slots across
 * every offering before ordering them.
 */
export function eligibleOfferingSlots(offering: ModelOffering, lane: Lane): Slot[] {
	return slotEligibleForLane(offering, lane) ? offeringSlots(offering) : []
}

/**
 * The eligible Cloud_Targets for a lane, preserving input order. Convenience for
 * order.ts, which groups these into Cloud_Spill_Tiers by Spend_Class.
 */
export function eligibleCloudTargets(clouds: readonly CloudTarget[], lane: Lane): CloudTarget[] {
	return clouds.filter((cloud) => cloudEligibleForLane(cloud, lane))
}
