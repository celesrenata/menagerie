import { promises as fs } from "fs"
import * as path from "path"

import { sha256Hex } from "./analysisDigest"
import { isSafeRelativePath, type EvidenceFreshness, type EvidenceVerifier } from "./AnalysisValidator"

function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target)
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Checks an evidence item against the real file: path stays inside the workspace (symlinks
 * resolved), the whole-file sha256 still equals the anchor's `fileDigest`, the line range
 * exists, and the excerpt is the verbatim slice of those lines. Any change makes the item
 * `stale`; an absent file is `missing`. Never throws.
 */
export function createWorkspaceEvidenceVerifier(workspaceRoot: string): EvidenceVerifier {
	return async (item): Promise<EvidenceFreshness> => {
		if (!isSafeRelativePath(item.anchor.path)) return "unsafe"
		try {
			const root = await fs.realpath(workspaceRoot)
			const resolved = await fs.realpath(path.resolve(root, item.anchor.path))
			if (!isInside(root, resolved)) return "unsafe"
			const content = await fs.readFile(resolved, "utf8")
			if (sha256Hex(content) !== item.anchor.fileDigest) return "stale"
			const lines = content.split(/\r?\n/)
			if (item.anchor.endLine > lines.length) return "stale"
			const slice = lines.slice(item.anchor.startLine - 1, item.anchor.endLine).join("\n")
			return slice === item.excerpt.replace(/\r\n/g, "\n").replace(/\n$/, "") ? "fresh" : "stale"
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe"
		}
	}
}
