import type { Endpoint, FleetInventory, Instance, Lane, ModelOffering } from "@roo-code/types"
import { describe, expect, it } from "vitest"

import {
	OMNIROUTE_HARD_CONCURRENCY_PROVIDERS_SETTING,
	concurrencyPerModel,
	connectionMaxConcurrent,
	defaultAllocationLookup,
	deviceConcurrency,
	hardConcurrencyProvidersSetting,
	laneMaximumTier,
	laneTierRouting,
	localProviders,
	offeringConcurrency,
	resolveDeviceAllocation,
	spendClassFirstTier,
} from "../capacity.js"

// Typed fixtures. capacity.ts operates on the validated typed model plus a
// resolved Device_Allocation, so these build FleetInventory pieces directly.

function offering(overrides: Partial<ModelOffering> = {}): ModelOffering {
	return {
		id: "coder",
		endpointId: "vllm",
		deviceId: "gpu0",
		modelId: "qwen-coder",
		context: 160_000,
		slots: 2,
		residencyGroup: "r0",
		tags: ["chat", "code"],
		ranks: [1, 3],
		...overrides,
	}
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		id: "vllm",
		provider: "vllm",
		deviceIds: ["gpu0"],
		addresses: [{ instanceId: "orc-primary", url: "http://gpu0:8000" }],
		noCredential: true,
		...overrides,
	}
}

function instance(overrides: Partial<Instance> = {}): Instance {
	return {
		id: "orc-primary",
		role: "primary",
		address: "http://primary:4000",
		backupRetention: 20,
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
		spillTiers: ["free", "low-budget"],
		failClosed: false,
		maxQueueMs: 1_000,
		capabilityLanes: ["coder.primary"],
		...overrides,
	}
}

function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [
			{ id: "gpu0", slotCeiling: 4, hostPreemption: false },
			{ id: "gpu1", slotCeiling: 2, hostPreemption: false },
		],
		endpoints: [endpoint()],
		residencyGroups: [{ id: "r0", swapLatencyMs: 0 }],
		offerings: [offering()],
		clouds: [],
		lanes: [lane()],
		instances: [instance()],
		diagnostics: [],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

describe("concurrencyPerModel / offeringConcurrency", () => {
	it("concurrencyPerModel equals the slot count when the allocation covers every slot", () => {
		expect(concurrencyPerModel(offering({ slots: 2 }), 4)).toBe(2)
		expect(concurrencyPerModel(offering({ slots: 2 }), 2)).toBe(2)
	})

	it("bounds per-instance concurrency to min(slots, Device_Allocation)", () => {
		// allocation below slot count clamps the per-model concurrency down
		expect(offeringConcurrency(offering({ slots: 4 }), 1)).toBe(1)
		expect(offeringConcurrency(offering({ slots: 4 }), 3)).toBe(3)
		// allocation above slot count is bounded by the slot count
		expect(offeringConcurrency(offering({ slots: 2 }), 10)).toBe(2)
	})

	it("yields 0 in-flight attempts when the instance holds no slots on the device", () => {
		expect(offeringConcurrency(offering({ slots: 4 }), 0)).toBe(0)
		expect(concurrencyPerModel(offering({ slots: 4 }), 0)).toBe(0)
	})

	it("treats a negative allocation as 0 (defensive clamp)", () => {
		expect(offeringConcurrency(offering({ slots: 4 }), -3)).toBe(0)
	})
})

describe("deviceConcurrency", () => {
	it("caps per-device in-flight attempts at the Device_Allocation", () => {
		expect(deviceConcurrency(3)).toBe(3)
		expect(deviceConcurrency(0)).toBe(0)
	})

	it("clamps a negative allocation to 0", () => {
		expect(deviceConcurrency(-1)).toBe(0)
	})
})

describe("connectionMaxConcurrent", () => {
	it("sums per-offering slot demand but caps each device at its allocation", () => {
		const offerings = [
			offering({ id: "a", modelId: "a", deviceId: "gpu0", slots: 3 }),
			offering({ id: "b", modelId: "b", deviceId: "gpu0", slots: 3 }),
		]
		// device gpu0 demand = 6 slots, but allocation on gpu0 is 4 → capped at 4
		expect(connectionMaxConcurrent(offerings, () => 4)).toBe(4)
	})

	it("adds independent per-device caps for a multi-device endpoint", () => {
		const offerings = [
			offering({ id: "a", modelId: "a", deviceId: "gpu0", slots: 3 }),
			offering({ id: "b", modelId: "b", deviceId: "gpu1", slots: 1 }),
		]
		const allocationFor = (deviceId: string) => (deviceId === "gpu0" ? 4 : 2)
		// gpu0: min(3,4)=3; gpu1: min(1,2)=1 → 4
		expect(connectionMaxConcurrent(offerings, allocationFor)).toBe(4)
	})

	it("is 0 when the instance has no allocation on the endpoint's devices", () => {
		const offerings = [offering({ slots: 2 })]
		expect(connectionMaxConcurrent(offerings, () => 0)).toBe(0)
	})
})

describe("resolveDeviceAllocation (Requirement 1.11 default)", () => {
	it("allocates a device's full ceiling to the single primary instance", () => {
		const inv = inventory()
		expect(resolveDeviceAllocation(inv, "gpu0", "orc-primary")).toBe(4)
		expect(resolveDeviceAllocation(inv, "gpu1", "orc-primary")).toBe(2)
	})

	it("allocates 0 slots to every non-primary instance", () => {
		const inv = inventory({
			instances: [
				instance({ id: "orc-primary", role: "primary" }),
				instance({ id: "orc-secondary", role: "secondary" }),
			],
		})
		expect(resolveDeviceAllocation(inv, "gpu0", "orc-secondary")).toBe(0)
		expect(resolveDeviceAllocation(inv, "gpu0", "orc-primary")).toBe(4)
	})

	it("resolves 0 for an unknown device id", () => {
		expect(resolveDeviceAllocation(inventory(), "nope", "orc-primary")).toBe(0)
	})

	it("defaultAllocationLookup closes over the inventory and applies the same default", () => {
		const lookup = defaultAllocationLookup(inventory())
		expect(lookup("gpu0", "orc-primary")).toBe(4)
		expect(lookup("gpu0", "ghost")).toBe(0)
	})
})

describe("localProviders / hard-concurrency providers Routing_Setting", () => {
	it("lists every local endpoint provider, de-duplicated and sorted", () => {
		const inv = inventory({
			endpoints: [
				endpoint({ id: "vllm", provider: "vllm", deviceIds: ["gpu0"] }),
				endpoint({ id: "ollama", provider: "ollama-local", deviceIds: ["gpu1"] }),
				endpoint({ id: "llama", provider: "llama-cpp", deviceIds: ["gpu0"] }),
				endpoint({ id: "arc", provider: "ovms-arc", deviceIds: ["gpu1"] }),
				// duplicate provider on a second endpoint collapses to one entry
				endpoint({ id: "vllm2", provider: "vllm", deviceIds: ["gpu1"] }),
			],
		})
		expect(localProviders(inv)).toEqual(["llama-cpp", "ollama-local", "ovms-arc", "vllm"])
	})

	it("builds the OMNIROUTE_HARD_CONCURRENCY_PROVIDERS setting with the local provider list", () => {
		const inv = inventory({
			endpoints: [
				endpoint({ id: "vllm", provider: "vllm" }),
				endpoint({ id: "ollama", provider: "ollama-local" }),
			],
		})
		const setting = hardConcurrencyProvidersSetting(inv)
		expect(setting.name).toBe(OMNIROUTE_HARD_CONCURRENCY_PROVIDERS_SETTING)
		expect(setting.name).toBe("OMNIROUTE_HARD_CONCURRENCY_PROVIDERS")
		expect(setting.providers).toEqual(["ollama-local", "vllm"])
	})

	it("includes no cloud provider (clouds are never hard-concurrency providers)", () => {
		const inv = inventory({
			clouds: [
				{
					id: "or",
					provider: "openrouter",
					modelId: "deepseek/chat",
					spend: "free",
					context: 128_000,
					tags: ["chat"],
				},
			],
		})
		expect(localProviders(inv)).not.toContain("openrouter")
	})
})

describe("tier ceiling mapping (Requirement 6.8)", () => {
	it("maps a local-only lane (no spill tiers) to maximumTier 1", () => {
		expect(laneMaximumTier(lane({ spillTiers: [], maxSpend: "paid" }))).toBe(1)
		expect(laneMaximumTier(lane({ spillTiers: [], maxSpend: "free" }))).toBe(1)
	})

	it("maps maxSpend free to maximumTier 2 (local + free)", () => {
		expect(laneMaximumTier(lane({ spillTiers: ["free"], maxSpend: "free" }))).toBe(2)
	})

	it("maps maxSpend low-budget to maximumTier 3 (local + free + low-budget)", () => {
		expect(laneMaximumTier(lane({ spillTiers: ["free", "low-budget"], maxSpend: "low-budget" }))).toBe(3)
	})

	it("maps maxSpend paid to an absent ceiling (undefined = all tiers)", () => {
		expect(laneMaximumTier(lane({ spillTiers: ["free", "low-budget", "paid"], maxSpend: "paid" }))).toBeUndefined()
	})

	it("laneTierRouting wraps the ceiling in a tierRouting block", () => {
		expect(laneTierRouting(lane({ spillTiers: ["free"], maxSpend: "free" }))).toEqual({ maximumTier: 2 })
		expect(laneTierRouting(lane({ spillTiers: ["free", "low-budget", "paid"], maxSpend: "paid" }))).toEqual({
			maximumTier: undefined,
		})
	})

	it("classifies each Spend_Class to the tier that first admits it", () => {
		expect(spendClassFirstTier("free")).toBe(2)
		expect(spendClassFirstTier("low-budget")).toBe(3)
		expect(spendClassFirstTier("paid")).toBeUndefined()
	})
})
