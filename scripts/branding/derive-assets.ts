// Feature: menagerie-branding-migration
//
// Asset-derivation script (Asset_Pipeline). Reads the canonical Menagerie brand
// asset (`menagerie.png` at the repository root) and (re)writes every derived
// extension asset declared in the derived-asset manifest from that single source,
// so all extension imagery traces back to one authoritative image (Requirement 1).
//
// This is a build/maintenance tool invoked manually or via a package script
// (`npx tsx scripts/branding/derive-assets.ts`). It is NOT imported by extension
// runtime code.
//
// Error-handling contract (see design.md "Error Handling"):
//   - Canonical asset missing/unreadable -> fail fast with a clear error naming the
//     expected path; derived assets are left untouched (fail closed, keep last-good).
//   - Per-target write failure -> report the failing target and exit non-zero,
//     never leaving a partially written file (write to a temp file, then atomic
//     rename into place).

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { derivedAssets, type DerivedAsset } from "../../src/branding/inventory"

/** Repository root, resolved relative to this file (`scripts/branding/`). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** The canonical brand asset path, relative to the repository root. */
export const CANONICAL_ASSET_PATH = path.join(REPO_ROOT, "menagerie.png")

/** The mirror of the canonical asset kept in sync inside the extension sources. */
export const CANONICAL_MIRROR_PATH = path.join(REPO_ROOT, "src", "assets", "icons", "menagerie.png")

/** Raised when the canonical brand asset cannot be read; names the expected path. */
export class CanonicalAssetError extends Error {
	constructor(canonicalPath: string, cause: unknown) {
		super(
			`Canonical brand asset is missing or unreadable at "${canonicalPath}". ` +
				`Derived assets were left untouched (last-good retained). ` +
				`Place the Menagerie brand image at this path and re-run the asset pipeline.`,
		)
		this.name = "CanonicalAssetError"
		this.cause = cause
	}
}

/** Raised when writing a single derived target fails; names the failing target. */
export class DerivedAssetWriteError extends Error {
	constructor(
		public readonly target: string,
		cause: unknown,
	) {
		super(`Failed to write derived asset target "${target}": ${describeCause(cause)}`)
		this.name = "DerivedAssetWriteError"
		this.cause = cause
	}
}

function describeCause(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message
	}
	return String(cause)
}

/**
 * Write `data` to `destination` atomically: write to a sibling temp file first,
 * then rename it into place. On any failure the temp file is cleaned up and a
 * {@link DerivedAssetWriteError} is thrown naming the logical target.
 */
function writeAtomic(destination: string, data: Buffer, target: string): void {
	const tempPath = `${destination}.tmp`
	try {
		fs.mkdirSync(path.dirname(destination), { recursive: true })
		fs.writeFileSync(tempPath, data)
		fs.renameSync(tempPath, destination)
	} catch (cause) {
		// Best-effort cleanup so a failed write never leaves a stray temp file.
		try {
			if (fs.existsSync(tempPath)) {
				fs.rmSync(tempPath, { force: true })
			}
		} catch {
			// Ignore cleanup failures; the original write error is what matters.
		}
		throw new DerivedAssetWriteError(target, cause)
	}
}

/**
 * Read the canonical brand asset and (re)generate every derived asset in the
 * manifest from it.
 *
 * @param canonicalPath Absolute or repo-relative path to the canonical `menagerie.png`.
 * @param manifest The derived-asset manifest; each entry's `target` is written from
 *   the canonical source. `target` paths are resolved relative to the repository root.
 * @returns The list of derived target paths that were written (repo-relative).
 * @throws CanonicalAssetError if the canonical asset cannot be read (fail closed).
 * @throws DerivedAssetWriteError if any single target cannot be written.
 */
export function deriveAssets(
	canonicalPath: string = CANONICAL_ASSET_PATH,
	manifest: readonly DerivedAsset[] = derivedAssets,
): string[] {
	const resolvedCanonical = path.isAbsolute(canonicalPath) ? canonicalPath : path.join(REPO_ROOT, canonicalPath)

	// Fail fast and closed: if we cannot read the canonical source, do not touch
	// any derived asset so the last-good outputs are retained.
	let canonicalData: Buffer
	try {
		canonicalData = fs.readFileSync(resolvedCanonical)
	} catch (cause) {
		throw new CanonicalAssetError(resolvedCanonical, cause)
	}

	// Keep the in-source mirror in sync with the canonical root asset. Skip when the
	// mirror *is* the canonical source to avoid a redundant self-write.
	if (path.resolve(resolvedCanonical) !== path.resolve(CANONICAL_MIRROR_PATH)) {
		writeAtomic(CANONICAL_MIRROR_PATH, canonicalData, path.relative(REPO_ROOT, CANONICAL_MIRROR_PATH))
	}

	const written: string[] = []
	for (const asset of manifest) {
		const destination = path.isAbsolute(asset.target) ? asset.target : path.join(REPO_ROOT, asset.target)
		writeAtomic(destination, canonicalData, asset.target)
		written.push(asset.target)
	}

	return written
}

/** CLI entry point: derive all assets from the defaults and report results. */
function main(): void {
	try {
		const written = deriveAssets()
		console.log(`Asset pipeline: derived ${written.length} target(s) from "${CANONICAL_ASSET_PATH}":`)
		for (const target of written) {
			console.log(`  ✓ ${target}`)
		}
	} catch (error) {
		if (error instanceof CanonicalAssetError || error instanceof DerivedAssetWriteError) {
			console.error(`Asset pipeline failed: ${error.message}`)
		} else {
			console.error(`Asset pipeline failed with an unexpected error: ${describeCause(error)}`)
		}
		process.exit(1)
	}
}

// Run as a CLI only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
const thisPath = fileURLToPath(import.meta.url)
if (invokedPath === thisPath) {
	main()
}
