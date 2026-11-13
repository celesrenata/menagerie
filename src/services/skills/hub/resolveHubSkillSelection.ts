import type { SkillHubSkillMode } from "@roo-code/types"

import type { HubSkillSummary } from "./SkillHubClient"

export interface ResolveHubSkillSelectionInput {
	/** Full hub catalog (used to resolve manual-on skills). */
	catalog: HubSkillSummary[]
	/** Ranked `omr_skill_search` hits for the current task. Empty when auto search is unavailable. */
	autoHits: HubSkillSummary[]
	/** Per-skill state keyed by hub skill id. Missing means auto. */
	modes: Record<string, SkillHubSkillMode> | undefined
	/** Total number of hub skills to offer. */
	maxSkills: number
	/** Names of local filesystem skills. A local skill wins over a hub skill with the same name. */
	localSkillNames: Iterable<string>
}

/**
 * Manual state always wins: `on` is included, `off` is never included, even if auto finds it.
 * Auto hits fill what is left of the budget in rank order. If manual-on alone exceeds the budget
 * every manual-on skill stays and auto adds nothing.
 */
export function resolveHubSkillSelection(input: ResolveHubSkillSelectionInput): HubSkillSummary[] {
	const { catalog, autoHits, modes, maxSkills } = input
	const localNames = new Set(Array.from(input.localSkillNames, (name) => name.toLowerCase()))
	const seenIds = new Set<string>()
	const seenNames = new Set<string>()
	const selected: HubSkillSummary[] = []

	const tryAdd = (skill: HubSkillSummary): void => {
		const nameKey = skill.name.toLowerCase()
		if (seenIds.has(skill.id) || seenNames.has(nameKey) || localNames.has(nameKey)) {
			return
		}
		seenIds.add(skill.id)
		seenNames.add(nameKey)
		selected.push(skill)
	}

	for (const skill of catalog) {
		if (modes?.[skill.id] === "on") {
			tryAdd(skill)
		}
	}

	const budget = Math.max(0, Math.floor(maxSkills))
	for (const skill of autoHits) {
		if (selected.length >= budget) {
			break
		}
		const mode = modes?.[skill.id]
		if (mode === "off" || mode === "on") {
			continue
		}
		tryAdd(skill)
	}

	return selected
}
