import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import { looksSecret, normalizeQuestion, questionSimilarity, tokenSet } from "./questionText"

/**
 * Persistent memory of questions the user has already answered (project scope).
 *
 * Stored in the workspace as `.kiro/memory/questions.json` (machine state) with a generated
 * `.kiro/memory/answered-questions.md` projection that is also a searchable doc. Entries carry
 * provenance (who answered, in which task, when) so a reused answer is always attributable, and
 * can be deleted by editing the JSON. Answers that look like credentials are never stored.
 */
export const MEMORY_DIR = path.join(".kiro", "memory")
const MAX_ENTRIES = 200
const MAX_ANSWER_CHARS = 600
const MAX_QUESTION_CHARS = 400
/** Question similarity needed to treat a stored answer as an answer to the new question. */
export const MEMORY_MATCH_THRESHOLD = 0.75

export interface AnsweredQuestion {
	id: string
	question: string
	normalized: string
	answer: string
	taskId?: string
	answeredAt: number
	lastUsedAt?: number
	uses: number
}

export type RecordResult = { recorded: true; entry: AnsweredQuestion } | { recorded: false; reason: "secret" | "empty" | "too-long" }

const idOf = (normalized: string): string => createHash("sha256").update(normalized).digest("hex").slice(0, 16)

export class QuestionMemory {
	constructor(
		private readonly workspaceRoot: string,
		private readonly now: () => number = Date.now,
	) {}

	private get file(): string {
		return path.join(this.workspaceRoot, MEMORY_DIR, "questions.json")
	}

	async list(): Promise<AnsweredQuestion[]> {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.file, "utf8"))
			if (!Array.isArray(parsed)) return []
			return parsed.filter(isEntry)
		} catch {
			// Missing or corrupt memory is just an empty memory; it must never break asking a question.
			return []
		}
	}

	/** Best stored answer for a new question, or undefined. Prefers the most similar, then the most recent. */
	async find(question: string, threshold = MEMORY_MATCH_THRESHOLD): Promise<AnsweredQuestion | undefined> {
		const wanted = tokenSet(question)
		if (wanted.size < 2) return undefined // one-word questions are too ambiguous to reuse
		let best: { entry: AnsweredQuestion; score: number } | undefined
		for (const entry of await this.list()) {
			const score = questionSimilarity(wanted, tokenSet(entry.question))
			if (score >= threshold && (!best || score > best.score || (score === best.score && entry.answeredAt > best.entry.answeredAt))) {
				best = { entry, score }
			}
		}
		return best?.entry
	}

	async record(question: string, answer: string, taskId?: string): Promise<RecordResult> {
		const q = question.trim()
		const a = answer.trim()
		if (!q || !a) return { recorded: false, reason: "empty" }
		if (q.length > MAX_QUESTION_CHARS || a.length > MAX_ANSWER_CHARS) return { recorded: false, reason: "too-long" }
		if (looksSecret(a) || looksSecret(q)) return { recorded: false, reason: "secret" }
		const normalized = normalizeQuestion(q)
		const id = idOf(normalized)
		const entries = await this.list()
		const previous = entries.find((e) => e.id === id)
		const entry: AnsweredQuestion = { id, question: q, normalized, answer: a, taskId, answeredAt: this.now(), uses: previous?.uses ?? 0 }
		const next = [entry, ...entries.filter((e) => e.id !== id)].slice(0, MAX_ENTRIES)
		await this.write(next)
		return { recorded: true, entry }
	}

	async markUsed(id: string): Promise<void> {
		const entries = await this.list()
		const hit = entries.find((e) => e.id === id)
		if (!hit) return
		hit.uses++
		hit.lastUsedAt = this.now()
		await this.write(entries)
	}

	async forget(id: string): Promise<boolean> {
		const entries = await this.list()
		const next = entries.filter((e) => e.id !== id)
		if (next.length === entries.length) return false
		await this.write(next)
		return true
	}

	private async write(entries: AnsweredQuestion[]): Promise<void> {
		const dir = path.join(this.workspaceRoot, MEMORY_DIR)
		await fs.mkdir(dir, { recursive: true })
		await atomicWrite(this.file, JSON.stringify(entries, null, 2))
		await atomicWrite(path.join(dir, "answered-questions.md"), renderMarkdown(entries))
	}
}

function isEntry(v: unknown): v is AnsweredQuestion {
	const e = v as Partial<AnsweredQuestion> | null
	return !!e && typeof e.id === "string" && typeof e.question === "string" && typeof e.answer === "string" && typeof e.answeredAt === "number" && typeof e.uses === "number" && typeof e.normalized === "string"
}

async function atomicWrite(file: string, content: string): Promise<void> {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await fs.writeFile(tmp, content, "utf8")
	try {
		await fs.rename(tmp, file)
	} catch (error) {
		await fs.rm(tmp, { force: true })
		throw error
	}
}

function renderMarkdown(entries: readonly AnsweredQuestion[]): string {
	const lines = [
		"# Answered questions",
		"",
		"Generated from `questions.json`. Questions you already answered; the assistant reuses these instead of asking again.",
		"To forget one, delete its entry from `questions.json`.",
		"",
	]
	for (const e of entries) {
		lines.push(`## ${e.question.replace(/\s+/g, " ")}`, "", `Answer: ${e.answer.replace(/\s+/g, " ")}`, `Answered: ${new Date(e.answeredAt).toISOString().slice(0, 10)}${e.taskId ? ` (task ${e.taskId.slice(0, 8)})` : ""}`, "")
	}
	return lines.join("\n")
}
