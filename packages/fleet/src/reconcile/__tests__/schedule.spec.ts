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
import type { AdvertisedModel, Connection, SecretResolver } from "../../omniroute/client.js"
import { FakeOmniRouteClient } from "../../omniroute/fake.js"
import type { DriftOptions } from "../drift.js"
import {
	AlertWriteError,
	HttpAlertWriter,
	MAX_SCHEDULE_INTERVAL_MS,
	runScheduledDrift,
	scheduleDrift,
	type AlertFetchLike,
	type AlertWriter,
	type ScheduleTimers,
} from "../schedule.js"

// ---------------------------------------------------------------------------
// Fixtures — a validated typed FleetInventory and a matching Live_Route_State.
// (Mirrors drift.spec.ts so a scheduled run is exercised on the same shapes.)
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
		alertDestination: { url: "https://alerts.example/hook", secretRef: "secret://alert-token" },
		improvementObjectiveOrder: [],
		...overrides,
	}
}

const REV: Revision = { commit: "abc123", uncommitted: false }

// Zero timeout + no-op sleep so the retry loop never actually waits.
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

/** A fake AlertWriter recording every summary written. */
class RecordingAlertWriter implements AlertWriter {
	readonly summaries: string[] = []
	async write(summary: string): Promise<void> {
		this.summaries.push(summary)
	}
}

/** A clean fleet whose live state matches the compiled desired state exactly. */
function cleanFake(inv: FleetInventory): FakeOmniRouteClient {
	const advertised: AdvertisedModel[] = [{ id: "qwen-coder", contextLength: 160_000 }]
	return new FakeOmniRouteClient({
		combos: cleanCombos(inv),
		connections: [connection()],
		advertisedModels: { "conn-vllm": advertised },
	})
}

// ---------------------------------------------------------------------------
// runScheduledDrift — alert-write decision (Requirement 8.13).
// ---------------------------------------------------------------------------

describe("runScheduledDrift — clean run (Req 8.13)", () => {
	it("writes NO alert when the run is complete with zero differences", async () => {
		const inv = inventory()
		const fake = cleanFake(inv)
		const alertWriter = new RecordingAlertWriter()

		const result = await runScheduledDrift({
			model: inv,
			revision: REV,
			clients: clientsFor("cluster", fake),
			alertWriter,
			driftOptions: FAST,
		})

		expect(result.report.outcome).toBe("complete")
		expect(result.alertWorthy).toBe(false)
		expect(result.alerted).toBe(false)
		expect(alertWriter.summaries).toEqual([])
	})
})

describe("runScheduledDrift — drifted run (Req 8.13)", () => {
	it("writes the human summary when a difference exists on a complete run", async () => {
		const inv = inventory()
		// Drop a desired combo from live → a `missing` difference while outcome stays complete.
		const combos = cleanCombos(inv).filter((c) => c.name !== "hybrid/code")
		const advertised: AdvertisedModel[] = [{ id: "qwen-coder", contextLength: 160_000 }]
		const fake = new FakeOmniRouteClient({
			combos,
			connections: [connection()],
			advertisedModels: { "conn-vllm": advertised },
		})
		const alertWriter = new RecordingAlertWriter()

		const result = await runScheduledDrift({
			model: inv,
			revision: REV,
			clients: clientsFor("cluster", fake),
			alertWriter,
			driftOptions: FAST,
		})

		expect(result.alertWorthy).toBe(true)
		expect(result.alerted).toBe(true)
		expect(alertWriter.summaries).toHaveLength(1)
		// The summary is exactly the report summary.
		expect(alertWriter.summaries[0]).toBe(result.report.summary)
		expect(alertWriter.summaries[0]).toContain("hybrid/code")
	})

	it("writes the summary when the outcome is incomplete (an unverified read)", async () => {
		const inv = inventory()
		// No client for the declared instance → every read is unverified → incomplete.
		const alertWriter = new RecordingAlertWriter()

		const result = await runScheduledDrift({
			model: inv,
			revision: REV,
			clients: new Map(),
			alertWriter,
			driftOptions: FAST,
		})

		expect(result.report.outcome).toBe("incomplete")
		expect(result.alertWorthy).toBe(true)
		expect(result.alerted).toBe(true)
		expect(alertWriter.summaries).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// runScheduledDrift — failed compile (Requirement 8.12 + 8.13).
// ---------------------------------------------------------------------------

describe("runScheduledDrift — failed outcome (Req 8.12, 8.13)", () => {
	it("writes a failure summary and performs no live reads when the inventory does not compile", async () => {
		// A lane whose capability no offering carries: no eligible target → compile failure.
		const inv = inventory({
			lanes: [lane({ id: "code", names: ["hybrid/code"], capabilities: ["nonexistent-tag"], minContext: 60_000 })],
		})
		// A bare fake: the fixture does not compile, so the clean-combo helper
		// cannot run; a failed compile performs no live reads regardless.
		const fake = new FakeOmniRouteClient({ connections: [connection()] })
		const alertWriter = new RecordingAlertWriter()

		const result = await runScheduledDrift({
			model: inv,
			revision: REV,
			clients: clientsFor("cluster", fake),
			alertWriter,
			driftOptions: FAST,
		})

		expect(result.report.outcome).toBe("failed")
		expect(result.report.failures.length).toBeGreaterThan(0)
		expect(result.alertWorthy).toBe(true)
		expect(result.alerted).toBe(true)
		expect(alertWriter.summaries).toHaveLength(1)
		expect(alertWriter.summaries[0]).toContain("failed")
		// Read-only: a failed compile performs no live comparison, so no reads happen.
		expect(fake.calls()).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Credential safety — the alert carries no secret (Requirement 22.4-22.6).
// ---------------------------------------------------------------------------

describe("runScheduledDrift — credential safety (Req 22)", () => {
	it("the written summary inherits the drift report's tokenized-segment redaction", async () => {
		const inv = inventory()
		// A drifted connection whose id embeds a tokenized URL path segment
		// (`/api/v1/vscode/<token>/`). The drift report redacts that segment before
		// it enters the summary, and the alert write passes the summary through
		// verbatim — so the token must not appear in what is written.
		const combos = cleanCombos(inv)
		const tokenizedId = "http://gpu0:2701/api/v1/vscode/SUPERSECRET123/combos"
		const drifted = connection({
			id: tokenizedId,
			rateLimitOverrides: { burst: 5 },
		})
		const advertised: AdvertisedModel[] = [{ id: "qwen-coder", contextLength: 160_000 }]
		const fake = new FakeOmniRouteClient({
			combos,
			connections: [drifted],
			advertisedModels: { [tokenizedId]: advertised },
		})
		const alertWriter = new RecordingAlertWriter()

		const result = await runScheduledDrift({
			model: inv,
			revision: REV,
			clients: clientsFor("cluster", fake),
			alertWriter,
			driftOptions: FAST,
		})

		expect(result.alerted).toBe(true)
		const written = alertWriter.summaries[0] ?? ""
		// The tokenized segment was redacted by the drift report; the alert
		// summary carries the redaction marker, not the raw token.
		expect(written).not.toContain("SUPERSECRET123")
		expect(written).toContain("<redacted>")
		// The alert destination's own secret reference never leaks into the body.
		expect(written).not.toContain("secret://alert-token")
	})
})

// ---------------------------------------------------------------------------
// scheduleDrift — interval scheduling with injected timers (Requirement 8.11).
// ---------------------------------------------------------------------------

/** A manual timer harness: one interval callback the test fires by hand. */
class ManualTimers implements ScheduleTimers {
	private handler: (() => void) | undefined
	intervalMs: number | undefined
	cleared = false

	setInterval(handler: () => void, ms: number): unknown {
		this.handler = handler
		this.intervalMs = ms
		return 1
	}

	clearInterval(_handle: unknown): void {
		this.cleared = true
		this.handler = undefined
	}

	/** Fire one scheduled tick, synchronously invoking the interval handler. */
	fire(): void {
		this.handler?.()
	}
}

/** Wait until `predicate()` is true, polling across macro+microtasks (no sleep). */
async function waitUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
	for (let i = 0; i < maxTicks; i++) {
		if (predicate()) {
			return
		}
		// Yield to both the microtask queue and the timer/macrotask queue so an
		// in-flight run that races a `setTimeout(…, 0)` deadline can settle.
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
	}
	if (!predicate()) {
		throw new Error("waitUntil: condition not met within the tick budget")
	}
}

describe("scheduleDrift — interval scheduling (Req 8.11)", () => {
	it("runs on the injected interval and writes a drifted summary per tick", async () => {
		const inv = inventory()
		const combos = cleanCombos(inv).filter((c) => c.name !== "hybrid/code")
		const advertised: AdvertisedModel[] = [{ id: "qwen-coder", contextLength: 160_000 }]
		const fake = new FakeOmniRouteClient({
			combos,
			connections: [connection()],
			advertisedModels: { "conn-vllm": advertised },
		})
		const alertWriter = new RecordingAlertWriter()
		const timers = new ManualTimers()

		const runs: boolean[] = []
		const handle = scheduleDrift({
			model: inv,
			revision: REV,
			clients: clientsFor("cluster", fake),
			alertWriter,
			driftOptions: FAST,
			intervalMs: 60_000,
			timers,
			onRun: (r) => runs.push(r.alerted),
		})

		expect(timers.intervalMs).toBe(60_000)

		timers.fire()
		await waitUntil(() => runs.length === 1)
		expect(runs).toEqual([true])
		expect(alertWriter.summaries).toHaveLength(1)

		timers.fire()
		await waitUntil(() => runs.length === 2)
		expect(runs).toEqual([true, true])
		expect(alertWriter.summaries).toHaveLength(2)

		handle.stop()
		expect(timers.cleared).toBe(true)
	})

	it("clamps a too-large interval to the 24 h bound (Req 8.11)", () => {
		const inv = inventory()
		const fake = cleanFake(inv)
		const timers = new ManualTimers()

		const handle = scheduleDrift({
			model: inv,
			revision: REV,
			clients: clientsFor("cluster", fake),
			alertWriter: new RecordingAlertWriter(),
			driftOptions: FAST,
			intervalMs: MAX_SCHEDULE_INTERVAL_MS * 10,
			timers,
		})

		expect(timers.intervalMs).toBe(MAX_SCHEDULE_INTERVAL_MS)
		handle.stop()
	})

	it("clamps a non-positive interval to the 24 h bound", () => {
		const inv = inventory()
		const fake = cleanFake(inv)
		const timers = new ManualTimers()

		const handle = scheduleDrift({
			model: inv,
			revision: REV,
			clients: clientsFor("cluster", fake),
			alertWriter: new RecordingAlertWriter(),
			driftOptions: FAST,
			intervalMs: 0,
			timers,
		})

		expect(timers.intervalMs).toBe(MAX_SCHEDULE_INTERVAL_MS)
		handle.stop()
	})
})

// ---------------------------------------------------------------------------
// HttpAlertWriter — resolves the secret and posts the summary.
// ---------------------------------------------------------------------------

/** A SecretResolver returning a fixed value for the alert secret. */
class FakeSecretResolver implements SecretResolver {
	constructor(private readonly value: string | undefined) {}
	async resolve(_ref: string): Promise<string | undefined> {
		return this.value
	}
}

describe("HttpAlertWriter — real HTTP write", () => {
	it("posts the summary to the destination url with the resolved bearer", async () => {
		const calls: { url: string; init?: { headers?: Record<string, string>; body?: string } }[] = []
		const fetchImpl: AlertFetchLike = async (url, init) => {
			calls.push({ url, init })
			return { ok: true, status: 200 }
		}
		const writer = new HttpAlertWriter({
			destination: { url: "https://alerts.example/hook", secretRef: "secret://alert-token" },
			secretResolver: new FakeSecretResolver("alert-bearer-value"),
			fetch: fetchImpl,
		})

		await writer.write("drift summary text")

		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe("https://alerts.example/hook")
		expect(calls[0]!.init?.body).toBe("drift summary text")
		expect(calls[0]!.init?.headers?.Authorization).toBe("Bearer alert-bearer-value")
	})

	it("omits the Authorization header when no secretRef is declared", async () => {
		let seenHeaders: Record<string, string> | undefined
		const fetchImpl: AlertFetchLike = async (_url, init) => {
			seenHeaders = init?.headers
			return { ok: true, status: 200 }
		}
		const writer = new HttpAlertWriter({
			destination: { url: "https://alerts.example/hook" },
			secretResolver: new FakeSecretResolver(undefined),
			fetch: fetchImpl,
		})

		await writer.write("summary")

		expect(seenHeaders?.Authorization).toBeUndefined()
	})

	it("throws AlertWriteError on a non-ok response", async () => {
		const fetchImpl: AlertFetchLike = async () => ({ ok: false, status: 503 })
		const writer = new HttpAlertWriter({
			destination: { url: "https://alerts.example/hook" },
			secretResolver: new FakeSecretResolver(undefined),
			fetch: fetchImpl,
		})

		await expect(writer.write("summary")).rejects.toBeInstanceOf(AlertWriteError)
	})
})
