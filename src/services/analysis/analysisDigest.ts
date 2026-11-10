import { createHash } from "crypto"

import type { AnalysisRequest } from "@roo-code/types"

/** Deterministic JSON with sorted object keys, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

export interface DigestRuntime {
	modelId: string
	/** Version of the exact prompt template text. */
	templateVersion: string
}

/**
 * Digest over everything that determines the answer: operation, evidence (anchors + excerpt
 * hashes), schema / instruction / template versions, model, output budget. It is computed by
 * Menagerie only. The model never supplies it. The excerpt is hashed, not embedded, so the
 * digest can be logged without leaking source.
 */
export function analysisDigest(request: AnalysisRequest, runtime: DigestRuntime): string {
	return sha256Hex(
		canonicalJson({
			operation: request.operation,
			specRevisionId: request.specRevisionId,
			sample: request.sample,
			schemaVersion: request.schemaVersion,
			instructionsVersion: request.instructionsVersion,
			maxOutputTokens: request.maxOutputTokens,
			modelId: runtime.modelId,
			templateVersion: runtime.templateVersion,
			evidence: request.evidence.map((e) => ({
				anchorId: e.anchorId,
				anchor: e.anchor,
				excerptSha256: sha256Hex(e.excerpt),
			})),
		}),
	)
}
