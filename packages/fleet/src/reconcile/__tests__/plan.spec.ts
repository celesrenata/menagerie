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
import type { Connection } from "../../omniroute/client.js"
import { FakeOmniRouteClient } from "../../omniroute/fake.js"
import { plan, type ChangeOp, type ChangePlan } from "../plan.js"

// ---------------------------------------------------------------------------
// Fixtures — a validated typed FleetInventory and a matching Live_Route_State.
// (Mirrors drift.spec.ts so the two suites share the same declared fleet.)
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

// A fixed UTC clock so createdAt is deterministic.
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
 * The live combos of a clean, no-drift fleet. A real OmniRoute live combo
 * carries the RESOLVED connection id on each local-slot ref (OmniRoute dispatches
 * by it); the compiler leaves it empty and the Reconciler fills it at plan time,
 * so the clean live state is the compiled state with `connectionId` filled to the
 * live connection the fixture declares (`conn-vllm`).
 */
function cleanCombos(inv: FleetInventory): Combo[] {
	return desiredState(inv).combos.map((c) => ({
		...structuredClone(c),
		models: c.models.map((m) =>
			m.id.startsWith("t:") ? { ...structuredClone(m), connectionId: "conn-vllm" } : structuredClone(m),
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

/** The combo names of a kind helper: the Internal_Pool is the hidden combo. */
function poolName(inv: FleetInventory): string {
	const pool = desiredState(inv).combos.find((c) => c.isHidden && c.name !== "diag/gpu0")
	if (!pool) {
		throw new Error("fixture produced no Internal_Pool combo")
	}
	return pool.name
}

/** The index of the first op creating/deleting the named combo, or -1. */
function indexOf(ops: readonly ChangeOp[], id: string, op: ChangeOp["op"]): number {
	return ops.findIndex((o) => o.kind === "combo" && o.id === id && o.op === op)
}

// A connection that resolves the vllm endpoint (provider vllm, gpu0:2701).
const VLLM_CONN = connection()

// ---------------------------------------------------------------------------
// All-create plan from an empty live state (Requirement 9.2 ordering).
// ---------------------------------------------------------------------------

describe("plan — all-create from empty live state", () => {
	it("emits a create for every desired combo, pools ordered before the routes that ref them", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({ connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		expect(result.instanceId).toBe("cluster")
		expect(result.revision).toEqual(REV)
		expect(result.createdAt).toBe("2026-10-15T00:00:00.000Z")
		expect(result.errors).toEqual([])

		// Every desired combo has a create op.
		const desired = desiredState(inv).combos
		for (const combo of desired) {
			expect(indexOf(result.ops, combo.name, "create")).toBeGreaterThanOrEqual(0)
		}

		// The lane's Internal_Pool is created before the Public_Route that refs it.
		const pool = poolName(inv)
		const poolCreate = indexOf(result.ops, pool, "create")
		const routeCreate = indexOf(result.ops, "hybrid/code", "create")
		expect(poolCreate).toBeGreaterThanOrEqual(0)
		expect(routeCreate).toBeGreaterThanOrEqual(0)
		expect(poolCreate).toBeLessThan(routeCreate)

		// A create carries an after and no before (Requirement 9.2).
		const routeOp = result.ops[routeCreate]!
		expect(routeOp.after).toBeDefined()
		expect(routeOp.before).toBeUndefined()
	})

	it("issues NO write op on the fake — only the two reads (Requirement 9.1)", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({ connections: [VLLM_CONN] })

		await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		const operations = fake.calls().map((c) => c.operation)
		expect(operations).toContain("listConnections")
		expect(operations).toContain("listCombos")
		// No write of any kind.
		for (const write of ["createCombo", "updateCombo", "deleteCombo", "patchConnection", "patchContextOverrides", "syncModels"]) {
			expect(operations).not.toContain(write)
		}
	})
})

// ---------------------------------------------------------------------------
// Update plan (Requirement 9.2 — complete before/after).
// ---------------------------------------------------------------------------

describe("plan — update", () => {
	it("emits an update with complete before/after when a live combo differs", async () => {
		const inv = inventory()
		// Live has every desired combo, but hybrid/code differs on context_length.
		const combos = cleanCombos(inv).map((c) =>
			c.name === "hybrid/code" ? { ...c, context_length: 999_999 } : c,
		)
		const fake = new FakeOmniRouteClient({ combos, connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		const update = result.ops.find((o) => o.op === "update" && o.id === "hybrid/code")
		expect(update).toBeDefined()
		expect((update!.before as Combo).context_length).toBe(999_999)
		expect((update!.after as Combo).context_length).toBe(desiredState(inv).combos.find((c) => c.name === "hybrid/code")!.context_length)
		// No create/delete for a combo that merely changed.
		expect(indexOf(result.ops, "hybrid/code", "create")).toBe(-1)
		expect(indexOf(result.ops, "hybrid/code", "delete")).toBe(-1)
	})

	it("does NOT emit an update when the only difference is the fleetRevision provenance key (Req 8.2)", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv).map((c) => ({
			...c,
			config: { ...c.config, fleetRevision: "a-different-commit", usageCount: 7 },
		}))
		const fake = new FakeOmniRouteClient({ combos, connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		expect(result.ops.filter((o) => o.op === "update" && o.kind === "combo")).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Delete plan (Requirement 9.2 — deletes after ref removal).
// ---------------------------------------------------------------------------

describe("plan — delete", () => {
	it("deletes an extra managed route before the pool it referenced", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv)
		// Two extra managed combos: a route that refs an extra pool. The route must
		// be deleted BEFORE the pool it references (Requirement 9.2).
		combos.push({
			id: "extra-pool",
			name: "pool/extra",
			strategy: "priority",
			models: [{ id: "t:gpu0:vllm:qwen-coder:0", kind: "model", model: "qwen-coder" }],
			config: { fleetRevision: "old-commit" },
			context_length: 0,
			isHidden: true,
		})
		combos.push({
			id: "extra-route",
			name: "hybrid/extra",
			strategy: "priority",
			models: [{ id: "hybrid/extra->pool/extra", kind: "combo-ref", comboName: "pool/extra" }],
			config: { fleetRevision: "old-commit" },
			context_length: 1000,
			isHidden: false,
		})
		const fake = new FakeOmniRouteClient({ combos, connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		const routeDelete = indexOf(result.ops, "hybrid/extra", "delete")
		const poolDelete = indexOf(result.ops, "pool/extra", "delete")
		expect(routeDelete).toBeGreaterThanOrEqual(0)
		expect(poolDelete).toBeGreaterThanOrEqual(0)
		expect(routeDelete).toBeLessThan(poolDelete)

		// A delete carries a before and no after (Requirement 9.2).
		const op = result.ops[routeDelete]!
		expect(op.before).toBeDefined()
		expect(op.after).toBeUndefined()
	})

	it("leaves an unmanaged (hand-made) live combo alone — no delete op", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv)
		combos.push({
			id: "hand-1",
			name: "hand-made",
			strategy: "priority",
			models: [{ id: "t:gpu0:vllm:qwen-coder:0", kind: "model", model: "qwen-coder" }],
			config: {}, // no fleetRevision provenance key → unmanaged
			context_length: 1000,
			isHidden: false,
		})
		const fake = new FakeOmniRouteClient({ combos, connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		expect(indexOf(result.ops, "hand-made", "delete")).toBe(-1)
	})
})

// ---------------------------------------------------------------------------
// Connection-id resolution (design §3).
// ---------------------------------------------------------------------------

describe("plan — connection-id resolution", () => {
	it("fills connectionId on every local-slot ref from GET /api/providers", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({ connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		// The pool's local-slot refs now carry the live connection id.
		const pool = poolName(inv)
		const poolCreate = result.ops.find((o) => o.op === "create" && o.id === pool)
		expect(poolCreate).toBeDefined()
		const slotRefs = (poolCreate!.after as Combo).models.filter((m) => m.id.startsWith("t:"))
		expect(slotRefs.length).toBeGreaterThan(0)
		for (const ref of slotRefs) {
			expect(ref.connectionId).toBe("conn-vllm")
		}
	})

	it("resolves by provider + host:port, ignoring scheme and path differences", async () => {
		const inv = inventory()
		// Same host:port, different scheme (https) + a trailing path. Must still match.
		const fake = new FakeOmniRouteClient({
			connections: [connection({ id: "conn-https", address: "https://gpu0:2701/v1" })],
		})

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		expect(result.errors).toEqual([])
		const pool = poolName(inv)
		const poolCreate = result.ops.find((o) => o.op === "create" && o.id === pool)!
		const slotRef = (poolCreate.after as Combo).models.find((m) => m.id.startsWith("t:"))!
		expect(slotRef.connectionId).toBe("conn-https")
	})

	it("reports a plan error naming the endpoint when no live connection resolves a referenced endpoint", async () => {
		const inv = inventory()
		// A live connection for a DIFFERENT host:port — the vllm endpoint is unresolved.
		const fake = new FakeOmniRouteClient({
			connections: [connection({ id: "conn-other", provider: "vllm", address: "http://other-host:9999" })],
		})

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		expect(result.errors).toHaveLength(1)
		const error = result.errors[0]!
		expect(error.kind).toBe("missing-connection")
		expect(error.endpointId).toBe("vllm")
		expect(error.provider).toBe("vllm")
		expect(error.message).toContain("vllm")
	})
})

// ---------------------------------------------------------------------------
// Credential safety (Requirement 22.4-22.6) — no tokenized segment leaks.
// ---------------------------------------------------------------------------

describe("plan — no secret / tokenized-segment leak (Req 22.4-22.6)", () => {
	it("redacts a tokenized URL path segment that appears in a live combo config", async () => {
		const inv = inventory()
		// A live managed combo carrying a tokenized URL segment in its config, so
		// the update's before value would otherwise leak it.
		const combos = cleanCombos(inv).map((c) =>
			c.name === "hybrid/code"
				? {
						...c,
						context_length: 1,
						config: { ...c.config, probeUrl: "https://host/api/v1/vscode/supersecrettoken/models" },
					}
				: c,
		)
		const fake = new FakeOmniRouteClient({ combos, connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		const serialized = JSON.stringify(result)
		expect(serialized).not.toContain("supersecrettoken")
		expect(serialized).toContain("<redacted>")
	})

	it("carries no connection address string verbatim in the plan ops", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({ connections: [VLLM_CONN] })

		const result: ChangePlan = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		// The resolved connection id is placed on refs; the raw connection address
		// is never copied into a plan op (only the opaque id is).
		const serialized = JSON.stringify(result.ops)
		expect(serialized).not.toContain("http://gpu0:2701")
	})
})

// ---------------------------------------------------------------------------
// Routing_Setting ops.
// ---------------------------------------------------------------------------

describe("plan — Routing_Settings", () => {
	it("proposes each compiled Routing_Setting as an update with the desired after value", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({ connections: [VLLM_CONN] })

		const result = await plan(inv, REV, "cluster", fake, { clock: CLOCK })

		const settingOps = result.ops.filter((o) => o.kind === "setting")
		expect(settingOps.length).toBeGreaterThan(0)
		for (const op of settingOps) {
			expect(op.op).toBe("update")
			expect(op.after).toBeDefined()
		}
	})
})
