import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { allowNetConnect } from "../../../vitest.setup"
import { assistWithReader } from "../questionAssist"
import { completeOnAnalysisRoute } from "../../../services/analysis/AnalysisService"

/**
 * Optional live check of the low reader lane. Skipped unless MENAGERIE_ANALYSIS_BASE_URL and
 * MENAGERIE_ANALYSIS_MODEL are set (the key, if any, comes from MENAGERIE_ANALYSIS_API_KEY).
 * Nothing here is a source constant.
 */
const live = process.env.MENAGERIE_ANALYSIS_BASE_URL && process.env.MENAGERIE_ANALYSIS_MODEL ? describe : describe.skip
live("reader-assisted question, live low lane", () => {
	it("answers from the original request and a design doc, with verified citations", async () => {
		allowNetConnect()
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "reader-live-"))
		try {
			await fs.mkdir(path.join(root, "docs/architecture"), { recursive: true })
			await fs.writeFile(path.join(root, "docs/architecture/sessions.md"), "# Sessions\n\nSessions are stored in Postgres. Redis is not used for sessions.\n")
			const result = await assistWithReader(
				{
					workspaceRoot: root,
					messages: [{ type: "say", say: "task", text: "Add login. Follow the design docs for storage." }],
					question: "Which database stores the sessions?",
					suggestions: ["Postgres", "Redis"],
					handled: new Set<string>(),
				},
				{
					complete: async (messages, maxTokens) => {
						const done = await completeOnAnalysisRoute({ messages, maxTokens })
						return done.kind === "ok" ? { kind: "ok", content: done.content } : done
					},
				},
			)
			expect(result.action).toBe("answer")
			if (result.action === "answer") {
				expect(result.lane).toBe("low")
				expect(result.text).toMatch(/postgres/i)
				expect(result.text).toContain("docs/architecture/sessions.md")
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	}, 90_000)
})
