import stringify from "safe-stable-stringify"
import { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

/** 32-bit FNV-1a hash. Returns the hash as a lowercase hex string. */
export function fnv1a(str: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16)
}

/** Merge `params` and `nativeArgs` into one plain object, dropping undefined/empty-string/null values. */
export function normalizeArgs(block: ToolUse): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...block.params }
	if (block.nativeArgs && Object.keys(block.nativeArgs).length > 0) {
		Object.assign(merged, block.nativeArgs)
	}
	for (const key of Object.keys(merged)) {
		const value = merged[key]
		if (value === undefined || value === "" || value === null) delete merged[key]
	}
	return merged
}

/** Order-stable hash of the tool name + normalized args. */
export function hashArgs(block: ToolUse): string {
	return fnv1a(stringify({ name: block.name, args: normalizeArgs(block) }) ?? "")
}

/** Pulls an iteration position from args/result. Order of preference: explicit offset, then line range, then pagination token. */
export function extractCursor(block: ToolUse, context?: ToolResultContext): string | number | undefined {
	const args = normalizeArgs(block)
	if (typeof args["offset"] === "number" || typeof args["offset"] === "string") return args["offset"] as string | number
	if (typeof args["start_line"] === "string") return `${args["start_line"]}:${args["end_line"] ?? ""}`
	const token = /next[_-]?(page|token|cursor)[^A-Za-z0-9]+([A-Za-z0-9=_-]+)/i.exec(context?.resultText ?? "")
	return token ? token[2] : undefined
}

/** File + line-range identity, independent of cursor advancement. */
export function extractTarget(block: ToolUse): string | undefined {
	const args = normalizeArgs(block)
	const path = (args["path"] ?? args["file"]) as string | undefined
	if (!path) return undefined
	const range = args["start_line"] ? `#${args["start_line"]}-${args["end_line"] ?? ""}` : ""
	return `${path}${range}`
}

/**
 * Returns true when `next` cursor is comparable to and strictly forward of `prev`.
 * Numeric comparison for offsets (next > prev); token inequality for pagination tokens.
 * Returns false when either cursor is undefined or they are not comparable.
 */
export function isCursorAdvanced(
	prev: string | number | undefined,
	next: string | number | undefined,
): boolean {
	if (prev === undefined || next === undefined) return false
	if (typeof prev === "number" && typeof next === "number") return next > prev
	if (typeof prev === "string" && typeof next === "string") {
		// Numeric strings (offsets serialized as strings): compare as numbers when both parse
		const prevNum = Number(prev)
		const nextNum = Number(next)
		if (!Number.isNaN(prevNum) && !Number.isNaN(nextNum)) return nextNum > prevNum
		// Pagination tokens: any change is forward progress
		return next !== prev
	}
	return false
}

/** Clamp a numeric value into the closed interval [min, max]. */
export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value
}

/**
 * Total function mapping a noProgressScore to an escalation band.
 * Boundaries: continue 0–5, nudge 6–9, replanning 10–13, hard_stop 14+.
 * Defensively handles out-of-range scores (negative ⇒ continue, >100 ⇒ hard_stop).
 */
export function deriveBand(score: number): Band {
	if (score <= 5) return "continue"
	if (score <= 9) return "nudge"
	if (score <= 13) return "replanning"
	return "hard_stop"
}

/**
 * Map a resolved band to the preserved `ToolRepetitionCheckResult` discriminated union.
 * - continue  ⇒ allow execution
 * - nudge     ⇒ nudge-variant with band "nudge"
 * - replanning ⇒ nudge-variant with band "replanning"
 * - hard_stop ⇒ askUser with messageKey "mistake_limit_reached" and i18n detail
 */
export function bandToResult(band: Band, toolName: string, repeatCount: number): ToolRepetitionCheckResult {
	switch (band) {
		case "continue":
			return { allowExecution: true }
		case "nudge":
			return { allowExecution: false, nudge: { toolName, repeatCount, band: "nudge" } }
		case "replanning":
			return { allowExecution: false, nudge: { toolName, repeatCount, band: "replanning" } }
		case "hard_stop":
			return {
				allowExecution: false,
				askUser: {
					messageKey: "mistake_limit_reached",
					messageDetail: t("tools:toolRepetitionLimitReached", { toolName }),
				},
			}
	}
}

/**
 * Tools whose repeated invocation is a normal part of making progress; they must
 * not be blocked on repetition alone (Requirement 5.1).
 */
export const ITERATIVE_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"read_command_output",
	"codebase_search",
	"search_files",
	"browser_action",
])

/** Command-shape matchers for execute_command bodies (kubectl/watch, test runners, polling). */
export const ITERATIVE_COMMAND_PATTERNS: readonly RegExp[] = [
	/\bkubectl\b.*\b(get|describe|logs|rollout status)\b/,
	/\bwatch\b/,
	/\b(jest|vitest|pytest|go test|cargo test|mocha)\b/,
	/\b(sleep|poll|until|while)\b/,
]

/**
 * Classifies a tool execution as iterative-capable: by explicit tool-set membership,
 * by an active polling workflow, or by a command body matching an iterative pattern
 * (Requirement 5.1).
 */
export function isIterativeCapable(block: ToolUse, context?: ToolResultContext): boolean {
	if (ITERATIVE_CAPABLE_TOOLS.has(String(block.name))) return true
	if (context?.isPollingWorkflow) return true
	// `nativeArgs` is a per-tool discriminated union (or `never`), so it cannot be indexed by a
	// literal key directly; `normalizeArgs` merges params + nativeArgs into a plain record for lookup.
	const command = normalizeArgs(block)["command"]
	return typeof command === "string" && ITERATIVE_COMMAND_PATTERNS.some((re) => re.test(command))
}

/**
 * Derived progress flags for a single execution. Returned alongside the progress
 * signal list so the caller can merge them into `CapturedSignals`.
 */
export interface ProgressFlags {
	workspaceChanged: boolean
	todoChanged: boolean
	resultChanged: boolean
	cursorAdvanced: boolean
	resultHash?: string
}

/**
 * Derives the progress signals (Requirement 3) for one tool execution from its
 * observable result context, the current `ToolUse`, and the previous `IterationState`.
 *
 * Only observable inputs are consulted; any `undefined` context field is treated
 * conservatively (no progress credit, no fabricated stagnation — Requirement 7.3).
 * Stagnation signals are NOT derived here (see `deriveStagnationSignals`).
 */
export function deriveProgressSignals(
	block: ToolUse,
	context: ToolResultContext,
	prevState: IterationState | undefined,
): { progress: ProgressSignal[]; flags: ProgressFlags } {
	const progress: ProgressSignal[] = []

	const newTarget = extractTarget(block)
	const newCursor = extractCursor(block, context)
	const newArgsHash = hashArgs(block)
	const newResultHash = fnv1a(context.resultText ?? "")

	// Req 3.1, 3.12: cursor/pagination advanced for the same target.
	let cursorAdvanced = false
	if (prevState && prevState.target === newTarget && isCursorAdvanced(prevState.cursor, newCursor)) {
		cursorAdvanced = true
		progress.push("cursor_advanced")
	}

	// Req 3.2: tool targets a different file/line range than before.
	if (prevState && newTarget !== prevState.target) {
		progress.push("target_changed")
	}

	// update_todo_list makes meaningful progress ONLY when a checklist item's status
	// actually changes (surfaced via context.todoChanged). Cosmetic edits — reordering
	// items, rephrasing text, or a validation-rejected update — change the args/result
	// hash but represent no forward progress. Crediting those as query_changed/result_changed
	// would cancel the stagnation score and let the model loop on update_todo_list
	// indefinitely. Suppress both signals for an update_todo_list no-op.
	const isTodoNoOp = String(block.name) === "update_todo_list" && context.todoChanged !== true

	// Req 3.3: search query / arguments changed meaningfully.
	if (!isTodoNoOp && prevState && newArgsHash !== prevState.normalizedArgsHash) {
		progress.push("query_changed")
	}

	// Req 3.4: result body differs from the previous execution.
	let resultChanged = false
	if (!isTodoNoOp && prevState && newResultHash !== prevState.resultHash) {
		resultChanged = true
		progress.push("result_changed")
	}

	// Req 3.5: Git/worktree state changed.
	let workspaceChanged = false
	if (context.workspaceChanged === true) {
		workspaceChanged = true
		progress.push("workspace_changed")
	}

	// Req 3.6: checklist (todo) state changed.
	let todoChanged = false
	if (context.todoChanged === true) {
		todoChanged = true
		progress.push("todo_changed")
	}

	// Req 3.7, 3.10, 3.11: external/command/k8s/browser state changed.
	if (
		context.externalStateHash !== undefined &&
		context.externalStateHash !== prevState?.prevExternalStateHash
	) {
		progress.push("external_state_changed")
	}

	// Req 3.8: the set of failing tests changed between runs.
	if (context.failingTestIds !== undefined && prevState?.prevFailingTestSetHash !== undefined) {
		const newSetHash = fnv1a(stringify([...context.failingTestIds].sort()) ?? "")
		if (newSetHash !== prevState.prevFailingTestSetHash) {
			progress.push("failing_tests_changed")
		}
	}

	// Req 3.9: the number of failing tests decreased between runs.
	if (
		context.failingTestCount !== undefined &&
		prevState?.prevFailingTestCount !== undefined &&
		context.failingTestCount < prevState.prevFailingTestCount
	) {
		progress.push("failing_tests_decreased")
	}

	// Req 3.13: explicit wait/poll workflow is legitimate iterative progress.
	if (context.isPollingWorkflow === true) {
		progress.push("poll_progress")
	}

	return {
		progress,
		flags: { workspaceChanged, todoChanged, resultChanged, cursorAdvanced, resultHash: newResultHash },
	}
}

/**
 * Tools whose repeated invocation mutates workspace/external state. A repeated
 * execution of a mutation tool that leaves the workspace unchanged is evidence
 * of a stalled edit (Requirement 4.3, 4.6). `browser_action` is intentionally
 * omitted: distinguishing its read vs. mutate modes is complex, and
 * `execute_command` covers the primary mutation case.
 */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
	"write_to_file",
	"apply_diff",
	"insert_code_block",
	"search_and_replace",
	"execute_command",
])

/**
 * Derives the stagnation signals (Requirement 4) for one tool execution from its
 * observable result context, the current `ToolUse`, the progress signals already
 * computed for this execution, and the previous `IterationState`.
 *
 * Only observable inputs are consulted; any `undefined` context field yields no
 * stagnation signal (conservative — Requirement 7.3). Signals that imply "no
 * intervening progress" are suppressed whenever `progressSignals` is non-empty.
 */
export function deriveStagnationSignals(
	block: ToolUse,
	context: ToolResultContext,
	prevState: IterationState | undefined,
	progressSignals: ProgressSignal[],
	newArgsHash: string,
	newResultHash: string | undefined,
): StagnationSignal[] {
	const stagnation: StagnationSignal[] = []
	const hasProgress = progressSignals.length > 0

	// Req 4.1, 4.4, 4.7: identical args AND identical result with no intervening progress.
	if (
		prevState &&
		!hasProgress &&
		newArgsHash === prevState.normalizedArgsHash &&
		newResultHash !== undefined &&
		newResultHash === prevState.resultHash
	) {
		stagnation.push("identical_args_and_result")
	}

	// Req 4.2, 4.5: same error class retried without intervening progress
	// (covers auth retry without new credentials).
	if (
		!hasProgress &&
		context.errorClass !== undefined &&
		prevState?.errorClass !== undefined &&
		context.errorClass === prevState.errorClass
	) {
		stagnation.push("repeated_error_class")
	}

	// Req 4.3, 4.6: mutation tool repeated with the same args but no workspace change
	// (covers repeated malformed edits).
	if (
		prevState &&
		MUTATION_TOOLS.has(String(block.name)) &&
		newArgsHash === prevState.normalizedArgsHash &&
		context.workspaceChanged !== true
	) {
		stagnation.push("empty_mutation_diff")
	}

	// update_todo_list is a state-mutation tool whose observable effect is a checklist
	// status change (todoChanged), not a workspace diff. A repeated update_todo_list call
	// that reports no status change is a stalled checklist edit — the same failure class as
	// empty_mutation_diff. This fires regardless of whether the todo *text* differs, because
	// cosmetic reorder/rephrase without a status transition is not progress. Guarding on a
	// prior update_todo_list ensures the very first call is never penalized.
	if (
		prevState &&
		String(block.name) === "update_todo_list" &&
		prevState.tool === "update_todo_list" &&
		context.todoChanged !== true &&
		!stagnation.includes("empty_mutation_diff")
	) {
		stagnation.push("empty_mutation_diff")
	}

	// Req 4.8: a claimed success contradicted by verification.
	if (context.verifiedSucceeded === false) {
		stagnation.push("unverified_success")
	}

	return stagnation
}

/**
 * Per-signal weight applied to the No_Progress_Score for each stagnation signal.
 * `identical_args_and_result` is the strongest evidence of a stuck loop (exact
 * repetition with no change), so it carries the largest increase.
 */
export const STAGNATION_WEIGHTS: Readonly<Record<StagnationSignal, number>> = {
	identical_args_and_result: 4,
	repeated_error_class: 3,
	empty_mutation_diff: 3,
	unverified_success: 2,
	// Weighted like a repeated error: a single tool-less turn is a first failure (the
	// host already grants one silent retry), but repeated empty responses accumulate
	// toward the same nudge/replanning/hard_stop bands as any other stalled loop.
	no_tool_use: 3,
}

/** Each observed progress signal decreases the No_Progress_Score by this amount. */
export const PROGRESS_WEIGHT = 2

/**
 * Converts the captured signals for one completed execution into a raw
 * No_Progress_Score delta (Requirements 1.5, 3.1, 6.1): each Progress_Signal
 * decreases the score, each Stagnation_Signal increases it by its weight.
 *
 * Iterative-capable exemption (Requirements 5.2, 5.3, 5.4, 7.2): when the tool is
 * iterative-capable AND at least one Progress_Signal was observed, the delta is
 * clamped so it can never raise the score (`Math.min(0, delta)`). This guarantees
 * repetition alone never escalates an iterative-capable tool that is making
 * progress. When no Progress_Signal is present, stagnation still raises the score
 * normally — interventions depend on accumulated stagnation, never a raw
 * repetition count.
 *
 * The returned value is the raw (unbounded) delta; the caller applies the
 * `clamp(0, 100)` bound to the accumulated score.
 */
export function computeScoreDelta(
	captured: CapturedSignals,
	prevState: IterationState | undefined,
	block: ToolUse,
	context?: ToolResultContext,
): number {
	void prevState // state-dependent signals are already resolved into `captured`

	const progressDelta = -(captured.progress.length * PROGRESS_WEIGHT)
	const stagnationDelta = captured.stagnation.reduce((sum, signal) => sum + STAGNATION_WEIGHTS[signal], 0)

	let delta = progressDelta + stagnationDelta

	// Req 5.2/5.3/5.4: an iterative-capable tool with observed progress is never
	// escalated; its delta can only be neutral or negative.
	if (isIterativeCapable(block, context) && captured.progress.length > 0) {
		delta = Math.min(0, delta)
	}

	return delta
}

/**
 * Preserved result contract. Callers branch on allowExecution / nudge / askUser.
 * `nudge.band` is additive and optional for callers; "replanning" reuses the nudge
 * channel because the contract exposes only nudge and askUser.
 */
export type ToolRepetitionCheckResult =
	| { allowExecution: true; nudge?: undefined; askUser?: undefined }
	| {
			allowExecution: false
			nudge: { toolName: string; repeatCount: number; band?: "nudge" | "replanning" }
			askUser?: undefined
	  }
	| {
			allowExecution: false
			nudge?: undefined
			askUser: { messageKey: "mistake_limit_reached"; messageDetail: string }
	  }

/** The escalation bands keyed to the No_Progress_Score. */
export type Band = "continue" | "nudge" | "replanning" | "hard_stop"

/**
 * Observable change that indicates work is advancing. A Progress_Signal decreases
 * the No_Progress_Score.
 */
export type ProgressSignal =
	| "cursor_advanced" // Req 3.1, 3.12
	| "target_changed" // Req 3.2
	| "query_changed" // Req 3.3
	| "result_changed" // Req 3.4
	| "workspace_changed" // Req 3.5
	| "todo_changed" // Req 3.6
	| "external_state_changed" // Req 3.7, 3.10, 3.11
	| "failing_tests_changed" // Req 3.8
	| "failing_tests_decreased" // Req 3.9
	| "poll_progress" // Req 3.13

/**
 * Observable condition that indicates work is not advancing. A Stagnation_Signal
 * increases the No_Progress_Score.
 */
export type StagnationSignal =
	| "identical_args_and_result" // Req 4.1, 4.4, 4.7
	| "repeated_error_class" // Req 4.2, 4.5
	| "empty_mutation_diff" // Req 4.3, 4.6
	| "unverified_success" // Req 4.8
	| "no_tool_use" // Turn produced no tool call (model stalled / empty-response churn)

/**
 * Per-task record describing the most recent evaluated tool execution and the
 * progress flags derived from it (Requirement 2).
 */
export interface IterationState {
	/** Most recently evaluated tool name. */
	tool: string
	/** Order-insensitive hash of normalized args (Requirement 2.5). */
	normalizedArgsHash: string
	/** Hash of the last result body; optional (Requirement 2.3). */
	resultHash?: string
	/** Extracted iteration position: read offset, pagination token, or line range. */
	cursor?: string | number
	/** Extracted target: file path and/or line range. */
	target?: string
	/** Error classification of the last execution, if it failed. */
	errorClass?: string

	/** True when git/worktree state changed as a result of the last execution. */
	workspaceChanged: boolean
	/** True when the checklist (todo) state changed as a result of the last execution. */
	todoChanged: boolean
	/** True when the result body differed from the previous execution. */
	resultChanged: boolean
	/** True when the cursor advanced relative to the previous execution. */
	cursorAdvanced: boolean

	/** Accumulated no-progress evidence, bounded 0..100 (Requirement 6.1). */
	noProgressScore: number

	// Internal bookkeeping (required for bands/hysteresis/hard-stop precondition):
	/** Count of completed executions recorded for this task (Requirement 6.7/6.8). */
	completedExecutions: number
	/** The band last surfaced, to enforce once-per-entry nudge and hysteresis cancellation. */
	lastBand: Band
	/** Set when a replanning/hard-stop intervention is pending but not yet issued. */
	pendingIntervention?: Band
	/** The previous failing-test count, to detect decrease (Requirement 3.9). */
	prevFailingTestCount?: number
	/** The previous failing-test id set hash, to detect set change (Requirement 3.8). */
	prevFailingTestSetHash?: string
	/** The previous external state hash (command/k8s/browser) (Requirement 3.7, 3.10, 3.11). */
	prevExternalStateHash?: string
}

/** Signals captured during `afterTool` for a single execution. */
export interface CapturedSignals {
	tool: string
	normalizedArgsHash: string
	resultHash?: string
	cursor?: string | number
	target?: string
	errorClass?: string
	progress: ProgressSignal[]
	stagnation: StagnationSignal[]
	workspaceChanged: boolean
	todoChanged: boolean
	resultChanged: boolean
	cursorAdvanced: boolean
}

/** Result of `evaluateProgress`: the band, the updated score, and the gate result. */
export interface BandDecision {
	band: Band
	noProgressScore: number
	result: ToolRepetitionCheckResult
}

/** Observable inputs available after a tool executes. Supplied by the host (presentAssistantMessage). */
export interface ToolResultContext {
	/** Serialized result text/body the tool produced. */
	resultText?: string
	/** Error classification when the tool failed (e.g. "auth", "malformed_diff", "not_found"). */
	errorClass?: string
	/** True when git/worktree state changed as a result of this execution. */
	workspaceChanged?: boolean
	/** True when the checklist (todo) state changed as a result of this execution. */
	todoChanged?: boolean
	/** Count of failing tests parsed from a test-runner result, when derivable. */
	failingTestCount?: number
	/** Stable identity set of failing tests, when derivable (for set-change detection). */
	failingTestIds?: string[]
	/** Observable external/command/k8s/browser state fingerprint, when derivable. */
	externalStateHash?: string
	/** When true, an explicit wait/poll workflow is in effect for this execution. */
	isPollingWorkflow?: boolean
	/** Verification signal: observed success/failure that may contradict a claimed success. */
	verifiedSucceeded?: boolean
}

/** The raw outcome of a tool execution supplied to the detector post-execution. */
export interface ToolExecutionResult {
	ok: boolean
	body?: string
}

/** Sink for nudge and stop metric outputs (Requirement 9). */
export interface MetricsSink {
	emitNudge(event: { toolName: string; noProgressScore: number }): void
	emitStop(event: { toolName: string; noProgressScore: number }): void
}

/** Optional dependencies injected into the detector. */
export interface ProgressAwareLoopDetectorDeps {
	metrics?: MetricsSink
	now?: () => number
}

/**
 * Band severity ordering for hysteresis comparison. Higher number = more severe.
 * Used by `gate()` to detect demotion (score dropped below the current band's
 * lower boundary) and cancel pending higher-band interventions (Requirement 6.6).
 */
const BAND_SEVERITY: Record<Band, number> = { continue: 0, nudge: 1, replanning: 2, hard_stop: 3 }

/**
 * Progress-aware replacement for the exact-repetition `ToolRepetitionDetector`.
 *
 * The detector evaluates each tool execution across four phases — `beforeTool`,
 * `executeTool`, `afterTool`, `evaluateProgress` (Requirement 1.1) — and maintains
 * one {@link IterationState} per task (Requirement 2.1). Interventions are a pure
 * function of the accumulated `noProgressScore`, never of a raw repetition count
 * (Requirement 1.5).
 *
 * This class provides the four phase methods plus per-task state. The `check()`
 * pre-execution gate and the `recordResult()` post-execution wrapper layer
 * hysteresis, once-per-entry nudge, and the hard-stop precondition on top of these
 * phase methods; the compatibility exports are added in task 6.3.
 */
export class ProgressAwareLoopDetector {
	/** Retained for compatibility with the existing `Task.ts` construction. The
	 * detector is score-driven (fixed bands), so `limit` does not gate bands; it is
	 * stored so `new ProgressAwareLoopDetector(this.consecutiveMistakeLimit)` keeps
	 * type-checking and remains available for future count-aware messaging. */
	private readonly limit: number

	/** Optional metrics sink; nudge/stop events are emitted through it when interventions are surfaced (task 8.1). */
	private readonly metrics?: MetricsSink
	/** Optional clock; wired into timing-sensitive logic in task 8.1. */
	private readonly now?: () => number

	/** Per-task iteration state, created lazily on first use. */
	private states: Map<string, IterationState> = new Map()

	/** Pre-execution inputs captured by `beforeTool`, keyed by taskId, reconciled in `afterTool`. */
	private pending: Map<string, Partial<IterationState>> = new Map()

	/** Implicit task id used when a caller does not supply one. */
	private static readonly DEFAULT_TASK_ID = "__default__"

	constructor(limit: number = 3, deps?: ProgressAwareLoopDetectorDeps) {
		this.limit = limit
		this.metrics = deps?.metrics
		this.now = deps?.now
		// `limit` and `now` are stored for use in later tasks (6.2 messaging, timing-sensitive
		// logic). Reference them here so the fields are not flagged as unused. `metrics` is now
		// used by the emission helpers (task 8.1), so it no longer needs a `void` guard.
		void this.limit
		void this.now
	}

	/**
	 * Returns the {@link IterationState} for `taskId`, lazily creating a fresh
	 * default state the first time the task is seen (Requirement 2.1).
	 */
	private getState(taskId: string): IterationState {
		let state = this.states.get(taskId)
		if (!state) {
			state = {
				tool: "",
				normalizedArgsHash: "",
				workspaceChanged: false,
				todoChanged: false,
				resultChanged: false,
				cursorAdvanced: false,
				noProgressScore: 0,
				completedExecutions: 0,
				lastBand: "continue",
			}
			this.states.set(taskId, state)
		}
		return state
	}

	/**
	 * Phase 1 (pre-execution, Requirement 1.2). Normalizes the args, computes the
	 * `normalizedArgsHash`, extracts the `cursor`/`target`, and captures them as
	 * pending pre-execution inputs for this task.
	 *
	 * Returns the GATE decision derived from the score accumulated by PRIOR
	 * completed executions (`deriveBand(state.noProgressScore)`); it does not
	 * re-score the current execution, which has no result yet. The hard-stop
	 * precondition and hysteresis are applied by `recordResult()`/`check()` in task 6.2.
	 */
	public beforeTool(block: ToolUse, taskId: string): ToolRepetitionCheckResult {
		const state = this.getState(taskId)

		const normalizedArgsHash = hashArgs(block)
		const cursor = extractCursor(block)
		const target = extractTarget(block)

		this.pending.set(taskId, { normalizedArgsHash, cursor, target })

		const band = deriveBand(state.noProgressScore)
		return bandToResult(band, String(block.name), state.completedExecutions)
	}

	/**
	 * Phase 2 (execution boundary, Requirement 1 four-phase API). The detector does
	 * NOT run the tool; the host (`presentAssistantMessage.ts`) owns actual
	 * execution via its `switch (block.name)` dispatch. This method exists purely to
	 * document the boundary so all four named phase operations are present on the
	 * class (Requirement 1.1).
	 */
	public executeTool(): void {
		// Intentional no-op: tool execution is performed by the host.
	}

	/**
	 * Phase 3 (post-execution, Requirement 1.3). Reads the previous state, computes
	 * the current `normalizedArgsHash`, derives the progress and stagnation signals
	 * from the observable {@link ToolResultContext}, and returns the fully-populated
	 * {@link CapturedSignals} for this execution. State mutation happens in
	 * `evaluateProgress`.
	 */
	public afterTool(
		block: ToolUse,
		result: ToolExecutionResult,
		context: ToolResultContext,
		taskId: string,
	): CapturedSignals {
		void result // the raw ok/body outcome is reflected in `context`; retained for the phase contract
		const prevState = this.states.get(taskId)
		const newArgsHash = hashArgs(block)

		const { progress, flags } = deriveProgressSignals(block, context, prevState)
		const stagnation = deriveStagnationSignals(
			block,
			context,
			prevState,
			progress,
			newArgsHash,
			flags.resultHash,
		)

		return {
			tool: String(block.name),
			normalizedArgsHash: newArgsHash,
			resultHash: flags.resultHash,
			cursor: extractCursor(block, context),
			target: extractTarget(block),
			errorClass: context.errorClass,
			progress,
			stagnation,
			workspaceChanged: flags.workspaceChanged,
			todoChanged: flags.todoChanged,
			resultChanged: flags.resultChanged,
			cursorAdvanced: flags.cursorAdvanced,
		}
	}

	/**
	 * Phase 4 (post-execution, Requirement 1.4). Converts the captured signals into
	 * a `noProgressScore` delta, applies it with `clamp(0, 100)` (Requirement 6.1),
	 * increments `completedExecutions`, updates the per-task {@link IterationState}
	 * from the captured signals and bookkeeping context, re-derives the band, and
	 * returns the {@link BandDecision}.
	 *
	 * `block`/`context` are optional so this method can be driven either by the
	 * `recordResult()` wrapper (task 6.2, which has both) or directly. When omitted,
	 * a synthetic `ToolUse` carrying only the captured tool name is used so
	 * `computeScoreDelta` can still evaluate the iterative-capable exemption; without
	 * a command body or polling context the synthetic block is conservatively
	 * non-iterative, which cannot wrongly suppress stagnation.
	 *
	 * Hysteresis, once-per-entry nudge, and the hard-stop precondition are NOT
	 * applied here; they are layered on in task 6.2. `lastBand`/`pendingIntervention`
	 * are left for that task to manage.
	 */
	public evaluateProgress(
		taskId: string,
		captured: CapturedSignals,
		block?: ToolUse,
		context?: ToolResultContext,
	): BandDecision {
		const state = this.getState(taskId)

		// Synthetic fallback carries only the tool name; it is conservatively
		// non-iterative when no command/polling context is supplied.
		const scoringBlock: ToolUse = block ?? ({ type: "tool_use", name: captured.tool, params: {}, partial: false } as ToolUse)

		const delta = computeScoreDelta(captured, state, scoringBlock, context)
		state.noProgressScore = clamp(state.noProgressScore + delta, 0, 100)
		state.completedExecutions += 1

		// Reflect the most recent evaluated execution (Requirement 2.4).
		state.tool = captured.tool
		state.normalizedArgsHash = captured.normalizedArgsHash
		state.resultHash = captured.resultHash
		state.cursor = captured.cursor
		state.target = captured.target
		state.errorClass = captured.errorClass
		state.workspaceChanged = captured.workspaceChanged
		state.todoChanged = captured.todoChanged
		state.resultChanged = captured.resultChanged
		state.cursorAdvanced = captured.cursorAdvanced

		// Bookkeeping for next-execution change detection (Requirements 3.7–3.11).
		state.prevExternalStateHash = context?.externalStateHash ?? state.prevExternalStateHash
		state.prevFailingTestCount = context?.failingTestCount ?? state.prevFailingTestCount
		state.prevFailingTestSetHash = context?.failingTestIds
			? fnv1a(stringify([...context.failingTestIds].sort()) ?? "")
			: state.prevFailingTestSetHash

		const band = deriveBand(state.noProgressScore)
		const result = bandToResult(band, captured.tool, state.completedExecutions)
		return { band, noProgressScore: state.noProgressScore, result }
	}

	/**
	 * Pre-execution gate (Requirements 6.2, 6.9, 8.5). Thin wrapper over the private
	 * {@link gate} method, preserving the existing single-arg `check(block)` signature
	 * so the sole runtime call site in `presentAssistantMessage.ts` needs no change.
	 *
	 * `taskId` defaults to a single implicit task when omitted, selecting that task's
	 * accumulated {@link IterationState}.
	 */
	public check(block: ToolUse, taskId?: string): ToolRepetitionCheckResult {
		const id = taskId ?? ProgressAwareLoopDetector.DEFAULT_TASK_ID
		return this.gate(id, block)
	}

	/**
	 * Core gating logic. Derives the band from the score accumulated by PRIOR
	 * completed executions, then applies the band semantics layered on top of the
	 * raw phase methods:
	 *
	 * - **Hysteresis (Requirement 6.6):** when the derived band is less severe than
	 *   `state.lastBand`, the score has crossed below the current band's lower
	 *   boundary; demote to the new band and cancel any pending higher-band
	 *   intervention not yet issued.
	 * - **Once-per-entry nudge (Requirement 6.4):** a nudge (or replanning) is
	 *   surfaced only once per entry into that band. If we are still in the band we
	 *   already surfaced (`state.lastBand === band`), allow execution instead of
	 *   re-nudging.
	 * - **Hard-stop precondition (Requirements 6.7, 6.8, 8.1):** a hard stop is only
	 *   surfaced once `completedExecutions >= 2`. Below that, the hard stop is
	 *   withheld and execution continues.
	 * - **Reset after hard stop (Requirement 6.9):** when a hard stop IS surfaced,
	 *   the task's accumulated score and intervention state are reset so the user can
	 *   guide the model past the condition without being immediately re-blocked.
	 *
	 * `beforeTool` is called to capture the pending pre-execution inputs; its raw
	 * band result is recomputed here with the gating semantics applied.
	 */
	private gate(id: string, block: ToolUse): ToolRepetitionCheckResult {
		// Capture pending pre-execution inputs for the matching recordResult step.
		this.beforeTool(block, id)
		return this.gateByName(id, String(block.name))
	}

	/**
	 * Band-gating logic shared by {@link gate} (executed tools, which first run
	 * {@link beforeTool}) and {@link recordNoToolTurn} (tool-less turns, which have no
	 * `ToolUse` block and no pending pre-execution inputs to capture). Keyed by a plain
	 * tool-name string so a synthetic turn needs no fabricated `ToolUse`. All hysteresis,
	 * once-per-entry nudge, hard-stop precondition, and reset semantics live here.
	 */
	private gateByName(id: string, toolName: string): ToolRepetitionCheckResult {
		const state = this.getState(id)

		const band = deriveBand(state.noProgressScore)

		// Hysteresis: a less-severe band than last time means the score dropped below
		// the prior band's lower boundary; demote and cancel any pending intervention.
		if (BAND_SEVERITY[band] < BAND_SEVERITY[state.lastBand]) {
			state.pendingIntervention = undefined
			state.lastBand = band
		}

		switch (band) {
			case "continue":
				state.lastBand = "continue"
				return { allowExecution: true }

			case "nudge":
				// Once-per-entry: a nudge was already issued for this band entry.
				if (state.lastBand === "nudge") return { allowExecution: true }
				state.lastBand = "nudge"
				// Issuing a new nudge: emit the nudge metric (Requirement 9.1).
				this.emitNudge(toolName, state.noProgressScore)
				return bandToResult("nudge", toolName, state.completedExecutions)

			case "replanning":
				// Once-per-entry: replanning guidance was already issued for this entry.
				if (state.lastBand === "replanning") return { allowExecution: true }
				state.lastBand = "replanning"
				// Replanning reuses the nudge channel, so it emits a nudge metric (Requirement 9.1).
				this.emitNudge(toolName, state.noProgressScore)
				return bandToResult("replanning", toolName, state.completedExecutions)

			case "hard_stop": {
				// Hard-stop precondition: require at least two completed executions.
				if (state.completedExecutions < 2) {
					state.lastBand = "hard_stop"
					return { allowExecution: true }
				}
				// Capture the score BEFORE the reset so the stop metric reflects the score at the
				// time of the hard stop (>= 14), not the post-reset 0 (Requirement 9.2).
				const scoreBeforeReset = state.noProgressScore
				// Surface the hard stop, then reset so the user can guide the model past it.
				const result = bandToResult("hard_stop", toolName, state.completedExecutions)
				this.emitStop(toolName, scoreBeforeReset)
				state.noProgressScore = 0
				state.completedExecutions = 0
				state.lastBand = "continue"
				state.pendingIntervention = undefined
				return result
			}
		}
	}

	/**
	 * Post-execution signal capture and scoring (Requirements 1.3, 1.4). Thin
	 * wrapper that runs `afterTool` to capture the observable signals for this
	 * completed execution, then `evaluateProgress` to update the score and band for
	 * the next gate.
	 *
	 * `taskId` defaults to the same implicit task as `check()` when omitted.
	 */
	public recordResult(
		block: ToolUse,
		result: ToolExecutionResult,
		context: ToolResultContext,
		taskId?: string,
	): void {
		const id = taskId ?? ProgressAwareLoopDetector.DEFAULT_TASK_ID
		const captured = this.afterTool(block, result, context, id)
		this.evaluateProgress(id, captured, block, context)
	}

	/**
	 * Records a turn that produced NO tool call (the model emitted only text/reasoning,
	 * or an empty response). The host's `switch (block.name)` dispatch never runs for
	 * such a turn, so `recordResult()` is never reached and the detector would otherwise
	 * be blind to the empty-response retry churn. This feeds a synthetic `no_tool_use`
	 * stagnation signal through the same scoring path so repeated tool-less turns escalate
	 * through the normal nudge → replanning → hard_stop bands.
	 *
	 * Returns the GATE decision to surface for the NEXT turn, derived from the score
	 * accumulated so far (including this tool-less turn). The caller may use the result's
	 * `askUser` to escalate a persistent empty-response loop to the user; `nudge`/`continue`
	 * can be treated as "retry". `taskId` defaults to the implicit task as elsewhere.
	 */
	public recordNoToolTurn(taskId?: string): ToolRepetitionCheckResult {
		const id = taskId ?? ProgressAwareLoopDetector.DEFAULT_TASK_ID
		const state = this.getState(id)

		// A tool-less turn carries exactly one stagnation signal and no progress; feed it
		// through evaluateProgress with a synthetic captured-signal set so the score, band,
		// and bookkeeping advance identically to a stalled tool execution.
		const captured: CapturedSignals = {
			tool: "__no_tool_use__",
			normalizedArgsHash: state.normalizedArgsHash,
			resultHash: state.resultHash,
			cursor: state.cursor,
			target: state.target,
			errorClass: state.errorClass,
			progress: [],
			stagnation: ["no_tool_use"],
			workspaceChanged: false,
			todoChanged: false,
			resultChanged: false,
			cursorAdvanced: false,
		}
		// evaluateProgress updates the score/band; the return value is unused here because
		// the gate below re-reads the freshly-updated score to apply the shared band semantics.
		void this.evaluateProgress(id, captured)

		// Surface interventions through the same hysteresis / once-per-entry / hard-stop
		// precondition machinery used by executed tools, so empty-response escalation
		// behaves consistently.
		return this.gateByName(id, "__no_tool_use__")
	}

	/**
	 * Emits a nudge metric (Requirement 9.1) when a nudge or replanning intervention is
	 * surfaced. Sink failures are swallowed so a throwing metrics sink can never break
	 * tool dispatch (Error Handling: Metrics sink failures).
	 */
	private emitNudge(toolName: string, noProgressScore: number): void {
		try {
			this.metrics?.emitNudge({ toolName, noProgressScore })
		} catch {
			// Metric emission must never break tool dispatch (Error Handling: Metrics sink failures).
		}
	}

	/**
	 * Emits a stop metric (Requirement 9.2) when a hard stop is surfaced. Sink failures are
	 * swallowed so a throwing metrics sink can never break tool dispatch.
	 */
	private emitStop(toolName: string, noProgressScore: number): void {
		try {
			this.metrics?.emitStop({ toolName, noProgressScore })
		} catch {
			// Metric emission must never break tool dispatch.
		}
	}
}

/**
 * Compatibility alias so existing import sites (`Task.ts`) keep resolving without
 * a rename. The `ToolRepetitionCheckResult` type is already exported above.
 */
export { ProgressAwareLoopDetector as ToolRepetitionDetector }
