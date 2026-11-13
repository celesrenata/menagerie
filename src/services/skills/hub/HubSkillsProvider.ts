import { DEFAULT_SKILL_HUB_ENABLED, DEFAULT_SKILL_HUB_MAX_SKILLS, type SkillHubSkillMode } from "@roo-code/types"

import { SkillHubClient, SkillHubError, type HubSkillContent, type HubSkillSummary } from "./SkillHubClient"
import { resolveHubSkillSelection } from "./resolveHubSkillSelection"

export const HUB_SKILL_SOURCE = "omniroute-hub"
export const HUB_SKILL_LOCATION_PREFIX = `${HUB_SKILL_SOURCE}:`

/** Settings snapshot read at call time so a saved change applies to the next turn. */
export interface HubSkillsConfig {
	enabled?: boolean
	baseUrl?: string
	apiKey?: string
	maxSkills?: number
	modes?: Record<string, SkillHubSkillMode>
}

export interface HubSkillsProviderOptions {
	getConfig: () => HubSkillsConfig | Promise<HubSkillsConfig>
	/** Origin to use when `baseUrl` is blank (the active OmniRoute profile). */
	getFallbackBaseUrl?: () => string | undefined | Promise<string | undefined>
	clientFactory?: (options: { baseUrl: string; apiKey: string }) => Pick<SkillHubClient, "search" | "list" | "load">
	catalogTtlMs?: number
	now?: () => number
}

const DEFAULT_CATALOG_TTL_MS = 60_000
const MAX_CACHED_TASKS = 50

/** Resolves which Skill Hub skills a task sees. Every failure degrades to manual-on only. */
export class HubSkillsProvider {
	private catalogCache?: { key: string; at: number; skills: HubSkillSummary[] }
	private readonly autoByTask = new Map<string, HubSkillSummary[]>()
	private readonly known = new Map<string, HubSkillSummary>()
	private readonly ttl: number
	private readonly now: () => number

	constructor(private readonly options: HubSkillsProviderOptions) {
		this.ttl = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
		this.now = options.now ?? Date.now
	}

	/** Catalog for the settings UI. Throws a typed {@link SkillHubError} so the UI can show the reason. */
	async getCatalog(forceRefresh = false): Promise<HubSkillSummary[]> {
		const client = await this.createClient()
		if (!client) {
			return []
		}
		const key = client.key
		const cached = this.catalogCache
		if (!forceRefresh && cached && cached.key === key && this.now() - cached.at < this.ttl) {
			return cached.skills
		}
		const skills = await client.client.list()
		this.catalogCache = { key, at: this.now(), skills }
		for (const skill of skills) {
			this.known.set(skill.id, skill)
		}
		return skills
	}

	/**
	 * Hub skills offered to one task. `taskText` seeds the auto search once per task id.
	 * Never throws: a failing hub yields only what could be resolved without it.
	 */
	async resolveForTask(
		taskId: string,
		taskText: string,
		localSkillNames: Iterable<string>,
	): Promise<HubSkillSummary[]> {
		const config = await this.options.getConfig()
		if (!(config.enabled ?? DEFAULT_SKILL_HUB_ENABLED)) {
			return []
		}
		const modes = config.modes ?? {}
		const maxSkills = config.maxSkills ?? DEFAULT_SKILL_HUB_MAX_SKILLS
		const hasManualOn = Object.values(modes).includes("on")

		let catalog: HubSkillSummary[] = []
		if (hasManualOn) {
			catalog = await this.getCatalog().catch(() => [])
		}

		let autoHits = this.autoByTask.get(taskId) ?? []
		if (!this.autoByTask.has(taskId) && maxSkills > 0) {
			const found = await this.searchForTask(taskText, maxSkills + Object.keys(modes).length)
			if (found) {
				// A failed search (undefined) is not cached, so the next turn retries.
				autoHits = found
				this.rememberAuto(taskId, found)
			}
		}

		const selection = resolveHubSkillSelection({ catalog, autoHits, modes, maxSkills, localSkillNames })
		for (const skill of selection) {
			this.known.set(skill.id, skill)
		}
		return selection
	}

	/** Loads a skill by `omniroute-hub:<id>` or by a name seen in an earlier selection. */
	async load(nameOrLocation: string): Promise<(HubSkillContent & { source: string }) | null> {
		const config = await this.options.getConfig()
		if (!(config.enabled ?? DEFAULT_SKILL_HUB_ENABLED)) {
			return null
		}
		const id = this.resolveId(nameOrLocation)
		if (!id || config.modes?.[id] === "off") {
			return null
		}
		const created = await this.createClient()
		if (!created) {
			return null
		}
		try {
			const loaded = await created.client.load(id)
			return { ...loaded, source: HUB_SKILL_SOURCE }
		} catch (error) {
			if (error instanceof SkillHubError && error.code === "not_found") {
				return null
			}
			throw error
		}
	}

	private resolveId(nameOrLocation: string): string | undefined {
		if (nameOrLocation.startsWith(HUB_SKILL_LOCATION_PREFIX)) {
			return nameOrLocation.slice(HUB_SKILL_LOCATION_PREFIX.length) || undefined
		}
		const wanted = nameOrLocation.toLowerCase()
		for (const skill of this.known.values()) {
			if (skill.name.toLowerCase() === wanted) {
				return skill.id
			}
		}
		return undefined
	}

	private async searchForTask(taskText: string, limit: number): Promise<HubSkillSummary[] | undefined> {
		try {
			const created = await this.createClient()
			return created ? await created.client.search(taskText, limit) : []
		} catch {
			return undefined
		}
	}

	private rememberAuto(taskId: string, hits: HubSkillSummary[]): void {
		this.autoByTask.set(taskId, hits)
		if (this.autoByTask.size > MAX_CACHED_TASKS) {
			const oldest = this.autoByTask.keys().next().value
			if (oldest !== undefined) {
				this.autoByTask.delete(oldest)
			}
		}
	}

	private async createClient(): Promise<
		{ client: Pick<SkillHubClient, "search" | "list" | "load">; key: string } | undefined
	> {
		const config = await this.options.getConfig()
		const apiKey = config.apiKey?.trim()
		const baseUrl = config.baseUrl?.trim() || (await this.options.getFallbackBaseUrl?.())?.trim()
		// The Bearer key is sent to this origin only, so accept http(s) URLs and nothing else.
		if (!apiKey || !baseUrl || !/^https?:\/\//i.test(baseUrl) || originOf(baseUrl) === undefined) {
			return undefined
		}
		const factory = this.options.clientFactory ?? ((o) => new SkillHubClient(o))
		// The cache key holds the URL only; the key never leaves this scope.
		return { client: factory({ baseUrl, apiKey }), key: baseUrl }
	}
}

/** Origin of an OpenAI-compatible base URL such as `http://host:20128/v1`. Undefined if unparsable. */
export function originOf(url: string | undefined): string | undefined {
	if (!url) {
		return undefined
	}
	try {
		return new URL(url).origin
	} catch {
		return undefined
	}
}
