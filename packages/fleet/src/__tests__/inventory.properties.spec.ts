// Property tests for the Fleet_Inventory parser / printer / validator triad
// (OmniRoute Fleet Topology, task 2.4; Requirements 2.3, 2.4, 2.10).
//
// Three properties compose the three components end to end:
//
//   Property 1 (round-trip, Requirement 2.4): for every model the validator
//   accepts, parse(print(m)) → adapt → validate yields the SAME model, with
//   every ordered field (names, ranks, spill tiers, capability lanes, tags,
//   improvement-objective order) in the same order.
//
//   Property 2 (printer stability, Requirement 2.3): equal models print
//   byte-identically; print is a pure function of the model.
//
//   Property 3 (validator totality, Requirement 2.10): validate returns either
//   {ok:true} or a non-empty violations list, and NEVER throws, on any
//   parsed+adapted document — valid, defaulted, or corrupted.
//
// The example-based rejection tests for individual rules live in
// `../inventory/__tests__/validator.spec.ts`; this file adds the few rejection
// examples that pass THROUGH the printer+parser+adapter pipeline, each asserting
// the reported field path and that no secret value leaks into the output.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { FleetInventory } from "@roo-code/types"

import { parse } from "../inventory/parser.js"
import { inventoryPrinter } from "../inventory/printer.js"
import { adapt } from "../inventory/adapt.js"
import { createInventoryValidator, type ValidationResult } from "../inventory/validator.js"

const RUNS = 120

const validator = createInventoryValidator()

// The nine improvement objectives, in a fixed declaration order (Requirement
// 20.8 requires each listed exactly once; order itself is free).
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

// -------------------------------------------------------------------------
// Pipeline helpers
// -------------------------------------------------------------------------

function printParseAdaptValidate(model: FleetInventory): ValidationResult {
	const text = inventoryPrinter.print(model)
	const parsed = parse(text)
	if (!parsed.ok) {
		throw new Error(`parse failed at ${parsed.error.line}:${parsed.error.column} (${parsed.error.elementKind})`)
	}
	return validator.validate(adapt(parsed.value))
}

// -------------------------------------------------------------------------
// Arbitrary: a valid FleetInventory
// -------------------------------------------------------------------------
//
// The strategy keeps the referential/structural skeleton fixed-and-valid (one
// primary instance, two devices, local + cloud endpoints, offerings covering
// chat/code/read/embed/rerank, and ten lanes carrying the eight baseline names,
// the four capability lanes once each, and the embed/rerank capability tags),
// and varies the within-bounds values (ceilings, latencies, contexts, slot
// counts, ranks, retention, queue waits, spend/spill, booleans, tag sets, and
// the improvement-objective order) so every generated model is accepted while
// still exercising the ordered-field round-trip across a wide value space.

const spend = fc.constantFrom("free" as const, "low-budget" as const, "paid" as const)

// A valid context window, well within [1, 16_777_216].
const context = fc.integer({ min: 1024, max: 1_000_000 })

// Max-queue wait and backup retention are explicitly generated so the model
// carries no implicit default (printer emits them; adapter reads them back).
const maxQueueMs = fc.integer({ min: 0, max: 120_000 })
const backupRetention = fc.integer({ min: 1, max: 1000 })

// A capability-tag set that always includes "chat" (so lanes can require it)
// plus an optional extra tag drawn from a whitespace-free alphabet. Tags must
// never name a declared id, so we draw from a disjoint vocabulary.
const extraTag = fc.constantFrom("tools", "vision", "long", "json")
const chatTags = fc.uniqueArray(extraTag, { minLength: 0, maxLength: 3 }).map((xs) => ["chat", ...xs])

// A device slot ceiling, and an offering's slot count that never exceeds it.
const slotCeiling = fc.integer({ min: 2, max: 64 })

/** Build a ranks array of the given length, each in [1, 1000]. */
const ranksOfLength = (slots: number): fc.Arbitrary<number[]> =>
	fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: slots, maxLength: slots })

const inventoryArb: fc.Arbitrary<FleetInventory> = fc
	.record({
		gpuCeiling: slotCeiling,
		arcCeiling: slotCeiling,
		gpuSwap: fc.integer({ min: 0, max: 600_000 }),
		arcSwap: fc.integer({ min: 0, max: 600_000 }),
		coderContext: context,
		embedContext: context,
		rerankContext: context,
		cloudContext: context,
		coderSlots: fc.integer({ min: 1, max: 2 }),
		embedSlots: fc.integer({ min: 1, max: 2 }),
		rerankSlots: fc.integer({ min: 1, max: 2 }),
		gpuPreempt: fc.boolean(),
		arcPreempt: fc.boolean(),
		coderTags: chatTags,
		cloudTags: chatTags,
		laneMinContext: fc.integer({ min: 1, max: 2048 }),
		laneFailClosed: fc.boolean(),
		laneSpend: spend,
		laneQueue: maxQueueMs,
		retention: backupRetention,
		objectiveOrder: fc
			.shuffledSubarray(ALL_OBJECTIVES, { minLength: ALL_OBJECTIVES.length, maxLength: ALL_OBJECTIVES.length })
			.map((xs) => [...xs] as FleetInventory["improvementObjectiveOrder"]),
	})
	.chain((seed) =>
		fc
			.tuple(ranksOfLength(seed.coderSlots), ranksOfLength(seed.embedSlots), ranksOfLength(seed.rerankSlots))
			.map(([coderRanks, embedRanks, rerankRanks]): FleetInventory => {
				// A lane's spill tiers must each be ≤ its max spend; "free" is the
				// floor, so a single "free" tier is always valid.
				const spillFor = (max: "free" | "low-budget" | "paid"): ("free" | "low-budget" | "paid")[] =>
					max === "free" ? ["free"] : ["free", max]

				const lane = (
					id: string,
					name: string,
					capabilities: string[],
					capabilityLanes: FleetInventory["lanes"][number]["capabilityLanes"],
				): FleetInventory["lanes"][number] => ({
					id,
					names: [name],
					capabilities,
					minContext: seed.laneMinContext,
					order: "fill-first",
					maxSpend: seed.laneSpend,
					spillTiers: spillFor(seed.laneSpend),
					failClosed: seed.laneFailClosed,
					maxQueueMs: seed.laneQueue,
					capabilityLanes,
				})

				return {
					devices: [
						{ id: "gpu0", slotCeiling: seed.gpuCeiling, hostPreemption: seed.gpuPreempt },
						{ id: "arc0", slotCeiling: seed.arcCeiling, hostPreemption: seed.arcPreempt },
					],
					endpoints: [
						{
							id: "vllm",
							provider: "vllm",
							deviceIds: ["gpu0"],
							addresses: [{ instanceId: "cluster", url: "http://host:2701" }],
							secretRef: "vllm_key",
							noCredential: false,
						},
						{
							id: "ovms",
							provider: "ovms",
							deviceIds: ["arc0"],
							addresses: [{ instanceId: "cluster", url: "http://ovms:8000" }],
							noCredential: true,
						},
					],
					residencyGroups: [
						{ id: "r0", swapLatencyMs: seed.gpuSwap },
						{ id: "r1", swapLatencyMs: seed.arcSwap },
					],
					offerings: [
						{
							id: "coder",
							endpointId: "vllm",
							deviceId: "gpu0",
							modelId: "qwen-coder",
							context: seed.coderContext,
							slots: seed.coderSlots,
							residencyGroup: "r0",
							tags: ["code", "read", ...seed.coderTags.filter((t) => t !== "chat")].concat(["chat"]),
							ranks: coderRanks,
						},
						{
							id: "embed",
							endpointId: "ovms",
							deviceId: "arc0",
							modelId: "qwen-embed",
							context: seed.embedContext,
							slots: seed.embedSlots,
							residencyGroup: "r1",
							tags: ["embed"],
							ranks: embedRanks,
						},
						{
							id: "rerank",
							endpointId: "ovms",
							deviceId: "arc0",
							modelId: "qwen-rerank",
							context: seed.rerankContext,
							slots: seed.rerankSlots,
							residencyGroup: "r1",
							tags: ["rerank"],
							ranks: rerankRanks,
						},
					],
					clouds: [
						{
							id: "codestral",
							provider: "mistral",
							modelId: "codestral",
							spend: seed.laneSpend,
							context: seed.cloudContext,
							tags: seed.cloudTags,
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
							id: "cluster",
							role: "primary",
							address: "https://omniroute",
							secretRef: "mgmt_key",
							backupRetention: seed.retention,
						},
					],
					diagnostics: [{ id: "diag/gpu0", deviceId: "gpu0" }],
					alertDestination: { url: "https://alerts", secretRef: "alert_key" },
					improvementObjectiveOrder: seed.objectiveOrder,
				}
			}),
	)

// A model free of the two defaulted fields, to prove they round-trip through
// the printer's explicit emission rather than relying on the arbitrary. Shared
// by the stability property.
function sampleModel(): FleetInventory {
	return fc.sample(inventoryArb, { numRuns: 1, seed: 1 })[0]!
}

describe("Fleet_Inventory property suite", () => {
	// Feature: omniroute-fleet-topology, Property 1: Inventory round-trip —
	// parse(print(m)) equals m, including every ordered field's order.
	it("Property 1: parse(print(m)) round-trips to an equal model", () => {
		fc.assert(
			fc.property(inventoryArb, (model) => {
				const result = printParseAdaptValidate(model)
				if (!result.ok) {
					throw new Error(`expected round-trip accept, got: ${JSON.stringify(result.violations)}`)
				}
				expect(result.model).toEqual(model)
			}),
			{ numRuns: RUNS },
		)
	})

	// Feature: omniroute-fleet-topology, Property 2: Printer stability — equal
	// models print byte-identically; print is a pure function of the model.
	it("Property 2: equal models print byte-identically", () => {
		fc.assert(
			fc.property(inventoryArb, (model) => {
				const once = inventoryPrinter.print(model)
				const twice = inventoryPrinter.print(model)
				const cloned = inventoryPrinter.print(structuredClone(model))
				expect(twice).toBe(once)
				expect(cloned).toBe(once)
			}),
			{ numRuns: RUNS },
		)
	})

	// Feature: omniroute-fleet-topology, Property 3: Validator totality —
	// validate returns ok or a non-empty violation list and never throws on any
	// parsed+adapted document (valid or corrupted).
	it("Property 3: validate is total on any parsed+adapted document", () => {
		// A corruption injected into the printed KDL text, chosen so the result
		// still parses as KDL (so adapt+validate run) but may violate rules.
		const corruption = fc.option(
			fc.constantFrom<(text: string) => string>(
				(t) => t.replace(/slot-ceiling=\d+/, "slot-ceiling=9999"),
				(t) => t.replace(/host-preemption=#(true|false)/, 'host-preemption="maybe"'),
				(t) => t.replace(/role="primary"/, 'role="chief"'),
				(t) => t.replace(/min-context=\d+/, "min-context=0"),
				(t) => t.replace(/names="hybrid\/code"/, 'names="HYBRID/CODE"'),
				(t) => t.replace(/max-queue-ms=\d+/, "max-queue-ms=999999"),
				(t) => t.replace(/device "gpu0"/, 'device "gpu0" bogus="x"'),
				(t) => t.replace(/tags="[^"]*"/, 'tags=""'),
				(t) => t.replace(/\n}\n/, "\n}\n"), // identity: keep a valid variant too
			),
			{ nil: undefined },
		)

		fc.assert(
			fc.property(inventoryArb, corruption, (model, corrupt) => {
				const text = corrupt ? corrupt(inventoryPrinter.print(model)) : inventoryPrinter.print(model)
				const parsed = parse(text)
				if (!parsed.ok) {
					// A syntax fault is a legitimate parser outcome, not a
					// validator throw; totality concerns parsed documents only.
					return
				}
				const result = validator.validate(adapt(parsed.value))
				// Never throws (reaching here proves it) and the result is a
				// well-formed discriminated union with a non-empty failure list.
				if (result.ok) {
					expect(result.model).toBeDefined()
				} else {
					expect(result.violations.length).toBeGreaterThan(0)
				}
			}),
			{ numRuns: RUNS },
		)
	})
})

// -------------------------------------------------------------------------
// Example-based rejection tests that run through the full
// print → parse → adapt → validate pipeline. These complement the
// loose-document rejection tests in validator.spec.ts by proving the rules
// still fire after a real round-trip, and that no secret value is echoed.
// -------------------------------------------------------------------------

const SECRET = "sk-SUPER-SECRET-abc123"

/** Print, mutate the KDL text, parse, adapt, validate — returns the result. */
function pipeline(model: FleetInventory, mutate: (kdl: string) => string): ValidationResult {
	const parsed = parse(mutate(inventoryPrinter.print(model)))
	if (!parsed.ok) {
		throw new Error(`parse failed: ${parsed.error.elementKind} at ${parsed.error.line}:${parsed.error.column}`)
	}
	return validator.validate(adapt(parsed.value))
}

const codesOf = (r: ValidationResult): string[] => (r.ok ? [] : r.violations.map((v) => v.code))
const pathsOf = (r: ValidationResult): string[] => (r.ok ? [] : r.violations.map((v) => v.fieldPath))

describe("Fleet_Inventory rejection examples through the pipeline", () => {
	it("accepts the baseline sample model (fixture sanity)", () => {
		const r = printParseAdaptValidate(sampleModel())
		expect(r.ok).toBe(true)
	})

	it("rejects an out-of-range numeric value and reports the field path (2.6)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/slot-ceiling=\d+/, "slot-ceiling=9999"))
		expect(codesOf(r)).toContain("range")
		expect(pathsOf(r)).toContain("devices[gpu0].slotCeiling")
	})

	it("rejects an unresolved reference and reports the field path (2.5)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/endpoint="vllm"/, 'endpoint="ghost"'))
		expect(codesOf(r)).toContain("unresolved-ref")
		expect(pathsOf(r)).toContain("offerings[coder].endpointId")
	})

	it("rejects a model-device binding mismatch (2.5)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/model "coder"([^\n]*)device="gpu0"/, 'model "coder"$1device="arc0"'))
		expect(codesOf(r)).toContain("model-device-binding")
	})

	it("rejects offering slots exceeding the device ceiling (2.7)", () => {
		// Force a 1-slot GPU and a 2-slot coder offering so slots > ceiling.
		const base = sampleModel()
		const model: FleetInventory = {
			...base,
			devices: base.devices.map((d) => (d.id === "gpu0" ? { ...d, slotCeiling: 1 } : d)),
			offerings: base.offerings.map((o) => (o.id === "coder" ? { ...o, slots: 2, ranks: [1, 2] } : o)),
		}
		const r = printParseAdaptValidate(model)
		expect(codesOf(r)).toContain("slots-exceed-ceiling")
		expect(pathsOf(r)).toContain("offerings[coder].slots")
	})

	it("rejects a duplicate identifier (2.8)", () => {
		const r = pipeline(sampleModel(), (k) => `${k}device "gpu0" slot-ceiling=2 host-preemption=#false\n`)
		expect(codesOf(r)).toContain("duplicate-id")
	})

	it("rejects an inline credential WITHOUT echoing the secret value (2.9)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/secret="mgmt_key"/, `secret="${SECRET} with spaces"`))
		expect(codesOf(r)).toContain("inline-credential")
		expect(pathsOf(r)).toContain("instances[cluster].secretRef")
		expect(JSON.stringify(r)).not.toContain("SUPER-SECRET")
	})

	it("rejects a tokenized URL segment WITHOUT echoing the token (2.9/22.5)", () => {
		const r = pipeline(sampleModel(), (k) =>
			k.replace(/address="https:\/\/omniroute"/, 'address="https://host/api/v1/vscode/TOKEN123/x"'),
		)
		expect(codesOf(r)).toContain("tokenized-segment")
		expect(JSON.stringify(r)).not.toContain("TOKEN123")
	})

	it("rejects a performance-rank count differing from the slot count (2.11)", () => {
		const base = sampleModel()
		const model: FleetInventory = {
			...base,
			offerings: base.offerings.map((o) => (o.id === "coder" ? { ...o, slots: 2, ranks: [1] } : o)),
		}
		// slots=2 but ranks has length 1 — the printer emits one rank child.
		const r = printParseAdaptValidate(model)
		expect(codesOf(r)).toContain("rank-count")
	})

	it("rejects an unknown field (2.11)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/device "gpu0"/, 'device "gpu0" bogus="x"'))
		expect(codesOf(r)).toContain("unknown-field")
		expect(pathsOf(r)).toContain("devices[gpu0].bogus")
	})

	it("rejects a capability tag that names a declared identifier (3.2)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/capabilities="chat code"/, 'capabilities="chat gpu0"'))
		expect(codesOf(r)).toContain("capability-names-identifier")
	})

	it("rejects when a baseline route name is missing (3.3/3.8)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/names="hybrid\/code"/, 'names="hybrid/elsewhere"'))
		expect(codesOf(r)).toContain("baseline-name-missing")
	})

	it("rejects when a capability lane is unmapped (3.4/3.8)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/capability-lanes="coder.primary"/, 'capability-lanes=""'))
		expect(codesOf(r)).toContain("capability-lane-unmapped")
	})

	it("rejects when the embeddings lane is absent (3.5)", () => {
		const base = sampleModel()
		const model: FleetInventory = { ...base, lanes: base.lanes.filter((l) => l.id !== "embed-lane") }
		const r = printParseAdaptValidate(model)
		expect(codesOf(r)).toContain("no-embed-lane")
	})

	it("rejects an invalid route-name character (4.8)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/names="hybrid\/research"/, 'names="hybrid/RESEARCH"'))
		expect(codesOf(r)).toContain("route-name-charset")
	})

	it("rejects more than one primary instance (10.2)", () => {
		const base = sampleModel()
		const model: FleetInventory = {
			...base,
			instances: [
				...base.instances,
				{ id: "cluster2", role: "primary", address: "https://b", backupRetention: 20 },
			],
		}
		const r = printParseAdaptValidate(model)
		expect(codesOf(r)).toContain("primary-count")
	})

	it("rejects a diagnostic pinned to an undeclared device (12.7)", () => {
		const r = pipeline(sampleModel(), (k) => k.replace(/diagnostic "diag\/gpu0" device="gpu0"/, 'diagnostic "diag/gpu0" device="ghost"'))
		expect(codesOf(r)).toContain("unresolved-ref")
		expect(pathsOf(r)).toContain("diagnostics[diag/gpu0].deviceId")
	})

	it("rejects an improvement-objective order missing an objective (20.8)", () => {
		const base = sampleModel()
		const model: FleetInventory = { ...base, improvementObjectiveOrder: base.improvementObjectiveOrder.slice(1) }
		const r = printParseAdaptValidate(model)
		expect(codesOf(r)).toContain("missing-objective")
	})
})
