import { INDEX_EXCLUDED_DIRS } from "../constants"

/**
 * Checks whether a (relative) file path lives inside a directory the code indexer excludes.
 *
 * This is directory-name based and index-only. It mirrors the segment-equality + `/dir/` substring matching used
 * by `isPathInIgnoredDirectory()` in `src/services/glob/ignore-utils.ts`, but reads from the code-index-only
 * `INDEX_EXCLUDED_DIRS` list ("i18n", "locales", "translations") instead of the shared `DIRS_TO_IGNORE` denylist.
 *
 * Unlike the shared helper there is no hidden-directory (".*") handling here — hidden dirs remain the shared
 * helper's responsibility, and the scanner/watcher call both helpers.
 *
 * @param filePath The file path to check (pass a workspace-relative path to avoid matching ancestor dirs)
 * @returns true if any path segment equals an index-excluded directory name, false otherwise
 */
export function isPathInIndexExcludedDirectory(filePath: string): boolean {
	// Normalize path separators
	const normalizedPath = filePath.replace(/\\/g, "/")
	const pathParts = normalizedPath.split("/")

	// Check each path segment for an exact match against an excluded directory name
	for (const part of pathParts) {
		// Skip empty parts (from leading or trailing slashes)
		if (!part) continue

		if ((INDEX_EXCLUDED_DIRS as readonly string[]).includes(part)) {
			return true
		}
	}

	// Also catch the directory appearing anywhere in the path (same `/dir/` check the shared helper uses)
	for (const dir of INDEX_EXCLUDED_DIRS) {
		if (normalizedPath.includes(`/${dir}/`)) {
			return true
		}
	}

	return false
}
