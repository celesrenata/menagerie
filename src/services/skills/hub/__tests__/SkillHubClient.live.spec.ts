import { describe, expect, it } from "vitest"

import { allowNetConnect } from "../../../../vitest.setup"
import { HubSkillsProvider } from "../HubSkillsProvider"
import { SkillHubClient, SkillHubError } from "../SkillHubClient"

/**
 * Optional live check against a running OmniRoute. Skipped unless MENAGERIE_SKILLHUB_URL and
 * MENAGERIE_SKILLHUB_KEY are set. MENAGERIE_SKILLHUB_DENIED_KEY (an inference-only key) and
 * MENAGERIE_SKILLHUB_SKILL_ID (an installed skill) are optional. Keys are never logged.
 */
const baseUrl = process.env.MENAGERIE_SKILLHUB_URL
const apiKey = process.env.MENAGERIE_SKILLHUB_KEY
const deniedKey = process.env.MENAGERIE_SKILLHUB_DENIED_KEY
const skillId = process.env.MENAGERIE_SKILLHUB_SKILL_ID ?? "imported:demo/demo-hub-skill"
const live = baseUrl && apiKey ? describe : describe.skip

live("Skill Hub client, live OmniRoute", () => {
	it("searches and loads with the secondary key (same search as omr_skill_search)", async () => {
		allowNetConnect()
		const client = new SkillHubClient({ baseUrl: baseUrl!, apiKey: apiKey! })
		const hits = await client.search("demo hub skill", 10)
		console.log("[live] search ids:", hits.map((h) => h.id).join(", "))
		expect(hits.map((h) => h.id)).toContain(skillId)
		const loaded = await client.load(skillId)
		console.log("[live] load:", loaded.id, "content chars:", loaded.content.length)
		expect(loaded.content.length).toBeGreaterThan(0)
	})

	it("resolves manual on/off plus auto for a task", async () => {
		allowNetConnect()
		const provider = new HubSkillsProvider({
			getConfig: () => ({
				enabled: true,
				baseUrl,
				apiKey,
				maxSkills: 3,
				modes: { "builtin:cli-mcp": "on", [skillId]: "off" },
			}),
		})
		const selection = await provider.resolveForTask("task-live-1", "demo hub skill", [])
		const ids = selection.map((s) => s.id)
		console.log("[live] resolveForTask (max 3, cli-mcp=on, demo=off):", ids.join(", "))
		expect(ids[0]).toBe("builtin:cli-mcp")
		expect(ids).not.toContain(skillId)
		expect(ids.length).toBeLessThanOrEqual(3)
	})

	it.runIf(Boolean(deniedKey))("surfaces a typed forbidden error for an inference-only key", async () => {
		allowNetConnect()
		const client = new SkillHubClient({ baseUrl: baseUrl!, apiKey: deniedKey! })
		const error = await client.search("demo", 5).catch((e: unknown) => e)
		console.log("[live] inference key:", error instanceof SkillHubError ? `${error.code} ${error.status}` : error)
		expect(error).toBeInstanceOf(SkillHubError)
		expect((error as SkillHubError).code).toBe("forbidden")
	})
})
