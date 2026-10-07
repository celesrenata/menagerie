import ignore from "ignore"

/**
 * Shared, I/O-free denylist for the parallel-worker read path.
 *
 * This module is the single source of truth consumed by the file-read tool
 * (`ReadFileTool`) and the reader-swarm document pick
 * (`ParallelTaskReader.addSharedDocumentReader`). It deliberately holds no
 * runtime behavior of its own: the predicate is pure (NFR-3) so it can be
 * unit-tested at the lowest layer, and both call sites route through it so the
 * two ingestion routes cannot drift.
 *
 * The config has four fields with *distinct* match semantics so first-party
 * source is never caught by a build-output or vendored directory name that
 * also recurs as a nested first-party segment:
 *
 *   - `vendoredDirs` — a directory NAME matched ANYWHERE in the path segments
 *     (unambiguously third-party / tool-generated, e.g. `node_modules`).
 *   - `rootDirs` — matched ONLY as the FIRST path segment (root-anchored).
 *     An entry ending in `*` is prefix-matched (e.g. `out-*` matches `out-foo`),
 *     so `src/features/build/x.ts` and `packages/pkg/index.ts` stay readable.
 *   - `files` — exact basename match (e.g. `package-lock.json`).
 *   - `globs` — `ignore`-compiled globs tested against the full relPath.
 */
export interface ReadDenylistConfig {
	/** Directory name matched anywhere in the path. */
	vendoredDirs: readonly string[]
	/** Matched only as the first path segment; a `*` suffix is prefix-matched. */
	rootDirs: readonly string[]
	/** Exact basenames. */
	files: readonly string[]
	/** `ignore`-style globs matched against the full relPath. */
	globs: readonly string[]
}

/**
 * Normalize an arbitrary relative path into forward-slash, workspace-relative
 * form, stripping a leading `./` and any trailing slash. Returns `undefined`
 * for a path that cannot be a well-formed workspace-relative read target (empty,
 * absolute, or containing a `..` traversal segment) so callers can fail open.
 */
function normalizeRelPath(relPath: string): string | undefined {
	if (typeof relPath !== "string" || relPath.length === 0) {
		return undefined
	}

	// Collapse backslashes to forward slashes so Windows-style paths normalize.
	let normalized = relPath.replace(/\\/g, "/")

	// Reject absolute paths (POSIX root or Windows drive) — not a workspace-relative target.
	if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
		return undefined
	}

	// Strip a leading `./`.
	normalized = normalized.replace(/^\.\//, "")

	// Strip a trailing slash.
	normalized = normalized.replace(/\/+$/, "")

	if (normalized.length === 0) {
		return undefined
	}

	const segments = normalized.split("/")

	// Reject any `..` traversal segment or empty interior segment.
	if (segments.some((segment) => segment === ".." || segment === "")) {
		return undefined
	}

	return normalized
}

/**
 * Pure predicate deciding whether a workspace-relative read path is denied by
 * the given denylist config.
 *
 * Five-step match semantics (design §B):
 *   (1) return `{ denied: false }` immediately when `opts.knownTarget` is true
 *       (the Known_Target override — a path the user or mastermind named),
 *   (2) deny if any segment equals a `vendoredDirs` entry,
 *   (3) deny if the FIRST segment equals a `rootDirs` entry (or matches an
 *       `out-*`-style prefix for entries ending in `*`),
 *   (4) deny if the basename is in `files`,
 *   (5) deny if any `globs` entry matches via the `ignore` library.
 *
 * The returned `category` is the matched `field:entry`, for the user-facing
 * notice. A malformed `relPath` fails open to `{ denied: false }` so a parsing
 * edge case never blocks a legitimate read (the per-worker budget is the
 * backstop against abuse).
 */
export function isDeniedRead(
	relPath: string,
	config: ReadDenylistConfig,
	opts?: { knownTarget?: boolean },
): { denied: boolean; category?: string } {
	if (opts?.knownTarget) {
		return { denied: false }
	}

	const normalized = normalizeRelPath(relPath)
	if (normalized === undefined) {
		return { denied: false }
	}

	const segments = normalized.split("/")

	// (2) Vendored directory name matched anywhere in the path.
	for (const entry of config.vendoredDirs) {
		if (segments.includes(entry)) {
			return { denied: true, category: `vendoredDirs:${entry}` }
		}
	}

	// (3) Root-anchored build-output directory (first segment only).
	const firstSegment = segments[0]
	for (const entry of config.rootDirs) {
		if (entry.endsWith("*")) {
			const prefix = entry.slice(0, -1)
			if (firstSegment.startsWith(prefix)) {
				return { denied: true, category: `rootDirs:${entry}` }
			}
		} else if (firstSegment === entry) {
			return { denied: true, category: `rootDirs:${entry}` }
		}
	}

	// (4) Exact basename.
	const basename = segments[segments.length - 1]
	for (const entry of config.files) {
		if (basename === entry) {
			return { denied: true, category: `files:${entry}` }
		}
	}

	// (5) `ignore`-style glob match against the full relPath.
	for (const entry of config.globs) {
		if (ignore().add(entry).ignores(normalized)) {
			return { denied: true, category: `globs:${entry}` }
		}
	}

	return { denied: false }
}

/**
 * A path-literal token: contains at least one `/`, ends in a file extension
 * `.[A-Za-z0-9]+` (optionally a compound extension such as `.d.ts`), optionally
 * followed by a `:line` or `:line:col` diagnostic suffix. The surrounding
 * delimiter (whitespace, paren, comma, semicolon, or quote) is handled by the
 * tokenizer below, not by this pattern.
 */
const PATH_LITERAL = /(?:[^\s(),;'"`]*\/[^\s(),;'"`]*)/g

/**
 * Extract the set of Known_Target paths named verbatim in a worker's task text.
 *
 * A path literal (design §B grammar) is a token that:
 *   (a) contains at least one `/`,
 *   (b) ends in a file extension `.[A-Za-z0-9]+` (compound `.d.ts` supported),
 *   (c) is whitespace/paren/comma/semicolon-delimited bare text, or is enclosed
 *       in backticks / single / double quotes.
 * A trailing `:line` or `:line:col` suffix (diagnostic `file:line` form) is
 * stripped before storing. Any token containing a `..` segment is rejected
 * (no path traversal). Returned paths are normalized workspace-relative.
 */
export function extractKnownTargetPaths(message: string): Set<string> {
	const result = new Set<string>()
	if (typeof message !== "string" || message.length === 0) {
		return result
	}

	// Strip quote characters so quoted and bare tokens tokenize uniformly. The
	// grammar treats backtick/single/double quotes as delimiters, so replacing
	// them with whitespace exposes the enclosed path literal to the tokenizer.
	const unquoted = message.replace(/[`'"]/g, " ")

	const matches = unquoted.match(PATH_LITERAL)
	if (matches === null) {
		return result
	}

	for (const raw of matches) {
		// Strip a trailing `:line` or `:line:col` diagnostic suffix.
		const withoutLineSuffix = raw.replace(/:\d+(?::\d+)?$/, "")

		// Must end in a file extension (compound `.d.ts` is covered by the
		// generic trailing-extension rule).
		if (!/\.[A-Za-z0-9]+$/.test(withoutLineSuffix)) {
			continue
		}

		const normalized = normalizeRelPath(withoutLineSuffix)
		if (normalized === undefined) {
			// Rejects absolute paths and `..` traversal tokens.
			continue
		}

		result.add(normalized)
	}

	return result
}

/**
 * Merge a stored (user-adjustable) denylist config over the hardcoded default
 * with per-field REPLACE-over-default semantics (design §F NIT 6).
 *
 * For each of `vendoredDirs` / `rootDirs` / `files` / `globs`:
 *   - if the stored config OMITS the key, inherit the default array unchanged;
 *   - if the stored config PROVIDES the key (including an explicit empty array
 *     `[]`), that array REPLACES the default for that field — so `[]` clears a
 *     category (how a user re-enables reading, e.g. vendored typings).
 *
 * This is NOT the numeric key-merge of `mergeRouteCapacityMap`: array union
 * could never *remove* a default entry, so the denylist uses replace.
 */
export function mergeReadDenylist(
	stored: Partial<ReadDenylistConfig> | undefined,
	defaults: ReadDenylistConfig,
): ReadDenylistConfig {
	if (stored === undefined) {
		return {
			vendoredDirs: defaults.vendoredDirs,
			rootDirs: defaults.rootDirs,
			files: defaults.files,
			globs: defaults.globs,
		}
	}

	return {
		vendoredDirs: stored.vendoredDirs ?? defaults.vendoredDirs,
		rootDirs: stored.rootDirs ?? defaults.rootDirs,
		files: stored.files ?? defaults.files,
		globs: stored.globs ?? defaults.globs,
	}
}
