// fleetctl — CLI smoke tests (task 10.2; Requirements 22.1, 22.2).
// fleetctl — CLI smoke tests (task 10.2; Requirements 22.1, 22.2).
//
// Drives the task-10.1 command handlers (`validate`/`compile`/`drift`/`plan`/
// `apply`) directly against the in-memory `FakeOmniRouteClient`, a scripted
// `ConfirmationProvider`, a captured `OutputSink`, and a fixed clock — never a
// real stdout/stdin, filesystem, or network. The fixture inventory is a typed
// `FleetInventory` round-tripped through `inventoryPrinter.print()` so the KDL
// the CLI reads is guaranteed valid.
//
// The behaviors asserted:
//   1. `validate` accepts the fixture (exit 0) and rejects an invalid inventory
//      (exit 1, violations printed) — read-only (Requirement 22.1).
//   2. `compile` prints the Desired_Route_State (exit 0) — read-only.
//   3. `drift` is read-only: exit 0 and the fake saw ONLY read ops.
//   4. `plan` is read-only: exit 0 and the fake saw NO write op.
//   5. `apply` WITHOUT a confirmation (provider returns undefined) refuses with
//      a non-zero exit, issues NO write, and reports "not confirmed"
//      (Requirement 22.2 — writes are gated on the per-invocation confirmation).
//   6. `apply` WITH a matching confirmation issues writes and succeeds, showing
//      the writer path works once confirmed.
//   7. No management key / secret value ever appears in captured output.

import type { FleetInventory, Lane } from "@roo-code/types"
import { describe, expect, it } from "vitest"

import {
	applyCommand,
	compileCommand,
	driftCommand,
	planCommand,
	validateCommand,
} from "../cli/commands.js"
import {
	buildConfirmation,
	type CliDeps,
	type ConfirmationProvider,
	type ConfirmationRequest,
	type OutputSink,
} from "../cli/shared.js"
import type { OperatorConfirmation } from "../reconcile/apply.js"
import type { Connection, OmniRouteClient, SecretResolver } from "../omniroute/client.js"
import { FakeOmniRouteClient, type FakeCall, type FakeOperation } from "../omniroute/fake.js"
import { inventoryPrinter } from "../inventory/printer.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLUSTER = "cluster"
/** The inventory's bare management-secret reference (not a value) — never printed. */
const MANAGEMENT_SECRET_REF = "mgmt_key"
/** The resolved management key the resolver returns; it must never be printed. */
const MANAGEMENT_SECRET_VALUE = "zoo-super-secret-management-key-DO-NOT-PRINT"
const FIXED_NOW = "2026-10-15T00:00:00.000Z"

/** The OmniRoute write methods a read-only command must never invoke (Req 22.1). */
const WRITE_OPERATIONS: ReadonlySet<FakeOperation> = new Set<FakeOperation>([
	"createCombo",
	"updateCombo",
	"deleteCombo",
	"patchConnection",
	"patchContextOverrides",
	"syncModels",
])

// ---------------------------------------------------------------------------
// Typed inventory fixture — the full validator-accepted skeleton (two devices,
// local + cloud endpoints, offerings covering chat/code/read/embed/rerank, the
// ten lanes carrying the eight baseline names + embed/rerank + the four
// capability lanes, and all nine improvement objectives). Adapted from the
// validated skeleton in inventory.properties.spec.ts, with fixed values. The
// instance carries a bare `secretRef` so the "no secret leaks" assertion has a
// real reference and resolved value to check against the output.
// ---------------------------------------------------------------------------

/** The nine improvement objectives, each listed exactly once (Requirement 20.8). */
const ALL_OBJECTIVES: FleetInventory["improvementObjectiveOrder"] = [
	"planner-cloud-share",
	"planner-multi-attempt",
	"code-p50",
	"reader-cloud-share",
	"reader-multi-attempt",
	"cloud-input-tokens",
	"capacity-rejections",
	"embeddings-success",
	"model-switches",
]

function lane(
	id: string,
	name: string,
	capabilities: string[],
	capabilityLanes: Lane["capabilityLanes"],
): Lane {
	return {
		id,
		names: [name],
		capabilities,
		minContext: 1024,
		order: "fill-first",
		maxSpend: "paid",
		spillTiers: ["free", "paid"],
		failClosed: false,
		maxQueueMs: 30_000,
		capabilityLanes,
	}
}

function inventory(): FleetInventory {
	return {
		devices: [
			{ id: "gpu0", slotCeiling: 8, hostPreemption: false },
			{ id: "arc0", slotCeiling: 8, hostPreemption: false },
		],
		endpoints: [
			{
				id: "vllm",
				provider: "vllm",
				deviceIds: ["gpu0"],
				addresses: [{ instanceId: CLUSTER, url: "http://host:2701" }],
				secretRef: "vllm_key",
				noCredential: false,
			},
			{
				id: "ovms",
				provider: "ovms",
				deviceIds: ["arc0"],
				addresses: [{ instanceId: CLUSTER, url: "http://ovms:8000" }],
				noCredential: true,
			},
		],
		residencyGroups: [
			{ id: "r0", swapLatencyMs: 0 },
			{ id: "r1", swapLatencyMs: 0 },
		],
		offerings: [
			{
				id: "coder",
				endpointId: "vllm",
				deviceId: "gpu0",
				modelId: "qwen-coder",
				context: 160_000,
				slots: 2,
				residencyGroup: "r0",
				tags: ["code", "read", "chat"],
				ranks: [1, 3],
			},
			{
				id: "embed",
				endpointId: "ovms",
				deviceId: "arc0",
				modelId: "qwen-embed",
				context: 32_000,
				slots: 1,
				residencyGroup: "r1",
				tags: ["embed"],
				ranks: [1],
			},
			{
				id: "rerank",
				endpointId: "ovms",
				deviceId: "arc0",
				modelId: "qwen-rerank",
				context: 32_000,
				slots: 1,
				residencyGroup: "r1",
				tags: ["rerank"],
				ranks: [1],
			},
		],
		clouds: [
			{
				id: "codestral",
				provider: "mistral",
				modelId: "codestral",
				spend: "paid",
				context: 200_000,
				tags: ["chat"],
			},
		],
		lanes: [
			lane("code", "hybrid/code", ["chat", "code"], ["coder.primary"]),
			lane("research", "hybrid/research", ["chat"], []),
			lane("fast", "hybrid/fast", ["chat"], []),
			lane("planner", "hybrid/planner", ["chat"], ["reasoning.escalation"]),
			lane("reader", "hybrid/reader", ["chat", "read"], ["reader.fast", "reader.deep"]),
			lane("reviewer", "hybrid/reviewer", ["chat"], []),
			lane("frontier", "hybrid/frontier", ["chat"], []),
			lane("tester", "hybrid/tester", ["chat"], []),
			lane("embed-lane", "memory/embed", ["embed"], []),
			lane("rerank-lane", "memory/rerank", ["rerank"], []),
		],
		instances: [
			{
				id: CLUSTER,
				role: "primary",
				address: "https://omniroute",
				secretRef: MANAGEMENT_SECRET_REF,
				backupRetention: 20,
			},
		],
		diagnostics: [{ id: "diag/gpu0", deviceId: "gpu0" }],
		alertDestination: { url: "https://alerts", secretRef: "alert_key" },
		improvementObjectiveOrder: ALL_OBJECTIVES,
	}
}

/** The valid fixture KDL the CLI reads — guaranteed parseable by the printer. */
const FIXTURE_KDL = inventoryPrinter.print(inventory())

/**
 * An inventory the validator rejects: the embed and rerank lanes are dropped, so
 * no lane requires the embedding/rerank capability tags the offerings carry
 * (`no-embed-lane` / `no-rerank-lane`). The printed KDL parses but fails
 * validation, so `validate` prints violations and exits non-zero.
 */
const INVALID_KDL = inventoryPrinter.print({
	...inventory(),
	lanes: inventory().lanes.filter((l) => l.id !== "embed-lane" && l.id !== "rerank-lane"),
})

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A recording sink that captures every out/err line for assertions. */
interface RecordingSink extends OutputSink {
	readonly outLines: string[]
	readonly errLines: string[]
	readonly allLines: () => readonly string[]
}

function recordingSink(): RecordingSink {
	const outLines: string[] = []
	const errLines: string[] = []
	return {
		out: (line: string): void => {
			outLines.push(line)
		},
		err: (line: string): void => {
			errLines.push(line)
		},
		outLines,
		errLines,
		allLines: (): readonly string[] => [...outLines, ...errLines],
	}
}

/** A secret resolver that returns the management key; the CLI must never print it. */
const secretResolver: SecretResolver = {
	resolve: async (ref: string): Promise<string | undefined> =>
		ref === MANAGEMENT_SECRET_REF ? MANAGEMENT_SECRET_VALUE : undefined,
}

/** A confirmation provider that always declines (returns undefined). */
const decliningConfirmation: ConfirmationProvider = {
	confirm: async (): Promise<OperatorConfirmation | undefined> => undefined,
}

/**
 * A confirmation provider that confirms every request as `operator`, building
 * the matching `OperatorConfirmation` from the request (as the real stdin
 * provider does once the operator types `yes`).
 */
function confirmingProvider(operator: string): ConfirmationProvider {
	return {
		confirm: async (request: ConfirmationRequest): Promise<OperatorConfirmation | undefined> =>
			buildConfirmation(request, operator),
	}
}

/**
 * The live connection that resolves the fixture's `vllm` endpoint (provider +
 * host:port of `http://gpu0:2701`), so `plan`/`drift` resolve a connection id
 * and `apply` can issue combo creates against a clean live state.
 */
function liveConnections(): Connection[] {
	return [
		{ id: "conn-vllm", provider: "vllm", address: "http://host:2701", isActive: true },
		{ id: "conn-ovms", provider: "ovms", address: "http://ovms:8000", isActive: true },
	]
}

/** Build the injectable CLI deps around a fake client and the chosen confirmation. */
function makeDeps(args: {
	readonly fake: FakeOmniRouteClient
	readonly confirmation: ConfirmationProvider
	readonly inventoryKdl?: string
}): { readonly deps: CliDeps; readonly sink: RecordingSink } {
	const sink = recordingSink()
	const clientFactory = (): OmniRouteClient => args.fake
	const deps: CliDeps = {
		sink,
		secretResolver,
		clientFactory,
		confirmation: args.confirmation,
		clock: () => FIXED_NOW,
		readFile: async (): Promise<string> => args.inventoryKdl ?? FIXTURE_KDL,
	}
	return { deps, sink }
}

/** The write ops the fake recorded (empty for a correctly read-only command). */
function writeCalls(calls: readonly FakeCall[]): readonly FakeCall[] {
	return calls.filter((c) => WRITE_OPERATIONS.has(c.operation))
}

/** Assert no captured line carries the management key or any secret value. */
function expectNoSecretLeak(sink: RecordingSink): void {
	for (const line of sink.allLines()) {
		expect(line).not.toContain(MANAGEMENT_SECRET_VALUE)
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fleetctl CLI smoke tests (Req 22.1, 22.2)", () => {
	it("validate accepts the fixture inventory (exit 0, read-only)", async () => {
		const fake = new FakeOmniRouteClient()
		const { deps, sink } = makeDeps({ fake, confirmation: decliningConfirmation })

		const code = await validateCommand("fleet.kdl", deps)

		expect(code).toBe(0)
		expect(sink.outLines.join("\n")).toContain("inventory accepted")
		expect(sink.errLines).toHaveLength(0)
		expect(writeCalls(fake.calls())).toHaveLength(0)
		expectNoSecretLeak(sink)
	})

	it("validate rejects an invalid inventory (exit 1, prints violations)", async () => {
		const fake = new FakeOmniRouteClient()
		const { deps, sink } = makeDeps({
			fake,
			confirmation: decliningConfirmation,
			inventoryKdl: INVALID_KDL,
		})

		const code = await validateCommand("bad.kdl", deps)

		expect(code).toBe(1)
		expect(sink.errLines.join("\n")).toContain("inventory rejected")
		expect(sink.errLines.length).toBeGreaterThan(0)
		expect(writeCalls(fake.calls())).toHaveLength(0)
		expectNoSecretLeak(sink)
	})

	it("compile prints the Desired_Route_State (exit 0, read-only)", async () => {
		const fake = new FakeOmniRouteClient()
		const { deps, sink } = makeDeps({ fake, confirmation: decliningConfirmation })

		const code = await compileCommand("fleet.kdl", {}, deps)

		expect(code).toBe(0)
		expect(sink.outLines.join("\n")).toContain(`instance '${CLUSTER}'`)
		// The compiler is pure; no OmniRoute request of any kind was issued.
		expect(fake.calls()).toHaveLength(0)
		expectNoSecretLeak(sink)
	})

	it("drift is read-only: exit 0 and only read ops reach the fake", async () => {
		const fake = new FakeOmniRouteClient({ connections: liveConnections() })
		const { deps, sink } = makeDeps({ fake, confirmation: decliningConfirmation })

		const code = await driftCommand("fleet.kdl", {}, deps)

		expect(code).toBe(0)
		expect(sink.outLines.join("\n")).toContain("Drift detection outcome")
		expect(writeCalls(fake.calls())).toHaveLength(0)
		// The fake was actually driven (it is a live-state read, not a no-op).
		expect(fake.calls().length).toBeGreaterThan(0)
		expectNoSecretLeak(sink)
	})

	it("plan is read-only: exit 0 and no write op reaches the fake", async () => {
		const fake = new FakeOmniRouteClient({ connections: liveConnections() })
		const { deps, sink } = makeDeps({ fake, confirmation: decliningConfirmation })

		const code = await planCommand("fleet.kdl", {}, deps)

		expect(code).toBe(0)
		expect(sink.outLines.join("\n")).toContain(`Change_Plan for instance '${CLUSTER}'`)
		expect(writeCalls(fake.calls())).toHaveLength(0)
		expectNoSecretLeak(sink)
	})

	it("apply WITHOUT confirmation refuses: non-zero exit, no write, 'not confirmed'", async () => {
		const fake = new FakeOmniRouteClient({ connections: liveConnections() })
		const { deps, sink } = makeDeps({ fake, confirmation: decliningConfirmation })

		const code = await applyCommand("fleet.kdl", { confirmDeletions: false }, deps)

		expect(code).not.toBe(0)
		expect(sink.errLines.join("\n")).toContain("not confirmed")
		// The decisive assertion (Requirement 22.2): a refused apply writes nothing.
		expect(writeCalls(fake.calls())).toHaveLength(0)
		expectNoSecretLeak(sink)
	})

	it("apply WITH a matching confirmation issues writes and succeeds", async () => {
		// A clean live state (no combos) + the resolving connection means the plan
		// is all creates, so a confirmed apply issues createCombo writes.
		const fake = new FakeOmniRouteClient({ connections: liveConnections() })
		const { deps, sink } = makeDeps({
			fake,
			confirmation: confirmingProvider("operator@zoo"),
		})

		// A committed revision is required: apply refuses an uncommitted plan (9.17).
		const code = await applyCommand(
			"fleet.kdl",
			{ revision: "abc123def456", confirmDeletions: false },
			deps,
		)

		expect(code).toBe(0)
		expect(sink.outLines.join("\n")).toContain("apply outcome: succeeded")
		// The writer path ran: at least one combo create reached the fake.
		expect(writeCalls(fake.calls()).some((c) => c.operation === "createCombo")).toBe(true)
		expectNoSecretLeak(sink)
	})
})
