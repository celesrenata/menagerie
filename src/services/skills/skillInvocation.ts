import type { SkillContent } from "../../shared/skills"

export interface HubSkillLookup {
	load(nameOrLocation: string): Promise<{ name: string; description: string; content: string; source: string } | null>
}

export interface SkillLookup {
	getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null>
}

export async function resolveSkillContentForMode(
	skillsManager: SkillLookup | undefined,
	skillName: string,
	currentMode: string,
	hubSkills?: HubSkillLookup,
): Promise<SkillContent | null> {
	// Local filesystem skills win over hub skills with the same name.
	const local = skillsManager ? await skillsManager.getSkillContent(skillName, currentMode) : null
	if (local || !hubSkills) {
		return local
	}

	const hub = await hubSkills.load(skillName)
	if (!hub) {
		return null
	}

	return {
		name: hub.name,
		description: hub.description,
		path: `omniroute-hub:${skillName}`,
		// Reported as "omniroute-hub" in the approval message; SkillMetadata only types the local sources.
		source: hub.source as SkillContent["source"],
		instructions: hub.content,
	}
}

type SkillContentForFormatting = Pick<SkillContent, "source" | "description" | "instructions">

export function buildSkillApprovalMessage(
	skillName: string,
	args: string | undefined,
	skillContent: Pick<SkillContent, "source" | "description">,
): string {
	return JSON.stringify({
		tool: "skill",
		skill: skillName,
		args,
		source: skillContent.source,
		description: skillContent.description,
	})
}

export function buildSkillResult(
	skillName: string,
	args: string | undefined,
	skillContent: SkillContentForFormatting,
): string {
	let result = `Skill: ${skillName}`

	if (skillContent.description) {
		result += `\nDescription: ${skillContent.description}`
	}

	if (args) {
		result += `\nProvided arguments: ${args}`
	}

	result += `\nSource: ${skillContent.source}`
	result += `\n\n--- Skill Instructions ---\n\n${skillContent.instructions}`

	return result
}
