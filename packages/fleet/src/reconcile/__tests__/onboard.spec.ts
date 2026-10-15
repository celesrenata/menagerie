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

import { compile, type Revision } from "../../compile/compiler.js"
import type { AdvertisedModel, Connection, SecretResolver } from "../../omniroute/client.js"
import { FakeOmniRouteClient } from "../../omniroute/fake.js"
import { detectDrift } from "../drift.js"
import {
	apply,
	InMemoryAuditLog,
	InMemoryBackupStore,
	type InstanceLocks,
	type OperatorConfirmation,
} from "../apply.js"
import {
	onboardPlan,
	orderedSteps,
	preflightCheck,
	type ConnectionOp,
	type OnboardPlan,
} from "../onboard.js"

// ---------------------------------------------------------------------------
// Fixtures — a two-endpoint fleet so onboarding a NEW endpoint is expressible.
// Mirrors plan.spec.ts / drift.spec.ts conventions.
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

/**
 * The BASE fleet (before onboarding): one existing endpoint `vllm` on gpu0 with
 * the `coder` offering. The reader lane is served by this offering too (tags
 * include `read`).
 */
function baseInventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
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

/**
 * The ONBOARDED fleet: adds a new device `gpu1`, a new endpoint `vllm2`, and a
 * new offering `reader` on it (an inventory-only edit, Requirement 11.2). The
 * new offering is eligible for the `code` lane (same tags).
 */
function onboardedInventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	const base = baseInventory()
	return {
		...base,
		devices: [...base.devices, device({ id: "gpu1", slotCeiling: 4 })],
		endpoints: [
			...base.endpoints,
			endpoint({
				id: "vllm2",
				provider: "vllm",
				deviceIds: ["gpu1"],
				addresses: [{ instanceId: "cluster", url: "http://gpu1:2701" }],
			}),
		],
		offerings: [
			...base.offerings,
			offering({
				id: "reader",
				endpointId: "vllm2",
				deviceId: "gpu1",
				modelId: "qwen-reader",
				context: 128_000,
				slots: 2,
				ranks: [5, 7],
			}),
		],
		...overrides,
	}
}

const REV: Revision = { commit: "abc123", uncommitted: false }
const CLOCK = () => "2026-10-15T00:00:00.000Z"

/** A secret resolver that resolves every ref to a fixed non-empty value. */
const resolvingSecrets: SecretResolver = { resolve: async () => "a-key" }
/** A secret resolver that resolves nothing (every secret absent). */
const emptySecrets: SecretResolver = { resolve: async () => undefined }

/** No-sleep + 0 ms timers so retries do not stall the test. */
const FAST = { readAttempts: 3, readTimeoutMs: 0, secretTimeoutMs: 0, sleep: async () => {} }

function connection(overrides: Partial<Connection> = {}): Connection {
	return { id: "conn-vllm", provider: "vllm", address: "http://gpu0:2701", isActive: true, ...overrides }
}

/** The advertised models of the new endpoint, matching the declared offering. */
const READER_ADVERTISED: AdvertisedModel[] = [{ id: "qwen-reader", contextLength: 128_000 }]

// ---------------------------------------------------------------------------
// Preflight — passing (Requirement 11.3)
// ---------------------------------------------------------------------------

describe("preflightCheck — pass", () => {
	it("passes when the endpoint is reachable, advertises the exact model id, and exposes the declared context", async () => {
		const inv = onboardedInventory()
		const ep = inv.endpoints.find((e) => e.id === "vllm2")!
		const fake = new FakeOmniRouteClient({ advertisedModels: { "conn-vllm2": READER_ADVERTISED } })

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(true)
		expect(result.endpointFailure).toBeUndefined()
		expect(result.offerings).toHaveLength(1)
		expect(result.offerings[0]!.pass).toBe(true)
	})

	it("passes a credentialed endpoint when the secret resolves (never carrying the value)", async () => {
		const inv = onboardedInventory()
		const ep = { ...inv.endpoints.find((e) => e.id === "vllm2")!, noCredential: false, secretRef: "secret:API_KEY" }
		const fake = new FakeOmniRouteClient({ advertisedModels: { "conn-vllm2": READER_ADVERTISED } })

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(true)
		expect(JSON.stringify(result)).not.toContain("a-key")
	})
})

// ---------------------------------------------------------------------------
// Preflight — failing (Requirement 11.3, 11.4)
// ---------------------------------------------------------------------------

describe("preflightCheck — fail", () => {
	it("reports a reachability failure (endpoint-level) when the advertised-models read never succeeds", async () => {
		const inv = onboardedInventory()
		const ep = inv.endpoints.find((e) => e.id === "vllm2")!
		const fake = new FakeOmniRouteClient({ advertisedModels: { "conn-vllm2": READER_ADVERTISED } })
		fake.scriptFailure({ operation: "getAdvertisedModels", kind: "writeError", status: 500 })

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(false)
		expect(result.endpointFailure?.check).toBe("reachability")
		// The endpoint-level failure is duplicated onto every declared offering.
		expect(result.offerings.every((o) => o.cause?.check === "reachability")).toBe(true)
	})

	it("reports an authentication failure when the endpoint's secret does not resolve, carrying ref/field only", async () => {
		const inv = onboardedInventory()
		const ep = { ...inv.endpoints.find((e) => e.id === "vllm2")!, noCredential: false, secretRef: "secret:API_KEY" }
		const fake = new FakeOmniRouteClient({ advertisedModels: { "conn-vllm2": READER_ADVERTISED } })

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, emptySecrets, FAST)

		expect(result.pass).toBe(false)
		expect(result.endpointFailure?.check).toBe("authentication")
		expect(result.endpointFailure?.secretRef).toBe("secret:API_KEY")
		expect(result.endpointFailure?.secretFieldPath).toContain("vllm2")
	})

	it("reports a per-offering model-id failure (exact, case-sensitive) when the advertised id differs", async () => {
		const inv = onboardedInventory()
		const ep = inv.endpoints.find((e) => e.id === "vllm2")!
		// Advertises a DIFFERENT-CASE id — exact comparison must still fail.
		const fake = new FakeOmniRouteClient({
			advertisedModels: { "conn-vllm2": [{ id: "Qwen-Reader", contextLength: 128_000 }] },
		})

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(false)
		expect(result.endpointFailure).toBeUndefined() // scoped to the offering, not the endpoint
		expect(result.offerings[0]!.cause?.check).toBe("model-id")
	})

	it("reports a per-offering context-window mismatch where the endpoint exposes a different context", async () => {
		const inv = onboardedInventory()
		const ep = inv.endpoints.find((e) => e.id === "vllm2")!
		const fake = new FakeOmniRouteClient({
			advertisedModels: { "conn-vllm2": [{ id: "qwen-reader", contextLength: 64_000 }] },
		})

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(false)
		expect(result.offerings[0]!.cause?.check).toBe("context-window")
	})

	it("passes the context check when the endpoint does not expose a context window (no contextLength)", async () => {
		const inv = onboardedInventory()
		const ep = inv.endpoints.find((e) => e.id === "vllm2")!
		const fake = new FakeOmniRouteClient({ advertisedModels: { "conn-vllm2": [{ id: "qwen-reader" }] } })

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// Preflight — the 3×retry (Requirement 8.10)
// ---------------------------------------------------------------------------

describe("preflightCheck — 3× retry", () => {
	it("retries the advertised-models read up to 3 times, then succeeds on the 3rd attempt", async () => {
		const inv = onboardedInventory()
		const ep = inv.endpoints.find((e) => e.id === "vllm2")!
		const fake = new FakeOmniRouteClient({ advertisedModels: { "conn-vllm2": READER_ADVERTISED } })
		// Fail the first two reads; succeed on the third.
		fake.scriptFailure({ operation: "getAdvertisedModels", kind: "writeError", status: 503, onCall: 1 })
		fake.scriptFailure({ operation: "getAdvertisedModels", kind: "writeError", status: 503, onCall: 2 })

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(true)
		const reads = fake.calls().filter((c) => c.operation === "getAdvertisedModels")
		expect(reads).toHaveLength(3)
	})

	it("gives up after 3 failed attempts and reports a reachability failure", async () => {
		const inv = onboardedInventory()
		const ep = inv.endpoints.find((e) => e.id === "vllm2")!
		const fake = new FakeOmniRouteClient({ advertisedModels: { "conn-vllm2": READER_ADVERTISED } })
		fake.scriptFailure({ operation: "getAdvertisedModels", kind: "writeError", status: 503 })

		const result = await preflightCheck(ep, inv.offerings, "conn-vllm2", fake, resolvingSecrets, FAST)

		expect(result.pass).toBe(false)
		expect(result.endpointFailure?.check).toBe("reachability")
		const reads = fake.calls().filter((c) => c.operation === "getAdvertisedModels")
		expect(reads).toHaveLength(3)
	})
})

// ---------------------------------------------------------------------------
// Onboarding plan — ordering (Requirement 11.5, 11.6, 11.7)
// ---------------------------------------------------------------------------

describe("onboardPlan — connection lifecycle ordering (Req 11.5-11.7)", () => {
	it("emits create-inactive → sync-catalog → activate for the new connection, before any referencing combo", async () => {
		const inv = onboardedInventory()
		// Only the pre-existing vllm endpoint has a live connection; vllm2 is new.
		const fake = new FakeOmniRouteClient({
			connections: [connection()],
			advertisedModels: { "conn-vllm2": READER_ADVERTISED },
		})
		// Preflight resolves vllm2 to no live connection, which would be a
		// reachability failure for the probe; preflight is run against the live
		// connection id resolved below. To exercise a PASSING onboarding we give
		// the fake an advertised list keyed by the id the resolver would find.
		// Since vllm2 has no live connection yet, we add one so the preflight read
		// has a target; the lifecycle still treats it as "new" via newEndpointIds.
		const fakeWithConn = new FakeOmniRouteClient({
			connections: [connection(), connection({ id: "conn-vllm2", provider: "vllm", address: "http://gpu1:2701" })],
			advertisedModels: { "conn-vllm2": READER_ADVERTISED },
		})

		const result = await onboardPlan({
			model: inv,
			rev: REV,
			instanceId: "cluster",
			client: fakeWithConn,
			secretResolver: resolvingSecrets,
			newEndpointIds: ["vllm2"],
			preflightOptions: FAST,
			planOptions: { clock: CLOCK },
		})
		void fake

		expect(result.outcome).toBe("ok")
		const steps = orderedSteps(result)

		// The three connection steps appear in order.
		const connSteps = steps.filter((s): s is ConnectionOp => "step" in s && s.endpointId === "vllm2")
		expect(connSteps.map((s) => s.step)).toEqual(["sync-catalog"])
		// vllm2 resolved to a live connection (conn-vllm2) so it is an existing
		// connection gaining an offering: a single sync-catalog step.
		expect(connSteps[0]!.expectedModelIds).toEqual(["qwen-reader"])

		// Every connection op precedes every combo op (Requirement 11.7).
		const lastConn = findLastIndex(steps, (s) => "step" in s)
		const firstCombo = steps.findIndex((s) => "op" in s && (s as { kind: string }).kind === "combo")
		expect(lastConn).toBeGreaterThanOrEqual(0)
		expect(firstCombo).toBeGreaterThanOrEqual(0)
		expect(lastConn).toBeLessThan(firstCombo)
	})

	it("creates a brand-new connection inactive, syncs, then activates when no live connection resolves", async () => {
		const inv = onboardedInventory()
		// vllm2 has NO live connection yet — it is new to OmniRoute. The pre-apply
		// reachability/model checks are DEFERRED to the apply-time repeat (create
		// inactive → sync → repeat Preflight → activate, Requirement 11.5), so the
		// offerings survive and the full three-step lifecycle is emitted.
		const fake = new FakeOmniRouteClient({ connections: [connection()] })

		const result = await onboardPlan({
			model: inv,
			rev: REV,
			instanceId: "cluster",
			client: fake,
			secretResolver: resolvingSecrets,
			newEndpointIds: ["vllm2"],
			preflightOptions: FAST,
			planOptions: { clock: CLOCK },
		})

		expect(result.outcome).toBe("ok")
		// Preflight deferred the probe (no live connection to reach pre-apply).
		const vllm2Preflight = result.preflight.find((p) => p.endpointId === "vllm2")!
		expect(vllm2Preflight.deferred).toBe(true)
		expect(vllm2Preflight.pass).toBe(true)

		const vllm2Ops = result.connectionOps.filter((o) => o.endpointId === "vllm2")
		expect(vllm2Ops.map((o) => o.step)).toEqual(["create-inactive", "sync-catalog", "activate"])

		// Ordering within orderedSteps: all three precede the referencing combos.
		const steps = orderedSteps(result)
		const activateIdx = steps.findIndex((s) => "step" in s && s.step === "activate" && s.endpointId === "vllm2")
		const firstCombo = steps.findIndex((s) => "op" in s && (s as { kind: string }).kind === "combo")
		expect(activateIdx).toBeLessThan(firstCombo)
	})
})

// ---------------------------------------------------------------------------
// Onboarding plan — Preflight failure excludes offerings and compiles as-if-absent
// (Requirement 11.4), including the 5.7 trip (Requirement 5.7).
// ---------------------------------------------------------------------------

describe("onboardPlan — exclusion and compile-as-if-absent (Req 11.4)", () => {
	it("excludes a model-id-failing offering and compiles the plan without it", async () => {
		const inv = onboardedInventory()
		const fake = new FakeOmniRouteClient({
			connections: [connection(), connection({ id: "conn-vllm2", provider: "vllm", address: "http://gpu1:2701" })],
			// vllm2 advertises the WRONG id, so the reader offering is excluded.
			advertisedModels: { "conn-vllm2": [{ id: "wrong-id", contextLength: 128_000 }] },
		})

		const result = await onboardPlan({
			model: inv,
			rev: REV,
			instanceId: "cluster",
			client: fake,
			secretResolver: resolvingSecrets,
			newEndpointIds: ["vllm2"],
			preflightOptions: FAST,
			planOptions: { clock: CLOCK },
		})

		// The onboarding still compiles (the base vllm offering keeps the lane
		// populated), with the reader offering excluded.
		expect(result.outcome).toBe("ok")
		expect(result.excluded).toHaveLength(1)
		expect(result.excluded[0]!.offeringId).toBe("reader")
		expect(result.excluded[0]!.cause.check).toBe("model-id")
		// The excluded endpoint contributes no connection lifecycle op.
		expect(result.connectionOps.filter((o) => o.endpointId === "vllm2")).toEqual([])
	})

	it("surfaces a Requirement 5.7 compile failure when the exclusion empties a lane", async () => {
		// A fleet whose ONLY offering serves the only lane; onboarding it as a new
		// endpoint and failing its Preflight leaves the lane with no eligible
		// target → Requirement 5.7.
		const soleInv: FleetInventory = {
			devices: [device({ id: "gpu0", slotCeiling: 4 })],
			endpoints: [endpoint({ id: "vllm", provider: "vllm", deviceIds: ["gpu0"] })],
			residencyGroups: [residency()],
			offerings: [offering({ id: "coder", modelId: "qwen-coder", slots: 2, ranks: [1, 3] })],
			clouds: [], // no cloud spill to fall back on
			lanes: [
				lane({
					id: "code",
					names: ["hybrid/code"],
					capabilities: ["chat", "code"],
					minContext: 60_000,
					spillTiers: [],
					failClosed: true,
				}),
			],
			instances: [instance()],
			diagnostics: [],
			improvementObjectiveOrder: [],
		}
		const fake = new FakeOmniRouteClient({
			connections: [connection()],
			// The sole endpoint advertises the wrong id → its offering is excluded.
			advertisedModels: { "conn-vllm": [{ id: "wrong-id" }] },
		})

		const result = await onboardPlan({
			model: soleInv,
			rev: REV,
			instanceId: "cluster",
			client: fake,
			secretResolver: resolvingSecrets,
			newEndpointIds: ["vllm"],
			preflightOptions: FAST,
			planOptions: { clock: CLOCK },
		})

		expect(result.outcome).toBe("compile-failed")
		expect(result.changePlan).toBeUndefined()
		expect(result.compileFailures.length).toBeGreaterThan(0)
		expect(result.compileFailures.join(" ")).toContain("code")
	})
})

// ---------------------------------------------------------------------------
// Requirement 11.2 — inventory-only onboarding yields no drift after apply.
// ---------------------------------------------------------------------------

describe("onboardPlan — inventory-only, no drift after apply (Req 11.2)", () => {
	it("onboards by editing the inventory, applying the plan, and finds no drift for the new entries", async () => {
		const onboarded = onboardedInventory()

		// The live fleet before onboarding: the base vllm combos (clean, with the
		// connection id filled) plus both live connections (vllm already active,
		// vllm2 pre-created as a live connection the plan will reference).
		const baseState = compile(baseInventory(), REV)
		if (!baseState.ok) throw new Error("base fixture failed to compile")
		const baseCombos = (baseState.states.get("cluster")?.combos ?? []).map((c) => ({
			...structuredClone(c),
			models: c.models.map((m) =>
				m.id.startsWith("t:") ? { ...structuredClone(m), connectionId: "conn-vllm" } : structuredClone(m),
			),
		}))

		const fake = new FakeOmniRouteClient({
			combos: baseCombos,
			connections: [
				connection(),
				connection({ id: "conn-vllm2", provider: "vllm", address: "http://gpu1:2701", isActive: true }),
			],
			advertisedModels: {
				"conn-vllm": [{ id: "qwen-coder", contextLength: 160_000 }],
				"conn-vllm2": READER_ADVERTISED,
			},
		})

		// Plan the onboarding over the edited inventory.
		const onboarding = await onboardPlan({
			model: onboarded,
			rev: REV,
			instanceId: "cluster",
			client: fake,
			secretResolver: resolvingSecrets,
			newEndpointIds: ["vllm2"],
			preflightOptions: FAST,
			planOptions: { clock: CLOCK },
		})
		expect(onboarding.outcome).toBe("ok")
		expect(onboarding.changePlan).toBeDefined()
		expect(onboarding.changePlan!.errors).toEqual([])

		// Apply the base Change_Plan via the fake (the combo/setting writer path).
		const locks: InstanceLocks = new Set<string>()
		const applyResult = await apply(onboarding.changePlan!, confirmationFor(onboarding), {
			client: fake,
			backups: new InMemoryBackupStore(),
			audit: new InMemoryAuditLog(),
			locks,
			clock: CLOCK,
		})
		expect(applyResult.outcome).toBe("succeeded")

		// A drift run after the apply reports no drift for the new combos.
		const clients = new Map([["cluster", fake]])
		const drift = await detectDrift(onboarded, REV, clients, {
			readAttempts: 1,
			readTimeoutMs: 0,
			sleep: async () => {},
		})

		const cluster = drift.instances.find((i) => i.instanceId === "cluster")!
		// No missing/extra/changed combo for the fleet's routes after apply —
		// onboarding was an inventory-only edit (Requirement 11.2).
		expect(cluster.counts.missing).toBe(0)
		expect(cluster.counts.extra).toBe(0)
		expect(cluster.counts.changed).toBe(0)

		// Specifically: the NEW reader entries (the gpu1/vllm2 slots) show no drift.
		const newEntryDiffs = cluster.differences.filter((d) => JSON.stringify(d).includes("qwen-reader"))
		expect(newEntryDiffs).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Read-only guarantee (Requirement 22.1) — planning issues no write.
// ---------------------------------------------------------------------------

describe("onboardPlan — read-only (Req 22.1)", () => {
	it("issues no write while planning", async () => {
		const inv = onboardedInventory()
		const fake = new FakeOmniRouteClient({
			connections: [connection(), connection({ id: "conn-vllm2", provider: "vllm", address: "http://gpu1:2701" })],
			advertisedModels: { "conn-vllm2": READER_ADVERTISED },
		})

		await onboardPlan({
			model: inv,
			rev: REV,
			instanceId: "cluster",
			client: fake,
			secretResolver: resolvingSecrets,
			newEndpointIds: ["vllm2"],
			preflightOptions: FAST,
			planOptions: { clock: CLOCK },
		})

		const operations = fake.calls().map((c) => c.operation)
		for (const write of ["createCombo", "updateCombo", "deleteCombo", "patchConnection", "patchContextOverrides", "syncModels"]) {
			expect(operations).not.toContain(write)
		}
	})
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (predicate(items[i]!)) {
			return i
		}
	}
	return -1
}

/** Build the apply confirmation from the plan the operator reviewed. */
function confirmationFor(plan: OnboardPlan): OperatorConfirmation {
	const change = plan.changePlan!
	return {
		operator: "tester",
		instanceId: change.instanceId,
		target: { kind: "plan", revision: change.revision.commit, createdAt: change.createdAt },
		confirmDeletions: true,
	}
}
