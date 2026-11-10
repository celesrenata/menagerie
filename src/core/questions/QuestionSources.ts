import * as fs from "fs/promises"
import * as path from "path"

import { coverage, tokenSet } from "./questionText"

/**
 * Where an already-answerable question might be answered, without asking the user:
 * the conversation so far (initial prompt, earlier replies) and the dedicated docs the assistant
 * is told to work from (README/AGENTS, steering, specs, rules). Retrieval is deterministic token
 * overlap, bounded in files, bytes and passages. It never decides an answer; it surfaces passages.
 */
export interface SourceDoc {
	/** Human label, e.g. `.kiro/specs/foo/design.md` or `your original request`. */
	label: string
	text: string
	/** Conversation docs are weighted slightly above static docs: the user said it for this task. */
	kind: "conversation" | "doc"
}

export interface Passage {
	label: string
	startLine: number
	endLine: number
	text: string
	shared: number
	ratio: number
	kind: SourceDoc["kind"]
}

const ROOT_FILES = ["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]
const DIR_GLOBS: Array<{ dir: string; match: RegExp }> = [
	{ dir: ".kiro/steering", match: /\.md$/i },
	{ dir: ".roo/rules", match: /\.(md|txt)$/i },
]
const SPEC_FILES = ["requirements.md", "design.md", "tasks.md"]
const MAX_FILES = 40
const MAX_BYTES_PER_FILE = 64 * 1024
const MAX_PASSAGE_CHARS = 600
const WINDOW_LINES = 8

async function readBounded(root: string, rel: string): Promise<string | undefined> {
	try {
		const realRoot = await fs.realpath(root)
		const real = await fs.realpath(path.resolve(realRoot, rel))
		if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined // symlink escape
		const handle = await fs.open(real, "r")
		try {
			const buf = Buffer.alloc(MAX_BYTES_PER_FILE)
			const { bytesRead } = await handle.read(buf, 0, MAX_BYTES_PER_FILE, 0)
			return buf.subarray(0, bytesRead).toString("utf8")
		} finally {
			await handle.close()
		}
	} catch {
		return undefined
	}
}

async function listDir(root: string, rel: string): Promise<string[]> {
	try {
		return (await fs.readdir(path.join(root, rel))).sort()
	} catch {
		return []
	}
}

export async function gatherDocs(workspaceRoot: string): Promise<SourceDoc[]> {
	const candidates: string[] = [...ROOT_FILES]
	for (const { dir, match } of DIR_GLOBS) {
		for (const name of await listDir(workspaceRoot, dir)) if (match.test(name)) candidates.push(`${dir}/${name}`)
	}
	for (const spec of await listDir(workspaceRoot, ".kiro/specs")) {
		if (spec.startsWith(".")) continue
		for (const f of SPEC_FILES) candidates.push(`.kiro/specs/${spec}/${f}`)
	}
	const docs: SourceDoc[] = []
	for (const rel of candidates.slice(0, MAX_FILES)) {
		const text = await readBounded(workspaceRoot, rel)
		if (text) docs.push({ label: rel, text, kind: "doc" })
	}
	return docs
}

export interface ConversationMessageLike {
	type: string
	say?: string
	text?: string
}

/** The task's initial prompt (first message) plus the user's later replies. Assistant text is excluded: it is not an answer. */
export function conversationDocs(messages: readonly ConversationMessageLike[]): SourceDoc[] {
	const docs: SourceDoc[] = []
	messages.forEach((m, index) => {
		if (m.type !== "say" || !m.text?.trim()) return
		if (index === 0) docs.push({ label: "your original request", text: m.text, kind: "conversation" })
		else if (m.say === "user_feedback") docs.push({ label: "your earlier reply in this conversation", text: m.text, kind: "conversation" })
	})
	return docs
}

/** Split a doc into windows that respect blank-line boundaries, keeping 1-based line numbers. */
function* windows(text: string): Generator<{ startLine: number; endLine: number; text: string }> {
	const lines = text.split(/\r?\n/)
	let start = 0
	while (start < lines.length) {
		let end = Math.min(lines.length, start + WINDOW_LINES)
		// Prefer to end at a blank line inside the window so a thought is not cut in half.
		for (let i = end - 1; i > start + 2; i--) {
			if (lines[i].trim() === "") {
				end = i
				break
			}
		}
		const chunk = lines.slice(start, end).join("\n").trim()
		if (chunk) yield { startLine: start + 1, endLine: end, text: chunk }
		start = Math.max(end, start + 1)
	}
}

export interface RankOptions {
	/** Minimum distinct question tokens a passage must contain. */
	minShared?: number
	/** Minimum fraction of the question's tokens a passage must cover. */
	minRatio?: number
	limit?: number
}

export const STRONG_MIN_SHARED = 3
export const STRONG_MIN_RATIO = 0.6
/** A short message (e.g. the original request) that is mostly about the question's topic also counts. */
export const STRONG_MIN_PASSAGE_RATIO = 0.75

/** Passages that cover enough of the question to be worth reading before asking. Best first. */
export function rankPassages(question: string, suggestions: readonly string[], docs: readonly SourceDoc[], options: RankOptions = {}): Passage[] {
	const q = tokenSet(question)
	// Suggested answers describe the options; a passage naming the options is relevant too, at lower weight.
	const extra = tokenSet(suggestions.join(" "))
	for (const t of q) extra.delete(t)
	const minShared = options.minShared ?? STRONG_MIN_SHARED
	const minRatio = options.minRatio ?? STRONG_MIN_RATIO
	const found: Passage[] = []
	for (const doc of docs) {
		for (const w of windows(doc.text)) {
			const tokens = tokenSet(w.text)
			const { shared, ratio } = coverage(q, tokens)
			const optionHits = coverage(extra, tokens).shared
			const passageRatio = tokens.size > 0 ? shared / tokens.size : 0
			if (shared < minShared || (ratio < minRatio && passageRatio < STRONG_MIN_PASSAGE_RATIO)) continue
			if (extra.size > 0 && optionHits === 0 && ratio < 0.8 && passageRatio < STRONG_MIN_PASSAGE_RATIO) continue // question words alone are common; require an option or a near-full match
			found.push({ label: doc.label, startLine: w.startLine, endLine: w.endLine, text: w.text.slice(0, MAX_PASSAGE_CHARS), shared, ratio: ratio + (doc.kind === "conversation" ? 0.05 : 0), kind: doc.kind })
		}
	}
	return found.sort((a, b) => b.ratio - a.ratio || b.shared - a.shared).slice(0, options.limit ?? 3)
}
