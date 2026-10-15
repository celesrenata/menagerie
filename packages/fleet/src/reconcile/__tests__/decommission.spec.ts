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

import { compile, type Combo, type DesiredRouteState, type Revision } from "../../index.js"
import type { Connection, ContextOverride } from "../../omniroute/client.js"
import { FakeOmniRouteClient } from "../../omniroute/fake.js"
import { decommission, replacementEligibleLanes } from "../decommission.js"

// ---------------------------------------------------------------------------
// Fixtures — a validated typed FleetInventory and a matching Live_Route_State.
// Mirrors plan.spec.ts / drift.spec.ts so the suites share the same fleet shape.
// ---------------------------------------------------------------------------

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

function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [device({ id: "gpu0", slotCeiling: 4 })],
		endpoints: [endpoint({ id: "vllm", provider: "vllm", deviceIds: ["gpu0"] })],
		residencyGroups: [residency({ id: "r0", swapLatencyMs: 0 })],
		offerings: [offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })],
		clouds: [cloud()],
		lanes: [lane({ id: "code", names: ["hybrid/code"], capabilities: ["chat", "code"], minContext: 60_000 })],
		instances: [instance()],
		diagnostics: [{ id: "diag/gpu0", deviceId: "gpu0" } satisfies Diagnostic],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

const REV: Revision = { commit: "abc123", uncommitted: false }
const CLOCK = () => "2026-10-15T00:00:00.000Z"

function desiredState(inv: FleetInventory): DesiredRouteState {
	const result = compile(inv, REV)
	if (!result.ok) {
		throw new Error(`fixture failed to compile: ${JSON.stringify(result.failures)}`)
	}
	const state = result.states.get("cluster")
	if (!state) {
		throw new Error("fixture produced no state for cluster")
	}
	return state
}

/**
 * The live combos of a clean fleet compiled from `inv`, with the resolved
 * connection id filled on each local-slot ref (OmniRoute carries the resolved
 * id, the compiler leaves it empty). Marked managed via the `fleetRevision`
 * provenance key the compiler emits (so the plan treats them as ours to delete).
 */
function cleanCombos(inv: FleetInventory, connectionId = "conn-vllm"): Combo[] {
	return desiredState(inv).combos.map((c) => ({
		...structuredClone(c),
		models: c.models.map((m) =>
			m.id.startsWith("t:") ? { ...structuredClone(m), connectionId } : structuredClone(m),
		),
	}))
}

function connection(overrides: Partial<Connection> = {}): Connection {
	return {
		id: "conn-vllm",
		provider: "vllm",
		address: "http://gpu0:2701",
		isActive: true,
		...overrides,
	}
}

/** The declared model ids present in the live combos (for assertions). */
function slotModelIds(combos: readonly Combo[]): Set<string> {
	const ids = new Set<string>()
	for (const combo of combos) {
		for (const ref of combo.models) {
			if (ref.id.startsWith("t:")) {
				ids.add(ref.id.split(":")[3]!)
			}
		}
	}
	return ids
}

// ---------------------------------------------------------------------------
// (12.1) Dropping an offering removes its targets from every route.
// ---------------------------------------------------------------------------

describe("decommission — Requirement 12.1 (remove dropped targets)", () => {
	it("removes every target of a dropped offering from the desired combos", async () => {
		// OLD: two offerings on gpu0. NEW: the second offering is dropped.
		const old = inventory({
			offerings: [
				offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] }),
				offering({ id: "coder2", modelId: "qwen-coder-b", slots: 1, ranks: [2] }),
			],
		})
		const next = inventory({
			offerings: [offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })],
		})

		const liveCombos = cleanCombos(old)
		// Sanity: the dropped model id IS present live before the plan.
		expect(slotModelIds(liveCombos).has("qwen-coder-b")).toBe(true)

		const fake = new FakeOmniRouteClient({ combos: liveCombos, connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		// The recompiled desired state references no dropped target.
		const desiredAfter = desiredState(next)
		expect(slotModelIds(desiredAfter.combos).has("qwen-coder-b")).toBe(false)

		// Every combo update/delete op's after-combos drop the dropped model id.
		for (const op of result.ops) {
			if (op.kind !== "combo" || !op.after) {
				continue
			}
			const after = op.after as Combo
			for (const ref of after.models) {
				if (ref.id.startsWith("t:")) {
					expect(ref.id.split(":")[3]).not.toBe("qwen-coder-b")
				}
			}
		}
	})

	it("plans deletion of the dead OpenRouter-free and 5090-reader targets dropped from the new inventory", async () => {
		// Model the two dead targets from the findings: an OpenRouter free cloud
		// target and a 5090 reader offering present LIVE but dropped from NEW.
		const dead5090 = offering({
			id: "reader-5090",
			endpointId: "vllm",
			deviceId: "gpu0",
			modelId: "reader-5090-model",
			context: 160_000,
			slots: 1,
			ranks: [2],
			tags: ["chat", "code", "read"],
		})
		const openRouterFree = cloud({
			id: "or-free-27b",
			provider: "openrouter",
			modelId: "free-27b",
			spend: "free",
			context: 256_000,
			tags: ["chat", "code"],
		})
		const old = inventory({
			offerings: [offering(), dead5090],
			clouds: [cloud(), openRouterFree],
		})
		const next = inventory() // both dead targets dropped.

		const liveCombos = cleanCombos(old)
		expect(slotModelIds(liveCombos).has("reader-5090-model")).toBe(true)

		const fake = new FakeOmniRouteClient({ combos: liveCombos, connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		// No desired combo after the plan references either dead target.
		const serialized = JSON.stringify(result.ops.filter((o) => o.kind === "combo").map((o) => o.after))
		expect(serialized).not.toContain("reader-5090-model")
		expect(serialized).not.toContain("free-27b")
	})
})

// ---------------------------------------------------------------------------
// (12.2) A same-tag replacement lands in every eligible lane.
// ---------------------------------------------------------------------------

describe("decommission — Requirement 12.2 (same-tag replacement)", () => {
	it("places the replacement offering's slots in every lane the dropped one was eligible for", async () => {
		const dropped = offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })
		// Same capability tags + context ≥ lane min → eligible for the same lanes.
		const replacement = offering({
			id: "coder-v2",
			modelId: "qwen-coder-v2",
			slots: 2,
			ranks: [1, 3],
			tags: ["chat", "code", "read"],
			context: 160_000,
		})

		const old = inventory({ offerings: [dropped] })
		const next = inventory({ offerings: [replacement] })

		// The replacement is eligible for exactly the lanes the dropped one was.
		const droppedLanes = replacementEligibleLanes(old, dropped)
		const replacementLanes = replacementEligibleLanes(next, replacement)
		expect(replacementLanes).toEqual(droppedLanes)
		expect(replacementLanes.length).toBeGreaterThan(0)

		const fake = new FakeOmniRouteClient({ combos: cleanCombos(old), connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		// The replacement's slot targets appear in the desired combos the plan emits.
		const replacementSlotIds = slotModelIds(desiredState(next).combos)
		expect(replacementSlotIds.has("qwen-coder-v2")).toBe(true)

		const emitted = new Set<string>()
		for (const op of result.ops) {
			if (op.kind === "combo" && op.after) {
				for (const ref of (op.after as Combo).models) {
					if (ref.id.startsWith("t:")) {
						emitted.add(ref.id.split(":")[3]!)
					}
				}
			}
		}
		expect(emitted.has("qwen-coder-v2")).toBe(true)
		expect(emitted.has("qwen-coder")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// (12.3) Deactivate a connection whose devices are all removed, AFTER combo ops.
// ---------------------------------------------------------------------------

describe("decommission — Requirement 12.3 (deactivate connections after combo ops)", () => {
	it("deactivates a connection whose endpoint's devices are all dropped, ordered after combo ops", async () => {
		// OLD: gpu0 served by the vllm endpoint. NEW: gpu0 (and its endpoint) dropped.
		const old = inventory()
		// Drop the device, its endpoint, its offering, and the lane's only local
		// target. Keep the lane alive via the surviving cloud target so NEW compiles.
		const next = inventory({
			devices: [],
			endpoints: [],
			offerings: [],
			residencyGroups: [],
		})

		const fake = new FakeOmniRouteClient({ combos: cleanCombos(old), connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		// A deactivation op is produced for conn-vllm.
		expect(result.connectionDeactivations).toHaveLength(1)
		const deactivation = result.connectionDeactivations[0]!
		expect(deactivation.connectionId).toBe("conn-vllm")
		expect(deactivation.endpointId).toBe("vllm")
		expect(deactivation.removedDevices).toContain("gpu0")

		// Ordering (Req 12.3): the deactivation op is placed AFTER every combo op.
		const deactivationOpIndex = result.ops.findIndex(
			(o) => o.kind === "setting" && o.id === "connection:conn-vllm",
		)
		expect(deactivationOpIndex).toBeGreaterThanOrEqual(0)
		const lastComboOpIndex = result.ops.map((o) => o.kind).lastIndexOf("combo")
		expect(deactivationOpIndex).toBeGreaterThan(lastComboOpIndex)
	})
})

// ---------------------------------------------------------------------------
// (12.4 keep-active) A connection shared with a surviving device stays active.
// ---------------------------------------------------------------------------

describe("decommission — Requirement 12.4 (keep shared connections active)", () => {
	it("keeps a connection active when its endpoint still serves a surviving device", async () => {
		// Endpoint serves gpu0 AND gpu1. OLD declares both; NEW drops only gpu0.
		const sharedEndpoint = endpoint({ id: "vllm", provider: "vllm", deviceIds: ["gpu0", "gpu1"] })
		const old = inventory({
			devices: [device({ id: "gpu0", slotCeiling: 4 }), device({ id: "gpu1", slotCeiling: 4 })],
			endpoints: [sharedEndpoint],
			offerings: [
				offering({ id: "coder", deviceId: "gpu0", modelId: "qwen-coder", slots: 2, ranks: [1, 3] }),
				offering({ id: "coder-b", deviceId: "gpu1", modelId: "qwen-coder-b", slots: 2, ranks: [1, 3] }),
			],
		})
		const next = inventory({
			devices: [device({ id: "gpu1", slotCeiling: 4 })],
			endpoints: [endpoint({ id: "vllm", provider: "vllm", deviceIds: ["gpu1"] })],
			offerings: [offering({ id: "coder-b", deviceId: "gpu1", modelId: "qwen-coder-b", slots: 2, ranks: [1, 3] })],
		})

		const fake = new FakeOmniRouteClient({ combos: cleanCombos(old), connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		// The endpoint survives and still serves gpu1 → no deactivation.
		expect(result.connectionDeactivations).toHaveLength(0)
		expect(result.ops.some((o) => o.kind === "setting" && o.id === "connection:conn-vllm")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// (12.4 criterion) Stale catalog / context-override removal.
// ---------------------------------------------------------------------------

describe("decommission — Requirement 12.4 (context-override removal)", () => {
	it("removes the per-model context override for a dropped model id", async () => {
		const old = inventory({
			offerings: [
				offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] }),
				offering({ id: "coder2", modelId: "qwen-coder-b", slots: 1, ranks: [2] }),
			],
		})
		const next = inventory({
			offerings: [offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })],
		})

		const overrides: ContextOverride[] = [
			{ model: "qwen-coder", contextLength: 160_000 },
			{ model: "qwen-coder-b", contextLength: 160_000 },
		]
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(old),
			connections: [connection()],
			contextOverrides: overrides,
		})
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		// The dropped model id's override is removed; the surviving one is kept.
		expect(result.contextOverrideRemovals.map((r) => r.modelId)).toEqual(["qwen-coder-b"])
		expect(result.ops.some((o) => o.kind === "setting" && o.id === "context-override:qwen-coder-b")).toBe(true)
		expect(result.ops.some((o) => o.kind === "setting" && o.id === "context-override:qwen-coder")).toBe(false)
	})

	it("does NOT remove a context override whose model id a surviving offering reuses", async () => {
		// The replacement reuses the same model id → override must stay.
		const old = inventory({ offerings: [offering({ id: "coder", modelId: "qwen-coder" })] })
		const next = inventory({ offerings: [offering({ id: "coder-renamed", modelId: "qwen-coder" })] })

		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(old),
			connections: [connection()],
			contextOverrides: [{ model: "qwen-coder", contextLength: 160_000 }],
		})
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		expect(result.contextOverrideRemovals).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// (12.5) Stale-reference report for an unmanaged combo.
// ---------------------------------------------------------------------------

describe("decommission — Requirement 12.5 (stale references in un-generated combos)", () => {
	it("reports a target resolving to a dropped offering in an unmanaged combo", async () => {
		const old = inventory({
			offerings: [
				offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] }),
				offering({ id: "coder2", modelId: "qwen-coder-b", slots: 1, ranks: [2] }),
			],
		})
		const next = inventory({
			offerings: [offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })],
		})

		const liveCombos = cleanCombos(old)
		// A hand-made (unmanaged — no fleetRevision) combo that references the dropped model id.
		liveCombos.push({
			id: "hand-1",
			name: "hand-made/legacy",
			strategy: "priority",
			models: [{ id: "t:gpu0:vllm:qwen-coder-b:0", kind: "model", model: "qwen-coder-b" }],
			config: {},
			context_length: 1000,
			isHidden: false,
		})

		const fake = new FakeOmniRouteClient({ combos: liveCombos, connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		expect(result.staleReferences).toHaveLength(1)
		const stale = result.staleReferences[0]!
		expect(stale.comboName).toBe("hand-made/legacy")
		expect(stale.modelId).toBe("qwen-coder-b")
		expect(stale.targetId).toBe("t:gpu0:vllm:qwen-coder-b:0")

		// The unmanaged combo is NOT deleted by the plan (not ours to remove).
		expect(result.ops.some((o) => o.kind === "combo" && o.op === "delete" && o.id === "hand-made/legacy")).toBe(
			false,
		)
	})

	it("does not report stale references in managed (generated) combos", async () => {
		const old = inventory({
			offerings: [
				offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] }),
				offering({ id: "coder2", modelId: "qwen-coder-b", slots: 1, ranks: [2] }),
			],
		})
		const next = inventory({
			offerings: [offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })],
		})

		// All live combos are managed (carry fleetRevision from the compiler).
		const fake = new FakeOmniRouteClient({ combos: cleanCombos(old), connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		expect(result.staleReferences).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// (12.6) Per-route local-Slot loss report.
// ---------------------------------------------------------------------------

describe("decommission — Requirement 12.6 (per-route local-Slot loss)", () => {
	it("reports each Public_Route whose local-Slot count decreased, with live and desired counts", async () => {
		// OLD: two offerings → more local slots in the lane. NEW: one dropped.
		const old = inventory({
			offerings: [
				offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] }),
				offering({ id: "coder2", modelId: "qwen-coder-b", slots: 2, ranks: [1, 3] }),
			],
		})
		const next = inventory({
			offerings: [offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })],
		})

		const fake = new FakeOmniRouteClient({ combos: cleanCombos(old), connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		const loss = result.routeSlotLosses.find((r) => r.route === "hybrid/code")
		expect(loss).toBeDefined()
		expect(loss!.liveLocalSlots).toBeGreaterThan(loss!.desiredLocalSlots)
	})

	it("reports no loss when the local-Slot count is unchanged", async () => {
		const old = inventory()
		const next = inventory() // identical.

		const fake = new FakeOmniRouteClient({ combos: cleanCombos(old), connections: [connection()] })
		const result = await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		expect(result.routeSlotLosses).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// Dry-run guarantee — no writes.
// ---------------------------------------------------------------------------

describe("decommission — dry-run (no writes)", () => {
	it("issues no write op on the fake", async () => {
		const old = inventory()
		const next = inventory()
		const fake = new FakeOmniRouteClient({ combos: cleanCombos(old), connections: [connection()] })

		await decommission(old, next, REV, "cluster", fake, { clock: CLOCK })

		const operations = fake.calls().map((c) => c.operation)
		for (const write of [
			"createCombo",
			"updateCombo",
			"deleteCombo",
			"patchConnection",
			"patchContextOverrides",
			"syncModels",
		]) {
			expect(operations).not.toContain(write)
		}
	})
})
