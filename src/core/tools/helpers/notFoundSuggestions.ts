import * as path from "path"

import { isDeniedRead, type ReadDenylistConfig } from "../../../services/glob/readDenylist"
import { searchWorkspaceFiles } from "../../../services/search/file-search"

/**
 * Default cap on the number of near-match suggestions surfaced for a not-found
 * read. Kept small so the structured notice stays cheap and never bloats the
 * model context (design FR-5).
 */
const DEFAULT_SUGGESTION_CAP = 5

/**
 * Type-guard for a Node `ENOENT` (no-such-file) error. A missing path thrown by
 * `fs.stat`/`fs.readFile` carries `code === "ENOENT"`.
 *
 * The `as NodeJS.ErrnoException` is a documented Node-errno structural cast
 * (AGENTS.md permits this with a comment): Node's `fs` rejections are plain
 * `Error` instances that additionally carry a `code` string, which the public
 * `Error` type does not model. It is NOT `as any`.
 */
export function isEnoent(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

/**
 * Renders the structured not-found notice surfaced as the file result content.
 *
 * The notice ALWAYS begins with a `File: <relPath>` line (matching every other
 * `nativeContent` the read tool builds) and carries the stable `Not found:`
 * token that Layer 3 (`normalizeWorkerResult`) keys on. The phrasing steers the
 * model to verify the path and re-read a candidate rather than treat the read
 * as a fatal error.
 *
 * @param relPath - the workspace-relative path that did not exist
 * @param suggestions - near-match candidate PATHS (never file contents)
 */
export function formatNotFoundNotice(relPath: string, suggestions: string[]): string {
	if (suggestions.length === 0) {
		return (
			`File: ${relPath}\n` +
			`Not found: no file exists at this path, and no similar files were found in the workspace.\n` +
			`Verify the intended path.`
		)
	}

	const candidateLines = suggestions.map((candidate) => `  - ${candidate}`).join("\n")
	return (
		`File: ${relPath}\n` +
		`Not found: no file exists at this path.\n` +
		`Did you mean one of these? (verify the intended path and re-read)\n` +
		candidateLines
	)
}

/**
 * Searches the workspace file list for near-match PATHS to a missing read
 * target, honoring rooIgnore and the read denylist so vendored/generated junk
 * is never suggested.
 *
 * Ranking (de-duplicated, stable):
 *   Tier 1 — exact basename equality (case-sensitive, then case-insensitive).
 *   Tier 2 — stem match (basename without extension equals the missing stem).
 *   Tier 3 — residual fzf/substring order from the source.
 *
 * Each candidate must pass BOTH `isAccessAllowed` (rooIgnore) AND the read
 * denylist (with the per-candidate Known_Target bypass, which mirrors the read
 * tool's own gate) BEFORE the `cap` trim, so a denied top hit does not consume
 * a slot. Returns workspace-relative POSIX paths, length ≤ cap, possibly empty,
 * NEVER file contents.
 *
 * `searchWorkspaceFiles` already returns `[]` on any ripgrep/enumeration
 * failure, so the surrounding `try/catch` is only a defensive guard against an
 * unexpected throw; it is not the failure-to-empty mechanism.
 */
export async function suggestNearbyPaths(args: {
	missingRelPath: string
	cwd: string
	denylist: ReadDenylistConfig
	isAccessAllowed: (relPath: string) => boolean
	isKnownTarget: (relPath: string) => boolean
	cap?: number
}): Promise<string[]> {
	const { missingRelPath, cwd, denylist, isAccessAllowed, isKnownTarget } = args
	const cap = args.cap ?? DEFAULT_SUGGESTION_CAP

	const basename = path.basename(missingRelPath)
	if (basename.length === 0) {
		return []
	}
	const stem = basename.slice(0, basename.length - path.extname(basename).length)

	try {
		// Request headroom beyond `cap` so post-filtering a denied top hit does
		// not starve the final list.
		const results = await searchWorkspaceFiles(basename, cwd, cap * 4)

		const files = results.filter((result) => result.type === "file").map((result) => result.path)

		// Rank by tier. A lower tier number sorts first; the index within the
		// source list breaks ties, preserving fzf's stable order.
		const tierOf = (candidate: string): number => {
			const candidateBase = path.basename(candidate)
			if (candidateBase === basename) {
				return 0 // exact basename, case-sensitive
			}
			if (candidateBase.toLowerCase() === basename.toLowerCase()) {
				return 1 // exact basename, case-insensitive
			}
			const candidateStem = candidateBase.slice(0, candidateBase.length - path.extname(candidateBase).length)
			if (stem.length > 0 && candidateStem.toLowerCase() === stem.toLowerCase()) {
				return 2 // stem match
			}
			return 3 // residual substring/fzf order
		}

		const seen = new Set<string>()
		const ranked = files
			.map((candidate, index) => ({ candidate, tier: tierOf(candidate), index }))
			.filter(({ candidate }) => {
				if (seen.has(candidate)) {
					return false
				}
				seen.add(candidate)
				return true
			})
			.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.index - b.index))

		const allowed: string[] = []
		for (const { candidate } of ranked) {
			if (!isAccessAllowed(candidate)) {
				continue
			}
			if (isDeniedRead(candidate, denylist, { knownTarget: isKnownTarget(candidate) }).denied) {
				continue
			}
			allowed.push(candidate.replace(/\\/g, "/"))
			if (allowed.length >= cap) {
				break
			}
		}

		return allowed
	} catch (error) {
		// Defensive guard only — `searchWorkspaceFiles` already swallows ripgrep
		// failures to `[]`. A suggestion-source failure must never escalate a
		// not-found read into noise, so log at debug level and degrade to no
		// suggestions.
		console.debug("suggestNearbyPaths: unexpected failure, returning no suggestions", error)
		return []
	}
}
