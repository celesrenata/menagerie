// Property tests for the Route_Compiler (OmniRoute Fleet Topology, task 3.5;
// Requirements 5.2, 5.3, 5.4, 5.5, 7.2, 7.3; Properties 4-7).
//
// Four properties exercise the pure `compile(model, revision)` function and its
// identity helpers end to end:
//
//   Property 4 (compiler determinism, Requirement 5.2): compile(m, rev) twice is
//   byte-identical, and stays identical when the ambient clock (Date) and locale
//   (Intl) are swapped out — the compiler takes neither, so its output is a pure
//   function of (model, revision).
//
//   Property 5 (Target_Identifier stability, Requirement 5.3): changing a Slot's
//   rank / context / tags / lane membership leaves its Target_Identifier
//   unchanged, and distinct (device, endpoint, modelId, slotIndex) tuples never
//   collide.
//
//   Property 6 (Internal_Pool dedup + reachability, Requirements 5.4, 5.5): no
//   two emitted internal pools share an identical (ordered targetIds, dispatch
//   config) — i.e. internal pool names are unique — and every emitted internal
//   pool is reachable (transitively) from a Public_Route combo.
//
//   Property 7 (capacity bound, Requirements 7.2, 7.3): for every compiled state,
//   each Model_Offering's per-instance concurrencyPerModel ≤ min(slots,
//   Device_Allocation) and per-Device concurrency ≤ Device_Allocation, with the
//   expected allocation read through resolveDeviceAllocation.
//
// A worked example compiles a fixture inventory modelling today's fleet (5090 /
// 4070 / M5 / 4×Arc) and asserts the eight baseline Public_Route names, the
// hard-concurrency Routing_Setting contents, and that two dead targets (a free
// OpenRouter cloud ineligible for every lane, and a 5090-reader offering made
// ineligible for every lane) never appear in any compiled combo.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { FleetInventory, ModelOffering } from "@roo-code/types"

import {
	compile,
	type Combo,
	type DesiredRouteState,
} from "../index.js"
import { resolveDeviceAllocation } from "../compile/capacity.js"
import { slotTargetId, type Slot } from "../compile/targets.js"

const RUNS = 120

// The nine improvement objectives, in a fixed declaration order (Requirement
// 20.8 requires each listed exactly once).
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

// The eight baseline Public_Route names (Requirement 4; design §2).
const BASELINE_ROUTE_NAMES = [
	"hybrid/code",
	"hybrid/research",
	"hybrid/fast",
	"hybrid/planner",
	"hybrid/reader",
	"hybrid/reviewer",
	"hybrid/frontier",
	"hybrid/tester",
] as const

// -------------------------------------------------------------------------
// Arbitrary: a valid FleetInventory
// -------------------------------------------------------------------------
//
// Mirrors the generator in inventory.properties.spec.ts (task 2.4) so every
// generated model is one the validator accepts and the compiler can compile. The
// referential skeleton is fixed-and-valid (one primary instance, two devices,
// local + cloud endpoints, offerings covering chat/code/read/embed/rerank, and
// the ten lanes carrying the eight baseline names plus the embed/rerank lanes);
// within-bounds values vary.

const spend = fc.constantFrom("free" as const, "low-budget" as const, "paid" as const)
const context = fc.integer({ min: 1024, max: 1_000_000 })
const maxQueueMs = fc.integer({ min: 0, max: 120_000 })
const backupRetention = fc.integer({ min: 1, max: 1000 })
const extraTag = fc.constantFrom("tools", "vision", "long", "json")
const chatTags = fc.uniqueArray(extraTag, { minLength: 0, maxLength: 3 }).map((xs) => ["chat", ...xs])
const slotCeiling = fc.integer({ min: 2, max: 64 })

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
		// Keep the lane minimum at or below the offering/cloud context floor
		// (1024) so every local Slot and the cloud always clear it — the embed
		// and rerank lanes depend on their local offerings being eligible, so a
		// minimum above the context floor would leave them with no target and
		// make compile() fail by design (Requirement 5.7). These properties
		// concern successfully-compiled states.
		laneMinContext: fc.integer({ min: 1, max: 1024 }),
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

const hexChar = fc.constantFrom(..."0123456789abcdef".split(""))
const revisionArb = fc.record({
	commit: fc.array(hexChar, { minLength: 7, maxLength: 40 }).map((xs) => xs.join("")),
	uncommitted: fc.boolean(),
})

// -------------------------------------------------------------------------
// Serialization + traversal helpers
// -------------------------------------------------------------------------

/** Serialize a CompileResult to a stable JSON string (states is a Map). */
function resultToJson(result: ReturnType<typeof compile>): string {
	if (!result.ok) {
		return JSON.stringify({ ok: false, failures: result.failures })
	}
	const states: Record<string, DesiredRouteState> = {}
	// Sort instance ids so Map insertion order can never perturb the string.
	for (const id of [...result.states.keys()].sort()) {
		states[id] = result.states.get(id)!
	}
	return JSON.stringify({ ok: true, states })
}

/** The combos of every compiled state, flattened. */
function allCombos(result: ReturnType<typeof compile>): Combo[] {
	if (!result.ok) {
		return []
	}
	const combos: Combo[] = []
	for (const state of result.states.values()) {
		combos.push(...state.combos)
	}
	return combos
}

/** The internal-pool combos in a state (kind === "internal" in metadata). */
function internalCombos(state: DesiredRouteState): Combo[] {
	return state.combos.filter((combo) => state.publishedMetadata.kinds[combo.name] === "internal")
}

/** The public-route combos in a state. */
function publicCombos(state: DesiredRouteState): Combo[] {
	return state.combos.filter((combo) => state.publishedMetadata.kinds[combo.name] === "public")
}

/**
 * The set of combo names reachable from the given roots by following every
 * combo-ref model ref transitively, within one state's combo set.
 */
function reachableNames(state: DesiredRouteState, roots: readonly string[]): Set<string> {
	const byName = new Map(state.combos.map((combo) => [combo.name, combo]))
	const reached = new Set<string>()
	const stack = [...roots]
	while (stack.length > 0) {
		const name = stack.pop()!
		if (reached.has(name)) {
			continue
		}
		reached.add(name)
		const combo = byName.get(name)
		if (!combo) {
			continue
		}
		for (const ref of combo.models) {
			if (ref.kind === "combo-ref" && ref.comboName && !reached.has(ref.comboName)) {
				stack.push(ref.comboName)
			}
		}
	}
	return reached
}

// -------------------------------------------------------------------------
// Properties
// -------------------------------------------------------------------------

describe("Route_Compiler property suite", () => {
	// Feature: omniroute-fleet-topology, Property 4: Compiler determinism —
	// compile(m, rev) is byte-identical across repeated calls and independent of
	// the ambient clock and locale (the compiler reads neither).
	it("Property 4: compile is a pure, byte-identical function of (model, revision)", () => {
		fc.assert(
			fc.property(inventoryArb, revisionArb, (model, revision) => {
				const once = resultToJson(compile(model, revision))

				// A second call with the same inputs is byte-identical.
				const twice = resultToJson(compile(model, revision))
				expect(twice).toBe(once)

				// Compiling a structural clone produces the same output, so no
				// hidden object identity leaks into the result.
				const cloned = resultToJson(compile(structuredClone(model), { ...revision }))
				expect(cloned).toBe(once)

				// Swap the wall clock and locale, then recompile: output is
				// unchanged because the compiler takes neither as input.
				const realDateNow = Date.now
				const realDtf = Intl.DateTimeFormat
				try {
					Date.now = () => 1_700_000_000_000
					// Replace Intl.DateTimeFormat with a fixed-locale stand-in.
					// A deliberate override of a readonly global for the duration
					// of this check; restored in `finally`.
					Object.defineProperty(Intl, "DateTimeFormat", {
						configurable: true,
						writable: true,
						value: function FixedDtf() {
							return realDtf("fr-FR")
						},
					})
					const underStub = resultToJson(compile(model, revision))
					expect(underStub).toBe(once)
				} finally {
					Date.now = realDateNow
					Object.defineProperty(Intl, "DateTimeFormat", {
						configurable: true,
						writable: true,
						value: realDtf,
					})
				}
			}),
			{ numRuns: RUNS },
		)
	})

	// Feature: omniroute-fleet-topology, Property 5: Target-identifier stability —
	// a Slot's Target_Identifier depends only on (device, endpoint, modelId,
	// slotIndex); rank / context / tags / lane membership do not change it, and
	// distinct identity tuples never collide.
	it("Property 5: slot Target_Identifier is stable under rank/context/tag changes and never collides", () => {
		const offeringArb = fc.record({
			id: fc.constant("off"),
			endpointId: fc.constantFrom("vllm", "ovms", "ollama"),
			deviceId: fc.constantFrom("gpu0", "arc0", "m5"),
			modelId: fc.constantFrom("qwen-coder", "qwen-embed", "llama"),
			context: fc.integer({ min: 1024, max: 1_000_000 }),
			slots: fc.integer({ min: 1, max: 4 }),
			residencyGroup: fc.constant("r0"),
			tags: fc.uniqueArray(fc.constantFrom("chat", "code", "read", "embed", "rerank"), {
				minLength: 0,
				maxLength: 5,
			}),
		})

		fc.assert(
			fc.property(offeringArb, (seed) => {
				const slotIndex = seed.slots - 1
				const ranks = Array.from({ length: seed.slots }, (_, i) => i + 1)
				const offering: ModelOffering = { ...seed, ranks }
				const slot: Slot = { offering, slotIndex, rank: ranks[slotIndex]! }
				const baseId = slotTargetId(slot)

				// Changing rank / context / tags leaves the identifier unchanged.
				const mutated: ModelOffering = {
					...offering,
					context: offering.context + 7777,
					tags: [...offering.tags, "extra-tag"],
				}
				const mutatedSlot: Slot = { offering: mutated, slotIndex, rank: 999 }
				expect(slotTargetId(mutatedSlot)).toBe(baseId)

				// Distinct identity tuples (changing any of device/endpoint/model/
				// slotIndex) never produce the same id.
				if (slot.slotIndex > 0) {
					const otherIndex: Slot = { offering, slotIndex: slotIndex - 1, rank: 1 }
					expect(slotTargetId(otherIndex)).not.toBe(baseId)
				}
				const otherDevice: Slot = {
					offering: { ...offering, deviceId: `${offering.deviceId}-x` },
					slotIndex,
					rank: slot.rank,
				}
				expect(slotTargetId(otherDevice)).not.toBe(baseId)
			}),
			{ numRuns: RUNS },
		)
	})

	// Feature: omniroute-fleet-topology, Property 6: Internal-pool dedup and
	// reachability — no two emitted internal pools share identical (targets,
	// config), so their names are unique, and every emitted internal pool is
	// reachable from a Public_Route.
	it("Property 6: internal pools are unique and every one is reachable from a Public_Route", () => {
		fc.assert(
			fc.property(inventoryArb, revisionArb, (model, revision) => {
				const result = compile(model, revision)
				expect(result.ok).toBe(true)
				if (!result.ok) {
					return
				}
				for (const state of result.states.values()) {
					const pools = internalCombos(state)

					// Dedup: pool names are unique, and no two pools share the same
					// (ordered targetIds, config) — a collision would mean dedup
					// failed to collapse them.
					const names = pools.map((pool) => pool.name)
					expect(new Set(names).size).toBe(names.length)
					const identities = pools.map((pool) =>
						JSON.stringify({ ids: pool.models.map((m) => m.id), config: pool.config }),
					)
					expect(new Set(identities).size).toBe(identities.length)

					// Reachability (Requirement 5.5): every emitted internal pool
					// is reachable by following combo-refs from a non-internal
					// root route. Public_Routes and their aliases root the lane
					// pools; Diagnostic_Routes root the device-pinned diagnostic
					// pools. An internal pool reachable from none of these would
					// be dead weight the compiler must not emit.
					const roots = state.combos
						.filter((combo) => state.publishedMetadata.kinds[combo.name] !== "internal")
						.map((combo) => combo.name)
					const reachable = reachableNames(state, roots)
					for (const pool of pools) {
						expect(reachable.has(pool.name)).toBe(true)
					}

					// Every lane pool specifically is reachable from a Public_Route
					// (not merely a diagnostic), which is the core of Requirement 5.5.
					const publicReachable = reachableNames(
						state,
						publicCombos(state).map((combo) => combo.name),
					)
					const diagnosticPoolNames = new Set<string>()
					for (const diag of state.combos.filter(
						(combo) => state.publishedMetadata.kinds[combo.name] === "diagnostic",
					)) {
						for (const ref of diag.models) {
							if (ref.kind === "combo-ref" && ref.comboName) {
								diagnosticPoolNames.add(ref.comboName)
							}
						}
					}
					for (const pool of pools) {
						// A lane pool (not a diagnostic-only pool) must be reachable
						// from a Public_Route.
						if (!diagnosticPoolNames.has(pool.name)) {
							expect(publicReachable.has(pool.name)).toBe(true)
						}
					}
				}
			}),
			{ numRuns: RUNS },
		)
	})

	// Feature: omniroute-fleet-topology, Property 7: Capacity bound — each
	// Model_Offering's per-instance concurrencyPerModel ≤ min(slots,
	// Device_Allocation) and per-Device concurrency ≤ Device_Allocation.
	it("Property 7: per-model and per-device concurrency never exceed the allocation bound", () => {
		fc.assert(
			fc.property(inventoryArb, revisionArb, (model, revision) => {
				const result = compile(model, revision)
				expect(result.ok).toBe(true)
				if (!result.ok) {
					return
				}
				const offeringByModelId = new Map(model.offerings.map((o) => [o.modelId, o]))

				for (const [instanceId, state] of result.states) {
					// Per-device demand accumulated from the concurrencyPerModel
					// maps of this instance's internal pools.
					const perDeviceDemand = new Map<string, number>()
					for (const pool of internalCombos(state)) {
						const concurrency = pool.config["concurrencyPerModel"]
						if (!concurrency || typeof concurrency !== "object") {
							continue
						}
						for (const [modelId, raw] of Object.entries(concurrency as Record<string, unknown>)) {
							const value = raw as number
							const offering = offeringByModelId.get(modelId)
							expect(offering).toBeDefined()
							if (!offering) {
								continue
							}
							const allocation = resolveDeviceAllocation(model, offering.deviceId, instanceId)
							const bound = Math.min(offering.slots, Math.max(0, allocation))
							// Per-model (per-instance) bound, Requirement 7.2.
							expect(value).toBeLessThanOrEqual(bound)
							perDeviceDemand.set(
								offering.deviceId,
								Math.max(perDeviceDemand.get(offering.deviceId) ?? 0, value),
							)
						}
					}
					// Per-device bound, Requirement 7.3: no device's per-model
					// concurrency exceeds its Device_Allocation on this instance.
					for (const [deviceId, demand] of perDeviceDemand) {
						const allocation = resolveDeviceAllocation(model, deviceId, instanceId)
						expect(demand).toBeLessThanOrEqual(Math.max(0, allocation))
					}
				}
			}),
			{ numRuns: RUNS },
		)
	})
})

// -------------------------------------------------------------------------
// Example: today's fleet
// -------------------------------------------------------------------------
//
// A hand-built inventory that models the live fleet (5090 / 4070 / M5 / 4×Arc),
// carries the eight baseline Public_Route names plus the embed and rerank lanes,
// and includes two DEAD targets that must never appear in a compiled combo:
//
//   - a free OpenRouter cloud target whose tags satisfy no lane (so it is
//     ineligible for every lane and never spills into a route), and
//   - a 5090-reader Model_Offering whose tags satisfy no lane (modelling a
//     disabled offering: the schema has no "disabled" flag, so a dead offering
//     is one made ineligible for every lane).

/** A device entry for the fixture. */
function device(id: string, slotCeiling: number): FleetInventory["devices"][number] {
	return { id, slotCeiling, hostPreemption: false }
}

const DEAD_CLOUD_ID = "c:openrouter:free-model"
// The dead reader is pinned to gpu-4070, which has NO diagnostic. Diagnostics
// pin every Slot of their device regardless of lane eligibility, so a dead
// offering on a diagnosed device would legitimately surface in that diagnostic
// pool; placing it on an undiagnosed device keeps it absent from EVERY combo.
const DEAD_READER_SLOT_ID = "t:gpu-4070:vllm-4070:dead-reader:0"

const todaysFleet: FleetInventory = {
	devices: [
		device("gpu-5090", 4),
		device("gpu-4070", 2),
		device("m5", 2),
		device("arc0", 1),
		device("arc1", 1),
		device("arc2", 1),
		device("arc3", 1),
	],
	endpoints: [
		{
			id: "vllm-5090",
			provider: "vllm",
			deviceIds: ["gpu-5090"],
			addresses: [{ instanceId: "cluster", url: "http://5090:2701" }],
			secretRef: "vllm_key",
			noCredential: false,
		},
		{
			id: "vllm-4070",
			provider: "vllm",
			deviceIds: ["gpu-4070"],
			addresses: [{ instanceId: "cluster", url: "http://4070:2701" }],
			secretRef: "vllm_key",
			noCredential: false,
		},
		{
			id: "mlx-m5",
			provider: "mlx",
			deviceIds: ["m5"],
			addresses: [{ instanceId: "cluster", url: "http://m5:2702" }],
			noCredential: true,
		},
		{
			id: "ovms-arc",
			provider: "ovms",
			deviceIds: ["arc0", "arc1", "arc2", "arc3"],
			addresses: [{ instanceId: "cluster", url: "http://arc:8000" }],
			noCredential: true,
		},
	],
	residencyGroups: [
		{ id: "r-5090", swapLatencyMs: 4000 },
		{ id: "r-4070", swapLatencyMs: 6000 },
		{ id: "r-m5", swapLatencyMs: 8000 },
		{ id: "r-arc", swapLatencyMs: 3000 },
	],
	offerings: [
		{
			id: "coder-5090",
			endpointId: "vllm-5090",
			deviceId: "gpu-5090",
			modelId: "qwen-coder",
			context: 262_144,
			slots: 2,
			residencyGroup: "r-5090",
			tags: ["chat", "code", "read"],
			ranks: [1, 2],
		},
		{
			id: "general-4070",
			endpointId: "vllm-4070",
			deviceId: "gpu-4070",
			modelId: "qwen-general",
			context: 131_072,
			slots: 2,
			residencyGroup: "r-4070",
			tags: ["chat", "read"],
			ranks: [3, 4],
		},
		{
			id: "planner-m5",
			endpointId: "mlx-m5",
			deviceId: "m5",
			modelId: "qwen-planner",
			context: 131_072,
			slots: 1,
			residencyGroup: "r-m5",
			tags: ["chat"],
			ranks: [5],
		},
		{
			id: "embed-arc",
			endpointId: "ovms-arc",
			deviceId: "arc0",
			modelId: "qwen-embed",
			context: 32_768,
			slots: 1,
			residencyGroup: "r-arc",
			tags: ["embed"],
			ranks: [1],
		},
		{
			id: "rerank-arc",
			endpointId: "ovms-arc",
			deviceId: "arc1",
			modelId: "qwen-rerank",
			context: 32_768,
			slots: 1,
			residencyGroup: "r-arc",
			tags: ["rerank"],
			ranks: [1],
		},
		// DEAD offering: a 5090-era reader that is ineligible for every lane. The
		// schema has no "disabled" flag, so the dead state is modelled as an
		// offering whose tags satisfy no lane's capabilities — it must never be
		// compiled into any combo. Pinned to gpu-4070 (no diagnostic) so no
		// Diagnostic_Route can legitimately include its slots.
		{
			id: "dead-reader",
			endpointId: "vllm-4070",
			deviceId: "gpu-4070",
			modelId: "dead-reader",
			context: 262_144,
			slots: 1,
			residencyGroup: "r-4070",
			tags: ["decommissioned"],
			ranks: [9],
		},
	],
	clouds: [
		{
			id: "codestral",
			provider: "mistral",
			modelId: "codestral",
			spend: "low-budget",
			context: 256_000,
			tags: ["chat", "code", "read"],
		},
		// DEAD cloud: a free OpenRouter target whose tags satisfy no lane, so it
		// is ineligible for every lane and never spills into a route.
		{
			id: "openrouter-free",
			provider: "openrouter",
			modelId: "free-model",
			spend: "free",
			context: 128_000,
			tags: ["decommissioned"],
		},
	],
	lanes: [
		{
			id: "code",
			names: ["hybrid/code"],
			capabilities: ["chat", "code"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "low-budget",
			spillTiers: ["free", "low-budget"],
			failClosed: false,
			maxQueueMs: 30_000,
			capabilityLanes: ["coder.primary"],
		},
		{
			id: "research",
			names: ["hybrid/research"],
			capabilities: ["chat"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "low-budget",
			spillTiers: ["free", "low-budget"],
			failClosed: false,
			maxQueueMs: 30_000,
			capabilityLanes: [],
		},
		{
			id: "fast",
			names: ["hybrid/fast"],
			capabilities: ["chat"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "free",
			spillTiers: ["free"],
			failClosed: true,
			maxQueueMs: 10_000,
			capabilityLanes: [],
		},
		{
			id: "planner",
			names: ["hybrid/planner"],
			capabilities: ["chat"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "paid",
			spillTiers: ["free", "low-budget", "paid"],
			failClosed: false,
			maxQueueMs: 60_000,
			capabilityLanes: ["reasoning.escalation"],
		},
		{
			id: "reader",
			names: ["hybrid/reader"],
			capabilities: ["chat", "read"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "low-budget",
			spillTiers: ["free", "low-budget"],
			failClosed: false,
			maxQueueMs: 30_000,
			capabilityLanes: ["reader.fast", "reader.deep"],
		},
		{
			id: "reviewer",
			names: ["hybrid/reviewer"],
			capabilities: ["chat"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "paid",
			spillTiers: ["free", "low-budget", "paid"],
			failClosed: false,
			maxQueueMs: 60_000,
			capabilityLanes: [],
		},
		{
			id: "frontier",
			names: ["hybrid/frontier"],
			capabilities: ["chat"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "paid",
			spillTiers: ["free", "low-budget", "paid"],
			failClosed: false,
			maxQueueMs: 90_000,
			capabilityLanes: [],
		},
		{
			id: "tester",
			names: ["hybrid/tester"],
			capabilities: ["chat"],
			minContext: 32_768,
			order: "fill-first",
			maxSpend: "free",
			spillTiers: ["free"],
			failClosed: true,
			maxQueueMs: 10_000,
			capabilityLanes: [],
		},
		{
			id: "embed-lane",
			names: ["memory/embed"],
			capabilities: ["embed"],
			minContext: 8192,
			order: "fill-first",
			maxSpend: "free",
			spillTiers: ["free"],
			failClosed: true,
			maxQueueMs: 10_000,
			capabilityLanes: [],
		},
		{
			id: "rerank-lane",
			names: ["memory/rerank"],
			capabilities: ["rerank"],
			minContext: 8192,
			order: "fill-first",
			maxSpend: "free",
			spillTiers: ["free"],
			failClosed: true,
			maxQueueMs: 10_000,
			capabilityLanes: [],
		},
	],
	instances: [
		{
			id: "cluster",
			role: "primary",
			address: "https://omniroute",
			secretRef: "mgmt_key",
			backupRetention: 20,
		},
	],
	diagnostics: [{ id: "diag/gpu-5090", deviceId: "gpu-5090" }],
	alertDestination: { url: "https://alerts", secretRef: "alert_key" },
	improvementObjectiveOrder: ALL_OBJECTIVES,
}

describe("Route_Compiler example — today's fleet", () => {
	const result = compile(todaysFleet, { commit: "abc1234", uncommitted: false })

	it("compiles successfully", () => {
		expect(result.ok).toBe(true)
	})

	it("emits the eight baseline Public_Route names", () => {
		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		const state = result.states.get("cluster")!
		const publicNames = publicCombos(state).map((combo) => combo.name)
		for (const name of BASELINE_ROUTE_NAMES) {
			expect(publicNames).toContain(name)
		}
	})

	it("lists the local providers in the hard-concurrency Routing_Setting", () => {
		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		const state = result.states.get("cluster")!
		const setting = state.routingSettings.find(
			(s) => s.name === "OMNIROUTE_HARD_CONCURRENCY_PROVIDERS",
		)
		expect(setting).toBeDefined()
		// Local providers only (deduped, sorted); cloud providers (mistral,
		// openrouter) are never hard-concurrency providers.
		expect(setting!.value).toEqual(["mlx", "ovms", "vllm"])
	})

	it("never compiles the dead OpenRouter-free or 5090-reader targets into any combo", () => {
		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		const refIds = new Set<string>()
		for (const combo of allCombos(result)) {
			for (const ref of combo.models) {
				refIds.add(ref.id)
			}
		}
		expect(refIds.has(DEAD_CLOUD_ID)).toBe(false)
		expect(refIds.has(DEAD_READER_SLOT_ID)).toBe(false)
		// Also confirm neither dead model id surfaces as a ref model.
		const modelIds = new Set<string>()
		for (const combo of allCombos(result)) {
			for (const ref of combo.models) {
				if (ref.model) {
					modelIds.add(ref.model)
				}
			}
		}
		expect(modelIds.has("free-model")).toBe(false)
		expect(modelIds.has("dead-reader")).toBe(false)
	})
})
