import type { CloudTarget, Lane, ModelOffering } from "@roo-code/types"
import { describe, expect, it } from "vitest"

import { slotTargetId } from "../targets.js"
import {
	buildCloudSpill,
	dedupPools,
	orderLaneTargets,
	orderLocalSlots,
	poolName,
	reachablePools,
	type InternalPool,
	type PoolIdentity,
} from "../order.js"

// Typed fixtures mirroring targets.spec.ts: order.ts operates on the validated
// typed model, so these build ModelOffering/CloudTarget/Lane objects directly.

function offering(overrides: Partial<ModelOffering> = {}): ModelOffering {
	return {
		id: "coder",
		endpointId: "vllm",
		deviceId: "gpu0",
		modelId: "qwen-coder",
		context: 160_000,
		slots: 2,
		residencyGroup: "r0",
		tags: ["chat", "code", "read"],
		ranks: [1, 3],
		...overrides,
	}
}

function cloud(overrides: Partial<CloudTarget> = {}): CloudTarget {
	return {
		id: "or-free",
		provider: "openrouter",
		modelId: "deepseek/chat",
		spend: "free",
		context: 128_000,
		tags: ["chat", "code"],
		...overrides,
	}
}

function lane(overrides: Partial<Lane> = {}): Lane {
	return {
		id: "code",
		names: ["hybrid/code"],
		capabilities: ["chat", "code"],
		minContext: 60_000,
		order: "fill-first",
		maxSpend: "paid",
		spillTiers: ["free"],
		failClosed: false,
		maxQueueMs: 1_000,
		capabilityLanes: ["coder.primary"],
		...overrides,
	}
}

describe("orderLocalSlots — fill-first by rank, tie-break by Target_Identifier (Req 6.4)", () => {
	it("orders slots across offerings by ascending Performance_Rank", () => {
		// gpu0 slots rank [1, 3]; gpu1 slots rank [2, 4]. Expect 1, 2, 3, 4.
		const gpu0 = offering({ id: "a", deviceId: "gpu0", modelId: "m0", slots: 2, ranks: [1, 3] })
		const gpu1 = offering({ id: "b", deviceId: "gpu1", modelId: "m1", slots: 2, ranks: [2, 4] })

		const ordered = orderLocalSlots([gpu0, gpu1], lane())

		expect(ordered.map((s) => s.rank)).toEqual([1, 2, 3, 4])
	})

	it("keeps the additional slot of one offering at its own worse rank (5090b sits later)", () => {
		// A fast first slot (rank 1) and a worse second slot (rank 6) of the SAME
		// offering, with a middle offering at rank 3. The second slot sorts last.
		const fast = offering({ id: "a", deviceId: "gpu0", modelId: "m0", slots: 2, ranks: [1, 6] })
		const mid = offering({ id: "b", deviceId: "gpu1", modelId: "m1", slots: 1, ranks: [3] })

		const ordered = orderLocalSlots([fast, mid], lane())

		expect(ordered.map((s) => s.rank)).toEqual([1, 3, 6])
		// The last slot is the second slot of the fast offering (slotIndex 1).
		expect(ordered[2]!.offering.id).toBe("a")
		expect(ordered[2]!.slotIndex).toBe(1)
	})

	it("breaks rank ties by Target_Identifier in ascending lexicographic order", () => {
		// Two offerings, each one slot at the SAME rank 2. Tie-break by target id.
		const za = offering({ id: "za", deviceId: "gpuZ", modelId: "za", slots: 1, ranks: [2] })
		const ab = offering({ id: "ab", deviceId: "gpuA", modelId: "ab", slots: 1, ranks: [2] })

		const ordered = orderLocalSlots([za, ab], lane())
		const ids = ordered.map((s) => slotTargetId(s))

		expect(ids).toEqual([...ids].sort())
		// gpuA sorts before gpuZ.
		expect(ordered[0]!.offering.deviceId).toBe("gpuA")
	})

	it("excludes ineligible offerings (missing tag or short context)", () => {
		const eligible = offering({ id: "ok", deviceId: "g0", modelId: "ok", slots: 1, ranks: [1] })
		const noTag = offering({ id: "notag", deviceId: "g1", modelId: "notag", slots: 1, ranks: [2], tags: ["chat"] })
		const shortCtx = offering({ id: "short", deviceId: "g2", modelId: "short", slots: 1, ranks: [3], context: 1_000 })

		const ordered = orderLocalSlots([eligible, noTag, shortCtx], lane())

		expect(ordered).toHaveLength(1)
		expect(ordered[0]!.offering.id).toBe("ok")
	})
})

describe("buildCloudSpill — grouping, ordering, exclusion report, free-tier marker (Req 6.5-6.7)", () => {
	it("groups eligible clouds by Spend_Class, one tier per declared spill", () => {
		const free = cloud({ id: "f", provider: "p", modelId: "free", spend: "free" })
		const low = cloud({ id: "l", provider: "p", modelId: "low", spend: "low-budget" })

		const spill = buildCloudSpill([free, low], lane({ spillTiers: ["free", "low-budget"] }))

		expect(spill.tiers.map((t) => t.spend)).toEqual(["free", "low-budget"])
		expect(spill.tiers[0]!.clouds.map((c) => c.modelId)).toEqual(["free"])
		expect(spill.tiers[1]!.clouds.map((c) => c.modelId)).toEqual(["low"])
	})

	it("orders tiers by ascending Spend_Class regardless of declared order", () => {
		const spill = buildCloudSpill([], lane({ spillTiers: ["paid", "free", "low-budget"] }))

		expect(spill.tiers.map((t) => t.spend)).toEqual(["free", "low-budget", "paid"])
	})

	it("keeps declared order among tiers of equal Spend_Class (stable)", () => {
		// Two free tiers declared; both stay free and keep declared order.
		const a = cloud({ id: "fa", provider: "p", modelId: "fa", spend: "free" })
		const b = cloud({ id: "fb", provider: "p", modelId: "fb", spend: "free" })

		const spill = buildCloudSpill([a, b], lane({ spillTiers: ["free", "free"] }))

		expect(spill.tiers).toHaveLength(2)
		expect(spill.tiers.every((t) => t.spend === "free")).toBe(true)
	})

	it("marks a free tier fail-closed-when-exhausted and non-free tiers not (Req 6.7)", () => {
		const spill = buildCloudSpill([], lane({ spillTiers: ["free", "low-budget"] }))

		expect(spill.tiers[0]!.failClosedWhenExhausted).toBe(true)
		expect(spill.tiers[1]!.failClosedWhenExhausted).toBe(false)
	})

	it("reports clouds of a tier's Spend_Class excluded for a missing tag", () => {
		const ok = cloud({ id: "ok", provider: "p", modelId: "ok", spend: "free", tags: ["chat", "code"] })
		const noTag = cloud({ id: "nt", provider: "p", modelId: "nt", spend: "free", tags: ["chat"] })

		const spill = buildCloudSpill([ok, noTag], lane({ spillTiers: ["free"] }))

		expect(spill.tiers[0]!.clouds.map((c) => c.modelId)).toEqual(["ok"])
		expect(spill.excluded).toHaveLength(1)
		expect(spill.excluded[0]!.cloud.modelId).toBe("nt")
		expect(spill.excluded[0]!.reason).toBe("missing-tag")
	})

	it("reports clouds excluded for insufficient context", () => {
		const shortCtx = cloud({ id: "sc", provider: "p", modelId: "sc", spend: "free", context: 1_000 })

		const spill = buildCloudSpill([shortCtx], lane({ spillTiers: ["free"] }))

		expect(spill.tiers[0]!.clouds).toHaveLength(0)
		expect(spill.excluded).toHaveLength(1)
		expect(spill.excluded[0]!.reason).toBe("insufficient-context")
	})

	it("does not report clouds whose Spend_Class is not a declared spill tier", () => {
		const paid = cloud({ id: "pd", provider: "p", modelId: "pd", spend: "paid" })

		const spill = buildCloudSpill([paid], lane({ spillTiers: ["free"] }))

		expect(spill.tiers.map((t) => t.spend)).toEqual(["free"])
		expect(spill.excluded).toHaveLength(0)
	})
})

describe("orderLaneTargets — local slots first, then cloud tiers (Req 6.4, 6.5)", () => {
	it("places every cloud tier after all local slots", () => {
		const local = offering({ id: "a", deviceId: "g0", modelId: "m0", slots: 1, ranks: [1] })
		const free = cloud({ id: "f", provider: "p", modelId: "free", spend: "free" })

		const ordered = orderLaneTargets([local], [free], lane({ spillTiers: ["free"] }))

		expect(ordered.localSlots).toHaveLength(1)
		expect(ordered.spill.tiers).toHaveLength(1)
		expect(ordered.spill.tiers[0]!.clouds.map((c) => c.modelId)).toEqual(["free"])
	})
})

describe("Internal_Pool dedup and reachability (Req 5.4, 5.5)", () => {
	it("produces a stable pool/<sha1-12> name for identical (targets, config)", () => {
		const identity: PoolIdentity = {
			targetIds: ["t:g0:vllm:m0:0", "c:openrouter:deepseek/chat"],
			config: { tierRouting: { maximumTier: 2 }, concurrencyPerModel: 1 },
		}

		const n1 = poolName(identity)
		const n2 = poolName({ targetIds: [...identity.targetIds], config: { ...identity.config } })

		expect(n1).toMatch(/^pool\/[0-9a-f]{12}$/)
		expect(n2).toBe(n1)
	})

	it("ignores object-key insertion order in the dispatch config", () => {
		const a = poolName({ targetIds: ["x"], config: { b: 1, a: 2 } })
		const b = poolName({ targetIds: ["x"], config: { a: 2, b: 1 } })

		expect(b).toBe(a)
	})

	it("produces distinct names for different target lists", () => {
		const a = poolName({ targetIds: ["x", "y"], config: {} })
		const b = poolName({ targetIds: ["y", "x"], config: {} })

		expect(a).not.toBe(b)
	})

	it("produces distinct names for different dispatch config", () => {
		const a = poolName({ targetIds: ["x"], config: { tierRouting: { maximumTier: 1 } } })
		const b = poolName({ targetIds: ["x"], config: { tierRouting: { maximumTier: 2 } } })

		expect(a).not.toBe(b)
	})

	it("dedups pools that share identity and keeps distinct ones", () => {
		const dup1: PoolIdentity = { targetIds: ["x", "y"], config: { k: 1 } }
		const dup2: PoolIdentity = { targetIds: ["x", "y"], config: { k: 1 } }
		const other: PoolIdentity = { targetIds: ["x", "z"], config: { k: 1 } }

		const pools = dedupPools([dup1, dup2, other])

		expect(pools).toHaveLength(2)
		expect(pools[0]!.name).toBe(poolName(dup1))
		expect(pools[1]!.name).toBe(poolName(other))
	})

	it("keeps only pools reachable from a Public_Route and drops empty pools (Req 5.5)", () => {
		const root: InternalPool = { name: "pool/root", targetIds: ["x"], config: {} }
		const nested: InternalPool = { name: "pool/nested", targetIds: ["y"], config: {} }
		const orphan: InternalPool = { name: "pool/orphan", targetIds: ["z"], config: {} }
		const empty: InternalPool = { name: "pool/empty", targetIds: [], config: {} }

		const references = (name: string): string[] => (name === "pool/root" ? ["pool/nested", "pool/empty"] : [])

		const reachable = reachablePools([root, nested, orphan, empty], ["pool/root"], references)

		expect(reachable.map((p) => p.name).sort()).toEqual(["pool/nested", "pool/root"])
	})
})
