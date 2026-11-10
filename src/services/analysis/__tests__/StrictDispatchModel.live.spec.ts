import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { allowNetConnect } from "../../../vitest.setup"
import { makeParallelTasksSchema } from "../../../core/tools/ParallelTasksTool"
import { SpecRevisionStore } from "../../../core/specs/SpecRevisionStore"
import { approveSpecRevision, importSpecDraft, type SpecUi } from "../../../core/specs/specCommands"
import { checkStrictDispatch, SPECS_DIR } from "../../../core/specs/strictSpecRun"
import { baseContent } from "../../../core/specs/__tests__/specFixtures"
import { GraniteAnalysisClient, OMNIROUTE_ANALYSIS_HEADERS } from "../GraniteAnalysisClient"

/**
 * Optional live check: do real models, given what the mastermind would see (the strict rejection message
 * and the contents of dispatch.json as a read_file result), produce a parallel_tasks call that passes the
 * REAL tool schema and the REAL strict dispatch check? Skipped unless MENAGERIE_ANALYSIS_BASE_URL and
 * STRICT_DISPATCH_MODELS (comma separated) are set. STRICT_DISPATCH_SAMPLES defaults to 5 per model.
 */
const base = process.env.MENAGERIE_ANALYSIS_BASE_URL
const models = (process.env.STRICT_DISPATCH_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean)
const live = base && models.length > 0 ? describe : describe.skip

const ui = (): SpecUi => ({ chooseFile: async () => undefined, chooseRevision: async (items) => items[0]?.id, confirm: async () => true, info: () => {}, warn: () => {} })

live("strict dispatch with a real model", () => {
	for (const model of models) {
		it(`${model} copies dispatch.json into a valid, traced parallel_tasks call`, async () => {
			allowNetConnect()
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "strict-live-"))
			try {
				const specsRoot = path.join(root, SPECS_DIR)
				await fs.mkdir(path.join(specsRoot, "demo"), { recursive: true })
				const draft = path.join(specsRoot, "demo", "spec.draft.json")
				await fs.writeFile(draft, JSON.stringify(baseContent()))
				const imported = await importSpecDraft({ ui: ui(), workspaceRoot: root, file: draft })
				if (!imported.ok) throw new Error(imported.issues.join("; "))
				await approveSpecRevision({ ui: ui(), workspaceRoot: root })
				const dispatch = await fs.readFile(path.join(specsRoot, "demo", "dispatch.json"), "utf8")
				const store = new SpecRevisionStore(specsRoot)

				const client = new GraniteAnalysisClient({
					baseUrl: base!,
					model,
					apiKey: process.env.MENAGERIE_ANALYSIS_API_KEY,
					timeoutMs: 180_000,
					extraHeaders: OMNIROUTE_ANALYSIS_HEADERS,
				})
				const samples = Number(process.env.STRICT_DISPATCH_SAMPLES ?? 5)
				let valid = 0
				const failures: string[] = []
				for (let i = 0; i < samples; i++) {
					const reply = await client.complete(
						[
							{
								role: "system",
								content: "You are an orchestrator that delegates work with the parallel_tasks tool. Reply with ONLY the JSON arguments object for the tool call, no prose and no code fence.",
							},
							{
								role: "user",
								content: [
									"The user asked: run the approved spec 'demo'.",
									'Your previous parallel_tasks call was rejected: Task worker has no specTrace; the "strict" workflow policy only dispatches tasks compiled from an approved spec revision. Use the "tasks" array in .kiro/specs/<specId>/dispatch.json (written when the user approves a revision) unchanged',
									"Result of read_file on .kiro/specs/demo/dispatch.json:",
									dispatch,
									"Now make the parallel_tasks call.",
								].join("\n\n"),
							},
						],
						4_000,
					)
					try {
						const text = reply.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")
						const parsed = makeParallelTasksSchema(12).safeParse(JSON.parse(text))
						if (!parsed.success) throw new Error(`schema: ${parsed.error.issues[0]?.message}`)
						const check = await checkStrictDispatch(parsed.data.tasks, store)
						if (check.violations.length > 0) throw new Error(check.violations[0])
						valid++
					} catch (error) {
						failures.push(error instanceof Error ? error.message.slice(0, 120) : "unknown")
					}
				}
				await fs.writeFile(path.join(os.tmpdir(), `strict-dispatch-${model.replace(/[^\w]/g, "_")}.json`), JSON.stringify({ model, samples, valid, failures }))
				expect(valid).toBeGreaterThanOrEqual(Math.ceil(samples * 0.8))
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		}, 600_000)
	}
})
