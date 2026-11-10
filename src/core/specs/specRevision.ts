import type { z } from "zod"

import { specRevisionSchema, type SpecRevision, type SpecRevisionContent } from "@roo-code/types"

import { canonicalJson, sha256Hex } from "../../services/analysis/analysisDigest"

const contentSchema = specRevisionSchema.omit({ revisionId: true })

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
