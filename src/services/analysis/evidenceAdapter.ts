import type { AnalysisEvidenceItem, AnalysisOutcome, AnalysisRequest, WorkerResult } from "@roo-code/types"

import type { EvidencePacket } from "../../core/exploration/types"
import type { ReaderFinding } from "../../core/task/preparedContextWorkPackage"
import { sha256Hex } from "./analysisDigest"
import { isSafeRelativePath } from "./AnalysisValidator"

/**
 * Glue between EXISTING retrieval/scout output and the tool-less analysis executor
 * (MEN-GRANITE-SDD-001 R5.1, R7.3). Granite never opens files: this adapter does the reading
 * (through an injected reader), pins each excerpt to the file's content digest, and hands the
 * executor only bounded, anchored text. It adds no retrieval store of its own.
 */

export interface PacketAdapterOptions {
	workspaceUri: string
	repositoryRevision?: string
	/** Returns the full current file text, or undefined when unreadable. Injected for tests and workspace scoping. */
	readFileText: (relativePath: string) => Promise<string | undefined>
	/** Cap on excerpt length per item (characters). */
	maxExcerptChars?: number
	maxItems?: number
}

export interface PacketAdaptation {
	evidence: AnalysisEvidenceItem[]
	/** Items not forwarded, with the reason. Visible so a skipped item is never silent. */
	skipped: Array<{ file: string; reason: "stale" | "unsafe-path" | "unreadable" | "bad-range" | "over-limit" }>
}

export async function evidencePacketToAnalysisEvidence(packet: EvidencePacket, options: PacketAdapterOptions): Promise<PacketAdaptation> {
	const maxChars = options.maxExcerptChars ?? 6_000
	const maxItems = options.maxItems ?? 8
	const evidence: AnalysisEvidenceItem[] = []
	const skipped: PacketAdaptation["skipped"] = []

	for (const item of packet.items) {
		if (evidence.length >= maxItems) {
			skipped.push({ file: item.file, reason: "over-limit" })
			continue
		}
		if (item.fresh === false) {
			skipped.push({ file: item.file, reason: "stale" })
			continue
		}
		if (!isSafeRelativePath(item.file)) {
			skipped.push({ file: item.file, reason: "unsafe-path" })
			continue
		}
		const content = await options.readFileText(item.file)
		if (content === undefined) {
			skipped.push({ file: item.file, reason: "unreadable" })
			continue
		}
		const lines = content.split(/\r?\n/)
		if (!Number.isInteger(item.startLine) || !Number.isInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine || item.endLine > lines.length) {
			skipped.push({ file: item.file, reason: "bad-range" })
			continue
		}
		const excerpt = lines.slice(item.startLine - 1, item.endLine).join("\n")
		if (excerpt.length > maxChars) {
			// Never truncate: dropping part of an excerpt can change its meaning. The caller may narrow the range.
			skipped.push({ file: item.file, reason: "over-limit" })
			continue
		}
		evidence.push({
			anchorId: `e${evidence.length + 1}`,
			anchor: {
				workspaceUri: options.workspaceUri,
				repositoryRevision: options.repositoryRevision,
				path: item.file,
				fileDigest: sha256Hex(content),
				startLine: item.startLine,
				endLine: item.endLine,
			},
			excerpt,
		})
	}
	return { evidence, skipped }
}

/**
 * Validated findings -> the existing `ReaderFinding` shape consumed by `PreparedContextWorkPackage`.
 * Only a `valid` outcome yields findings. References are `file:line` pointers, never code.
 */
export function outcomeToReaderFindings(outcome: AnalysisOutcome, request: AnalysisRequest): ReaderFinding[] {
	if (outcome.kind !== "valid") return []
	const byId = new Map(request.evidence.map((e) => [e.anchorId, e.anchor]))
	return outcome.findings.map((f) => {
		const anchors = f.anchorIds.flatMap((id) => {
			const a = byId.get(id)
			return a ? [a] : []
		})
		const first = anchors[0]
		return {
			claim: f.claim,
			location: first ? `${first.path}:${first.startLine}-${first.endLine}` : undefined,
			whyItMatters: f.recommendation,
			uncertainty: f.uncertainty,
			confidence: f.confidence,
			evidence: anchors.map((a) => ({ type: "file" as const, reference: a.path, lines: [a.startLine, a.endLine] as [number, number] })),
		}
	})
}

/**
 * Scout/reader `WorkerResult` -> candidate evidence packet for the analysis executor
 * (MEN-GRANITE-SDD-001 R5.1, R7.3). Only a completed result's `file` references with a line range
 * qualify; test/command/url/screenshot references and failed or blocked results contribute nothing.
 * The reader's own claims are NOT forwarded as evidence. Every candidate still goes through
 * `evidencePacketToAnalysisEvidence`, which re-reads the file and pins its digest, so a reference
 * the scout got wrong or invented is skipped there rather than trusted here.
 */
export function workerResultToEvidencePacket(result: WorkerResult, query: string): EvidencePacket {
	if (result.status !== "completed") return { query, items: [] }
	const seen = new Set<string>()
	const items: EvidencePacket["items"][number][] = []
	for (const ref of result.evidence) {
		if (ref.type !== "file" || !ref.lines) continue
		const [startLine, endLine] = ref.lines
		const key = `${ref.reference}:${startLine}-${endLine}`
		if (seen.has(key)) continue
		seen.add(key)
		items.push({ file: ref.reference, startLine, endLine, score: 1, reason: "cited by scout reader" })
	}
	return { query, items }
}
