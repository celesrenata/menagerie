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
import type { AdvertisedModel, Connection, ContextOverride } from "../../omniroute/client.js"
import { FakeOmniRouteClient } from "../../omniroute/fake.js"
import { detectDrift, type DriftOptions } from "../drift.js"

// ---------------------------------------------------------------------------
// Fixtures — a validated typed FleetInventory and a matching Live_Route_State.
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

// Zero timeout + no-op sleep so the retry loop never actually waits 30 s.
const FAST: DriftOptions = { readTimeoutMs: 0, sleep: async () => {} }

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

/** The live combos equal the compiled desired combos (a clean, no-drift fleet). */
function cleanCombos(inv: FleetInventory): Combo[] {
	return desiredState(inv).combos.map((c) => ({ ...c }))
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

function clientsFor(instanceId: string, fake: FakeOmniRouteClient): Map<string, FakeOmniRouteClient> {
	return new Map([[instanceId, fake]])
}

// ---------------------------------------------------------------------------
// Clean run — complete, no drift (Requirement 8.9).
// ---------------------------------------------------------------------------

describe("detectDrift — clean run", () => {
	it("reports a complete outcome and no differences when live matches desired", async () => {
		const inv = inventory()
		const advertised: AdvertisedModel[] = [{ id: "qwen-coder", contextLength: 160_000 }]
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": advertised },
		})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)

		expect(report.outcome).toBe("complete")
		const cluster = report.instances.find((i) => i.instanceId === "cluster")!
		expect(cluster.differences).toEqual([])
		expect(cluster.modelIdFindings).toEqual([])
		expect(cluster.unverified).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Combo classifications (Requirement 8.1).
// ---------------------------------------------------------------------------

describe("detectDrift — combo classification (Req 8.1)", () => {
	it("classifies a missing combo (desired, absent live)", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv).filter((c) => c.name !== "hybrid/code")
		const fake = new FakeOmniRouteClient({ combos })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const cluster = report.instances[0]!
		const diff = cluster.differences.find((d) => d.object === "combo" && d.name === "hybrid/code")
		expect(diff?.kind).toBe("missing")
	})

	it("classifies an extra combo (live with fleetRevision, not desired)", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv)
		combos.push({
			id: "extra-1",
			name: "hybrid/retired-extra",
			strategy: "priority",
			models: [{ id: "m", kind: "model", model: "qwen-coder" }],
			config: { fleetRevision: "old-commit" },
			context_length: 1000,
			isHidden: false,
		})
		const fake = new FakeOmniRouteClient({ combos })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const diff = report.instances[0]!.differences.find((d) => d.name === "hybrid/retired-extra")
		expect(diff?.kind).toBe("extra")
	})

	it("classifies an unmanaged combo (live without fleetRevision, not desired)", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv)
		combos.push({
			id: "hand-1",
			name: "hand-made",
			strategy: "priority",
			models: [{ id: "m", kind: "model", model: "qwen-coder" }],
			config: {}, // no fleetRevision provenance key
			context_length: 1000,
			isHidden: false,
		})
		const fake = new FakeOmniRouteClient({ combos })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const diff = report.instances[0]!.differences.find((d) => d.name === "hand-made")
		expect(diff?.kind).toBe("unmanaged")
	})

	it("classifies a changed combo and lists the differing field, ignoring the provenance key", async () => {
		const inv = inventory()
		// A revision bump alone must NOT be drift (Req 8.2); change context_length too.
		const combos = cleanCombos(inv).map((c) =>
			c.name === "hybrid/code"
				? { ...c, config: { ...c.config, fleetRevision: "a-different-commit" }, context_length: 999_999 }
				: c,
		)
		const fake = new FakeOmniRouteClient({ combos })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const diff = report.instances[0]!.differences.find((d) => d.name === "hybrid/code" && d.kind === "changed")
		expect(diff).toBeDefined()
		expect(diff?.fields?.some((f) => f.field === "context_length")).toBe(true)
		// The provenance key is NOT reported as a differing field.
		expect(diff?.fields?.some((f) => f.field === `config.fleetRevision`)).toBe(false)
	})

	it("does not flag a combo whose only difference is the fleetRevision provenance key (Req 8.2)", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv).map((c) => ({
			...c,
			config: { ...c.config, fleetRevision: "freshly-bumped-commit" },
		}))
		const fake = new FakeOmniRouteClient({ combos })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const changed = report.instances[0]!.differences.filter((d) => d.kind === "changed")
		expect(changed).toEqual([])
	})

	it("ignores OmniRoute bookkeeping fields in the config comparison (Req 8.2)", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv).map((c) =>
			c.name === "hybrid/code"
				? { ...c, config: { ...c.config, createdAt: "2026-01-01", usageCount: 42, health: "ok" } }
				: c,
		)
		const fake = new FakeOmniRouteClient({ combos })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const changed = report.instances[0]!.differences.filter((d) => d.kind === "changed")
		expect(changed).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Model-id catalog findings (Requirement 8.5, 8.6, 8.7).
// ---------------------------------------------------------------------------

describe("detectDrift — model-id findings (Req 8.5-8.7)", () => {
	it("reports undeclared, missing, and stale model ids (exact case-sensitive)", async () => {
		const inv = inventory()
		// Advertised: an undeclared id and NOT the declared qwen-coder (so it is missing).
		const advertised: AdvertisedModel[] = [{ id: "surprise-model" }]
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			// synced catalog carries a stale id no longer advertised.
			connections: [connection({ defaultModel: "stale-model" })],
			advertisedModels: { "conn-vllm": advertised },
		})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const findings = report.instances[0]!.modelIdFindings
		expect(findings.some((f) => f.modelId === "surprise-model" && f.kind === "undeclared")).toBe(true)
		expect(findings.some((f) => f.modelId === "qwen-coder" && f.kind === "missing")).toBe(true)
		expect(findings.some((f) => f.modelId === "stale-model" && f.kind === "stale")).toBe(true)
	})

	it("treats model-id matching as case-sensitive (QWEN-CODER != qwen-coder)", async () => {
		const inv = inventory()
		const advertised: AdvertisedModel[] = [{ id: "QWEN-CODER", contextLength: 160_000 }]
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": advertised },
		})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const findings = report.instances[0]!.modelIdFindings
		expect(findings.some((f) => f.modelId === "QWEN-CODER" && f.kind === "undeclared")).toBe(true)
		expect(findings.some((f) => f.modelId === "qwen-coder" && f.kind === "missing")).toBe(true)
	})

	it("reports an exposed-context mismatch as a changed Model_Offering (Req 8.8)", async () => {
		const inv = inventory()
		// Advertised context differs from the declared 160_000.
		const advertised: AdvertisedModel[] = [{ id: "qwen-coder", contextLength: 128_000 }]
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": advertised },
		})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const diff = report.instances[0]!.differences.find((d) => d.object === "modelOffering" && d.name === "qwen-coder")
		expect(diff?.kind).toBe("changed")
		expect(diff?.fields?.[0]).toMatchObject({ field: "contextWindow", desired: 160_000, live: 128_000 })
	})

	it("prefers a live per-model context override over the advertised context (Req 8.8)", async () => {
		const inv = inventory()
		const advertised: AdvertisedModel[] = [{ id: "qwen-coder", contextLength: 160_000 }]
		const overrides: ContextOverride[] = [{ model: "qwen-coder", contextLength: 64_000 }]
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": advertised },
			contextOverrides: overrides,
		})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const diff = report.instances[0]!.differences.find((d) => d.object === "modelOffering" && d.name === "qwen-coder")
		expect(diff?.fields?.[0]).toMatchObject({ field: "contextWindow", desired: 160_000, live: 64_000 })
	})
})

// ---------------------------------------------------------------------------
// Off-inventory connection override (Requirement 7.7).
// ---------------------------------------------------------------------------

describe("detectDrift — off-inventory connection override (Req 7.7)", () => {
	it("reports a live concurrency / rate-limit / wait override as drift", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [
				connection({
					maxConcurrent: 99,
					rateLimitOverrides: { rpm: 10 },
				}),
			],
			advertisedModels: { "conn-vllm": [{ id: "qwen-coder", contextLength: 160_000 }] },
		})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const diff = report.instances[0]!.differences.find((d) => d.object === "connection")
		expect(diff?.kind).toBe("changed")
		const fieldNames = diff?.fields?.map((f) => f.field) ?? []
		expect(fieldNames).toContain("maxConcurrent")
		expect(fieldNames).toContain("rateLimitOverrides")
		// The connection resolves to the declared endpoint's device.
		expect(diff?.touchedDevices).toContain("gpu0")
	})
})

// ---------------------------------------------------------------------------
// Retired-instance shadows (Requirement 10.4, 10.6).
// ---------------------------------------------------------------------------

describe("detectDrift — retired instance shadows (Req 10.4, 10.6)", () => {
	it("reports every combo reusing a declared route name or touching a declared device as drift", async () => {
		const inv = inventory({
			instances: [instance({ id: "cluster", role: "primary" }), instance({ id: "mac", role: "retired" })],
		})

		const macConnections: Connection[] = [connection({ id: "conn-mac", address: "http://gpu0:2701", isActive: true })]
		// A stale hybrid/* shadow reusing a declared route name, plus a hand-made
		// combo touching the declared device via the connection it names.
		const macCombos: Combo[] = [
			{
				id: "shadow-1",
				name: "hybrid/code", // reuses a declared Public_Route name
				strategy: "priority",
				models: [{ id: "m", kind: "model", model: "qwen-coder", connectionId: "conn-mac" }],
				config: { fleetRevision: "ancient" },
				context_length: 1000,
				isHidden: false,
			},
			{
				id: "shadow-2",
				name: "hand/thing", // reuses no declared name but touches gpu0
				strategy: "priority",
				models: [{ id: "m", kind: "model", model: "qwen-coder", connectionId: "conn-mac" }],
				config: {},
				context_length: 1000,
				isHidden: false,
			},
		]

		const clusterFake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": [{ id: "qwen-coder", contextLength: 160_000 }] },
		})
		const macFake = new FakeOmniRouteClient({
			combos: macCombos,
			connections: macConnections,
		})
		const clients = new Map([
			["cluster", clusterFake],
			["mac", macFake],
		])

		const report = await detectDrift(inv, REV, clients, FAST)
		const mac = report.instances.find((i) => i.instanceId === "mac")!

		const shadow1 = mac.differences.find((d) => d.object === "combo" && d.name === "hybrid/code")
		expect(shadow1?.kind).toBe("extra") // records a producing revision
		expect(shadow1?.reusedName).toBe("hybrid/code")

		const shadow2 = mac.differences.find((d) => d.object === "combo" && d.name === "hand/thing")
		expect(shadow2?.kind).toBe("unmanaged") // no producing revision
		expect(shadow2?.touchedDevices).toContain("gpu0")

		// The active declared-endpoint connection is itself reported as a shadow.
		const connShadow = mac.differences.find((d) => d.object === "connection")
		expect(connShadow?.kind).toBe("unmanaged")
		expect(connShadow?.touchedDevices).toContain("gpu0")
	})
})

// ---------------------------------------------------------------------------
// Unverified reads (Requirement 8.10) — run completes as `incomplete`.
// ---------------------------------------------------------------------------

describe("detectDrift — unverified reads (Req 8.10)", () => {
	it("marks a target unverified when a scripted read fails every attempt and completes as incomplete", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": [{ id: "qwen-coder", contextLength: 160_000 }] },
		})
		fake.scriptFailure({ operation: "listCombos", kind: "writeError", status: 500 })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)

		expect(report.outcome).toBe("incomplete")
		const cluster = report.instances[0]!
		const unverified = cluster.unverified.find((u) => u.operation === "listCombos")
		expect(unverified).toBeDefined()
		expect(unverified?.reason).toBe("error response")
		// An unverified read is NEVER classified as a difference (Req 8.10).
		expect(cluster.differences.some((d) => d.object === "combo")).toBe(false)
	})

	it("retries the configured number of attempts before giving up", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": [{ id: "qwen-coder", contextLength: 160_000 }] },
		})
		// Fail only the first two attempts; the third succeeds, so no unverified.
		fake.scriptFailure({ operation: "listCombos", kind: "writeError", status: 500, onCall: 1 })
		fake.scriptFailure({ operation: "listCombos", kind: "writeError", status: 500, onCall: 2 })

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), { ...FAST, readAttempts: 3 })

		expect(report.outcome).toBe("complete")
		expect(report.instances[0]!.unverified).toEqual([])
	})

	it("marks every value unverified when no client is supplied for a declared instance", async () => {
		const inv = inventory()
		const report = await detectDrift(inv, REV, new Map(), FAST)
		expect(report.outcome).toBe("incomplete")
		expect(report.instances[0]!.unverified.length).toBeGreaterThan(0)
	})
})

// ---------------------------------------------------------------------------
// Failed outcome (Requirement 8.12).
// ---------------------------------------------------------------------------

describe("detectDrift — failed outcome (Req 8.12)", () => {
	it("ends as failed with the compile offenders when the inventory does not compile", async () => {
		// A lane whose capability no offering carries: no eligible target → compile failure.
		const inv = inventory({
			lanes: [lane({ id: "code", names: ["hybrid/code"], capabilities: ["nonexistent-tag"], minContext: 60_000 })],
		})
		const fake = new FakeOmniRouteClient({})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		expect(report.outcome).toBe("failed")
		expect(report.failures.length).toBeGreaterThan(0)
		expect(report.instances).toEqual([])
		// Read-only: a failed compile performs no live comparison, so no reads happen.
		expect(fake.calls()).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Read-only + no secret/body leaks (Requirement 8.3, 22.4-22.6).
// ---------------------------------------------------------------------------

describe("detectDrift — read-only and credential-free (Req 8.3, 22.4-22.6)", () => {
	it("issues only read operations against OmniRoute", async () => {
		const inv = inventory()
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			connections: [connection()],
			advertisedModels: { "conn-vllm": [{ id: "qwen-coder", contextLength: 160_000 }] },
		})

		await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)

		const writeOps = new Set([
			"createCombo",
			"updateCombo",
			"deleteCombo",
			"patchConnection",
			"patchContextOverrides",
			"syncModels",
		])
		expect(fake.calls().every((c) => !writeOps.has(c.operation))).toBe(true)
	})

	it("never leaks a secret value or a tokenized URL segment in the report", async () => {
		const inv = inventory()
		const secret = "sk-super-secret-token-value"
		const fake = new FakeOmniRouteClient({
			combos: cleanCombos(inv),
			// A connection id with a tokenized path segment and an override carrying
			// a tokenized URL — both must be redacted out of the report.
			connections: [
				connection({
					id: "/api/v1/vscode/" + secret + "/conn",
					address: "http://gpu0:2701",
					maxConcurrent: 7,
					rateLimitOverrides: { note: "see http://host/api/v1/vscode/" + secret + "/x" },
				}),
			],
			advertisedModels: {},
		})

		const report = await detectDrift(inv, REV, clientsFor("cluster", fake), FAST)
		const serialized = JSON.stringify(report)
		expect(serialized.includes(secret)).toBe(false)
	})
})
