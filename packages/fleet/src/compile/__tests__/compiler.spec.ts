import type {
	CloudTarget,
	Device,
	Diagnostic,
	Endpoint,
	FleetInventory,
	Instance,
	Lane,
	ModelOffering,
	ResidencyGroup,
} from "@roo-code/types"
import { describe, expect, it } from "vitest"

import type { Combo } from "../../omniroute/client.js"
import { compile, type DesiredRouteState, type Revision } from "../compiler.js"

// Typed fixtures mirroring the validator/capacity specs. The compiler operates
// on a validated typed FleetInventory, so these build the pieces directly.

function device(overrides: Partial<Device> = {}): Device {
	return { id: "gpu0", slotCeiling: 4, hostPreemption: false, ...overrides }
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		id: "vllm",
		provider: "vllm",
		deviceIds: ["gpu0"],
		addresses: [{ instanceId: "cluster", url: "http://gpu0:2701" }],
		noCredential: true,
		...overrides,
	}
}

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
		id: "codestral",
		provider: "mistral",
		modelId: "codestral",
		spend: "free",
		context: 256_000,
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
		maxSpend: "free",
		spillTiers: ["free"],
		failClosed: false,
		maxQueueMs: 1_000,
		capabilityLanes: ["coder.primary"],
		...overrides,
	}
}

function instance(overrides: Partial<Instance> = {}): Instance {
	return { id: "cluster", role: "primary", address: "https://omniroute", backupRetention: 20, ...overrides }
}

function residency(overrides: Partial<ResidencyGroup> = {}): ResidencyGroup {
	return { id: "r0", swapLatencyMs: 0, ...overrides }
}

// A small but complete fleet: one primary, two devices, two endpoints, a coder
// offering (chat/code/read) and a reader offering sharing a residency group with
// a second resident model, an embed offering, a free cloud, and lanes covering
// code / reader / embed.
function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [device({ id: "gpu0", slotCeiling: 4 }), device({ id: "arc0", slotCeiling: 6 })],
		endpoints: [
			endpoint({ id: "vllm", provider: "vllm", deviceIds: ["gpu0"] }),
			endpoint({ id: "ovms", provider: "ovms-arc", deviceIds: ["arc0"] }),
		],
		residencyGroups: [residency({ id: "r0", swapLatencyMs: 0 }), residency({ id: "rg-ollama", swapLatencyMs: 8500 })],
		offerings: [
			offering({ id: "coder", deviceId: "gpu0", modelId: "qwen-coder", residencyGroup: "r0", slots: 2, ranks: [1, 3] }),
			offering({
				id: "reader-a",
				deviceId: "gpu0",
				modelId: "reader-a",
				residencyGroup: "rg-ollama",
				context: 131_072,
				slots: 1,
				tags: ["chat", "read"],
				ranks: [2],
			}),
			offering({
				id: "reader-b",
				deviceId: "gpu0",
				modelId: "reader-b",
				residencyGroup: "rg-ollama",
				context: 131_072,
				slots: 1,
				tags: ["chat", "read"],
				ranks: [4],
			}),
			offering({
				id: "embed",
				endpointId: "ovms",
				deviceId: "arc0",
				modelId: "qwen-embed",
				context: 4096,
				slots: 3,
				residencyGroup: "r-embed",
				tags: ["embed"],
				ranks: [1, 1, 1],
			}),
		],
		clouds: [cloud()],
		lanes: [
			lane({ id: "code", names: ["hybrid/code"], capabilities: ["chat", "code"], minContext: 60_000 }),
			lane({
				id: "reader",
				names: ["hybrid/reader", "hybrid/read-old"],
				capabilities: ["chat", "read"],
				minContext: 32_768,
				maxSpend: "free",
				spillTiers: [],
				capabilityLanes: ["reader.fast", "reader.deep"],
			}),
			lane({
				id: "embed",
				names: ["memory/embed"],
				capabilities: ["embed"],
				minContext: 4096,
				maxSpend: "free",
				spillTiers: [],
				capabilityLanes: [],
			}),
		],
		instances: [instance()],
		diagnostics: [{ id: "diag/gpu0", deviceId: "gpu0" } satisfies Diagnostic],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

const REV: Revision = { commit: "abc123", uncommitted: false }

function expectOk(result: ReturnType<typeof compile>): Map<string, DesiredRouteState> {
	if (!result.ok) {
		throw new Error(`expected ok, got failures: ${JSON.stringify(result.failures)}`)
	}
	return result.states
}

function combosByName(state: DesiredRouteState): Map<string, Combo> {
	return new Map(state.combos.map((c) => [c.name, c]))
}

describe("compile — one DesiredRouteState per Managed_Instance (Req 5.1)", () => {
	it("produces one state for the primary and none for retired", () => {
		const inv = inventory({
			instances: [instance({ id: "cluster", role: "primary" }), instance({ id: "mac", role: "retired" })],
		})
		const states = expectOk(compile(inv, REV))
		expect([...states.keys()]).toEqual(["cluster"])
		expect(states.has("mac")).toBe(false)
	})

	it("produces a state for a secondary with the primary's Public_Route/alias name set (Req 10.3)", () => {
		const inv = inventory({
			instances: [instance({ id: "cluster", role: "primary" }), instance({ id: "sec", role: "secondary" })],
		})
		const states = expectOk(compile(inv, REV))
		const publicAndAlias = (s: DesiredRouteState): string[] =>
			s.combos
				.filter((c) => s.publishedMetadata.kinds[c.name] === "public" || s.publishedMetadata.kinds[c.name] === "alias")
				.map((c) => c.name)
				.sort()
		expect(publicAndAlias(states.get("sec")!)).toEqual(publicAndAlias(states.get("cluster")!))
	})
})

describe("compile — Public_Route names, aliases, retired aliases, diagnostics (Req 4.1, 4.3, 4.5, 4.6)", () => {
	it("emits one Public_Route per lane named names[0]", () => {
		const states = expectOk(compile(inventory(), REV))
		const state = states.get("cluster")!
		const kinds = state.publishedMetadata.kinds
		const publics = Object.keys(kinds).filter((n) => kinds[n] === "public")
		expect(publics.sort()).toEqual(["hybrid/code", "hybrid/reader", "memory/embed"])
	})

	it("emits each further lane name as an alias combo", () => {
		const states = expectOk(compile(inventory(), REV))
		const kinds = states.get("cluster")!.publishedMetadata.kinds
		expect(kinds["hybrid/read-old"]).toBe("alias")
	})

	it("emits a diagnostic combo of kind diagnostic pinned to its device", () => {
		const states = expectOk(compile(inventory(), REV))
		const state = states.get("cluster")!
		expect(state.publishedMetadata.kinds["diag/gpu0"]).toBe("diagnostic")
		const diag = combosByName(state).get("diag/gpu0")!
		// Option A (F7): OmniRoute does not persist isHidden, so diagnostics are
		// emitted visible; the `diagnostic` route-kind is the identity (asserted above).
		expect(diag.isHidden).toBe(false)
	})
})

describe("compile — published metadata (Req 13.1, 14.1, 14.2, 14.3)", () => {
	it("publishes a route context window equal to lane minContext", () => {
		const windows = expectOk(compile(inventory(), REV)).get("cluster")!.publishedMetadata.contextWindows
		expect(windows["hybrid/code"]).toBe(60_000)
		expect(windows["hybrid/reader"]).toBe(32_768)
		expect(windows["hybrid/read-old"]).toBe(32_768) // alias shares the window
		expect(windows["memory/embed"]).toBe(4096)
	})

	it("publishes RouteCapacity as the distinct local Slot count capped at Device_Allocation", () => {
		const caps = expectOk(compile(inventory(), REV)).get("cluster")!.publishedMetadata.capacities
		const byRoute = new Map(caps.map((c) => [c.route, c.capacity]))
		// code lane: coder has 2 slots on gpu0 (ceiling 4) → 2
		expect(byRoute.get("hybrid/code")).toBe(2)
		// reader lane: reader-a (1) + reader-b (1) + coder (2, has chat+read) on gpu0,
		// 4 distinct slots, gpu0 allocation = ceiling 4 → 4
		expect(byRoute.get("hybrid/reader")).toBe(4)
		// embed lane: 3 slots on arc0 (ceiling 6) → 3
		expect(byRoute.get("memory/embed")).toBe(3)
	})

	it("caps RouteCapacity by the Device_Allocation when below the slot count", () => {
		// gpu0 ceiling 1 < 2 coder slots → capacity capped at 1
		const inv = inventory({ devices: [device({ id: "gpu0", slotCeiling: 1 }), device({ id: "arc0", slotCeiling: 6 })] })
		const caps = expectOk(compile(inv, REV)).get("cluster")!.publishedMetadata.capacities
		const byRoute = new Map(caps.map((c) => [c.route, c.capacity]))
		expect(byRoute.get("hybrid/code")).toBe(1)
	})

	it("maps each Capability_Lane to exactly one Public_Route name", () => {
		const map = expectOk(compile(inventory(), REV)).get("cluster")!.publishedMetadata.capabilityLaneRoutes
		expect(map["coder.primary"]).toBe("hybrid/code")
		expect(map["reader.fast"]).toBe("hybrid/reader")
		expect(map["reader.deep"]).toBe("hybrid/reader")
	})

	it("publishes per-residency swap latency only for groups with >1 Model_Offering", () => {
		const swaps = expectOk(compile(inventory(), REV)).get("cluster")!.publishedMetadata.swapLatencies
		const groups = swaps.map((s) => s.residencyGroup)
		expect(groups).toContain("rg-ollama")
		expect(groups).not.toContain("r0") // single-offering group omitted
		const ollama = swaps.find((s) => s.residencyGroup === "rg-ollama")!
		expect(ollama.swapLatencyMs).toBe(8500)
		expect(ollama.routes).toContain("hybrid/reader")
	})
})

describe("compile — combo config (Req 5.6, dead-key stripping, tierRouting)", () => {
	it("sets config.fleetRevision on every combo and marks dirty when uncommitted", () => {
		const clean = expectOk(compile(inventory(), REV)).get("cluster")!
		for (const combo of clean.combos) {
			expect(combo.config["fleetRevision"]).toBe("abc123")
		}
		const dirty = expectOk(compile(inventory(), { commit: "abc123", uncommitted: true })).get("cluster")!
		for (const combo of dirty.combos) {
			expect(combo.config["fleetRevision"]).toBe("abc123-dirty")
		}
	})

	it("strips any config key outside the allowed live-snapshot set plus fleetRevision", () => {
		const state = expectOk(compile(inventory(), REV)).get("cluster")!
		const allowed = new Set([
			"maxRetries",
			"targetTimeoutMs",
			"concurrencyPerModel",
			"queueTimeoutMs",
			"nestedComboMode",
			"tierRouting",
			"failoverBeforeRetry",
			"trackMetrics",
			"dispatchSequence",
			"fleetRevision",
		])
		for (const combo of state.combos) {
			for (const key of Object.keys(combo.config)) {
				expect(allowed.has(key)).toBe(true)
			}
		}
	})

	it("carries tierRouting on each internal pool combo", () => {
		const state = expectOk(compile(inventory(), REV)).get("cluster")!
		const pools = state.combos.filter((c) => state.publishedMetadata.kinds[c.name] === "internal")
		expect(pools.length).toBeGreaterThan(0)
		for (const pool of pools) {
			expect(pool.config).toHaveProperty("tierRouting")
		}
	})

	it("lists local providers in the OMNIROUTE_HARD_CONCURRENCY_PROVIDERS routing setting", () => {
		const state = expectOk(compile(inventory(), REV)).get("cluster")!
		const setting = state.routingSettings.find((s) => s.name === "OMNIROUTE_HARD_CONCURRENCY_PROVIDERS")!
		expect(setting.value).toEqual(["ovms-arc", "vllm"])
	})
})

describe("compile — Internal_Pool dedup and no self-reference (Req 5.4, 5.5, 5.11)", () => {
	it("emits only reachable, non-empty internal pools and no combo references itself", () => {
		const state = expectOk(compile(inventory(), REV)).get("cluster")!
		for (const combo of state.combos) {
			for (const ref of combo.models) {
				if (ref.kind === "combo-ref") {
					expect(ref.comboName).not.toBe(combo.name) // Req 5.11
				}
			}
		}
		const pools = state.combos.filter((c) => state.publishedMetadata.kinds[c.name] === "internal")
		for (const pool of pools) {
			expect(pool.models.length).toBeGreaterThan(0) // non-empty (Req 5.5)
		}
	})

	it("shares one Internal_Pool between two lanes with identical ordered targets and config", () => {
		// Two lanes with the same capabilities, context floor, and spill produce the
		// same ordered targets + dispatch config → one shared pool (Req 5.4).
		const inv = inventory({
			diagnostics: [], // isolate lane pools from the device-pinned diagnostic pool
			lanes: [
				lane({ id: "code", names: ["hybrid/code"], capabilities: ["chat", "code"], minContext: 60_000 }),
				lane({ id: "research", names: ["hybrid/research"], capabilities: ["chat", "code"], minContext: 60_000 }),
			],
		})
		const state = expectOk(compile(inv, REV)).get("cluster")!
		const pools = state.combos.filter((c) => state.publishedMetadata.kinds[c.name] === "internal")
		// code and research share identity → exactly one internal pool.
		expect(pools).toHaveLength(1)
		// both Public_Routes reference that one shared pool.
		const poolName = pools[0]!.name
		for (const name of ["hybrid/code", "hybrid/research"]) {
			const combo = state.combos.find((c) => c.name === name)!
			expect(combo.models[0]!.comboName).toBe(poolName)
		}
	})
})

describe("compile — failures name every offender, no partial output (Req 5.7, 13.6)", () => {
	it("fails when a lane has no eligible target on an instance", () => {
		const inv = inventory({
			lanes: [lane({ id: "ghost", names: ["hybrid/ghost"], capabilities: ["nonexistent-tag"], spillTiers: [] })],
		})
		const result = compile(inv, REV)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.failures.some((f) => f.code === "lane-no-eligible-target" && f.laneId === "ghost")).toBe(true)
		}
	})

	it("produces no states when any lane fails (no partial output)", () => {
		const inv = inventory({
			lanes: [
				lane({ id: "code", names: ["hybrid/code"], capabilities: ["chat", "code"], minContext: 60_000 }),
				lane({ id: "ghost", names: ["hybrid/ghost"], capabilities: ["nonexistent-tag"], spillTiers: [] }),
			],
		})
		const result = compile(inv, REV)
		expect(result.ok).toBe(false)
	})
})

describe("compile — determinism (Req 5.2)", () => {
	it("produces byte-identical output on repeat", () => {
		const a = compile(inventory(), REV)
		const b = compile(inventory(), REV)
		expect(a.ok && b.ok).toBe(true)
		if (a.ok && b.ok) {
			const serialize = (states: Map<string, DesiredRouteState>): string =>
				JSON.stringify([...states.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)))
			expect(serialize(a.states)).toBe(serialize(b.states))
		}
	})

	it("is deep-equal across two separate compilations of the same model", () => {
		const a = compile(inventory(), REV)
		const b = compile(inventory(), REV)
		if (a.ok && b.ok) {
			expect(a.states.get("cluster")).toEqual(b.states.get("cluster"))
		}
	})
})
