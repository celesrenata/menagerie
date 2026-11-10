import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { WorkerResult } from "@roo-code/types"
import { describe, expect, it } from "vitest"

import { allowNetConnect } from "../../../vitest.setup"
import { extractFileCitations } from "../evidenceAdapter"
import { analyzeReaderResults } from "../AnalysisService"

/**
 * Optional live check of the whole reader -> analysis path through a real route (e.g. OmniRoute).
 * Skipped unless MENAGERIE_ANALYSIS_BASE_URL and MENAGERIE_ANALYSIS_MODEL are set; the key, if any,
 * comes from MENAGERIE_ANALYSIS_API_KEY. Nothing here is a source constant.
 */
const live = process.env.MENAGERIE_ANALYSIS_BASE_URL && process.env.MENAGERIE_ANALYSIS_MODEL ? describe : describe.skip

live("AnalysisService live", () => {
	it("analyzes a prose reader result by mining its verified citation", async () => {
		allowNetConnect()
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-live-"))
		await fs.mkdir(path.join(root, "src"))
		await fs.writeFile(
			path.join(root, "src/cache.ts"),
			"// Entries expire after ttlMs.\nexport const ttlMs = 30 * 60 * 1000\nexport function isExpired(at: number, now: number) {\n\treturn now - at > ttlMs\n}\n",
		)
		const prose = "Session expiry is implemented in src/cache.ts:1-5."
		const result: WorkerResult = {
			status: "completed",
			summary: prose,
			findings: [],
			evidence: extractFileCitations(prose),
			changes: [],
			tests: [],
			blockers: [],
			artifacts: [],
		}
		const out = await analyzeReaderResults({ batchId: "live", workspaceRoot: root, readers: [{ name: "reader", result }], required: false })
		expect(out.status).toBe("analyzed")
		if (out.status === "analyzed") {
			expect(out.items[0].status).toBe("valid")
		}
		await fs.rm(root, { recursive: true, force: true })
	}, 180_000)
})
