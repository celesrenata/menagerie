import { z } from "zod"
import { DynamicProvider, LocalProvider } from "./provider-settings.js"

/**
 * ReasoningEffort
 */

export const reasoningEfforts = ["low", "medium", "high"] as const

export const reasoningEffortsSchema = z.enum(reasoningEfforts)

export type ReasoningEffort = z.infer<typeof reasoningEffortsSchema>

/**
 * ReasoningEffortWithMinimal
 */

export const reasoningEffortWithMinimalSchema = z.union([reasoningEffortsSchema, z.literal("minimal")])

export type ReasoningEffortWithMinimal = z.infer<typeof reasoningEffortWithMinimalSchema>

/**
 * Extended Reasoning Effort (includes "none" and "minimal")
 * Note: "disable" is a UI/control value, not a value sent as effort
 */
export const reasoningEffortsExtended = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export const reasoningEffortExtendedSchema = z.enum(reasoningEffortsExtended)

export type ReasoningEffortExtended = z.infer<typeof reasoningEffortExtendedSchema>

/**
 * Orchestration Reasoning Effort (normalized subset used by the GLM mastermind)
 *
 * This is a strict subset of reasoningEffortsExtended; mapNormalizedToExtended is
 * total and identity-on-shared-members.
 */
export const orchestrationReasoningEfforts = ["minimal", "low", "medium", "high", "max"] as const

export const orchestrationReasoningEffortSchema = z.enum(orchestrationReasoningEfforts)

export type OrchestrationReasoningEffort = z.infer<typeof orchestrationReasoningEffortSchema>

/**
 * Map a normalized orchestration reasoning effort to an extended reasoning effort.
 * Total mapping — every normalized value yields a valid ReasoningEffortExtended value.
 */
export function mapNormalizedToExtended(value: OrchestrationReasoningEffort): ReasoningEffortExtended {
	// All five normalized members are already members of reasoningEffortsExtended.
	return value
}

/** Rank used for ordering comparisons (maxEffort >= effort, used >= requested). */
export const orchestrationReasoningRank: Record<OrchestrationReasoningEffort, number> = {
	minimal: 0,
	low: 1,
	medium: 2,
	high: 3,
	max: 4,
}

/**
 * WorkerReasoningPolicy
 *
 * Reasoning intent attached to a delegated worker. The required `effort` expresses
 * the baseline cognition budget; `adaptive`/`maxEffort` govern escalation and
 * `priority` biases translation. Rejects a `maxEffort` ranked below `effort`.
 */
export const workerReasoningPriorities = ["latency", "balanced", "quality"] as const

export const workerReasoningPolicySchema = z
	.object({
		effort: orchestrationReasoningEffortSchema,
		adaptive: z.boolean().optional(),
		maxEffort: orchestrationReasoningEffortSchema.optional(),
		priority: z.enum(workerReasoningPriorities).optional(),
	})
	.superRefine((policy, ctx) => {
		if (
			policy.maxEffort !== undefined &&
			orchestrationReasoningRank[policy.maxEffort] < orchestrationReasoningRank[policy.effort]
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `maxEffort (${policy.maxEffort}) must be >= effort (${policy.effort})`,
				path: ["maxEffort"],
			})
		}
	})

export type WorkerReasoningPolicy = z.infer<typeof workerReasoningPolicySchema>

/**
 * Resolves the escalation ceiling for a worker reasoning policy.
 * When `adaptive` is set without a `maxEffort`, the requested `effort` is the ceiling.
 */
export function resolveEffortCeiling(policy: WorkerReasoningPolicy): OrchestrationReasoningEffort {
	return policy.maxEffort ?? policy.effort
}

/**
 * EvidenceReference
 *
 * A pointer to verifiable support for a worker result or task-state entry.
 * `lines` is an optional [start, end] tuple; `result` is an optional outcome string.
 */
export const evidenceReferenceSchema = z.object({
	type: z.enum(["file", "test", "command", "url", "screenshot"]),
	reference: z.string(),
	lines: z.tuple([z.number(), z.number()]).optional(),
	result: z.string().optional(),
})

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>

/**
 * Finding
 *
 * A single claim produced by a worker, with an optional confidence score.
 */
export const findingSchema = z.object({
	claim: z.string(),
	confidence: z.number().optional(),
})

export type Finding = z.infer<typeof findingSchema>

/**
 * WorkerResult
 *
 * The bounded, structured contract a worker returns. Array fields are always present;
 * the optional `reasoning` telemetry reports requested vs. used effort and escalation count.
 */
export const workerResultSchema = z.object({
	status: z.enum(["completed", "failed", "blocked"]),
	summary: z.string(),
	findings: z.array(findingSchema),
	evidence: z.array(evidenceReferenceSchema),
	changes: z.array(z.string()),
	tests: z.array(z.string()),
	blockers: z.array(z.string()),
	artifacts: z.array(z.string()),
	reasoning: z
		.object({
			requested: orchestrationReasoningEffortSchema,
			used: orchestrationReasoningEffortSchema,
			escalations: z.number().int().nonnegative(),
		})
		.optional(),
})

export type WorkerResult = z.infer<typeof workerResultSchema>

/**
 * VerificationPolicy
 *
 * The mastermind's request for independent verification on a task. `required` gates parent
 * success through a verifier role; `criteria`, when supplied, yields one pass/fail evidence
 * entry per criterion.
 */
export const verificationPolicySchema = z.object({
	required: z.boolean(),
	mode: z.string().optional(),
	criteria: z.array(z.string()).optional(),
})

export type VerificationPolicy = z.infer<typeof verificationPolicySchema>

/**
 * TaskKind
 *
 * The categories of delegated work that drive recommended verification defaults.
 */
export type TaskKind = "read-only" | "code-modification" | "deployment" | "migration-destructive"

/**
 * Recommended verification posture by task kind (Requirement 10):
 * read-only analysis is optional, code modification is recommended, and deployment or
 * migration/destructive infrastructure changes are required.
 */
export function defaultVerificationFor(kind: TaskKind): "optional" | "recommended" | "required" {
	switch (kind) {
		case "read-only":
			return "optional"
		case "code-modification":
			return "recommended"
		case "deployment":
		case "migration-destructive":
			return "required"
	}
}

/**
 * AutonomousTaskState
 *
 * The authoritative, structured task-state object maintained out-of-band from the
 * conversational transcript. It accumulates the objective, constraints, decisions,
 * assumptions, work status, touched files, blockers, open questions, next actions,
 * and verifiable evidence (reusing the shared `evidenceReferenceSchema`), and survives
 * `condenseContext` so a read after condensation returns the preserved state rather than
 * a reconstruction from the transcript.
 */
export const autonomousTaskStateSchema = z.object({
	objective: z.string(),
	constraints: z.array(z.string()),
	decisions: z.array(z.string()),
	assumptions: z.array(z.string()),
	activeWork: z.array(z.string()),
	completedWork: z.array(z.string()),
	filesTouched: z.array(z.string()),
	blockers: z.array(z.string()),
	openQuestions: z.array(z.string()),
	evidence: z.array(evidenceReferenceSchema),
	nextActions: z.array(z.string()),
})

export type AutonomousTaskState = z.infer<typeof autonomousTaskStateSchema>

/**
 * Reasoning Effort user setting (includes "disable")
 */
export const reasoningEffortSettingValues = [
	"disable",
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const
export const reasoningEffortSettingSchema = z.enum(reasoningEffortSettingValues)

/**
 * Verbosity
 */

export const verbosityLevels = ["low", "medium", "high"] as const

export const verbosityLevelsSchema = z.enum(verbosityLevels)

export type VerbosityLevel = z.infer<typeof verbosityLevelsSchema>

/** Serialized service tier field used in provider request payloads and responses. */
export const SERVICE_TIER_KEY = "service_tier"

/**
 * Service tiers for the public OpenAI Responses API.
 */
export const OpenAiServiceTier = {
	Default: "default",
	Flex: "flex",
	Priority: "priority",
} as const

export const serviceTiers = [OpenAiServiceTier.Default, OpenAiServiceTier.Flex, OpenAiServiceTier.Priority] as const
export const serviceTierSchema = z.enum(serviceTiers)
export type ServiceTier = z.infer<typeof serviceTierSchema>

/**
 * Service tiers for Codex requests authenticated through a ChatGPT subscription.
 */
export const OpenAiCodexServiceTier = {
	Default: "default",
	Priority: "priority",
} as const

export const openAiCodexServiceTiers = [OpenAiCodexServiceTier.Default, OpenAiCodexServiceTier.Priority] as const
export const openAiCodexServiceTierSchema = z.enum(openAiCodexServiceTiers)
export type OpenAiCodexServiceTier = z.infer<typeof openAiCodexServiceTierSchema>

/**
 * ModelParameter
 */

export const modelParameters = ["max_tokens", "temperature", "reasoning", "include_reasoning"] as const

export const modelParametersSchema = z.enum(modelParameters)

export type ModelParameter = z.infer<typeof modelParametersSchema>

export const isModelParameter = (value: string): value is ModelParameter =>
	modelParameters.includes(value as ModelParameter)

/**
 * ModelInfo
 */

export const modelInfoSchema = z.object({
	maxTokens: z.number().nullish(),
	maxThinkingTokens: z.number().nullish(),
	contextWindow: z.number(),
	supportsImages: z.boolean().optional(),
	supportsPromptCache: z.boolean(),
	// Optional default prompt cache retention policy for providers that support it.
	// When set to "24h", extended prompt caching will be requested; when omitted
	// or set to "in_memory", the default in‑memory cache is used.
	promptCacheRetention: z.enum(["in_memory", "24h"]).optional(),
	// Capability flag to indicate whether the model supports an output verbosity parameter
	supportsVerbosity: z.boolean().optional(),
	// Capability flag to indicate whether the model exposes a user-configurable max output
	// tokens control in settings. When set, the settings UI surfaces a slider that persists
	// `modelMaxTokens`; when the user leaves it unset, the default output clamp is used.
	supportsMaxTokens: z.boolean().optional(),
	supportsReasoningBudget: z.boolean().optional(),
	// Capability flag to indicate whether the model supports simple on/off binary reasoning
	supportsReasoningBinary: z.boolean().optional(),
	// Capability flag to indicate whether the model supports temperature parameter
	supportsTemperature: z.boolean().optional(),
	defaultTemperature: z.number().optional(),
	requiredReasoningBudget: z.boolean().optional(),
	supportsReasoningEffort: z
		.union([z.boolean(), z.array(z.enum(["disable", "none", "minimal", "low", "medium", "high", "xhigh", "max"]))])
		.optional(),
	requiredReasoningEffort: z.boolean().optional(),
	preserveReasoning: z.boolean().optional(),
	// Some OpenAI-compatible gateways require a Responses-backed route for tool calls.
	requiresResponsesApi: z.boolean().optional(),
	supportedParameters: z.array(modelParametersSchema).optional(),
	inputPrice: z.number().optional(),
	outputPrice: z.number().optional(),
	cacheWritesPrice: z.number().optional(),
	cacheReadsPrice: z.number().optional(),
	longContextPricing: z
		.object({
			thresholdTokens: z.number(),
			inputPriceMultiplier: z.number().optional(),
			outputPriceMultiplier: z.number().optional(),
			cacheWritesPriceMultiplier: z.number().optional(),
			cacheReadsPriceMultiplier: z.number().optional(),
			appliesToServiceTiers: z.array(serviceTierSchema).optional(),
		})
		.optional(),
	description: z.string().optional(),
	displayName: z.string().optional(),
	// Default effort value for models that support reasoning effort
	reasoningEffort: reasoningEffortExtendedSchema.optional(),
	minTokensPerCachePoint: z.number().optional(),
	maxCachePoints: z.number().optional(),
	cachableFields: z.array(z.string()).optional(),
	// Flag to indicate if the model is deprecated and should not be used
	deprecated: z.boolean().optional(),
	// Flag to indicate if the model should hide vendor/company identity in responses
	isStealthModel: z.boolean().optional(),
	// Flag to indicate if the model is free (no cost)
	isFree: z.boolean().optional(),
	// Exclude specific native tools from being available (only applies to native protocol)
	// These tools will be removed from the set of tools available to the model
	excludedTools: z.array(z.string()).optional(),
	// Include specific native tools (only applies to native protocol)
	// These tools will be added if they belong to an allowed group in the current mode
	// Cannot force-add tools from groups the mode doesn't allow
	includedTools: z.array(z.string()).optional(),
	/**
	 * Service tiers with pricing information.
	 * Each tier can have a name (for OpenAI service tiers) and pricing overrides.
	 * The top-level input/output/cache* fields represent the default/standard tier.
	 */
	tiers: z
		.array(
			z.object({
				name: serviceTierSchema.optional(), // Service tier name (flex, priority, etc.)
				contextWindow: z.number(),
				inputPrice: z.number().optional(),
				outputPrice: z.number().optional(),
				cacheWritesPrice: z.number().optional(),
				cacheReadsPrice: z.number().optional(),
			}),
		)
		.optional(),
})

export type ModelInfo = z.infer<typeof modelInfoSchema>

export type ModelRecord = Record<string, ModelInfo>

export type RouterModels = Record<DynamicProvider | LocalProvider, ModelRecord>

export const routerModelsMessageTypes = [
	"flushRouterModels",
	"requestRouterModels",
	"routerModels",
	"singleRouterModelFetchResponse",
] as const

export const routerModelsMessageTypeSchema = z.enum(routerModelsMessageTypes)

export const RouterModelsMessageType = routerModelsMessageTypeSchema.enum

export type RouterModelsMessageType = z.infer<typeof routerModelsMessageTypeSchema>

export const allRouterModelsProvider = "all" as const
