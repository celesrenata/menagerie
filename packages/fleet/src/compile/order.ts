// Route_Compiler — fill-first ordering, Cloud_Spill_Tiers, and Internal_Pool
// dedup (design §2, steps 2, 3, 5).
//
// Second module of the pure Route_Compiler. Like targets.ts this is a pure
// function of the validated model: no I/O, no clock, no env, no secrets. The
// one external call is Node's `crypto.createHash("sha1")`, used only to derive a
// deterministic content hash for Internal_Pool names (`pool/<sha1-12>`). That is
// a pure, deterministic transform of its input, not I/O, so it does not
// compromise the determinism property (Requirement 5.2).
//
// This module builds the ordered target sequence for one lane (local Slots first
// in fill-first order, then Cloud_Spill_Tiers), and provides the Internal_Pool
// dedup/reachability helpers. compiler.ts (task 3.4) assembles these into the
// live combo shape.

import { createHash } from "node:crypto"

import type { CloudTarget, Lane, ModelOffering, SpendClass } from "@roo-code/types"

import {
	cloudTargetId,
	eligibleCloudTargets,
	eligibleOfferingSlots,
	slotTargetId,
	spendRank,
	type Slot,
} from "./targets.js"

/**
 * The ordered local Slots of a lane under fill-first ordering (Requirement 6.4),
 * flattened across every offering: ascending Performance_Rank (1 = best), ties
 * broken by Target_Identifier in ascending lexicographic order. Each Slot keeps
 * its own `rank`, so a second (worse-ranked) Slot of the same offering — the
 * additional 5090 slot in the design example — naturally sorts later. The sort
 * is total and deterministic: `rank` then `slotTargetId`, both of which are
 * unique-enough to leave no undefined tie (distinct Slots never share a
 * Target_Identifier, Requirement 5.3).
 */
export function orderLocalSlots(offerings: readonly ModelOffering[], lane: Lane): Slot[] {
	const slots: Slot[] = []
	for (const offering of offerings) {
		slots.push(...eligibleOfferingSlots(offering, lane))
	}
	return slots.sort((a, b) => {
		if (a.rank !== b.rank) {
			return a.rank - b.rank
		}
		return compareIds(slotTargetId(a), slotTargetId(b))
	})
}

/** A single Cloud_Spill_Tier of a lane: the eligible clouds of one Spend_Class. */
export interface CloudSpillTier {
	/** The tier's Spend_Class (Requirement 6.5). */
	readonly spend: SpendClass
	/**
	 * The eligible Cloud_Targets of exactly this Spend_Class, in input order
	 * (Requirement 6.6). The order among clouds of equal Spend_Class is the
	 * inventory's declared order (Requirement 6.5).
	 */
	readonly clouds: readonly CloudTarget[]
	/**
	 * Fail-closed marker for a `free` tier (Requirement 6.7): a free-only tier,
	 * once its Cloud_Targets are all exhausted, ends the request rather than
	 * queuing or falling through. compiler.ts carries this flag into the combo so
	 * the OmniRoute_Instance can enforce it. Always `false` for non-free tiers.
	 */
	readonly failClosedWhenExhausted: boolean
}

/** One Cloud_Target the compiler excluded from a tier, with the reason. */
export interface ExcludedCloudTarget {
	readonly cloud: CloudTarget
	/**
	 * Why the Cloud_Target was excluded despite its Spend_Class matching a declared
	 * spill tier: a missing capability tag or an insufficient Served_Context_Window
	 * (Requirement 6.6). Clouds above the lane's `maxSpend` are never grouped into a
	 * tier in the first place, so they are not reported here.
	 */
	readonly reason: "missing-tag" | "insufficient-context"
}

/** The ordered cloud spill of a lane: its tiers plus the per-tier exclusion report. */
export interface CloudSpill {
	/**
	 * The lane's Cloud_Spill_Tiers, placed after every local Slot, in ascending
	 * Spend_Class order (free < low-budget < paid). The order among tiers of equal
	 * Spend_Class is the lane's declared order (Requirement 6.5).
	 */
	readonly tiers: readonly CloudSpillTier[]
	/**
	 * Every Cloud_Target of a declared tier's Spend_Class that the compiler left
	 * out for a missing tag or insufficient context (Requirement 6.6). The compiler
	 * surfaces these so the operator can see a cloud that "should" have spilled but
	 * did not qualify.
	 */
	readonly excluded: readonly ExcludedCloudTarget[]
}

/**
 * Build the Cloud_Spill_Tiers of a lane from the fleet's Cloud_Targets
 * (Requirements 6.5, 6.6, 6.7).
 *
 *   - One tier per entry in `lane.spillTiers`, each containing exactly the
 *     Cloud_Targets whose Spend_Class equals that tier's Spend_Class AND that are
 *     eligible for the lane (every required tag, context ≥ lane minimum). The
 *     validator already guarantees each spill Spend_Class is ≤ the lane's
 *     `maxSpend` (Requirement 3.1).
 *   - Tiers are returned in ascending Spend_Class order; ties keep the lane's
 *     declared order (a stable sort of the declared tiers, Requirement 6.5).
 *   - A `free` tier is marked fail-closed-when-exhausted (Requirement 6.7).
 *   - Every Cloud_Target of a declared tier's Spend_Class that was excluded for a
 *     missing tag or short context is reported (Requirement 6.6).
 *
 * Cloud_Targets whose Spend_Class is not named by any declared spill tier (and
 * clouds above `maxSpend`) are simply not part of the lane's cloud spill and are
 * not reported as excluded.
 */
export function buildCloudSpill(clouds: readonly CloudTarget[], lane: Lane): CloudSpill {
	const eligibleIds = new Set(eligibleCloudTargets(clouds, lane).map((cloud) => cloudTargetId(cloud)))

	// Stable sort of the declared tiers by Spend_Class rank; equal ranks keep the
	// lane's declared order (Array.prototype.sort is stable in modern engines, and
	// we only compare by rank so equal entries are never reordered).
	const orderedSpends = lane.spillTiers
		.map((spend, index) => ({ spend, index }))
		.sort((a, b) => {
			const byRank = spendRank(a.spend) - spendRank(b.spend)
			return byRank !== 0 ? byRank : a.index - b.index
		})
		.map((entry) => entry.spend)

	const tiers: CloudSpillTier[] = []
	const excluded: ExcludedCloudTarget[] = []

	for (const spend of orderedSpends) {
		const tierClouds: CloudTarget[] = []
		for (const cloud of clouds) {
			if (cloud.spend !== spend) {
				continue
			}
			if (eligibleIds.has(cloudTargetId(cloud))) {
				tierClouds.push(cloud)
			} else {
				excluded.push({ cloud, reason: exclusionReason(cloud, lane) })
			}
		}
		tiers.push({
			spend,
			clouds: tierClouds,
			failClosedWhenExhausted: spend === "free",
		})
	}

	return { tiers, excluded }
}

/**
 * The ordered target sequence of a lane: fill-first local Slots first, then every
 * Cloud_Spill_Tier after all local Slots (Requirements 6.4, 6.5). Also carries the
 * per-tier exclusion report so compiler.ts can surface it (Requirement 6.6).
 */
export interface OrderedLaneTargets {
	readonly lane: Lane
	readonly localSlots: readonly Slot[]
	readonly spill: CloudSpill
}

/**
 * Compute the full ordered target sequence for one lane under fill-first
 * ordering: eligible local Slots sorted by rank then Target_Identifier, followed
 * by the Cloud_Spill_Tiers in ascending Spend_Class order (Requirements 6.4,
 * 6.5, 6.6, 6.7).
 */
export function orderLaneTargets(
	offerings: readonly ModelOffering[],
	clouds: readonly CloudTarget[],
	lane: Lane,
): OrderedLaneTargets {
	return {
		lane,
		localSlots: orderLocalSlots(offerings, lane),
		spill: buildCloudSpill(clouds, lane),
	}
}

// --- Internal_Pool dedup (Requirements 5.4, 5.5) ---------------------------

/**
 * The dispatch-affecting config of a pool: the subset of combo config that
 * changes how OmniRoute dispatches a request. Two pools with the same ordered
 * target ids but different dispatch-affecting config are distinct pools
 * (Requirement 5.4); two with the same ids and the same config are one.
 *
 * This is an open record so compiler.ts (task 3.4) can supply the exact
 * dispatch-affecting keys from the live combo schema (`tierRouting`,
 * `concurrencyPerModel`, `dispatchSequence`, etc.) without this module needing
 * to know every key. Non-dispatch-affecting bookkeeping (e.g. `fleetRevision`)
 * must NOT be included by the caller, so a revision bump does not fork a pool.
 */
export type DispatchConfig = Readonly<Record<string, unknown>>

/**
 * The identity of an Internal_Pool: its ordered Target_Identifier list and its
 * dispatch-affecting config (Requirement 5.4).
 */
export interface PoolIdentity {
	/** Target_Identifiers in dispatch order. */
	readonly targetIds: readonly string[]
	/** The dispatch-affecting config (see DispatchConfig). */
	readonly config: DispatchConfig
}

/** A deduplicated Internal_Pool with its stable `pool/<sha1-12>` name. */
export interface InternalPool {
	/** `pool/<sha1-12>` — a 12-hex-char prefix of the SHA-1 of the canonical identity. */
	readonly name: string
	readonly targetIds: readonly string[]
	readonly config: DispatchConfig
}

/**
 * The stable name of an Internal_Pool: `pool/` followed by the first 12 hex
 * characters of the SHA-1 of a canonical serialization of its (ordered target
 * ids, dispatch-affecting config). Deterministic — identical identities always
 * produce the same name, distinct identities almost always produce distinct
 * names — and independent of clock, locale, and environment (Requirement 5.2).
 */
export function poolName(identity: PoolIdentity): string {
	const hash = createHash("sha1").update(canonicalIdentity(identity)).digest("hex")
	return `pool/${hash.slice(0, 12)}`
}

/**
 * Deduplicate Internal_Pools by identity (Requirement 5.4). Pools that share the
 * same ordered target ids AND the same dispatch-affecting config collapse to one;
 * distinct identities stay separate. The first occurrence of each identity wins
 * its position; the returned list is in first-seen order so the output is
 * deterministic for a deterministic input.
 */
export function dedupPools(identities: readonly PoolIdentity[]): InternalPool[] {
	const byName = new Map<string, InternalPool>()
	for (const identity of identities) {
		const name = poolName(identity)
		if (!byName.has(name)) {
			byName.set(name, { name, targetIds: identity.targetIds, config: identity.config })
		}
	}
	return [...byName.values()]
}

/**
 * Keep only the Internal_Pools reachable from a Public_Route (Requirement 5.5).
 * `rootPoolNames` are the pool names referenced directly by a Public_Route;
 * `references(name)` returns the pool names a given pool references (a pool may
 * nest other pools). An empty pool — one with no targets — is also dropped,
 * since the compiler emits only pools that contain at least one target
 * (Requirement 5.5).
 */
export function reachablePools(
	pools: readonly InternalPool[],
	rootPoolNames: readonly string[],
	references: (poolName: string) => readonly string[],
): InternalPool[] {
	const byName = new Map(pools.map((pool) => [pool.name, pool]))
	const reached = new Set<string>()
	const stack = [...rootPoolNames]
	while (stack.length > 0) {
		const name = stack.pop()!
		if (reached.has(name) || !byName.has(name)) {
			continue
		}
		reached.add(name)
		for (const next of references(name)) {
			if (!reached.has(next)) {
				stack.push(next)
			}
		}
	}
	return pools.filter((pool) => reached.has(pool.name) && pool.targetIds.length > 0)
}

// --- internals -------------------------------------------------------------

/** Ascending lexicographic compare over code units, stable and locale-free. */
function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Why a Cloud_Target of a tier's Spend_Class was excluded (Requirement 6.6). A
 * missing capability tag is reported in preference to a context shortfall when
 * both hold, so the report names the most actionable cause.
 */
function exclusionReason(cloud: CloudTarget, lane: Lane): ExcludedCloudTarget["reason"] {
	const have = new Set(cloud.tags)
	const missingTag = lane.capabilities.some((required) => !have.has(required))
	return missingTag ? "missing-tag" : "insufficient-context"
}

/**
 * Canonical, deterministic serialization of a PoolIdentity for hashing. Target
 * ids are already ordered (dispatch order is significant). The config is
 * serialized with its object keys sorted so that two configs that differ only in
 * key insertion order hash identically — key order is not dispatch-affecting.
 */
function canonicalIdentity(identity: PoolIdentity): string {
	return JSON.stringify({ targetIds: identity.targetIds, config: canonicalize(identity.config) })
}

/** Recursively sort object keys so serialization is independent of insertion order. */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalize(entry))
	}
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {}
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = canonicalize((value as Record<string, unknown>)[key])
		}
		return sorted
	}
	return value
}
