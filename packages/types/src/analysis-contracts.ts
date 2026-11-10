import { z } from "zod"

/**
 * Shared contracts for the pure-analysis executor (MEN-GRANITE-SDD-001).
 *
 * The analysis executor is a bounded, non-streaming, tool-less JSON transformer over
 * evidence that tool-capable workers / retrieval already selected. These schemas are the
 * only boundary between model text and the rest of Menagerie: nothing a model returns is
 * trusted until it parses here AND its citations are verified against the request.
 */

export const ANALYSIS_SCHEMA_VERSION = 1 as const

export const ANALYSIS_OPERATIONS = [
	"extract-requirements",
	"extract-code-contract",
	"summarize-evidence",
	"find-contradictions",
	"classify-change-risk",
	"map-acceptance-to-tests",
	"triage-test-failure",
	"review-diff-against-criteria",
] as const

export const analysisOperationSchema = z.enum(ANALYSIS_OPERATIONS)
export type AnalysisOperation = z.infer<typeof analysisOperationSchema>

/** Hard caps. They bound parsing work and parent-visible size independent of model behaviour. */
export const ANALYSIS_LIMITS = {
	maxEvidenceItems: 24,
	maxExcerptChars: 12_000,
	maxPathChars: 512,
	maxFindings: 32,
	maxClaimChars: 1_000,
	maxTextFieldChars: 1_000,
	maxAnchorIdsPerFinding: 8,
	maxUnknowns: 16,
	maxOutputTokens: 1_024,
} as const

const boundedText = z.string().min(1).max(ANALYSIS_LIMITS.maxTextFieldChars)

/** A location in a workspace file, pinned to the content digest it was read at. */
export const evidenceAnchorSchema = z
	.object({
		workspaceUri: z.string().min(1).max(ANALYSIS_LIMITS.maxPathChars),
		repositoryRevision: z.string().min(1).max(128).optional(),
		/** Workspace-relative POSIX path. Absolute paths and `..` segments are rejected. */
		path: z.string().min(1).max(ANALYSIS_LIMITS.maxPathChars),
		fileDigest: z.string().min(1).max(128),
		startLine: z.number().int().min(1),
		endLine: z.number().int().min(1),
	})
	.strict()
	.refine((a) => a.endLine >= a.startLine, { message: "endLine must be >= startLine", path: ["endLine"] })
export type EvidenceAnchor = z.infer<typeof evidenceAnchorSchema>

export const analysisEvidenceItemSchema = z
	.object({
		/** Stable id the model cites. Assigned by Menagerie, never by the model. */
		anchorId: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_.-]+$/),
		anchor: evidenceAnchorSchema,
		excerpt: z.string().max(ANALYSIS_LIMITS.maxExcerptChars),
	})
	.strict()
export type AnalysisEvidenceItem = z.infer<typeof analysisEvidenceItemSchema>

export const analysisRequestSchema = z
	.object({
		requestId: z.string().min(1).max(128),
		operation: analysisOperationSchema,
		specRevisionId: z.string().min(1).max(128).optional(),
		/** Vote index. Part of the cache digest so independent votes are never served from one cache entry. */
		sample: z.number().int().min(0).max(9).optional(),
		evidence: z.array(analysisEvidenceItemSchema).min(1).max(ANALYSIS_LIMITS.maxEvidenceItems),
		instructionsVersion: z.string().min(1).max(64),
		schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
		maxOutputTokens: z.number().int().min(1).max(ANALYSIS_LIMITS.maxOutputTokens),
	})
	.strict()
	.superRefine((req, ctx) => {
		const seen = new Set<string>()
		req.evidence.forEach((item, index) => {
			if (seen.has(item.anchorId)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `duplicate anchorId ${item.anchorId}`,
					path: ["evidence", index, "anchorId"],
				})
			}
			seen.add(item.anchorId)
		})
	})
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>

export const analysisFindingSchema = z
	.object({
		claim: z.string().min(1).max(ANALYSIS_LIMITS.maxClaimChars),
		/** Ids from the request's evidence list. Verified by the validator, not trusted here. */
		anchorIds: z.array(z.string().min(1).max(64)).max(ANALYSIS_LIMITS.maxAnchorIdsPerFinding),
		/** A model self-report. NEVER a calibrated probability. */
		confidence: z.number().min(0).max(1).optional(),
		uncertainty: boundedText.optional(),
		recommendation: boundedText.optional(),
	})
	.strict()
export type AnalysisFinding = z.infer<typeof analysisFindingSchema>

export const ANALYSIS_RISK_LEVELS = ["low", "medium", "high", "unknown"] as const

/** What the model is asked to return: one JSON object, nothing else. */
export const analysisModelResponseSchema = z
	.object({
		findings: z.array(analysisFindingSchema).max(ANALYSIS_LIMITS.maxFindings),
		unknowns: z.array(boundedText).max(ANALYSIS_LIMITS.maxUnknowns).optional(),
		risk: z.enum(ANALYSIS_RISK_LEVELS).optional(),
	})
	.strict()
export type AnalysisModelResponse = z.infer<typeof analysisModelResponseSchema>

/** Per-operation refinements on top of the common response shape. */
export const OPERATIONS_REQUIRING_RISK: ReadonlySet<AnalysisOperation> = new Set(["classify-change-risk"])
/** Contradictions need at least two sources; one anchor cannot contradict itself. */
export const OPERATIONS_REQUIRING_MULTI_ANCHOR: ReadonlySet<AnalysisOperation> = new Set(["find-contradictions"])

export const ANALYSIS_FAILURE_KINDS = [
	"unavailable",
	"rate-limited",
	"queue-full",
	"oversize",
	"non-json",
	"invalid-schema",
	"stale-evidence",
	"timeout",
	"cancelled",
] as const
export const analysisFailureKindSchema = z.enum(ANALYSIS_FAILURE_KINDS)
export type AnalysisFailureKind = z.infer<typeof analysisFailureKindSchema>

export const analysisOutcomeSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("valid"),
			requestId: z.string().min(1),
			operation: analysisOperationSchema,
			findings: z.array(analysisFindingSchema).max(ANALYSIS_LIMITS.maxFindings),
			unknowns: z.array(z.string()).max(ANALYSIS_LIMITS.maxUnknowns),
			risk: z.enum(ANALYSIS_RISK_LEVELS).optional(),
			/** Derived by Menagerie from canonical inputs. Never supplied by the model. */
			digest: z.string().regex(/^[a-f0-9]{64}$/),
			modelId: z.string().min(1),
			/** True when a format retry was needed. The first failure is kept in `attempts`. */
			retried: z.boolean(),
		})
		.strict(),
	z
		.object({
			kind: analysisFailureKindSchema,
			requestId: z.string().min(1),
			reason: z.string().min(1).max(ANALYSIS_LIMITS.maxTextFieldChars),
		})
		.strict(),
])

export type AnalysisValidOutcome = {
	kind: "valid"
	requestId: string
	operation: AnalysisOperation
	findings: AnalysisFinding[]
	unknowns: string[]
	risk?: (typeof ANALYSIS_RISK_LEVELS)[number]
	digest: string
	modelId: string
	retried: boolean
}
export type AnalysisFailureOutcome = { kind: AnalysisFailureKind; requestId: string; reason: string }
export type AnalysisOutcome = AnalysisValidOutcome | AnalysisFailureOutcome
