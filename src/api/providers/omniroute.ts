import axios from "axios"
import {
	omniRouteComboEntrySchema,
	omniRouteTierSchema,
	providerIdentifiers,
	type OmniRouteCatalogEntry,
	type OmniRouteCatalogResponse,
	type ProviderSettings,
} from "@roo-code/types"

import { DEFAULT_HEADERS } from "./constants"

/**
 * OmniRoute client helpers.
 *
 * OmniRoute is not a distinct provider: an OmniRoute connection is an
 * OpenAI-compatible provider profile with the `openAiIsOmniRoute` opt-in flag set
 * (see docs/architecture/omniroute-integration-design.md §1.1). There is no
 * hostname literal or URL parsing — the flag is the sole discriminator, which is
 * the direct replacement for the removed hardcoded-host check.
 */

/** Placeholder token used when the server does not require an API key. */
export const OMNIROUTE_PUBLIC_TOKEN = "public"

/** Request header carrying the per-request OmniRoute cost-tier ceiling (1-5) — FEAT-005. */
export const OMNIROUTE_TIER_HEADER = "X-OmniRoute-Tier"

/**
 * Build the per-request OmniRoute header map for a profile.
 *
 * Returns `{ "X-OmniRoute-Tier": "<n>" }` only when this is an OmniRoute profile and a
 * valid cost tier (integer 1-5) is set; otherwise returns an empty object so no header is
 * sent and OmniRoute keeps its own default routing (FEAT-005). This is the single place the
 * tier-to-header mapping lives, so the client and its tests agree on the omit-when-unset rule.
 */
export function omniRouteRequestHeaders(configuration: ProviderSettings): Record<string, string> {
	if (!isOmniRoute(configuration)) {
		return {}
	}
	const tier = configuration.omniRouteTier
	if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 1 || tier > 5) {
		return {}
	}
	return { [OMNIROUTE_TIER_HEADER]: String(tier) }
}

/**
 * Return a copy of `configuration` carrying the live global OmniRoute cost tier.
 *
 * The global `omniRouteTier` setting is the single source of truth. A provider profile never
 * stores its own tier, so this sets `omniRouteTier` only for an OmniRoute profile with a valid
 * tier (1-5) and deletes it in every other case. Deleting also neutralizes any stale snapshot
 * left in a saved profile. The input is never mutated.
 */
export function withOmniRouteTier(configuration: ProviderSettings, tier: number | undefined): ProviderSettings {
	const next: ProviderSettings = { ...configuration }
	if (isOmniRoute(configuration) && omniRouteTierSchema.safeParse(tier).success) {
		next.omniRouteTier = tier
	} else {
		delete next.omniRouteTier
	}
	return next
}

/**
 * Resolve the effective OmniRoute cost tier for a single request (FEAT-003).
 * Precedence: a valid envelope tier wins; else a valid saved tier; else undefined
 * (OmniRoute default, no header). Any value that is not an integer in 1..5 is
 * treated as absent. Never mutates persisted state.
 */
export function resolveRequestTier(
	envelopeTier: number | undefined,
	savedTier: number | undefined,
): number | undefined {
	if (omniRouteTierSchema.safeParse(envelopeTier).success) return envelopeTier
	if (omniRouteTierSchema.safeParse(savedTier).success) return savedTier
	return undefined
}

/**
 * Clamp a mastermind worker's requested tier to the execution ceiling (FEAT-003).
 * - ceiling undefined => no ceiling; pass the requested tier through (may be undefined).
 * - requested undefined with a defined ceiling => the ceiling (worker inherits the ceiling).
 * - otherwise => min(requested, ceiling), i.e. below/at ceiling preserved, above clamped down.
 */
export function clampWorkerTier(
	requestedTier: number | undefined,
	ceilingTier: number | undefined,
): number | undefined {
	if (ceilingTier === undefined) return requestedTier
	if (requestedTier === undefined) return ceilingTier
	return Math.min(requestedTier, ceilingTier)
}

/**
 * True iff this profile is an OmniRoute connection: an OpenAI-compatible provider
 * with the `openAiIsOmniRoute` flag enabled. No URL parsing, no address literal.
 */
export function isOmniRoute(configuration: ProviderSettings): boolean {
	return configuration.apiProvider === providerIdentifiers.openai && configuration.openAiIsOmniRoute === true
}

/**
 * Per-route served context windows (input-token capacity), keyed by the OmniRoute
 * route id used as the model id in an OmniRoute profile.
 *
 * SOURCE OF TRUTH: the self-hosted serving config, not a guess. These mirror the
 * live `--max-model-len` / `num_ctx` the backends actually serve, so Menagerie's
 * auto-condense math (`willManageContext`) measures usage against the real window
 * instead of the flat `openAiModelInfoSaneDefaults.contextWindow` (128k) that every
 * route would otherwise share:
 *   - coder routes  -> qwen3.8-27b-nvfp4, vLLM --max-model-len 163840 (nix-flakes esnixi/vllm.nix)
 *   - planner/long/research/reviewer/tester -> ds4-glm53 via ollama, OLLAMA_CONTEXT_LENGTH 262144 (modules/profiles/ai.nix)
 *   - reader routes -> qwen3.5-9b reader, OmniRoute combo context_length 32768 (deliberately small 9B)
 *   - tiny/fast     -> small local models; keep conservative 32768
 *
 * Keep these in lockstep with the serving config when it changes. A route absent
 * from this map falls through to the profile's own `openAiCustomModelInfo` (or the
 * sane default), so an unknown/new route is never given a wrong window.
 */
export const OMNIROUTE_ROUTE_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
	// 27B coder on the 5090 (vLLM --max-model-len 163840).
	"hybrid/code": 163840,
	"pool/tier1/code": 163840,
	"pool/tier2/code": 163840,
	// GLM-5.3 on the M5 Max via ollama (OLLAMA_CONTEXT_LENGTH 262144).
	"hybrid/planner": 262144,
	"pool/tier1/planner": 262144,
	"pool/tier2/planner": 262144,
	"hybrid/research": 262144,
	"pool/tier1/research": 262144,
	"hybrid/long": 262144,
	"pool/tier1/long": 262144,
	"hybrid/reviewer": 262144,
	"hybrid/tester": 262144,
	"hybrid/frontier": 262144,
	// 9B reader, kept deliberately small (OmniRoute combo context_length 32768).
	"hybrid/reader": 32768,
	"local/m5-reader": 32768,
	"hybrid/tiny": 32768,
	"hybrid/fast": 32768,
}

/**
 * Final fallback window when nothing else resolves a route (Requirement 13.4).
 * Matches the OpenAI-compatible sane default so an unknown route on an unseen
 * server behaves exactly as it did before published metadata existed.
 */
export const OMNIROUTE_DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * How long a cached published catalog is considered fresh before a task-start
 * read triggers a background refresh (Requirement 13.5). The cached copy keeps
 * serving the resolver during and after a stale window; only a refresh that
 * SUCCEEDS replaces it, so a failed refresh keeps the last successful catalog
 * (Requirement 13.8).
 */
export const OMNIROUTE_CATALOG_STALE_MS = 60 * 60 * 1000

/** One cached, last-successful published catalog for a single server URL. */
interface PublishedCatalogCacheEntry {
	/** Published context window per route id, extracted from the catalog entries. */
	readonly contextWindows: Readonly<Record<string, number>>
	/**
	 * The raw parsed catalog entries from the last successful fetch, kept so the
	 * capacity/lane reader (task 13.3) can derive published RouteCapacity and the
	 * Capability_Lane→Public_Route map without a second parse. Body-free; only the
	 * additive published fields are consumed by downstream readers.
	 */
	readonly entries: readonly OmniRouteCatalogEntry[]
	/** Wall-clock ms (from the injected clock) when this catalog was fetched. */
	readonly fetchedAt: number
}

/**
 * Last-successful published catalog per profile server URL (Requirement 13.7).
 *
 * Keyed by the profile's SAVED server URL — not the tokenized URL — so two
 * profiles pointing at the same OmniRoute share one cache entry and a per-URL
 * refresh never leaks a window from a different fleet. Only a `connected` fetch
 * writes here; a failed fetch leaves the prior entry untouched (Requirement 13.8).
 *
 * Lifetime: process-lifetime, module-scoped. There is no expiry/eviction — a
 * stale entry still answers reads (so the first request is never delayed,
 * Requirement 13.5) and is simply overwritten by the next successful refresh.
 */
const publishedCatalogCache = new Map<string, PublishedCatalogCacheEntry>()

/** In-flight background refreshes, keyed by server URL, so we never stack them. */
const inFlightRefreshes = new Set<string>()

/**
 * Injectable clock + fetcher so tests can drive the >60 min stale boundary and the
 * no-delay background refresh deterministically without real time or network.
 */
interface PublishedCatalogDeps {
	now: () => number
	fetchCatalog: (serverRoot: string | undefined, apiKey?: string) => Promise<OmniRouteCatalogResponse>
}

const defaultPublishedCatalogDeps: PublishedCatalogDeps = {
	now: () => Date.now(),
	fetchCatalog: fetchOmniRouteCatalog,
}

let publishedCatalogDeps: PublishedCatalogDeps = defaultPublishedCatalogDeps

/**
 * TEST SEAM: override the clock/fetcher used by the published-catalog cache.
 * Pass `undefined` to restore the real `Date.now` + `fetchOmniRouteCatalog`.
 * Not used in production code.
 */
export function __setPublishedCatalogDeps(deps?: Partial<PublishedCatalogDeps>): void {
	publishedCatalogDeps = { ...defaultPublishedCatalogDeps, ...deps }
}

/** TEST SEAM: clear the per-server-URL cache and any in-flight refresh tracking. */
export function __resetPublishedCatalogCache(): void {
	publishedCatalogCache.clear()
	inFlightRefreshes.clear()
}

/** Build a route-id → contextWindow map from a connected catalog's entries. */
function extractContextWindows(response: OmniRouteCatalogResponse): Record<string, number> {
	const windows: Record<string, number> = {}
	for (const entry of response.entries) {
		if (typeof entry.contextWindow === "number") {
			windows[entry.id] = entry.contextWindow
		}
	}
	return windows
}

/**
 * Refresh the published catalog for `serverUrl` in the BACKGROUND (Requirement 13.5).
 *
 * Fire-and-forget: the caller never awaits this, so the first request after a
 * task start uses whatever is already cached (possibly nothing) and a later
 * request picks up the fresh window. Only a `connected` response overwrites the
 * cache; an `error` response (or a thrown fetch) leaves the last successful
 * catalog in place (Requirement 13.8). A single in-flight refresh per URL is
 * tracked so repeated task starts do not stack concurrent fetches.
 */
function refreshPublishedCatalogInBackground(serverUrl: string, apiKey?: string): void {
	if (inFlightRefreshes.has(serverUrl)) {
		return
	}
	inFlightRefreshes.add(serverUrl)
	publishedCatalogDeps
		.fetchCatalog(serverUrl, apiKey)
		.then((response) => {
			if (response.status === "connected") {
				publishedCatalogCache.set(serverUrl, {
					contextWindows: extractContextWindows(response),
					entries: response.entries,
					fetchedAt: publishedCatalogDeps.now(),
				})
			}
		})
		.catch(() => {
			// A failed refresh keeps the last successful published catalog (Requirement 13.8).
		})
		.finally(() => {
			inFlightRefreshes.delete(serverUrl)
		})
}

/**
 * Kick a background catalog refresh for a profile's saved server URL when the
 * cached copy is missing or stale (>60 min). Call this at TASK START. It never
 * blocks: the resolver keeps answering from the current cache / static map while
 * the refresh runs, so the first request is not delayed (Requirement 13.5).
 */
export function refreshPublishedCatalogIfStale(serverUrl: string | undefined, apiKey?: string): void {
	const key = serverUrl?.trim()
	if (!key) {
		return
	}
	const cached = publishedCatalogCache.get(key)
	const isStale = cached === undefined || publishedCatalogDeps.now() - cached.fetchedAt > OMNIROUTE_CATALOG_STALE_MS
	if (isStale) {
		refreshPublishedCatalogInBackground(key, apiKey)
	}
}

/**
 * Resolve the effective context window for an OmniRoute route id.
 *
 * Precedence (Requirements 13.2-13.5, 13.7, 13.8), highest wins:
 *   1. the route's `contextWindow` from the LAST SUCCESSFUL published catalog for
 *      the profile's saved `serverUrl` (the served value is authoritative — the
 *      route *is* the model, so the real `--max-model-len` / `num_ctx` drives
 *      auto-condense);
 *   2. else the built-in constant map `OMNIROUTE_ROUTE_CONTEXT_WINDOWS` (kept only
 *      as a fallback for a route not yet seen in a published catalog, Req 13.3);
 *   3. else the profile's own `customContextWindow`;
 *   4. else `OMNIROUTE_DEFAULT_CONTEXT_WINDOW` (128k, Req 13.4).
 *
 * `serverUrl` is the profile's saved server root; it keys the per-URL cache
 * (Requirement 13.7). When omitted (older call sites), only the static-map/profile/
 * default fallback is consulted — behavior identical to before published metadata.
 *
 * This read NEVER performs I/O and never awaits — refreshing is the separate,
 * non-blocking `refreshPublishedCatalogIfStale`, so resolving a window cannot
 * delay a request (Requirement 13.5).
 */
export function resolveOmniRouteContextWindow(
	routeId: string,
	customContextWindow?: number,
	serverUrl?: string,
): number | undefined {
	const key = serverUrl?.trim()
	if (key) {
		const published = publishedCatalogCache.get(key)?.contextWindows[routeId]
		if (typeof published === "number") {
			return published
		}
	}

	const mapped = OMNIROUTE_ROUTE_CONTEXT_WINDOWS[routeId]
	if (typeof mapped === "number") {
		return mapped
	}

	if (typeof customContextWindow === "number") {
		return customContextWindow
	}

	return OMNIROUTE_DEFAULT_CONTEXT_WINDOW
}

/**
 * Return the last successful published catalog entries for a profile's saved
 * server URL, or an empty array when none is cached (task 13.3).
 *
 * This NEVER performs I/O: it reads the same process-lifetime cache that
 * {@link refreshPublishedCatalogIfStale} populates in the background. The
 * capacity/lane reader uses the returned entries to build the published
 * RouteCapacity map and the Capability_Lane→Public_Route map; an empty array
 * (no cache yet, or a profile with no server URL) drives the static fallback
 * (Requirement 14.5). `serverUrl` keys the per-URL cache exactly as the
 * context-window resolver does, so two profiles on the same OmniRoute share one
 * entry and a reader never sees a different fleet's metadata (Requirement 13.7).
 */
export function getPublishedCatalogEntries(serverUrl: string | undefined): readonly OmniRouteCatalogEntry[] {
	const key = serverUrl?.trim()
	if (!key) {
		return []
	}
	return publishedCatalogCache.get(key)?.entries ?? []
}

/**
 * Derive OmniRoute's tokenized VS Code base URL from the user-entered server root.
 *
 * The user enters the server root without any suffix; menagerie appends the
 * tokenized VS Code path `/api/v1/vscode/<token>`, where the token is the API key
 * when present (it doubles as the path token, matching OmniRoute's clients) or the
 * `"public"` placeholder otherwise (§1.2). Trailing slashes on the root are
 * trimmed so the join never doubles a slash. No hardcoded address is ever
 * introduced — the result is entirely user-derived.
 */
export function omniRouteTokenizedBaseUrl(serverRoot: string, apiKey?: string): string {
	const root = serverRoot.replace(/\/+$/, "")
	const token = apiKey && apiKey.length > 0 ? apiKey : OMNIROUTE_PUBLIC_TOKEN
	return `${root}/api/v1/vscode/${token}`
}

/**
 * Fetch the live OmniRoute route (combo) catalog and report a connection status.
 *
 * Hits `GET <tokenizedBase>/combos`. The selectable chat ids are the combos'
 * `tier/role` ids (`hybrid/code`, `local/long`), carried in each combo's `name`
 * field — the id namespace the chat/completions endpoint actually requires. This
 * is DELIBERATELY not the `/models?prefix=alias` list, whose bare alias ids
 * (`code`, `reader`) the chat endpoint rejects with "Unable to determine provider
 * for model '<alias>'". Each entry is parsed through {@link omniRouteComboEntrySchema},
 * which transforms the combo into a catalog entry whose `id` is the full combo id,
 * so the webview can store `entry.id` verbatim and have a valid chat model id.
 * When a key exists it is sent as `Authorization: Bearer` as well as embedded in
 * the path token (§1.2). All errors resolve to an `error` status with the
 * server/error message; nothing is hardcoded.
 */
export async function fetchOmniRouteCatalog(
	serverRoot: string | undefined,
	apiKey?: string,
): Promise<OmniRouteCatalogResponse> {
	if (!serverRoot?.trim()) {
		return { status: "error", entries: [], error: "Server URL is required" }
	}

	const trimmedRoot = serverRoot.trim()
	if (!URL.canParse(trimmedRoot)) {
		return { status: "error", entries: [], error: "Server URL is not a valid URL" }
	}

	try {
		const base = omniRouteTokenizedBaseUrl(trimmedRoot, apiKey)
		const headers: Record<string, string> = { ...DEFAULT_HEADERS }
		if (apiKey && apiKey.length > 0) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const response = await axios.get(`${base}/combos`, { headers })
		// The tokenized combos route returns `{ object, data: [...], combos: [...] }`;
		// prefer `data`, fall back to `combos`, then a bare array.
		const rawEntries: unknown = response.data?.data ?? response.data?.combos ?? response.data ?? []
		const entries: OmniRouteCatalogEntry[] = Array.isArray(rawEntries)
			? rawEntries
					.map((entry) => omniRouteComboEntrySchema.safeParse(entry))
					.filter((result): result is { success: true; data: OmniRouteCatalogEntry } => result.success)
					.map((result) => result.data)
			: []

		return { status: "connected", entries }
	} catch (error) {
		const message =
			axios.isAxiosError(error) && typeof error.response?.data?.error === "string"
				? error.response.data.error
				: error instanceof Error
					? error.message
					: String(error)
		return { status: "error", entries: [], error: message }
	}
}
