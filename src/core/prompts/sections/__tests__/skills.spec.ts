import { getSkillsSection } from "../skills"
import type { EffectiveToolPolicy } from "../../tools/effective-tool-policy"

/** Build a policy advertising `tools` as logically available. */
function policyFor(tools: string[]): EffectiveToolPolicy {
	return {
		tools: new Set(tools),
		hasMcpGroup: false,
		hasMcpTools: false,
		hasMcpResources: false,
	}
}

describe("getSkillsSection", () => {
	it("should emit <available_skills> XML with name, description, and location", async () => {
		const mockSkillsManager = {
			getSkillsForMode: vi.fn().mockReturnValue([
				{
					name: "pdf-processing",
					description: "Extracts text & tables from PDFs",
					path: "/abs/path/pdf-processing/SKILL.md",
					source: "global" as const,
				},
			]),
		}

		const result = await getSkillsSection(mockSkillsManager, "code", policyFor(["skill"]))

		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
		expect(result).toContain("<skill>")
		expect(result).toContain("<name>pdf-processing</name>")
		// Ensure XML escaping for '&'
		expect(result).toContain("<description>Extracts text &amp; tables from PDFs</description>")
		// For filesystem-based agents, location should be the absolute path to SKILL.md
		expect(result).toContain("<location>/abs/path/pdf-processing/SKILL.md</location>")
	})

	it("should return empty string when skillsManager or currentMode is missing", async () => {
		await expect(getSkillsSection(undefined, "code", policyFor(["skill"]))).resolves.toBe("")
		await expect(getSkillsSection({ getSkillsForMode: vi.fn() }, undefined, policyFor(["skill"]))).resolves.toBe("")
	})

	it("should return empty string when the skill tool is disabled", async () => {
		const mockSkillsManager = {
			getSkillsForMode: vi.fn().mockReturnValue([
				{
					name: "pdf-processing",
					description: "Extracts text & tables from PDFs",
					path: "/abs/path/pdf-processing/SKILL.md",
					source: "global" as const,
				},
			]),
		}

		await expect(getSkillsSection(mockSkillsManager, "code", policyFor([]))).resolves.toBe("")
	})

	it("renders hub skills as extra entries with an omniroute-hub location", async () => {
		const manager = {
			getSkillsForMode: vi
				.fn()
				.mockReturnValue([{ name: "local-one", description: "Local", path: "/abs/local-one/SKILL.md" }]),
		}
		const result = await getSkillsSection(manager, "code", policyFor(["skill"]), [
			{ id: "h-1", name: "hub-one", description: "From <hub>" },
		])
		expect(result).toContain("<location>/abs/local-one/SKILL.md</location>")
		expect(result).toContain("<name>hub-one</name>")
		expect(result).toContain("<description>From &lt;hub&gt;</description>")
		expect(result).toContain("<location>omniroute-hub:h-1</location>")
	})

	it("emits hub skills even when there is no local skills manager", async () => {
		const result = await getSkillsSection(undefined, "code", policyFor(["skill"]), [
			{ id: "h-1", name: "hub-one", description: "d" },
		])
		expect(result).toContain("<location>omniroute-hub:h-1</location>")
	})

	it("stays empty with no local and no hub skills, or when the skill tool is off", async () => {
		await expect(getSkillsSection(undefined, "code", policyFor(["skill"]), [])).resolves.toBe("")
		await expect(
			getSkillsSection(undefined, "code", policyFor([]), [{ id: "h", name: "n", description: "d" }]),
		).resolves.toBe("")
	})
})
