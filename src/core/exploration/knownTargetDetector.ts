import type { KnownTargetInputs, KnownTargetResult } from "./types"

/**
 * A result signalling that no unambiguous known target could be detected.
 * Returned on ambiguous input, no clear single path, or any thrown error so the
 * detector degrades safely to the normal preference path (design: safe-degrade-to-absent).
 */
const ABSENT: KnownTargetResult = { present: false }

/**
 * File extensions that mark a bare token (no `/`) as a recognizable file path.
 * Kept intentionally small and focused on the ecosystems this repo works in.
 */
const RECOGNIZED_EXTENSIONS = [
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonc",
	"yaml",
	"yml",
	"md",
	"mdx",
	"toml",
	"lock",
	"css",
	"scss",
	"html",
	"sh",
	"py",
	"go",
	"rs",
	"java",
	"nix",
] as const

/**
 * Extensions sorted longest-first so the regex alternation tries `jsonc`
 * before `json` before `js`, `tsx` before `ts`, etc.
 */
const EXT_ALT = [...RECOGNIZED_EXTENSIONS].sort((a, b) => b.length - a.length).join("|")

/**
 * Matches a path-like token: a run of path characters that either contains a
 * `/` or ends in one of the recognized extensions. Line/column suffixes are
 * handled separately by {@link DIAGNOSTIC_PATH_LINE}.
 */
const PATH_TOKEN = new RegExp(
	String.raw`(?:[\w.\-]+\/)*[\w.\-]+\.(?:${EXT_ALT})` + String.raw`(?![\w])` +
		String.raw`|(?:[\w.\-]+\/)+[\w.\-]+`,
	"g",
)

/**
 * Matches a diagnostic reference of the form `path:line` (optionally
 * `path:line:column`), capturing the path and the 1-based line number.
 */
const DIAGNOSTIC_PATH_LINE = new RegExp(
	String.raw`((?:[\w.\-]+\/)*[\w.\-]+\.(?:${EXT_ALT}))` + String.raw`:(\d+)(?::\d+)?`,
)

/**
 * Returns true when a token looks like a file path: it contains a `/` or ends
 * in a recognized file extension.
 */
function looksLikePath(token: string): boolean {
	if (token.includes("/")) {
		return true
	}
	const dot = token.lastIndexOf(".")
	if (dot < 0 || dot === token.length - 1) {
		return false
	}
	const ext = token.slice(dot + 1).toLowerCase()
	return (RECOGNIZED_EXTENSIONS as ReadonlyArray<string>).includes(ext)
}

/**
 * Extracts the single unambiguous path from free text. Returns `undefined` when
 * there is no path, or when more than one distinct candidate path appears
 * (ambiguous → degrade to absent).
 */
function singlePathFrom(text: string): string | undefined {
	const matches = text.match(PATH_TOKEN)
	if (!matches) {
		return undefined
	}
	const distinct = Array.from(new Set(matches.filter(looksLikePath)))
	if (distinct.length !== 1) {
		return undefined
	}
	return distinct[0]
}

/**
 * Detects a `path:line` reference in a diagnostic message. Returns the first
 * well-formed match, or `undefined` when none is present or the line number
 * cannot be parsed into a finite positive integer.
 */
function diagnosticPathLineFrom(message: string): { path: string; line: number } | undefined {
	const match = DIAGNOSTIC_PATH_LINE.exec(message)
	if (!match) {
		return undefined
	}
	const path = match[1]
	const line = Number.parseInt(match[2], 10)
	if (!Number.isInteger(line) || line <= 0) {
		return undefined
	}
	return { path, line }
}

/**
 * Detects an exact file path a task already knows before exploring, from one of
 * three sources, in order of authority:
 *
 * 1. `workerHeldPath` — a worker already holding an exact path (`worker_held`).
 * 2. A `path:line` diagnostic message (`diagnostic`, with the parsed line).
 * 3. A user instruction naming a single exact path (`user_instruction`).
 *
 * Returns `{ present: false }` when detection is ambiguous (multiple candidate
 * paths, no clear single path) or when any step throws. The detector never
 * throws to the caller.
 */
export function detectKnownTarget(inputs: KnownTargetInputs): KnownTargetResult {
	try {
		const workerHeld = inputs.workerHeldPath?.trim()
		if (workerHeld && looksLikePath(workerHeld)) {
			return { present: true, path: workerHeld, source: "worker_held" }
		}

		if (inputs.diagnostics) {
			for (const diagnostic of inputs.diagnostics) {
				const parsed = diagnosticPathLineFrom(diagnostic.message)
				if (parsed) {
					return { present: true, path: parsed.path, line: parsed.line, source: "diagnostic" }
				}
			}
		}

		if (inputs.userInstruction) {
			const path = singlePathFrom(inputs.userInstruction)
			if (path) {
				return { present: true, path, source: "user_instruction" }
			}
		}

		return ABSENT
	} catch {
		return ABSENT
	}
}

/**
 * Concrete {@link KnownTargetDetector} implementation (design interface shape).
 */
export interface KnownTargetDetector {
	detect(inputs: KnownTargetInputs): KnownTargetResult
}

/**
 * Shared stateless detector instance. Detection is pure, so a single instance
 * is safe to reuse across tasks and workers.
 */
export const knownTargetDetector: KnownTargetDetector = {
	detect: detectKnownTarget,
}
