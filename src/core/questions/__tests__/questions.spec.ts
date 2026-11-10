import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { assistQuestion, rememberAnswer } from "../questionAssist"
import { decideQuestion } from "../questionGate"
import { MEMORY_DIR, QuestionMemory } from "../QuestionMemory"
import { conversationDocs, gatherDocs, rankPassages } from "../QuestionSources"
import { jaccard, looksSecret, normalizeQuestion, questionSimilarity, tokenSet } from "../questionText"

describe("questionText", () => {
	it("treats reordered and inflected paraphrases as the same question", () => {
		expect(normalizeQuestion("Which databases should we use?")).toBe(normalizeQuestion("Should we use which database"))
		expect(jaccard(tokenSet("Which test framework should I use?"), tokenSet("What test framework to use"))).toBeGreaterThanOrEqual(0.5)
	})
	it("does not conflate different questions", () => {
		expect(jaccard(tokenSet("Which database should we use?"), tokenSet("Which cache should we use?"))).toBeLessThan(0.75)
	})
	it("matches a question contained in a longer one, but not a different topic or a bare word", () => {
		const sim = (a: string, b: string) => questionSimilarity(tokenSet(a), tokenSet(b))
		expect(sim("Which test framework should I use?", "Which test framework should I use for the project?")).toBeGreaterThanOrEqual(0.75)
		expect(sim("Which cache should we use for sessions?", "Which database should we use for sessions?")).toBeLessThan(0.75)
		expect(sim("Should tests run in CI?", "Should tests run locally?")).toBeLessThan(0.75)
		expect(sim("Database?", "Which database should we use?")).toBe(0)
	})
	it("detects credentials", () => {
		for (const s of ["my key is sk-abcdefghijklmnop1234", "password: hunter2hunter2", "token=abcdef123456", "ghp_abcdefghijklmnopqrstuvwx", "-----BEGIN RSA PRIVATE KEY-----"]) {
			expect(looksSecret(s), s).toBe(true)
		}
		for (const s of ["use postgres", "the staging environment", "src/core/tools/Foo.ts"]) expect(looksSecret(s), s).toBe(false)
	})
})

describe("QuestionMemory", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "qmem-"))
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("stores an answer with provenance and finds it for a paraphrase", async () => {
		const m = new QuestionMemory(root, () => 1000)
		expect((await m.record("Which database should we use for sessions?", "Postgres", "task-1")).recorded).toBe(true)
		const hit = await m.find("What database should we use for the sessions")
		expect(hit).toMatchObject({ answer: "Postgres", taskId: "task-1", answeredAt: 1000 })
	})

	it("does not match a different question or a one-word question", async () => {
		const m = new QuestionMemory(root)
		await m.record("Which database should we use for sessions?", "Postgres")
		expect(await m.find("Which cache should we use for sessions?")).toBeUndefined()
		await m.record("Database?", "Postgres")
		expect(await m.find("Database?")).toBeUndefined()
	})

	it("replaces an old answer to the same question and counts uses", async () => {
		const m = new QuestionMemory(root)
		await m.record("Which database should we use?", "MySQL")
		await m.record("Which database should we use?", "Postgres")
		const all = await m.list()
		expect(all).toHaveLength(1)
		expect(all[0].answer).toBe("Postgres")
		await m.markUsed(all[0].id)
		expect((await m.list())[0].uses).toBe(1)
	})

	it("never stores secrets, empty or oversize answers", async () => {
		const m = new QuestionMemory(root)
		expect(await m.record("What is the API key?", "sk-abcdefghijklmnop1234567")).toEqual({ recorded: false, reason: "secret" })
		expect(await m.record("Which one?", "  ")).toEqual({ recorded: false, reason: "empty" })
		expect(await m.record("Explain", "x".repeat(700))).toEqual({ recorded: false, reason: "too-long" })
		expect(await m.list()).toEqual([])
	})

	it("treats a corrupt file as empty memory and recovers on the next write", async () => {
		const dir = path.join(root, MEMORY_DIR)
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(path.join(dir, "questions.json"), "{not json")
		const m = new QuestionMemory(root)
		expect(await m.list()).toEqual([])
		await m.record("Which framework do we use?", "Vitest")
		expect(await m.list()).toHaveLength(1)
	})

	it("writes a readable markdown projection and can forget an entry", async () => {
		const m = new QuestionMemory(root, () => Date.UTC(2026, 10, 10))
		const r = await m.record("Which framework do we use?", "Vitest", "abcdef123456")
		const md = await fs.readFile(path.join(root, MEMORY_DIR, "answered-questions.md"), "utf8")
		expect(md).toContain("## Which framework do we use?")
		expect(md).toContain("Answer: Vitest")
		expect(md).toContain("2026-11-10")
		if (!r.recorded) throw new Error("fixture")
		expect(await m.forget(r.entry.id)).toBe(true)
		expect(await m.list()).toEqual([])
	})

	it("keeps at most 200 entries, newest first", async () => {
		const m = new QuestionMemory(root)
		for (let i = 0; i < 205; i++) await m.record(`Question number ${i} alpha${i} beta${i}?`, `answer ${i}`)
		const all = await m.list()
		expect(all).toHaveLength(200)
		expect(all[0].answer).toBe("answer 204")
	})
})

describe("sources and ranking", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "qsrc-"))
		await fs.mkdir(path.join(root, ".kiro/specs/auth"), { recursive: true })
		await fs.mkdir(path.join(root, ".kiro/steering"), { recursive: true })
		await fs.writeFile(path.join(root, "README.md"), "# App\n\nThis is a demo.\n")
		await fs.writeFile(path.join(root, ".kiro/steering/stack.md"), "# Stack\n\nWe use Postgres as the session database and Vitest for the test framework.\n")
		await fs.writeFile(path.join(root, ".kiro/specs/auth/design.md"), "# Design\n\nSessions expire after thirty minutes of inactivity. Rate limiting uses a token bucket per IP address.\n")
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("reads README, steering and spec docs", async () => {
		const labels = (await gatherDocs(root)).map((d) => d.label)
		expect(labels).toEqual(expect.arrayContaining(["README.md", ".kiro/steering/stack.md", ".kiro/specs/auth/design.md"]))
	})

	it("finds the passage that covers the question and ignores unrelated docs", async () => {
		const docs = await gatherDocs(root)
		const hits = rankPassages("Which database and test framework should the sessions use?", [], docs)
		expect(hits[0].label).toBe(".kiro/steering/stack.md")
		expect(rankPassages("What color should the logo be?", [], docs)).toEqual([])
	})

	it("uses the original request and later user replies, not assistant text", () => {
		const docs = conversationDocs([
			{ type: "say", say: "task", text: "Build the billing page using Stripe" },
			{ type: "say", say: "text", text: "I will use PayPal" },
			{ type: "say", say: "user_feedback", text: "Use the sandbox account" },
		])
		expect(docs.map((d) => d.label)).toEqual(["your original request", "your earlier reply in this conversation"])
		const hits = rankPassages("Which payment provider should the billing page use, Stripe or PayPal?", ["Stripe", "PayPal"], docs)
		expect(hits[0].label).toBe("your original request")
	})

	it("does not follow a symlink out of the workspace", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "qout-"))
		await fs.writeFile(path.join(outside, "secret.md"), "internal secret staging database postgres credentials")
		await fs.symlink(path.join(outside, "secret.md"), path.join(root, "AGENTS.md"))
		const labels = (await gatherDocs(root)).map((d) => d.label)
		expect(labels).not.toContain("AGENTS.md")
		await fs.rm(outside, { recursive: true, force: true })
	})
})

describe("decideQuestion / assistQuestion", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "qassist-"))
		await fs.mkdir(path.join(root, ".kiro/steering"), { recursive: true })
		await fs.writeFile(path.join(root, ".kiro/steering/stack.md"), "# Stack\n\nWe use Postgres as the session database and Vitest for the test framework.\n")
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	const base = (over = {}) => ({ workspaceRoot: root, messages: [], question: "Which test framework should I use?", suggestions: [] as string[], handled: new Set<string>(), ...over })

	it("answers from memory without asking, and marks it used", async () => {
		const memory = new QuestionMemory(root)
		await memory.record("Which test framework should I use for the project?", "Vitest")
		const out = await assistQuestion(base({ memory }))
		expect(out).toMatchObject({ action: "answer" })
		if (out.action === "answer") expect(out.text).toContain("Vitest")
		expect((await memory.list())[0].uses).toBe(1)
	})

	it("consults docs once, then lets the same question through to the user", async () => {
		const handled = new Set<string>()
		const first = await assistQuestion(base({ handled, question: "Which database and test framework do the sessions use?" }))
		expect(first.action).toBe("consult")
		if (first.action === "consult") expect(first.text).toContain(".kiro/steering/stack.md")
		const again = await assistQuestion(base({ handled, question: "Which database and test framework do the sessions use?" }))
		expect(again.action).toBe("ask")
	})

	it("a repeated question after a memory answer also reaches the user (no loop)", async () => {
		const handled = new Set<string>()
		const memory = new QuestionMemory(root)
		await memory.record("Which test framework should I use for the project?", "Vitest")
		expect((await assistQuestion(base({ handled, memory }))).action).toBe("answer")
		expect((await assistQuestion(base({ handled, memory }))).action).toBe("ask")
	})

	it("asks when nothing relevant exists", async () => {
		expect((await assistQuestion(base({ question: "What should the onboarding tooltip say?" }))).action).toBe("ask")
	})

	it("only reuses a stored free-text answer when it still fits the offered options", () => {
		const entry = { id: "i", question: "Which database?", normalized: "database", answer: "MySQL", answeredAt: 1, uses: 0 }
		const input = { question: "Which database?", normalized: "database", passages: [], alreadyHandled: new Set<string>(), remembered: entry }
		expect(decideQuestion({ ...input, suggestions: ["Postgres", "SQLite"] }).action).toBe("ask")
		expect(decideQuestion({ ...input, suggestions: ["MySQL", "Postgres"] }).action).toBe("reuse")
		expect(decideQuestion({ ...input, suggestions: [] }).action).toBe("reuse")
	})

	it("falls back to asking when the workspace is unreadable", async () => {
		expect((await assistQuestion(base({ workspaceRoot: path.join(root, "does", "not", "exist") }))).action).toBe("ask")
	})

	it("rememberAnswer stores a real answer and refuses a secret", async () => {
		expect(await rememberAnswer(root, "Which test framework do we use?", "Vitest", "t1")).toBe(true)
		expect(await rememberAnswer(root, "What is the token?", "token=abcdef123456789", "t1")).toBe(false)
	})
})
