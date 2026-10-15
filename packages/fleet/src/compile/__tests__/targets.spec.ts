import type { CloudTarget, Lane, ModelOffering } from "@roo-code/types"
import { describe, expect, it } from "vitest"

import {
	cloudEligibleForLane,
	cloudTargetId,
	eligibleCloudTargets,
	eligibleOfferingSlots,
	offeringSlots,
	slotEligibleForLane,
	slotTargetId,
	spendRank,
	targetId,
	type Slot,
} from "../targets.js"

// Typed fixtures. targets.ts operates on the validated typed model, so these
// build ModelOffering/CloudTarget/Lane objects directly rather than parsed docs.

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
		maxSpend: "low-budget",
		spillTiers: ["free"],
		failClosed: false,
		maxQueueMs: 1_000,
		capabilityLanes: ["coder.primary"],
		...overrides,
	}
}

describe("targetId / slot identity", () => {
	it("formats a Slot id as t:<device>:<endpoint>:<modelId>:<slotIndex> (0-based)", () => {
		const slot: Slot = { offering: offering(), slotIndex: 0, rank: 1 }
		expect(slotTargetId(slot)).toBe("t:gpu0:vllm:qwen-coder:0")
		expect(targetId({ kind: "slot", slot })).toBe("t:gpu0:vllm:qwen-coder:0")
	})

	it("formats a Cloud_Target id as c:<provider>:<modelId>", () => {
		const c = cloud()
		expect(cloudTargetId(c)).toBe("c:openrouter:deepseek/chat")
		expect(targetId({ kind: "cloud", cloud: c })).toBe("c:openrouter:deepseek/chat")
	})

	it("is stable: changing rank, context, tags, or ranks leaves the Slot id unchanged", () => {
		const base: Slot = { offering: offering(), slotIndex: 1, rank: 3 }
		const id = slotTargetId(base)

		const changedRank: Slot = { ...base, rank: 99 }
		const changedContextTags: Slot = {
			...base,
			offering: offering({ context: 999_999, tags: ["chat", "code", "read", "planner"], ranks: [7, 8] }),
		}

		expect(slotTargetId(changedRank)).toBe(id)
		expect(slotTargetId(changedContextTags)).toBe(id)
	})

	it("is stable for Cloud_Targets: changing spend, context, or tags leaves the id unchanged", () => {
		const base = cloud()
		const id = cloudTargetId(base)
		expect(cloudTargetId(cloud({ spend: "paid", context: 8_000, tags: ["chat"] }))).toBe(id)
	})

	it("gives distinct slot indices distinct ids and never collides within an offering", () => {
		const slots = offeringSlots(offering({ slots: 2, ranks: [1, 3] }))
		const ids = slots.map(slotTargetId)
		expect(ids).toEqual(["t:gpu0:vllm:qwen-coder:0", "t:gpu0:vllm:qwen-coder:1"])
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("distinguishes slots that differ only by device, endpoint, or modelId", () => {
		const a: Slot = { offering: offering(), slotIndex: 0, rank: 1 }
		const byDevice: Slot = { offering: offering({ deviceId: "gpu1" }), slotIndex: 0, rank: 1 }
		const byEndpoint: Slot = { offering: offering({ endpointId: "vllm2" }), slotIndex: 0, rank: 1 }
		const byModel: Slot = { offering: offering({ modelId: "qwen-coder-b" }), slotIndex: 0, rank: 1 }
		const ids = [a, byDevice, byEndpoint, byModel].map(slotTargetId)
		expect(new Set(ids).size).toBe(4)
	})
})

describe("offeringSlots", () => {
	it("emits one 0-based Slot per slot index, each carrying its rank from offering.ranks", () => {
		const slots = offeringSlots(offering({ slots: 3, ranks: [2, 4, 6] }))
		expect(slots.map((s) => s.slotIndex)).toEqual([0, 1, 2])
		expect(slots.map((s) => s.rank)).toEqual([2, 4, 6])
	})
})

describe("spendRank", () => {
	it("orders free < low-budget < paid", () => {
		expect(spendRank("free")).toBeLessThan(spendRank("low-budget"))
		expect(spendRank("low-budget")).toBeLessThan(spendRank("paid"))
	})
})

describe("slotEligibleForLane", () => {
	it("accepts an offering carrying every required tag with context ≥ minimum", () => {
		expect(slotEligibleForLane(offering(), lane())).toBe(true)
	})

	it("rejects an offering missing a required capability tag", () => {
		expect(slotEligibleForLane(offering({ tags: ["chat", "read"] }), lane())).toBe(false)
	})

	it("matches tags case-sensitively: 'Code' does not satisfy a required 'code'", () => {
		expect(slotEligibleForLane(offering({ tags: ["chat", "Code"] }), lane())).toBe(false)
	})

	it("rejects an offering whose context is below the lane minimum", () => {
		expect(slotEligibleForLane(offering({ context: 59_999 }), lane({ minContext: 60_000 }))).toBe(false)
	})

	it("accepts an offering whose context equals the lane minimum (floor is inclusive)", () => {
		expect(slotEligibleForLane(offering({ context: 60_000 }), lane({ minContext: 60_000 }))).toBe(true)
	})
})

describe("cloudEligibleForLane", () => {
	it("accepts a cloud target with tags, context, and spend at or below max-spend", () => {
		expect(cloudEligibleForLane(cloud({ context: 60_000 }), lane({ minContext: 60_000 }))).toBe(true)
	})

	it("excludes a cloud target above the lane max-spend", () => {
		expect(cloudEligibleForLane(cloud({ spend: "paid" }), lane({ maxSpend: "low-budget" }))).toBe(false)
	})

	it("includes a cloud target whose spend equals the lane max-spend", () => {
		expect(cloudEligibleForLane(cloud({ spend: "low-budget" }), lane({ maxSpend: "low-budget" }))).toBe(true)
	})

	it("matches cloud tags case-sensitively", () => {
		expect(cloudEligibleForLane(cloud({ tags: ["chat", "Code"] }), lane())).toBe(false)
	})

	it("rejects a cloud target below the lane context floor", () => {
		expect(cloudEligibleForLane(cloud({ context: 59_999 }), lane({ minContext: 60_000 }))).toBe(false)
	})
})

describe("eligibleOfferingSlots / eligibleCloudTargets", () => {
	it("returns all slots for an eligible offering and none for an ineligible one", () => {
		expect(eligibleOfferingSlots(offering({ slots: 2, ranks: [1, 3] }), lane())).toHaveLength(2)
		expect(eligibleOfferingSlots(offering({ tags: ["chat"] }), lane())).toHaveLength(0)
	})

	it("keeps only eligible clouds and preserves input order", () => {
		const clouds: CloudTarget[] = [
			cloud({ id: "a", provider: "p", modelId: "free-ok", spend: "free" }),
			cloud({ id: "b", provider: "p", modelId: "paid-over", spend: "paid" }),
			cloud({ id: "c", provider: "p", modelId: "lb-ok", spend: "low-budget" }),
		]
		const eligible = eligibleCloudTargets(clouds, lane({ maxSpend: "low-budget" }))
		expect(eligible.map((c) => c.modelId)).toEqual(["free-ok", "lb-ok"])
	})
})
