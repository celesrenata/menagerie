import type { z } from "zod"

import { specRevisionSchema, type SpecRevision, type SpecRevisionContent } from "@roo-code/types"

import { canonicalJson, sha256Hex } from "../../services/analysis/analysisDigest"

const contentSchema = specRevisionSchema.omit({ revisionId: true })

/** Validate an untrusted draft (a revision without its id). Returns issues instead of throwing. */
export function parseSpecDraft(raw: unknown): { ok: true; content: z.output<typeof contentSchema> } | { ok: false; issues: string[] } {
	const parsed = contentSchema.safeParse(raw)
	if (parsed.success) return { ok: true, content: parsed.data }
	return { ok: false, issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) }
}

/** `sha256:<hex>` over the canonical content, excluding `revisionId` itself. */
export function computeRevisionId(content: SpecRevisionContent): string {
	return `sha256:${sha256Hex(canonicalJson(content))}`
}

/** Build an immutable revision from content. The id is derived here, never supplied by a caller or a model. */
export function sealRevision(content: z.input<typeof contentSchema>): SpecRevision {
	// Normalize first (schema defaults), so the id is over exactly what is stored and re-verified.
	const normalized: SpecRevisionContent = contentSchema.parse(content)
	return specRevisionSchema.parse({ ...normalized, revisionId: computeRevisionId(normalized) })
}

export function verifyRevisionId(revision: SpecRevision): boolean {
	const { revisionId, ...content } = revision
	return computeRevisionId(content) === revisionId
}
