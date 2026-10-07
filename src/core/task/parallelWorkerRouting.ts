import type { AutonomousTaskState, ProviderSettings } from "@roo-code/types"

import type { EvidencePacket } from "../exploration/types"
import type { ParallelTaskSpec } from "../tools/ParallelTasksTool"
import type {
	PreparedContextWorkPackage,
	PreparedContextWorkPackageBuilder,
	ReaderFinding,
} from "./preparedContextWorkPackage"
import { createPreparedContextWorkPackageBuilder } from "./preparedContextWorkPackage"
import type { CapabilityLane, LaneTaskType } from "./capabilityLanes"
import { laneToRouteCapability } from "./capabilityLanes"
import type { RouteCapability, RouteCapacity, RouteCapacityProvider } from "./elasticTypes"
import type { WorkerResultWithRouting } from "./routingMetadata"
import type {
	EscalationCost,
	ReaderCallerFlags,
	ReaderEscalationInput,
	ReaderEscalationOutcome,
} from "./readerEscalationDecision"
import { decide as decideReaderEscalation } from "./readerEscalationDecision"
import type { GlmInvocationDecision, GlmInvocationInput } from "./glmInvocationGate"
import { createGlmInvocationGate } from "./glmInvocationGate"

/**
 * Modes treated as read-only "reader" roles for parallel-worker model defaults.
 * `project-reader` is the shared read-only reader mode used by parallel fan-out
 * (see `addSharedDocumentReader`). Any of these modes defaults to the reader
 * route id; every other mode defaults to the reasoner route id.
 * See docs/architecture/omniroute-integration-design.md §5.3.
 *
 * Two-field OmniRoute profile -> three-tier intent:
 *   - reader field  (`openAiOmniRouteReaderRouteId`)   = LOW/9B reader; used only
 *     by `project-reader` workers (the sole READER_MODES member).
 *   - reasoner field (`openAiOmniRouteReasonerRouteId`) = HIGH/27B reader; shared
 *     by code workers AND `project-research` (which is deliberately NOT a reader
 *     mode, so it falls through to the reasoner field).
 */
export const READER_MODES: ReadonlySet<string> = new Set(["project-reader"])

/**
 * Resolve the default OmniRoute model id for a parallel worker by its role.
 *
 * Reader-role workers (see {@link READER_MODES}) use the configured
 * `openAiOmniRouteReaderRouteId` (LOW/9B tier); every other worker — including
 * `project-research` and code workers — uses `openAiOmniRouteReasonerRouteId`
 * (HIGH/27B tier). When the relevant field is unset this returns
 * `undefined`, so the caller falls back to the parent model id (single-model
 * behavior unchanged). This is a pure id pass-through — no tier or GPU math;
 * OmniRoute owns placement.
 */
export function roleDefault(mode: string, profile: ProviderSettings): string | undefined {
	return READER_MODES.has(mode) ? profile.openAiOmniRouteReaderRouteId : profile.openAiOmniRouteReasonerRouteId
}

/**
 * Resolve a parallel worker's effective `openAiModelId` with the three-tier
 * precedence (design §5.2): an explicit per-worker `route`, else the role default
 * for the worker's mode, else the parent's model id. Pure — no side effects,
 * no tier/GPU math.
 */
export function resolveWorkerModelId(
	route: string | null | undefined,
	mode: string,
	workerProfile: ProviderSettings,
	parentModelId: string | undefined,
): string | undefined {
	if (route) return route
	// A worker mode with its own saved profile runs on that profile's model.
	// Without this, a reader whose profile defines no role routes inherited the
	// parent orchestrator's model and did all its reading there.
	const ownModelId = workerProfile.openAiModelId
	if (ownModelId && ownModelId !== parentModelId) return ownModelId
	return roleDefault(mode, workerProfile) ?? parentModelId
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability-lane assignment (capability-lanes-routing, task 8.1)
//
// Lane assignment rides ADDITIVELY on the existing `ParallelTaskSpec` path. The
// `parallelTaskSpecSchema` uses `.strip()` (see ParallelTasksTool), so any field
// not declared on the schema is dropped on validation — a brand-new spec field
// would NOT survive a round trip and would silently vanish. The additive,
// `.strip()`-safe carrier is therefore a sidecar pairing, {@link LaneAssignment},
// that leaves the `ParallelTaskSpec` byte-for-byte unchanged (so legacy specs
// without lane metadata still validate and default) and carries the chosen
// `CapabilityLane` beside it. The OmniRoute route id continues to ride through
// the spec's existing `route` passthrough; the resolved `RouteCapability` from
// `laneToRouteCapability` is what the scheduler / `InferenceLeasePool` consume.
//
// This helper is pure and synchronous: it only selects which specs to build and
// what lane each carries. It performs no scheduler dispatch and no leasing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The default reader lane for any reader-mode spec that carries no explicit lane
 * (Req 5.1). Reader-mode specs (`project-reader`, see {@link READER_MODES})
 * default to `reader.fast`; this is the cheap parallel read-only investigation
 * lane and the starting point of every reader routing pattern.
 */
export const DEFAULT_READER_LANE: CapabilityLane = "reader.fast"

/**
 * The default lane for a non-reader spec that carries no explicit lane. Code
 * workers implement, so they default to the primary coder lane (Req 13.1,
 * 13.2); reasoning/escalation is a scarce resource never assigned by default.
 */
export const DEFAULT_CODER_LANE: CapabilityLane = "coder.primary"

/**
 * The additive sidecar that pairs an unchanged {@link ParallelTaskSpec} with the
 * `CapabilityLane` it was assigned and the resolved `RouteCapability` the
 * scheduler consumes.
 *
 * The `spec` is left exactly as supplied — same `name`, `mode`, `message`,
 * `todos`, `route`, `reasoning`, and `verification` — so it still validates under
 * the schema's `.strip()` and a spec with no lane metadata keeps working. The
 * lane is carried here, beside the spec, rather than inside it, because `.strip()`
 * would drop an undeclared spec field (Req 9.8). `capability` is derived purely
 * from `(lane, taskType)` via {@link laneToRouteCapability} and never encodes a
 * model, size, quantization, or GPU identity (Req 2.1).
 */
export interface LaneAssignment {
	/** The unchanged spec, byte-for-byte as supplied (so `.strip()` keeps legacy specs valid). */
	readonly spec: ParallelTaskSpec
	/** The semantic lane role this unit of work is assigned to. */
	readonly lane: CapabilityLane
	/** The resolved `RouteCapability` the scheduler / `InferenceLeasePool` consume. */
	readonly capability: RouteCapability
}

/**
 * The default `LaneTaskType` used to resolve a spec's `RouteCapability` when the
 * caller does not supply one. Reader-mode specs use `"lookup"` (readers map to
 * `"reader"` regardless of task type); non-reader specs use `"implementation"`
 * so a coder spec resolves to the code-reasoning `"reasoner"` capability. The
 * caller may override per spec via {@link assignLane}'s `taskType` argument.
 */
export function defaultLaneTaskType(mode: string): LaneTaskType {
	return READER_MODES.has(mode) ? "lookup" : "implementation"
}

/**
 * Assign a {@link CapabilityLane} to a single spec, additively.
 *
 * The spec is returned unchanged inside the resulting {@link LaneAssignment}; the
 * lane rides beside it. When `lane` is omitted, a reader-mode spec defaults to
 * {@link DEFAULT_READER_LANE} and every other spec to {@link DEFAULT_CODER_LANE}
 * (Req 5.1, 13.1). The resolved `capability` is derived from `(lane, taskType)`;
 * `taskType` defaults from the spec's mode via {@link defaultLaneTaskType}.
 *
 * Pure and synchronous — no I/O, no scheduler dispatch, no leasing.
 */
export function assignLane(spec: ParallelTaskSpec, lane?: CapabilityLane, taskType?: LaneTaskType): LaneAssignment {
	const resolvedLane = lane ?? (READER_MODES.has(spec.mode) ? DEFAULT_READER_LANE : DEFAULT_CODER_LANE)
	const resolvedType = taskType ?? defaultLaneTaskType(spec.mode)
	return {
		spec,
		lane: resolvedLane,
		capability: laneToRouteCapability(resolvedLane, resolvedType),
	}
}

/** A per-spec lane/task-type selection keyed by the spec's unique `name`. */
export interface LaneSelection {
	readonly lane?: CapabilityLane
	readonly taskType?: LaneTaskType
}

/**
 * Attach lane metadata to a batch of specs, additively.
 *
 * Each spec is paired with its {@link CapabilityLane} via {@link assignLane},
 * leaving every spec unchanged so the batch still validates under the schema's
 * `.strip()` and `.max(...)` cap (both untouched). A spec with no entry in
 * `selections` defaults by mode (reader → `reader.fast`, else `coder.primary`),
 * so a legacy batch carrying no lane metadata still resolves correctly (Req 9.8).
 *
 * Pure and synchronous — it only decides which lane each spec carries; it never
 * dispatches, leases, or mutates the input specs.
 */
export function assignLanes(
	specs: readonly ParallelTaskSpec[],
	selections: ReadonlyMap<string, LaneSelection> = new Map(),
): LaneAssignment[] {
	return specs.map((spec) => {
		const selection = selections.get(spec.name)
		return assignLane(spec, selection?.lane, selection?.taskType)
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane → route-id spread (parallel-capacity-routing, design §C)
//
// These resolvers connect the PURE, additive lane assignment above to the
// resolved OmniRoute route id, so same-category (non-reader) workers distribute
// across capable backends instead of all collapsing onto a single reasoner route
// id. They are additive: `assignLane`/`assignLanes`/`laneToRouteCapability` and
// `roleDefault`/`resolveWorkerModelId` are untouched (purity contract preserved).
// Nothing here dispatches, leases, or performs tier/GPU math — it is a pure id
// pass-through, consistent with this module's existing contract. OmniRoute still
// owns model + physical placement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect the ordered, de-duplicated list of OmniRoute route ids a
 * `coder.primary` worker may spread across (design §C "Code-route source").
 *
 * The list is the always-present reasoner route id (`openAiOmniRouteReasonerRouteId`,
 * when set) followed by every `openAiOmniRouteCustomRoutes` entry whose explicit
 * `capability` classifier is `"reasoner"` or `"general"` (mechanical code work is
 * still code-capable). Every other classification — including `"reader"`,
 * `"long-context"`, `"vision"`, and an unclassified route with no `capability` —
 * is excluded, so the spread can NEVER send code work to a reader-only alias.
 * Config order is preserved so the round-robin in {@link resolveLaneRouteId} is
 * deterministic. When the result is empty, falls back to `[parentModelId]`
 * (filtered of `undefined`) so single-model behavior is unchanged.
 */
export function collectCodeCapableRouteIds(profile: ProviderSettings, parentModelId: string | undefined): string[] {
	const ids: string[] = []
	const push = (id: string | undefined) => {
		if (id && !ids.includes(id)) ids.push(id)
	}
	push(profile.openAiOmniRouteReasonerRouteId)
	for (const route of profile.openAiOmniRouteCustomRoutes ?? []) {
		if (route.capability === "reasoner" || route.capability === "general") {
			push(route.modelId)
		}
	}
	if (ids.length === 0 && parentModelId) {
		return [parentModelId]
	}
	return ids
}

/** Inputs to {@link resolveLaneRouteId}: the lane dimension plus the spread inputs. */
export interface ResolveLaneRouteIdArgs {
	/** The lane this worker was assigned by {@link assignLanes} (pure, additive). */
	readonly lane: CapabilityLane
	/** The lane task type used to disambiguate coder/reasoning capability. */
	readonly taskType: LaneTaskType
	/** The worker's resolved profile (OmniRoute route ids live here). */
	readonly profile: ProviderSettings
	/** An explicit per-worker route (mastermind- or user-supplied); wins verbatim when set. */
	readonly route: string | null | undefined
	/** The parent orchestrator's model id; the final single-model fallback. */
	readonly parentModelId: string | undefined
	/** This worker's 0-based index among `coder.primary` workers ONLY (round-robin key). */
	readonly coderOrdinal: number | undefined
	/** The ordered, de-duplicated code-capable route ids from {@link collectCodeCapableRouteIds}. */
	readonly codeCapableRouteIds: readonly string[]
}

/**
 * Resolve a parallel worker's effective `openAiModelId` with the lane dimension
 * layered onto the existing precedence (design §C "Mechanism"):
 *
 *  1. An explicit `route` wins verbatim (honors a mastermind/user route and the
 *     existing pass-through-for-`route` rule).
 *  2. Else resolve by lane:
 *     - `reader.fast` / `reader.deep` → `openAiOmniRouteReaderRouteId` (the 9B
 *       reader lane; readers are preserved exactly, and code work is never sent
 *       to a reader-only model because only reader-MODE specs get a reader lane).
 *     - `coder.primary` → THE SPREAD: deterministic round-robin
 *       `codeCapableRouteIds[coderOrdinal % n]` when more than one code-capable id
 *       is configured, REGARDLESS of task type (so the common reasoning-typed
 *       coder population spreads; design-review finding #1). With a single
 *       configured id, returns `openAiOmniRouteReasonerRouteId` unchanged — no
 *       regression for an unconfigured user; the spread is opt-in via config.
 *     - `reasoning.escalation` → the reasoner/long-context route id by task type
 *       (scarce lane assigned only by `produceDeeperLaneFollowUp`, unchanged).
 *  3. Else fall back to the parent model id (single-model behavior unchanged).
 *
 * Pure — no side effects, no tier/GPU math.
 */
export function resolveLaneRouteId(args: ResolveLaneRouteIdArgs): string | undefined {
	const { lane, taskType, profile, route, parentModelId, coderOrdinal, codeCapableRouteIds } = args
	// 1) Explicit route wins verbatim.
	if (route) return route

	// 2) Resolve by lane.
	switch (lane) {
		case "reader.fast":
		case "reader.deep":
			return profile.openAiOmniRouteReaderRouteId ?? parentModelId
		case "coder.primary": {
			// Spread the common reasoning-typed coder population across every
			// configured code-capable backend by deterministic round-robin keyed on
			// the coder-only ordinal, regardless of task type (finding #1). With a
			// single id (or none configured), behavior is unchanged.
			if (codeCapableRouteIds.length > 1) {
				const ordinal = coderOrdinal ?? 0
				const index =
					((ordinal % codeCapableRouteIds.length) + codeCapableRouteIds.length) % codeCapableRouteIds.length
				return codeCapableRouteIds[index]
			}
			return profile.openAiOmniRouteReasonerRouteId ?? codeCapableRouteIds[0] ?? parentModelId
		}
		case "reasoning.escalation":
			// The scarce escalation lane. The two-field OmniRoute profile exposes no
			// separate long-context route id, so both long-horizon/architecture and
			// adjudication work resolve to the reasoner route id (OmniRoute owns the
			// long-context backend behind that route). `taskType` participates in the
			// capability resolution (laneToRouteCapability) but not the route id here.
			void taskType
			return profile.openAiOmniRouteReasonerRouteId ?? parentModelId
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Deeper-lane follow-up production (capability-lanes-routing, task 8.2)
//
// Given a SETTLED `WorkerResultWithRouting` plus failure history and the
// loop-detector signal, this layer asks the two pure decision components —
// `ReaderEscalationDecision.decide` and `GlmInvocationGate.evaluate` — whether a
// deeper lane should run, and if so emits a NEW follow-up `ParallelTaskSpec`
// carried on the additive {@link LaneAssignment} sidecar from task 8.1:
//   - `escalate-deep`  → one follow-up in the `reader.deep` lane (Req 5.2)
//   - GLM `invoke`     → one follow-up in the `reasoning.escalation` lane (Req 8.1, 8.8)
//   - neither fires    → `null` (no follow-up; GLM scarcity preserved, Req 8.9/8.10)
//
// Invariants this layer upholds:
//   - It is pure and synchronous. Capacity is read ONLY from the passed-in
//     `RouteCapacityProvider` snapshot (or an explicit `RouteCapacity[]`); it
//     performs no scheduler dispatch, leasing, DAG-runnability change, or
//     `onWorkerSettled` call (Req 13.3).
//   - Routing metadata is NEVER injected verbatim into the parent context. The
//     parent keeps receiving only the compacted summary
//     (`compactParallelTasksResultForParent`); the follow-up spec's `message` is a
//     concise directive synthesized here, not the raw `RoutingMetadata` block
//     (Req 12.3, 12.4).
//   - The chosen deeper lane rides on the `LaneAssignment` sidecar, not inside a
//     stripped spec field, honoring the additive-sidecar pattern from 8.1.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reader-escalation resource-cost signals that are not derivable from the
 * settled result alone (model swap latency, whether an alternate can answer,
 * expected deep-task duration, and whether loading deep interrupts fast
 * capacity). The caller supplies these from its scheduler-adjacent knowledge;
 * the capacity snapshot itself is read from the passed-in provider, so this
 * layer stays pure (Req 10.1–10.7).
 *
 * Every field is optional with a conservative default: an unknown cost is
 * treated as cheap (zero latency/duration/queue, no interruption, alternate can
 * answer), so escalation is not blocked by missing information while remaining
 * monotonic in any cost the caller does provide.
 */
export interface FollowUpCostSignals {
	/** Time cost of swapping/loading the deep model on shared hardware (Req 10.2). */
	readonly modelSwapLoadLatencyMs?: number
	/** True when loading deep would interrupt parallel fast capacity (Req 10.3). */
	readonly interruptsParallelFastCapacity?: boolean
	/** Count of queued `reader.fast` work the escalation would delay (Req 10.4). */
	readonly queuedFastReaderWork?: number
	/** Expected duration of the `reader.deep` task (Req 10.5). */
	readonly expectedDeepTaskMs?: number
	/** True when another resident model on different hardware can answer (Req 10.6). */
	readonly alternateHardwareCanAnswer?: boolean
}

/**
 * Everything this pure layer needs to decide and (optionally) build a deeper-lane
 * follow-up from a settled worker. All I/O is pushed to the caller: the capacity
 * snapshot is read from `capacityProvider` (never a scheduler call) and failure
 * history / loop signal / planning signals are passed in.
 */
export interface DeeperLaneFollowUpInput {
	/** The settled worker result, carrying optional additive `routing` telemetry. */
	readonly result: WorkerResultWithRouting
	/**
	 * The spec that produced {@link result}. Its `name`/`mode` seed the follow-up
	 * spec's identity; its `message`/`todos` are NOT copied verbatim (the parent
	 * context never receives the raw metadata block, Req 12.4).
	 */
	readonly originatingSpec: ParallelTaskSpec
	/** Count of consecutive `coder.primary` failures observed so far (Req 8.1). */
	readonly previousFailures: number
	/** The loop-detector verdict for this unit of work (Req 8.8). */
	readonly loopSignal: "none" | "cyclic" | "hard-stop"
	/** Planning-complexity signal in `[0, 1]` for the GLM gate (Req 7.1). */
	readonly complexity: number
	/** Context breadth for the GLM gate (Req 7.2, 8.4, 8.5). */
	readonly contextRequirement: "small" | "large" | "system-wide"
	/** The read-only capacity provider; the ONLY capacity source consulted (Req 13.3). */
	readonly capacityProvider: RouteCapacityProvider
	/** The parent explicitly requested deeper reader analysis (Req 5.9). */
	readonly explicitReaderRequest?: boolean
	/** Caller-observed reader quality flags not derivable from numeric metadata. */
	readonly readerCallerFlags?: ReaderCallerFlags
	/** Resource-cost signals for the reader escalation; unknown costs default cheap. */
	readonly costSignals?: FollowUpCostSignals
	/** The task type under investigation; `reader.deep` is refused for implementation (Req 5.11). */
	readonly taskType?: LaneTaskType
}

/**
 * A deeper-lane follow-up: the additive {@link LaneAssignment} sidecar carrying a
 * freshly built `ParallelTaskSpec`, plus the decision provenance that produced
 * it. `escalation`/`glm` echo the pure components' verdicts so callers (and
 * tests) can observe why the follow-up was emitted without re-deriving it.
 */
export interface DeeperLaneFollowUp {
	/** The follow-up spec paired with its deeper `CapabilityLane` (additive sidecar). */
	readonly assignment: LaneAssignment
	/** The reader-escalation verdict that fired, when the follow-up is `reader.deep`. */
	readonly escalation?: ReaderEscalationOutcome
	/** The GLM-gate verdict that fired, when the follow-up is `reasoning.escalation`. */
	readonly glm?: Extract<GlmInvocationDecision, { invoke: true }>
}

/** Max characters of the concise directive synthesized for a follow-up spec `message`. */
const MAX_FOLLOW_UP_DIRECTIVE_CHARS = 1_200

/**
 * Build the {@link EscalationCost} the reader decision consumes from the
 * passed-in capacity snapshot and the caller's cost signals. Capacity is read
 * ONLY from `capacityProvider.capacitiesFor("reader")`; no scheduler call and no
 * device identity participate (Req 10.8, 13.3). Unknown cost signals default to
 * the cheap end so missing information never fabricates a high cost.
 */
function buildEscalationCost(
	capacityProvider: RouteCapacityProvider,
	signals: FollowUpCostSignals | undefined,
): EscalationCost {
	const capacity: readonly RouteCapacity[] = capacityProvider.capacitiesFor("reader")
	return {
		modelSwapLoadLatencyMs: signals?.modelSwapLoadLatencyMs ?? 0,
		interruptsParallelFastCapacity: signals?.interruptsParallelFastCapacity ?? false,
		queuedFastReaderWork: signals?.queuedFastReaderWork ?? 0,
		expectedDeepTaskMs: signals?.expectedDeepTaskMs ?? 0,
		alternateHardwareCanAnswer: signals?.alternateHardwareCanAnswer ?? true,
		capacity,
	}
}

/**
 * Map a {@link DeeperLaneFollowUpInput} onto the pure {@link ReaderEscalationInput}.
 * Quality triggers are derived downstream from `routing` metadata, the explicit
 * request flag, and caller flags — never from token count (Req 5.10). The cost is
 * built from the capacity snapshot (above).
 */
function toReaderEscalationInput(input: DeeperLaneFollowUpInput): ReaderEscalationInput {
	return {
		metadata: input.result.routing,
		explicitRequest: input.explicitReaderRequest ?? false,
		callerFlags: input.readerCallerFlags,
		cost: buildEscalationCost(input.capacityProvider, input.costSignals),
		taskType: input.taskType,
	}
}

/**
 * Map a {@link DeeperLaneFollowUpInput} onto the pure {@link GlmInvocationInput}.
 * Adjudication triggers are derived downstream from `routing` metadata, the
 * failure count, and the loop signal; planning triggers from complexity/context
 * breadth. The gate preserves GLM scarcity — it invokes iff a trigger is present
 * (Req 8.9, 8.10).
 */
function toGlmInvocationInput(input: DeeperLaneFollowUpInput): GlmInvocationInput {
	return {
		metadata: input.result.routing,
		previousFailures: input.previousFailures,
		loopSignal: input.loopSignal,
		complexity: input.complexity,
		contextRequirement: input.contextRequirement,
	}
}

/** Clip a synthesized directive to the follow-up message bound without throwing. */
function clipDirective(text: string): string {
	const trimmed = text.trim()
	return trimmed.length > MAX_FOLLOW_UP_DIRECTIVE_CHARS
		? `${trimmed.slice(0, MAX_FOLLOW_UP_DIRECTIVE_CHARS - 1).trimEnd()}…`
		: trimmed
}

/**
 * Synthesize the concise directive for a `reader.deep` follow-up. This is a
 * short, human-readable instruction derived from the reasons/triggers — NOT the
 * raw `RoutingMetadata` block (Req 12.3, 12.4). The settled worker's compacted
 * summary is referenced so the deep reader knows what the fast pass concluded,
 * but no verbatim metadata is embedded.
 */
function deepReaderDirective(result: WorkerResultWithRouting, outcome: ReaderEscalationOutcome): string {
	const triggers = outcome.action === "escalate-deep" ? outcome.triggers : []
	const triggerList = triggers.length > 0 ? triggers.join(", ") : "deeper investigation requested"
	return clipDirective(
		`Deep reader follow-up. The fast reader pass concluded: ${result.summary}. ` +
			`Escalation triggers: ${triggerList}. Perform a deeper, bounded investigation to resolve these ` +
			`and return concise findings with evidence references only (no raw source).`,
	)
}

/**
 * Synthesize the concise directive for a `reasoning.escalation` follow-up. As
 * above, this is a short directive built from the role and triggers, never the
 * raw metadata block (Req 12.3, 12.4).
 */
function glmDirective(
	result: WorkerResultWithRouting,
	decision: Extract<GlmInvocationDecision, { invoke: true }>,
): string {
	const role = decision.role === "planning" ? "planning/orchestration" : "adjudication/recovery"
	const triggerList = decision.triggers.join(", ")
	return clipDirective(
		`Reasoning escalation (${role}). Prior worker concluded: ${result.summary}. ` +
			`Invocation triggers: ${triggerList}. Reason over the system-level question and return a decision ` +
			`with concise justification; do not re-run broad repository exploration.`,
	)
}

/**
 * Build a fresh follow-up {@link ParallelTaskSpec} for a deeper lane. The spec's
 * `message` is the synthesized concise directive (never the raw metadata block);
 * its `name` is derived from the originating spec so it is traceable and unique
 * within a batch; `todos`/`route`/`reasoning`/`verification` are intentionally
 * left unset so OmniRoute resolves placement from the lane's `RouteCapability`.
 */
function buildFollowUpSpec(
	originatingSpec: ParallelTaskSpec,
	mode: string,
	directive: string,
	suffix: string,
): ParallelTaskSpec {
	return {
		name: `${originatingSpec.name}#${suffix}`,
		mode,
		message: directive,
	}
}

/**
 * Produce at most one deeper-lane follow-up for a settled worker.
 *
 * Precedence: the reader-escalation decision is consulted first; if it returns
 * `escalate-deep`, a single `reader.deep` follow-up is emitted. Otherwise the GLM
 * gate is consulted; if it invokes, a single `reasoning.escalation` follow-up is
 * emitted. If neither fires, the function returns `null` and no follow-up runs,
 * so the scarce reasoning lane is never required per task (Req 8.9, 8.10).
 *
 * The chosen deeper lane rides on the additive {@link LaneAssignment} sidecar
 * (task 8.1), leaving the follow-up spec schema-valid under `.strip()`; the lane
 * is never stuffed into a stripped spec field. The function is pure/synchronous:
 * capacity is read only from the passed-in provider snapshot, and no dispatch,
 * leasing, DAG, or `onWorkerSettled` behavior is touched (Req 13.3).
 *
 * @returns the follow-up as a {@link DeeperLaneFollowUp}, or `null` when neither
 *   decision fires.
 */
export function produceDeeperLaneFollowUp(input: DeeperLaneFollowUpInput): DeeperLaneFollowUp | null {
	// 1) Reader quality escalation (reader.fast → reader.deep), Req 5.2.
	const escalation = decideReaderEscalation(toReaderEscalationInput(input))
	if (escalation.action === "escalate-deep") {
		const spec = buildFollowUpSpec(
			input.originatingSpec,
			input.originatingSpec.mode,
			deepReaderDirective(input.result, escalation),
			"reader-deep",
		)
		// `reader.deep` is a reader investigation lane; the capability is "reader"
		// regardless of task type, so the task-type override is irrelevant here.
		return { assignment: assignLane(spec, "reader.deep", "lookup"), escalation }
	}

	// 2) GLM dual-role invocation (→ reasoning.escalation), Req 8.1/8.8.
	const glm = createGlmInvocationGate().evaluate(toGlmInvocationInput(input))
	if (glm.invoke) {
		// Pick a lane task type so the resolved RouteCapability matches the role:
		// planning/system-wide work maps to "long-context"; adjudication maps to
		// "reasoner" (see laneToRouteCapability for reasoning.escalation).
		const laneTaskType: LaneTaskType = input.contextRequirement === "system-wide" ? "long-horizon" : "adjudication"
		const spec = buildFollowUpSpec(
			input.originatingSpec,
			input.originatingSpec.mode,
			glmDirective(input.result, glm),
			"reasoning-escalation",
		)
		return { assignment: assignLane(spec, "reasoning.escalation", laneTaskType), glm }
	}

	// 3) Neither fired: no follow-up. The parent still receives only the compacted
	// summary; nothing deeper is scheduled (Req 8.9, 8.10, 12.4).
	return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepared-context reader→coder handoff (capability-lanes-routing, task 8.3)
//
// After a reader settles, this layer runs the `PreparedContextWorkPackageBuilder`
// (preparedContextWorkPackage.ts) over the reader's concise findings — sourced
// from the existing bounded-output path — plus the optional
// `Worker_Bootstrap_Retrieval` `EvidencePacket` and the optional
// `AutonomousTaskState`, THEN serializes the built package into a concise coder
// `message` seed and emits a `coder.primary` `LaneAssignment` (reusing the
// additive sidecar from task 8.1). The handoff runs strictly between reader
// settle and coder spec construction (Req 6.1, 6.2, 6.4).
//
// Invariants this layer upholds:
//   - Pure and synchronous: it only builds the package and serializes a directive;
//     no scheduler dispatch, leasing, or I/O.
//   - The coder `message` is a CONCISE DIRECTIVE derived from the package
//     (objective, relevant files/symbols, findings, constraints, assumptions,
//     test failures, expected behavior, implementation boundaries) — NEVER raw
//     source or full file contents (Req 13.5, 13.6). The builder already copies
//     only concise findings and `file:line` references, so the serialized seed
//     carries references, not code bodies.
//   - The directive instructs the coder NOT to re-explore the repository broadly:
//     the prepared context IS its working set.
//   - The coder lane rides on the `LaneAssignment` sidecar, not inside a stripped
//     spec field, honoring the additive-sidecar pattern from 8.1.
// ─────────────────────────────────────────────────────────────────────────────

/** Max characters of the concise coder directive synthesized from the package. */
const MAX_CODER_DIRECTIVE_CHARS = 4_000

/** Max list items rendered per package section, keeping the seed concise. */
const MAX_DIRECTIVE_LIST_ITEMS = 20

/**
 * Inputs to {@link buildPreparedContextCoderAssignment}. The prepared-context
 * fields mirror {@link PreparedContextInputs} (objective, reader findings from
 * the bounded-output path, optional bootstrap evidence, optional task state); the
 * `baseCoderSpec` supplies the originating coder spec identity whose
 * `name`/`mode` seed the follow-up coder spec. The optional injected `builder`
 * lets callers/tests substitute a fake builder.
 */
export interface PreparedContextCoderInput {
	/** The implementation objective handed to the coder (Req 6.1). */
	readonly objective: string
	/** Concise reader findings from the existing bounded-output path (Req 4, 6.4). */
	readonly readerFindings: readonly ReaderFinding[]
	/** Optional `Worker_Bootstrap_Retrieval` evidence packet (references only, Req 6.5). */
	readonly bootstrap?: EvidencePacket
	/** Optional authoritative task state (constraints/assumptions/blockers, Req 6.2). */
	readonly taskState?: AutonomousTaskState
	/**
	 * The base coder spec identity. Its `name`/`mode` seed the prepared coder
	 * spec; its `message`/`todos` are NOT copied verbatim — the coder `message`
	 * is the synthesized concise directive, never the raw reader transcript or
	 * source (Req 13.5, 13.6).
	 */
	readonly baseCoderSpec: ParallelTaskSpec
	/** Optional injected builder; defaults to {@link createPreparedContextWorkPackageBuilder}. */
	readonly builder?: PreparedContextWorkPackageBuilder
}

/**
 * The result of the prepared-context handoff: the `coder.primary`
 * {@link LaneAssignment} (additive sidecar) carrying the freshly built coder
 * spec, plus the {@link PreparedContextWorkPackage} it was serialized from so
 * callers/tests can observe the handoff without re-deriving it.
 */
export interface PreparedContextCoderHandoff {
	/** The coder spec paired with its `coder.primary` lane (additive sidecar). */
	readonly assignment: LaneAssignment
	/** The built package that seeded the coder `message` (concise, no raw source). */
	readonly workPackage: PreparedContextWorkPackage
}

/** Clip the synthesized coder directive to its bound without throwing. */
function clipCoderDirective(text: string): string {
	const trimmed = text.trim()
	return trimmed.length > MAX_CODER_DIRECTIVE_CHARS
		? `${trimmed.slice(0, MAX_CODER_DIRECTIVE_CHARS - 1).trimEnd()}…`
		: trimmed
}

/**
 * Render a bulleted package section, capped at {@link MAX_DIRECTIVE_LIST_ITEMS}
 * entries, or `undefined` when the list is empty so the section is omitted. The
 * entries are already concise strings or `file:line` references from the builder
 * — never raw source (Req 6.5, 13.6).
 */
function renderDirectiveSection(heading: string, items: readonly string[]): string | undefined {
	if (items.length === 0) {
		return undefined
	}
	const shown = items.slice(0, MAX_DIRECTIVE_LIST_ITEMS)
	const extra = items.length - shown.length
	const bullets = shown.map((item) => `- ${item}`)
	if (extra > 0) {
		bullets.push(`- …(+${extra} more)`)
	}
	return `${heading}:\n${bullets.join("\n")}`
}

/**
 * Render the reader findings as concise one-line claims with their optional
 * `file:line` reference — never the raw evidence snippets (Req 6.5). Capped at
 * {@link MAX_DIRECTIVE_LIST_ITEMS}.
 */
function renderFindings(findings: readonly ReaderFinding[]): string | undefined {
	const lines = findings.map((finding) => {
		const location = finding.location !== undefined ? ` (${finding.location})` : ""
		return `${finding.claim}${location}`
	})
	return renderDirectiveSection("Reader findings", lines)
}

/**
 * Serialize a {@link PreparedContextWorkPackage} into a concise coder `message`
 * seed. The directive is assembled from the package's concise fields — objective,
 * relevant files/symbols, findings, constraints, assumptions, test failures,
 * expected behavior, and implementation boundaries — and NEVER contains raw
 * source or full file contents (Req 13.5, 13.6). It explicitly instructs the
 * coder not to re-explore the repository broadly: the prepared context is the
 * working set (Req 6.4).
 */
function serializeCoderDirective(workPackage: PreparedContextWorkPackage): string {
	const sections: string[] = [
		`Objective: ${workPackage.objective}`.trim(),
		"Use ONLY the prepared context below as your working set. Do not re-explore the repository broadly; " +
			"open only the referenced files/symbols as needed to implement the objective.",
	]

	const parts: Array<string | undefined> = [
		renderDirectiveSection("Relevant files", workPackage.relevantFiles),
		renderDirectiveSection("Relevant symbols", workPackage.relevantSymbols),
		renderFindings(workPackage.readerFindings),
		renderDirectiveSection("Architectural constraints", workPackage.architecturalConstraints),
		renderDirectiveSection("Known assumptions", workPackage.knownAssumptions),
		renderDirectiveSection("Existing test failures", workPackage.existingTestFailures),
		workPackage.expectedBehavior.trim().length > 0
			? `Expected behavior: ${workPackage.expectedBehavior.trim()}`
			: undefined,
		renderDirectiveSection("Implementation boundaries", workPackage.implementationBoundaries),
	]

	for (const part of parts) {
		if (part !== undefined) {
			sections.push(part)
		}
	}

	return clipCoderDirective(sections.join("\n\n"))
}

/**
 * Run the prepared-context handoff between reader settle and coder spec
 * construction.
 *
 * Builds a {@link PreparedContextWorkPackage} from the reader findings (sourced
 * from the bounded-output path) plus optional bootstrap evidence and task state,
 * serializes it into a concise coder `message` directive (never raw source,
 * Req 13.5/13.6), and returns a `coder.primary` {@link LaneAssignment} carrying a
 * freshly built coder spec. The coder spec reuses the base coder spec's `mode`
 * and a traceable derived `name`; its `message` is the synthesized directive and
 * it is instructed not to re-explore the repository broadly (Req 6.1, 6.2, 6.4).
 *
 * Pure and synchronous — it only builds the package and serializes the directive;
 * no scheduler dispatch, leasing, or I/O. The coder lane rides on the additive
 * sidecar from task 8.1, leaving the spec schema-valid under `.strip()`.
 */
export function buildPreparedContextCoderAssignment(input: PreparedContextCoderInput): PreparedContextCoderHandoff {
	const builder = input.builder ?? createPreparedContextWorkPackageBuilder()
	const workPackage = builder.build({
		objective: input.objective,
		readerFindings: [...input.readerFindings],
		bootstrap: input.bootstrap,
		taskState: input.taskState,
	})

	const spec: ParallelTaskSpec = {
		name: `${input.baseCoderSpec.name}#prepared-coder`,
		mode: input.baseCoderSpec.mode,
		message: serializeCoderDirective(workPackage),
	}

	// `coder.primary` with the "implementation" task type resolves to the
	// code-reasoning capability; the lane rides on the sidecar, not the spec.
	return { assignment: assignLane(spec, "coder.primary", "implementation"), workPackage }
}
