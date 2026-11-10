import { z } from "zod"

/**
 * Executable spec contracts (MEN-GRANITE-SDD-001 R6, R8).
 *
 * A `SpecRevision` is IMMUTABLE persisted commitment: requirements, decisions, tasks,
 * acceptance criteria and the executable checks that decide them. Run results are NOT part
 * of a revision (a revision cannot be immutable and also collect evidence); they live in
 * `SpecEvidenceRecord`s keyed by `revisionId`.
 *
 * Evidence `source` deliberately has no model-generated member. A model can suggest links
 * and raise risks, but it cannot be recorded as the source of a PASS.
 */

export const SPEC_POLICIES = ["explore", "build", "strict"] as const
export const specPolicySchema = z.enum(SPEC_POLICIES)
export type SpecPolicy = z.infer<typeof specPolicySchema>

export const SPEC_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const specId = z.string().regex(SPEC_ID_PATTERN, "ids must be 1-64 chars: letters, digits, _ . -")

export const CHECK_KINDS = ["test", "lint", "typecheck", "integration", "inspection"] as const
export const checkKindSchema = z.enum(CHECK_KINDS)
export type CheckKind = z.infer<typeof checkKindSchema>

export const specRequirementSchema = z
	.object({
		id: specId,
		text: z.string().min(1).max(4_000),
		acceptanceIds: z.array(specId).max(64),
	})
	.strict()

export const specDecisionSchema = z
	.object({
		id: specId,
		rationale: z.string().min(1).max(4_000),
		requirementIds: z.array(specId).min(1).max(64),
	})
	.strict()

export const specTaskSchema = z
	.object({
		id: specId,
		summary: z.string().min(1).max(2_000),
		/** Task ids. */
		dependsOn: z.array(specId).max(64),
		requirementIds: z.array(specId).min(1).max(64),
		decisionIds: z.array(specId).max(64).default([]),
		acceptanceIds: z.array(specId).max(64),
		filesWrite: z.array(z.string().min(1).max(512)).max(256).optional(),
		filesRead: z.array(z.string().min(1).max(512)).max(256).optional(),
		/** Worker mode for dispatch (e.g. "code"). */
		mode: z.string().min(1).max(64).optional(),
	})
	.strict()

export const specAcceptanceSchema = z
	.object({
		id: specId,
		text: z.string().min(1).max(2_000),
		required: z.boolean(),
		evidenceKind: checkKindSchema,
		/** Id of an entry in `checks`. */
		checkRef: specId,
	})
	.strict()

export const specCheckSchema = z
	.object({
		id: specId,
		kind: checkKindSchema,
		/** argv, never a shell string. Required for every kind except `inspection`. */
		command: z.array(z.string().min(1).max(1_024)).min(1).max(64).optional(),
		/** Workspace-relative paths whose content determines this check's result. */
		inputs: z.array(z.string().min(1).max(512)).max(256).optional(),
	})
	.strict()

const specRevisionBase = z
	.object({
		specId,
		/** `sha256:<hex>` over the canonical content of this revision. Verified, never trusted. */
		revisionId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		parentRevisionId: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
		policy: specPolicySchema,
		/** Git revision or workspace digest the spec was authored against. */
		sourceRevision: z.string().min(1).max(128),
		requirements: z.array(specRequirementSchema).max(512),
		decisions: z.array(specDecisionSchema).max(512),
		tasks: z.array(specTaskSchema).max(512),
		acceptance: z.array(specAcceptanceSchema).max(1_024),
		checks: z.array(specCheckSchema).max(1_024),
	})
	.strict()

export const specRevisionSchema = specRevisionBase
export type SpecRevision = z.infer<typeof specRevisionSchema>
/** The content a `revisionId` is computed over. */
export type SpecRevisionContent = Omit<SpecRevision, "revisionId">

export const EVIDENCE_SOURCES = ["runner", "verifier-gate", "human"] as const
export const evidenceSourceSchema = z.enum(EVIDENCE_SOURCES)
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>

export const specEvidenceRecordSchema = z
	.object({
		revisionId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		acceptanceId: specId,
		checkId: specId,
		/** Workspace revision the check ran against. */
		sourceRevision: z.string().min(1).max(128),
		/** Digests of the check's `inputs` at run time, keyed by path. */
		inputDigests: z.record(z.string(), z.string()).default({}),
		checkRunId: z.string().min(1).max(128),
		status: z.enum(["pass", "fail", "unknown"]),
		/** For `runner` evidence: the process exit status. A pass requires 0. */
		exitCode: z.number().int().optional(),
		artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
		source: evidenceSourceSchema,
		recordedAt: z.number().int().nonnegative(),
	})
	.strict()
export type SpecEvidenceRecord = z.infer<typeof specEvidenceRecordSchema>

export const specApprovalSchema = z
	.object({
		revisionId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		approvedBy: z.literal("user"),
		approvedAt: z.number().int().nonnegative(),
	})
	.strict()
export type SpecApproval = z.infer<typeof specApprovalSchema>
