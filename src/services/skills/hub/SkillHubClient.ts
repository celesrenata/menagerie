export type SkillHubErrorCode = "auth" | "forbidden" | "not_found" | "http" | "network" | "timeout" | "invalid"

/** Typed hub failure. The message is fixed text and never contains the key or the raw response body. */
export class SkillHubError extends Error {
	constructor(
		readonly code: SkillHubErrorCode,
		message: string,
		readonly status?: number,
	) {
		super(message)
		this.name = "SkillHubError"
	}
}

export interface HubSkillSummary {
	id: string
	name: string
	description: string
}

export interface HubSkillContent extends HubSkillSummary {
	content: string
}

export interface SkillHubClientOptions {
	baseUrl: string
	apiKey: string
	timeoutMs?: number
	fetchImpl?: typeof fetch
}

export const SKILL_HUB_QUERY_MAX_CHARS = 500
/** A 403 alone cannot distinguish a key without the scope from a server that has no scoped-key support. */
export const SKILL_HUB_FORBIDDEN_MESSAGE =
	"Skill Hub refused the request (403). The key may lack the read:catalog scope, or this OmniRoute server may not support scoped keys yet (update OmniRoute to a build that does)."
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_FIELD_CHARS = 2_000
const MAX_CONTENT_CHARS = 200_000

/** Reads the OmniRoute `/api/skills/catalog` REST surface with a Bearer key (scope `read:catalog`). */
export class SkillHubClient {
	private readonly baseUrl: string
	private readonly apiKey: string
	private readonly timeoutMs: number
	private readonly fetchImpl: typeof fetch

	constructor(options: SkillHubClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "")
		this.apiKey = options.apiKey
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		this.fetchImpl = options.fetchImpl ?? fetch
	}

	async search(query: string, limit: number): Promise<HubSkillSummary[]> {
		const trimmed = query.trim().slice(0, SKILL_HUB_QUERY_MAX_CHARS)
		if (!trimmed) {
			return []
		}
		const params = new URLSearchParams({ query: trimmed, limit: String(Math.max(1, Math.min(20, limit))) })
		return this.readSummaries(await this.request(`/api/skills/catalog?${params.toString()}`))
	}

	/** Browse-all catalog (an empty query returns the whole catalog; 2000 is the server maximum for browse-all). */
	async list(): Promise<HubSkillSummary[]> {
		return this.readSummaries(await this.request("/api/skills/catalog?limit=2000"))
	}

	async load(id: string): Promise<HubSkillContent> {
		const body = await this.request("/api/skills/catalog", {
			method: "POST",
			body: JSON.stringify({ action: "load", id }),
		})
		const record = asRecord(body)
		const content = record?.content
		if (!record || typeof content !== "string" || typeof record.id !== "string") {
			throw new SkillHubError("invalid", "Skill Hub returned an unexpected response")
		}
		return {
			id: record.id,
			name: clip(record.name, MAX_FIELD_CHARS) || record.id,
			description: clip(record.description, MAX_FIELD_CHARS),
			content: content.slice(0, MAX_CONTENT_CHARS),
		}
	}

	private readSummaries(body: unknown): HubSkillSummary[] {
		const results = asRecord(body)?.results
		if (!Array.isArray(results)) {
			throw new SkillHubError("invalid", "Skill Hub returned an unexpected response")
		}
		const summaries: HubSkillSummary[] = []
		for (const item of results) {
			const record = asRecord(item)
			if (!record || typeof record.id !== "string" || typeof record.name !== "string") {
				continue
			}
			summaries.push({
				id: record.id,
				name: clip(record.name, MAX_FIELD_CHARS),
				description: clip(record.description, MAX_FIELD_CHARS),
			})
		}
		return summaries
	}

	private async request(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: init.method ?? "GET",
				body: init.body,
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					Accept: "application/json",
					...(init.body ? { "Content-Type": "application/json" } : {}),
				},
			})
			if (response.status === 401) {
				throw new SkillHubError("auth", "Skill Hub rejected the key (401)", 401)
			}
			if (response.status === 403) {
				throw new SkillHubError("forbidden", SKILL_HUB_FORBIDDEN_MESSAGE, 403)
			}
			if (response.status === 404) {
				throw new SkillHubError("not_found", "Skill not found on the hub (404)", 404)
			}
			if (!response.ok) {
				throw new SkillHubError("http", `Skill Hub request failed (${response.status})`, response.status)
			}
			const text = await response.text()
			if (text.length > MAX_RESPONSE_BYTES) {
				throw new SkillHubError("invalid", "Skill Hub response is too large")
			}
			try {
				return JSON.parse(text) as unknown
			} catch {
				throw new SkillHubError("invalid", "Skill Hub returned invalid JSON")
			}
		} catch (error) {
			if (error instanceof SkillHubError) {
				throw error
			}
			if (error instanceof Error && error.name === "AbortError") {
				throw new SkillHubError("timeout", "Skill Hub request timed out")
			}
			throw new SkillHubError("network", "Skill Hub is unreachable")
		} finally {
			clearTimeout(timer)
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function clip(value: unknown, max: number): string {
	return typeof value === "string" ? value.slice(0, max) : ""
}
