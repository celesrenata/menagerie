import * as vscode from "vscode"
import { z } from "zod"
import { workerReasoningPolicySchema, verificationPolicySchema } from "@roo-code/types"
import { Task } from "../task/Task"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { getModeBySlug } from "../../shared/modes"
import { Package } from "../../shared/package"
import { runParallelTasks } from "../task/runParallelTasks"
import { addSharedDocumentReader } from "../task/ParallelTaskReader"
import { BoundedElasticScheduler } from "../task/BoundedElasticScheduler"
import {
	DEFAULT_SCHEDULER_BOUNDS,
	type ExecutionPlan,
	type RouteCapability,
	type RouteCapacity,
	type RouteCapacityProvider,
	type UserParallelismPolicy,
} from "../task/elasticTypes"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { formatResponse } from "../prompts/responses"
import { ParallelTasksArgumentError } from "./parallelTasksErrors"
import type { ToolCapabilityId } from "../capability/toolCapability"

/**
 * A DAG node's declared tool-capability requirement for the Dynamic Capability
 * Broker (FEAT-013). This rides ADDITIVELY on a {@link ParallelTaskSpec}: the
 * `required` set is provisioned before the worker's first generation (MCP-016),
 * `optionalHints` names capabilities the worker is likely to acquire lazily
 * in-execution (MCP-017), and `scopeHints` carries best-effort scope tokens per
 * capability (e.g. `{ "cluster.deploy": ["namespace=nervecenter"] }`).
 *
 * `parallelTaskSpecSchema` now carries `capabilities` as an OPTIONAL member (see
 * {@link nodeCapabilityRequirementSchema}), so the field SURVIVES validation and
 * the provisioning path reads it from the validated spec; legacy specs with no
 * capability metadata still validate (optional = absent is fine) and provision
 * an empty set. {@link readNodeCapabilityRequirement} also accepts a RAW
 * pre-validation spec, so both the validated and raw forms yield the same
 * requirement.
 */
export interface NodeCapabilityRequirement {
	/** Provisioned (policy-permitting) before the worker's first generation. */
	required: ToolCapabilityId[]
	/** Likely lazy in-execution acquisitions; a hint only, never auto-granted. */
	optionalHints?: ToolCapabilityId[]
	/** Best-effort scope tokens keyed by capability id. */
	scopeHints?: Record<string, string[]>
}

/**
 * The capability field riding on {@link ParallelTaskSpec}. Declared as its own
 * interface so consumers can refer to the shape without re-deriving it. The zod
 * schema now carries `capabilities` as an OPTIONAL member (see
 * {@link nodeCapabilityRequirementSchema}), so the field survives validation and
 * provisioning fires; this interface stays the authoritative hand-written shape
 * and is intersected into the exported `ParallelTaskSpec` so `capabilities`
 * resolves to exactly `NodeCapabilityRequirement | undefined` (the schema's
 * inferred `required: string[]` is assignable to `ToolCapabilityId[]` because
 * `ToolCapabilityId` keeps `(string & {})` open).
 */
export interface ParallelTaskSpecCapabilities {
	capabilities?: NodeCapabilityRequirement
}

/**
 * A single tool-capability id as it rides on a raw spec: a non-empty string.
 * The hand-written {@link ToolCapabilityId} keeps `(string & {})` open, so a
 * validated `string` is assignable to it (and vice versa); this schema only
 * enforces non-emptiness, leaving the namespaced vocabulary to the broker.
 */
const toolCapabilityIdSchema = z.string().min(1)

/**
 * OPTIONAL zod schema for a {@link NodeCapabilityRequirement} riding on a spec.
 * It is included in {@link parallelTaskSpecSchema} as an optional member so the
 * `capabilities` field SURVIVES validation (previously `.strip()` dropped it,
 * so provisioning never fired), while legacy specs with no capabilities still
 * validate — optional means absent is fine. `required` defaults to `[]` so a
 * present-but-partial requirement still yields a usable set; `.strip()` keeps
 * any stray inner key from rejecting the spec.
 */
const nodeCapabilityRequirementSchema = z
	.object({
		required: z.array(toolCapabilityIdSchema).default([]),
		optionalHints: z.array(toolCapabilityIdSchema).optional(),
		scopeHints: z.record(z.string(), z.array(z.string())).optional(),
	})
	.strip()

export const parallelTaskSpecSchema = z
	.object({
		name: z.string().min(1).max(80),
		mode: z.string().min(1),
		message: z.string().min(1).max(120_000),
		todos: z.string().nullable().optional(),
		// Optional per-worker OmniRoute model/route id (or custom-route name). Placement still
		// resolves in OmniRoute; menagerie only passes the selected id through (design §5.2).
		route: z.string().min(1).max(200).nullable().optional(),
		// Optional cognition metadata (design §FEAT-006/§FEAT-008). The mastermind expresses the
		// reasoning budget/bias and verification intent; OmniRoute still schedules the silicon.
		reasoning: workerReasoningPolicySchema.optional(),
		verification: verificationPolicySchema.optional(),
		// Optional capability requirement (FEAT-013, MCP-016). Preserved through validation so
		// `readNodeCapabilityRequirement` finds it and `setUpWorkerBroker` provisions the
		// required set before the worker's first generation. Absent for legacy/reader specs.
		capabilities: nodeCapabilityRequirementSchema.optional(),
	})
	// `.strip()` (not `.strict()`) for the transition release so a stray legacy
	// `routing_tier`/`routing_reason` on a worker spec is dropped rather than rejected (design §7).
	.strip()

/**
 * The elastic batch ceiling: the live-worker bound (`maxLive`), clamped by the
 * `User_Parallelism_Policy.maxLive` ceiling supplied for the exact submitted
 * request (design §"ParallelTasksTool and runParallelTasks"; PAR-003.2,
 * PAR-014.1). Replaces the former fixed `.max(4)` cap. An absent/invalid policy
 * ceiling leaves the scheduler default (`DEFAULT_SCHEDULER_BOUNDS.maxLive`, 12)
 * in effect; a positive policy ceiling tightens, never raises, the bound.
 */
export function resolveParallelTasksMax(policy?: UserParallelismPolicy): number {
	const ceiling = policy?.maxLive
	if (typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 1) {
		return Math.min(DEFAULT_SCHEDULER_BOUNDS.maxLive, Math.floor(ceiling))
	}
	return DEFAULT_SCHEDULER_BOUNDS.maxLive
}

/**
 * Build the `parallel_tasks` argument validator bounded by the elastic live
 * ceiling for a specific request. Keeps `.strict()` on the batch, `.strip()` on
 * each spec (via {@link parallelTaskSpecSchema}), and the unique-name
 * `.refine`; only the upper bound on `tasks` is elasticized.
 */
export function makeParallelTasksSchema(maxLive: number = DEFAULT_SCHEDULER_BOUNDS.maxLive) {
	return z
		.object({
			tasks: z.array(parallelTaskSpecSchema).min(1).max(maxLive),
		})
		.strict()
		.refine(
			({ tasks }) => new Set(tasks.map((task) => task.name)).size === tasks.length,
			"Task names must be unique",
		)
}

/**
 * Default `parallel_tasks` validator bounded by the scheduler default live
 * ceiling (`DEFAULT_SCHEDULER_BOUNDS.maxLive`). `execute` rebuilds a
 * policy-clamped schema at request time via {@link makeParallelTasksSchema}.
 */
export const parallelTasksSchema = makeParallelTasksSchema()

/**
 * The validated per-worker spec. The shape is inferred from
 * {@link parallelTaskSpecSchema} (which now includes the optional
 * `capabilities` member, so a `capabilities` requirement survives validation
 * and rides alongside every pre-existing field). The intersection with
 * {@link ParallelTaskSpecCapabilities} keeps that interface the authoritative
 * hand-written shape, narrowing the inferred `capabilities` to exactly
 * `NodeCapabilityRequirement | undefined`. {@link readNodeCapabilityRequirement}
 * still reads from the RAW input so a pre-validation spec is also supported.
 */
export type ParallelTaskSpec = z.infer<typeof parallelTaskSpecSchema> & ParallelTaskSpecCapabilities

/**
 * Extract a {@link NodeCapabilityRequirement} from a spec input. Accepts either
 * the validated spec (which now preserves `capabilities`) or a RAW
 * pre-validation input. Returns `undefined` when the spec
 * carries no capability metadata (legacy specs → empty capability set, no
 * error) or when the metadata is malformed in a way that cannot yield a usable
 * `required` set. Only well-typed `required` ids survive; `optionalHints` and
 * `scopeHints` are passed through best-effort.
 */
export function readNodeCapabilityRequirement(rawSpec: unknown): NodeCapabilityRequirement | undefined {
	if (typeof rawSpec !== "object" || rawSpec === null) return undefined
	const capabilities = (rawSpec as Record<string, unknown>).capabilities
	if (typeof capabilities !== "object" || capabilities === null) return undefined
	const record = capabilities as Record<string, unknown>
	const required = Array.isArray(record.required)
		? record.required.filter((id): id is ToolCapabilityId => typeof id === "string" && id.length > 0)
		: []
	const optionalHints = Array.isArray(record.optionalHints)
		? record.optionalHints.filter((id): id is ToolCapabilityId => typeof id === "string" && id.length > 0)
		: undefined
	const scopeHints =
		typeof record.scopeHints === "object" && record.scopeHints !== null
			? (record.scopeHints as Record<string, string[]>)
			: undefined
	if (required.length === 0 && optionalHints === undefined && scopeHints === undefined) return undefined
	return {
		required,
		...(optionalHints !== undefined ? { optionalHints } : {}),
		...(scopeHints !== undefined ? { scopeHints } : {}),
	}
}

/**
 * A capability/capacity-only `RouteCapacityProvider` used solely to construct a
 * `BoundedElasticScheduler` for plan admission validation at request time.
 *
 * Admission (`admitPlan`) only compiles the plan into a `TaskDag` to reject
 * cyclic/duplicate/invalid plans recoverably; it never acquires an inference
 * lease, so the capacity numbers reported here are never consulted. The real
 * route-capacity source is wired when `runParallelTasks` is rehosted onto the
 * scheduler (task 11); until then this reports no live capacity and no
 * sustained pressure, which is correct for validation-only use.
 */
const ADMISSION_ONLY_ROUTES: RouteCapacityProvider = {
	capacitiesFor(_capability: RouteCapability): readonly RouteCapacity[] {
		return []
	},
	sustainedPressure(): number {
		return 0
	},
}

/**
 * Build the `ExecutionPlan` the scheduler admits from a validated, reader-fanned
 * task list. The `parallel_tasks` schema currently supplies only a flat task
 * list, so `parallelGroups`/`dependencies` are omitted (they are optional); when
 * the tool carries dependency info, this is where it is attached (design
 * §"ParallelTasksTool and runParallelTasks").
 */
export function buildExecutionPlan(tasks: ParallelTaskSpec[]): ExecutionPlan {
	return { tasks }
}

export const MAX_READER_PARENT_RESULT_CHARS = 2_400
export const MAX_WORKER_PARENT_RESULT_CHARS = 6_000
export const MAX_WORKER_PARENT_ERROR_CHARS = 2_000

type ParentParallelTaskResult = {
	name: string
	mode: string
	state: string
	taskId?: string
	profile?: string
	workspace?: string
	patch?: string
	result?: string
	error?: string
}

type ParentParallelTaskBatch = {
	batchId: string
	manifestPath?: string
	tasks: ParentParallelTaskResult[]
}

function clipParentResult(text: string, maxChars: number, manifestPath?: string): string {
	if (text.length <= maxChars) return text
	const location = manifestPath
		? ` Full result: ${manifestPath}`
		: " Full result retained in the parallel-task manifest."
	return `${text.slice(0, maxChars)}\n… [clipped ${text.length - maxChars} chars.${location}]`
}

/**
 * Bound what parallel workers can inject back into the coordinator context.
 * Full completion text remains persisted in each worker record and manifest.
 */
export function compactParallelTasksResultForParent(result: ParentParallelTaskBatch) {
	return {
		batchId: result.batchId,
		manifestPath: result.manifestPath,
		tasks: result.tasks.map((worker) => {
			const maxResultChars =
				worker.mode === "project-reader" ? MAX_READER_PARENT_RESULT_CHARS : MAX_WORKER_PARENT_RESULT_CHARS
			const resultClipped = worker.result !== undefined && worker.result.length > maxResultChars
			const errorClipped = worker.error !== undefined && worker.error.length > MAX_WORKER_PARENT_ERROR_CHARS
			return {
				...worker,
				...(worker.result !== undefined
					? {
							result: clipParentResult(worker.result, maxResultChars, result.manifestPath),
							resultChars: worker.result.length,
							resultClipped,
						}
					: {}),
				...(worker.error !== undefined
					? {
							error: clipParentResult(worker.error, MAX_WORKER_PARENT_ERROR_CHARS, result.manifestPath),
							errorChars: worker.error.length,
							errorClipped,
						}
					: {}),
			}
		}),
	}
}

/**
 * Physical-placement keys the mastermind must never originate (design §4, §15 —
 * "GLM schedules cognition; OmniRoute schedules silicon"). GPU/VRAM/CUDA device,
 * provider-specific thinking tokens, and physical node all belong to OmniRoute.
 * The only exception is a user-supplied `route` override, which pins placement
 * explicitly and is forwarded verbatim.
 *
 * These are matched against the RAW spec input, because `parallelTaskSpecSchema`
 * uses `.strip()` and would silently drop them before validation could see them.
 */
export const MASTERMIND_PLACEMENT_KEYS = [
	"gpu",
	"vram",
	"cuda",
	"cudaDevice",
	"device",
	"thinkingTokens",
	"provider-thinking-tokens",
	"providerThinkingTokens",
	"node",
	"physicalNode",
] as const

/**
 * Reject any mastermind-originated physical-placement selection on a raw spec that
 * lacks a user `route` override. Inspects the raw input (before `.strip()`), so
 * placement keys that validation would otherwise drop are still caught. A spec with
 * a `route` passes through verbatim: OmniRoute owns placement resolution.
 */
function rejectMastermindPhysicalPlacement(rawTasks: unknown): void {
	if (!Array.isArray(rawTasks)) return
	for (const rawTask of rawTasks) {
		if (typeof rawTask !== "object" || rawTask === null) continue
		const spec = rawTask as Record<string, unknown>
		// A user route override explicitly pins placement; forward it verbatim.
		if (typeof spec.route === "string" && spec.route.length > 0) continue
		const offending = MASTERMIND_PLACEMENT_KEYS.filter((key) => spec[key] !== undefined)
		if (offending.length === 0) continue
		const name = typeof spec.name === "string" && spec.name.length > 0 ? spec.name : "unnamed"
		throw new ParallelTasksArgumentError(
			`Task ${name} selects physical placement (${offending.join(", ")}), but the mastermind schedules ` +
				"cognition, not silicon: GPU/VRAM/CUDA device/thinking-token/node selection belongs to OmniRoute. " +
				"Express reasoning intent via `reasoning` instead, or supply a user `route` override to pin placement.",
		)
	}
}

/** Build the recoverable tool-error text for invalid parallel_tasks arguments. */
export function formatParallelTasksArgumentError(error: z.ZodError | Error): string {
	const problems =
		error instanceof z.ZodError
			? error.issues
					.map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
					.join("; ")
			: error.message
	return (
		"Invalid parallel_tasks arguments: provide at least one task, each with a unique name, mode, message, " +
		`todos (string or null) and route (string or null). Problems: ${problems}`
	)
}

export class ParallelTasksTool extends BaseTool<"parallel_tasks"> {
	readonly name = "parallel_tasks" as const

	/**
	 * The per-request `User_Parallelism_Policy` ceiling (FEAT-011). Absent until
	 * that feature wires the policy source, in which case the scheduler default
	 * live ceiling applies. A supplied policy only tightens the batch bound.
	 */
	readonly parallelismPolicy?: UserParallelismPolicy

	async execute(input: { tasks: ParallelTaskSpec[] }, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			// Guard before validation: `.strip()` would drop placement keys, so inspect the raw
			// input to reject mastermind-originated physical placement without a user route override.
			rejectMastermindPhysicalPlacement((input as { tasks?: unknown })?.tasks)
			// Bound the batch by the elastic live ceiling, clamped by the User_Parallelism_Policy for
			// this exact request (PAR-014.1). The policy source (FEAT-011) is absent for now, so the
			// scheduler default live ceiling (12) applies; a policy ceiling only tightens it.
			const requestSchema = makeParallelTasksSchema(resolveParallelTasksMax(this.parallelismPolicy))
			const parsed = requestSchema.safeParse(input)
			if (!parsed.success) throw parsed.error
			const { tasks: requestedTasks } = parsed.data
			task.parallelTaskArgumentRecovery.onValidCall()
			const provider = task.providerRef.deref()
			if (!provider) throw new Error("Provider reference lost")
			const state = await provider.getState()
			if (!state.experiments?.parallelTasks)
				throw new Error("Enable Parallel tasks in Experimental settings first")
			if (task.parallelWorker)
				throw new Error("Parallel workers must finish their own task without spawning more workers")
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)
			const tasks = await addSharedDocumentReader(
				requestedTasks,
				task.cwd,
				Boolean(getModeBySlug("project-reader", state.customModes)),
				requireTodos,
			)
			for (const spec of tasks) {
				if (!getModeBySlug(spec.mode, state.customModes))
					throw new ParallelTasksArgumentError(`Invalid mode: ${spec.mode}`)
				if (requireTodos && spec.todos == null)
					throw new ParallelTasksArgumentError(`Task ${spec.name} requires todos`)
				if (spec.todos) {
					try {
						parseMarkdownChecklist(spec.todos)
					} catch (error) {
						throw new ParallelTasksArgumentError(
							`Task ${spec.name} has invalid todos: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
				}
			}
			// Build the ExecutionPlan and admit it so cyclic/duplicate/invalid plans are rejected
			// recoverably before any worker is dispatched. `admitPlan` compiles the plan into a
			// TaskDag, which throws `ParallelTasksArgumentError` on a cycle, a duplicate task name,
			// or a dependency naming an unknown task; that flows through the recoverable catch below.
			// NOTE (task 11 seam): this constructs a throwaway scheduler purely to validate the plan;
			// `runParallelTasks` still owns dispatch for now. When runParallelTasks is rehosted onto
			// the scheduler, the admitted scheduler instance built here should be shared with it
			// instead of discarded, and the real RouteCapacityProvider wired in place of
			// ADMISSION_ONLY_ROUTES.
			const plan = buildExecutionPlan(tasks)
			const policy = this.parallelismPolicy ?? {}
			const scheduler = new BoundedElasticScheduler(
				{ ...DEFAULT_SCHEDULER_BOUNDS, maxInferenceLeases: DEFAULT_SCHEDULER_BOUNDS.maxDispatched },
				policy,
				ADMISSION_ONLY_ROUTES,
			)
			scheduler.admitPlan(plan)
			const approved = await callbacks.askApproval(
				"tool",
				JSON.stringify({
					tool: "newTask",
					mode: "Parallel tasks",
					content: tasks
						.map(
							(spec) =>
								`${spec.name} (${spec.mode}${spec.route ? `, ${spec.route}` : ""})\n${spec.message}`,
						)
						.join("\n\n"),
				}),
			)
			if (!approved) return
			const result = await runParallelTasks(task, provider, tasks)
			callbacks.pushToolResult(JSON.stringify(compactParallelTasksResultForParent(result)))
		} catch (error) {
			// Argument problems are recoverable: report them to the model as a tool error so it can
			// retry with a valid batch of tasks, instead of surfacing a fatal user-facing error.
			if (error instanceof z.ZodError || error instanceof ParallelTasksArgumentError) {
				if (error instanceof z.ZodError) task.parallelTaskArgumentRecovery.onMalformedCall()
				task.consecutiveMistakeCount++
				task.recordToolError("parallel_tasks")
				task.didToolFailInCurrentTurn = true
				callbacks.pushToolResult(formatResponse.toolError(formatParallelTasksArgumentError(error)))
				return
			}
			task.didToolFailInCurrentTurn = true
			await callbacks.handleError(
				"running parallel tasks",
				error instanceof Error ? error : new Error(String(error)),
			)
		}
	}
}

export const parallelTasksTool = new ParallelTasksTool()
