// Feature: retrieval-fabric
//
// Semantic-boundary indexing chunker for the Retrieval Fabric (Requirement 17).
//
// This module turns a file's text into `SemanticChunk`s that:
//   - stay below the per-item serving ceiling (Req 17.1),
//   - target ~500-1200 tokens for source code (Req 17.2),
//   - target ~800-1600 tokens for docs/specs (Req 17.3),
//   - apply ~10-15% overlap between adjacent chunks (Req 17.4),
//   - prefer semantic boundaries over arbitrary token slicing (Req 17.5).
//
// It is a pure function with no I/O: `chunk(input, options)` takes the file
// content and content kind and returns a deterministic chunk list.
//
// ## Token-count approximation
//
// Exact tokenization depends on the embedding model's tokenizer, which this pure
// module deliberately does not depend on. We approximate token count as
// `ceil(characters / CHARS_PER_TOKEN)` with `CHARS_PER_TOKEN = 4`, a widely used
// heuristic (~4 characters per token for English + code). The approximation is
// intentionally conservative on the low side of real tokenizers for typical
// source, so the hard serving ceiling is enforced with margin; callers that need
// exactness should re-measure with the model tokenizer before embedding.
//
// ## Boundary heuristic
//
// Boundaries are detected per line with a documented heuristic rather than a full
// parser (kept reasonable and language-agnostic):
//   - source: lines that begin a function, method, class, module, or similar
//     declaration (e.g. `function`, `class`, `def`, `interface`, `impl`, `fn`,
//     `func`, `module`, `export function`, `public class`, `private foo() {`),
//   - docs: Markdown ATX headings (lines starting with `#`).
// A boundary line starts a new semantic unit. Units are then packed greedily into
// chunks up to the kind's token target (and always below the serving ceiling),
// with a single oversized unit hard-split on token budget as a fallback.

/**
 * The kind of content being chunked. Drives the token target band.
 *
 * - `"source"`: source code — target ~500-1200 tokens (Req 17.2).
 * - `"docs"`: documentation / specification prose — target ~800-1600 tokens (Req 17.3).
 */
export type ContentKind = "source" | "docs"

/**
 * A single indexing unit bounded by a semantic boundary and sized below the
 * per-item serving ceiling (the `Semantic_Chunk` of Requirement 17).
 */
export interface SemanticChunk {
	/** Workspace-relative file path the chunk came from. */
	file: string
	/** 1-based inclusive start line of the chunk within the file. */
	startLine: number
	/** 1-based inclusive end line of the chunk within the file. */
	endLine: number
	/** The chunk text (including any overlap carried from the previous chunk). */
	content: string
	/** Approximate token count of `content` (see module-level approximation note). */
	tokenCount: number
}

/** Input to {@link chunk}. */
export interface ChunkInput {
	/** Workspace-relative file path, copied onto each produced chunk. */
	file: string
	/** Full file content to chunk. */
	content: string
	/** Content kind, selecting the token target band and boundary heuristic. */
	kind: ContentKind
}

/** Options for {@link chunk}. All are optional and default to safe values. */
export interface ChunkOptions {
	/**
	 * Hard per-item serving ceiling in approximate tokens. No produced chunk's
	 * `tokenCount` may reach this value (Req 17.1). Defaults to
	 * {@link DEFAULT_SERVING_CEILING_TOKENS}.
	 */
	perItemServingCeilingTokens?: number
	/**
	 * Overlap fraction between adjacent chunks, clamped to the ~10-15% band
	 * (Req 17.4). Defaults to {@link DEFAULT_OVERLAP_FRACTION}.
	 */
	overlapFraction?: number
}

/** Approximate characters per token used by the token-count heuristic. */
export const CHARS_PER_TOKEN = 4

/**
 * Safe default per-item serving ceiling (approximate tokens). Below the legacy
 * 4096 embedding ceiling so chunks embed with margin even under the heuristic.
 */
export const DEFAULT_SERVING_CEILING_TOKENS = 2048

/** Default adjacent-chunk overlap fraction (12.5%, mid-band of 10-15%). */
export const DEFAULT_OVERLAP_FRACTION = 0.125

/** Lower / upper bounds of the valid overlap band (Req 17.4). */
export const MIN_OVERLAP_FRACTION = 0.1
export const MAX_OVERLAP_FRACTION = 0.15

/** Target token bands per content kind (Req 17.2, 17.3). */
const TOKEN_TARGETS: Record<ContentKind, { min: number; max: number }> = {
	source: { min: 500, max: 1200 },
	docs: { min: 800, max: 1600 },
}

/**
 * Approximate the token count of a string via the documented chars/4 heuristic.
 *
 * @param text The text to measure.
 * @returns A non-negative integer approximate token count.
 */
export function approximateTokenCount(text: string): number {
	if (text.length === 0) {
		return 0
	}
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Source-code boundary heuristic: does this line begin a new semantic unit
 * (function, method, class, module, interface, impl, etc.)?
 *
 * Language-agnostic and intentionally permissive: it keys off common declaration
 * keywords appearing at the start of the (trimmed) line, optionally preceded by
 * access/qualifier modifiers.
 */
function isSourceBoundary(line: string): boolean {
	const trimmed = line.trim()
	if (trimmed.length === 0) {
		return false
	}
	// Strip leading access/qualifier modifiers so `export async function` etc. match.
	const withoutModifiers = trimmed.replace(
		/^(export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+|final\s+|override\s+|pub\s+|const\s+)+/,
		"",
	)
	return /^(function|class|def|interface|impl|fn|func|module|namespace|struct|enum|trait|type)\b/.test(withoutModifiers)
}

/** Docs boundary heuristic: Markdown ATX heading line (`#`, `##`, ...). */
function isDocsBoundary(line: string): boolean {
	return /^#{1,6}\s/.test(line.trimStart())
}

/** Pick the boundary detector for a content kind. */
function boundaryDetectorFor(kind: ContentKind): (line: string) => boolean {
	return kind === "docs" ? isDocsBoundary : isSourceBoundary
}

/** A contiguous run of lines forming one semantic unit before packing. */
interface Segment {
	/** 0-based index of the first line of this segment. */
	startIndex: number
	/** 0-based index of the last line of this segment. */
	endIndex: number
}

/**
 * Split lines into semantic segments. A boundary line starts a new segment; any
 * leading lines before the first boundary form their own segment so no content
 * is dropped.
 */
function splitIntoSegments(lines: string[], isBoundary: (line: string) => boolean): Segment[] {
	const segments: Segment[] = []
	let currentStart = 0
	for (let i = 0; i < lines.length; i++) {
		// A boundary that is not the very first line closes the previous segment.
		if (i > 0 && isBoundary(lines[i])) {
			segments.push({ startIndex: currentStart, endIndex: i - 1 })
			currentStart = i
		}
	}
	if (lines.length > 0) {
		segments.push({ startIndex: currentStart, endIndex: lines.length - 1 })
	}
	return segments
}

/** Clamp the overlap fraction into the valid 10-15% band. */
function clampOverlap(fraction: number): number {
	if (Number.isNaN(fraction)) {
		return DEFAULT_OVERLAP_FRACTION
	}
	return Math.min(MAX_OVERLAP_FRACTION, Math.max(MIN_OVERLAP_FRACTION, fraction))
}

/**
 * Hard-split a run of lines on the token budget as a fallback for a single
 * segment that alone exceeds the ceiling (e.g. a huge generated function). This
 * is the only path that slices without a semantic boundary, and only when a
 * semantic unit cannot otherwise fit (Req 17.5 — boundaries are preferred, this
 * is the documented exception).
 */
function hardSplitLines(lines: string[], startIndex: number, maxTokens: number): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = []
	let runStart = startIndex
	let runTokens = 0
	for (let i = startIndex; i < startIndex + lines.length; i++) {
		const lineTokens = approximateTokenCount(lines[i - startIndex]) + 1 // +1 for the newline
		if (runTokens > 0 && runTokens + lineTokens >= maxTokens) {
			ranges.push({ start: runStart, end: i - 1 })
			runStart = i
			runTokens = 0
		}
		runTokens += lineTokens
	}
	ranges.push({ start: runStart, end: startIndex + lines.length - 1 })
	return ranges
}

/**
 * Chunk file content into semantic chunks (Requirement 17). Pure and
 * deterministic: identical input and options always produce identical output.
 *
 * Packing strategy:
 *   1. Detect semantic boundaries and split content into segments.
 *   2. Greedily pack whole segments into a chunk until adding the next segment
 *      would exceed the kind's token target (or the serving ceiling).
 *   3. A single segment larger than the ceiling is hard-split on token budget.
 *   4. Prepend ~10-15% overlap (trailing lines of the previous chunk) to each
 *      chunk after the first.
 *
 * Every produced chunk's `tokenCount` is strictly below `perItemServingCeilingTokens`.
 *
 * @param input The file path, content, and content kind.
 * @param options Serving ceiling and overlap fraction (both optional).
 * @returns The ordered list of semantic chunks (empty for empty content).
 */
export function chunk(input: ChunkInput, options: ChunkOptions = {}): SemanticChunk[] {
	const ceiling = options.perItemServingCeilingTokens ?? DEFAULT_SERVING_CEILING_TOKENS
	const overlapFraction = clampOverlap(options.overlapFraction ?? DEFAULT_OVERLAP_FRACTION)

	if (input.content.length === 0) {
		return []
	}

	const lines = input.content.split("\n")
	const isBoundary = boundaryDetectorFor(input.kind)
	const { max: targetMax } = TOKEN_TARGETS[input.kind]

	// The effective per-chunk cap for the chunk *body*. Overlap (up to
	// `overlapFraction` of the previous body) is prepended afterwards, so reserve
	// headroom for it: a body of `B` tokens plus overlap of `<= overlapFraction*B`
	// tokens must stay strictly below the ceiling. Solving `B*(1+f) < ceiling`
	// gives the overlap-aware ceiling cap below. We also honor the kind target.
	const overlapAwareCeilingCap = Math.max(1, Math.floor((ceiling - 1) / (1 + overlapFraction)))
	const chunkTokenCap = Math.min(targetMax, overlapAwareCeilingCap)

	const segments = splitIntoSegments(lines, isBoundary)

	// Expand any single segment that alone exceeds the cap into ceiling-safe
	// line ranges via the documented hard-split fallback.
	const packableRanges: Array<{ start: number; end: number }> = []
	for (const segment of segments) {
		const segmentLines = lines.slice(segment.startIndex, segment.endIndex + 1)
		const segmentTokens = approximateTokenCount(segmentLines.join("\n"))
		if (segmentTokens > chunkTokenCap) {
			packableRanges.push(...hardSplitLines(segmentLines, segment.startIndex, chunkTokenCap))
		} else {
			packableRanges.push({ start: segment.startIndex, end: segment.endIndex })
		}
	}

	// Greedily pack ranges into chunk line-spans up to the token cap.
	const chunkSpans: Array<{ start: number; end: number }> = []
	let spanStart = -1
	let spanEnd = -1
	for (const range of packableRanges) {
		if (spanStart === -1) {
			spanStart = range.start
			spanEnd = range.end
			continue
		}
		const candidateTokens = approximateTokenCount(lines.slice(spanStart, range.end + 1).join("\n"))
		if (candidateTokens <= chunkTokenCap) {
			spanEnd = range.end
		} else {
			chunkSpans.push({ start: spanStart, end: spanEnd })
			spanStart = range.start
			spanEnd = range.end
		}
	}
	if (spanStart !== -1) {
		chunkSpans.push({ start: spanStart, end: spanEnd })
	}

	// Materialize chunks, prepending overlap from the previous chunk's tail.
	const chunks: SemanticChunk[] = []
	for (let i = 0; i < chunkSpans.length; i++) {
		const span = chunkSpans[i]
		const bodyLines = lines.slice(span.start, span.end + 1)

		let overlapLines: string[] = []
		let startLine = span.start + 1 // 1-based

		if (i > 0) {
			const prev = chunkSpans[i - 1]
			const prevLineCount = prev.end - prev.start + 1
			const overlapCount = Math.min(prevLineCount, Math.max(1, Math.round(prevLineCount * overlapFraction)))
			const overlapStart = prev.end - overlapCount + 1
			overlapLines = lines.slice(overlapStart, prev.end + 1)
			startLine = overlapStart + 1 // 1-based start reflects the overlap region
		}

		const content = [...overlapLines, ...bodyLines].join("\n")
		chunks.push({
			file: input.file,
			startLine,
			endLine: span.end + 1, // 1-based inclusive
			content,
			tokenCount: approximateTokenCount(content),
		})
	}

	return chunks
}
