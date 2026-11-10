import { promises as fs } from "fs"
import * as path from "path"

import {
	SPEC_ID_PATTERN,
	specApprovalSchema,
	specEvidenceRecordSchema,
	specRevisionSchema,
	type SpecApproval,
	type SpecEvidenceRecord,
	type SpecRevision,
} from "@roo-code/types"

import { canonicalJson } from "../../services/analysis/analysisDigest"
import { verifyRevisionId } from "./specRevision"

/**
 * Versioned, immutable spec revision persistence (MEN-GRANITE-SDD-001 R6.1, R6.5).
 *
 * Lives next to the Kiro spec artifacts (`<specsRoot>/<specId>/.revisions/`), not in a second
 * task database. Revisions are write-once and content-addressed; evidence and approvals are
 * append-only JSONL. Status is therefore always DERIVED from these records, never from a
 * checkbox. Task lifecycle state stays with the existing task persistence.
 */
export class SpecStoreError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SpecStoreError"
	}
}

const HEX_ID = /^sha256:([a-f0-9]{64})$/

export class SpecRevisionStore {
	constructor(private readonly specsRoot: string) {}

	private specDir(specId: string): string {
		if (!SPEC_ID_PATTERN.test(specId)) throw new SpecStoreError(`invalid specId ${JSON.stringify(specId)}`)
		return path.join(this.specsRoot, specId, ".revisions")
	}

	private revisionPath(specId: string, revisionId: string): string {
		const m = HEX_ID.exec(revisionId)
		if (!m) throw new SpecStoreError(`invalid revisionId ${JSON.stringify(revisionId)}`)
		return path.join(this.specDir(specId), `${m[1]}.json`)
	}

	/** Write-once. Re-saving identical content is a no-op; differing content under one id is impossible by construction. */
	async saveRevision(revision: SpecRevision): Promise<void> {
		const parsed = specRevisionSchema.parse(revision)
		if (!verifyRevisionId(parsed)) throw new SpecStoreError("revisionId does not match content")
		const final = this.revisionPath(parsed.specId, parsed.revisionId)
		await fs.mkdir(path.dirname(final), { recursive: true })
		const tmp = `${final}.${process.pid}.${Date.now()}.tmp`
		await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), { flag: "wx" })
		try {
			// `link` fails with EEXIST rather than overwriting: a revision is never mutated.
			await fs.link(tmp, final)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		} finally {
			await fs.rm(tmp, { force: true })
		}
	}

	async loadRevision(specId: string, revisionId: string): Promise<SpecRevision> {
		const file = this.revisionPath(specId, revisionId)
		let raw: string
		try {
			raw = await fs.readFile(file, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SpecStoreError(`revision ${revisionId} not found`)
			throw error
		}
		const revision = specRevisionSchema.parse(JSON.parse(raw))
		if (revision.revisionId !== revisionId || !verifyRevisionId(revision)) {
			throw new SpecStoreError(`revision ${revisionId} failed integrity verification`)
		}
		return revision
	}

	async listRevisionIds(specId: string): Promise<string[]> {
		try {
			const names = await fs.readdir(this.specDir(specId))
			return names
				.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
				.map((n) => `sha256:${n.slice(0, 64)}`)
				.sort()
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
			throw error
		}
	}

	/** Newest-first chain via `parentRevisionId`, guarded against cycles and missing parents. */
	async lineage(specId: string, revisionId: string): Promise<SpecRevision[]> {
		const out: SpecRevision[] = []
		const seen = new Set<string>()
		let next: string | undefined = revisionId
		while (next && !seen.has(next)) {
			seen.add(next)
			const rev = await this.loadRevision(specId, next)
			out.push(rev)
			next = rev.parentRevisionId
		}
		return out
	}

	private async appendJsonl(specId: string, name: string, record: unknown): Promise<void> {
		const dir = this.specDir(specId)
		await fs.mkdir(dir, { recursive: true })
		await fs.appendFile(path.join(dir, name), `${canonicalJson(record)}\n`, "utf8")
	}

	private async readJsonl<T>(specId: string, name: string, parse: (v: unknown) => T): Promise<{ records: T[]; skipped: number }> {
		let raw: string
		try {
			raw = await fs.readFile(path.join(this.specDir(specId), name), "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 }
			throw error
		}
		const records: T[] = []
		let skipped = 0
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue
			try {
				records.push(parse(JSON.parse(line)))
			} catch {
				// A torn final line from an interrupted append must not poison earlier records.
				skipped++
			}
		}
		return { records, skipped }
	}

	async appendEvidence(record: SpecEvidenceRecord): Promise<void> {
		const parsed = specEvidenceRecordSchema.parse(record)
		const specId = await this.specIdOfRevision(parsed.revisionId)
		await this.appendJsonl(specId, "evidence.jsonl", parsed)
	}

	async readEvidence(specId: string): Promise<{ records: SpecEvidenceRecord[]; skipped: number }> {
		return this.readJsonl(specId, "evidence.jsonl", (v) => specEvidenceRecordSchema.parse(v))
	}

	async recordApproval(specId: string, approval: SpecApproval): Promise<void> {
		await this.loadRevision(specId, approval.revisionId) // can only approve a revision that exists and verifies
		await this.appendJsonl(specId, "approvals.jsonl", specApprovalSchema.parse(approval))
	}

	async findApproval(specId: string, revisionId: string): Promise<SpecApproval | undefined> {
		const { records } = await this.readJsonl(specId, "approvals.jsonl", (v) => specApprovalSchema.parse(v))
		return records.filter((a) => a.revisionId === revisionId).at(-1)
	}

	/** Evidence records carry only the revisionId; resolve the owning spec by scanning known spec dirs. */
	private async specIdOfRevision(revisionId: string): Promise<string> {
		const m = HEX_ID.exec(revisionId)
		if (!m) throw new SpecStoreError(`invalid revisionId ${JSON.stringify(revisionId)}`)
		let dirs: string[]
		try {
			dirs = await fs.readdir(this.specsRoot)
		} catch {
			throw new SpecStoreError(`unknown revision ${revisionId}`)
		}
		for (const dir of dirs) {
			if (!SPEC_ID_PATTERN.test(dir)) continue
			try {
				await fs.access(path.join(this.specsRoot, dir, ".revisions", `${m[1]}.json`))
				return dir
			} catch {
				// keep looking
			}
		}
		throw new SpecStoreError(`evidence references unknown revision ${revisionId}`)
	}
}
