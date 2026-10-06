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
