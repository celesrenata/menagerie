import type { OmniRouteCatalogEntry } from "@roo-code/types"

/**
 * Route-reference validation flags for OmniRoute (omniroute-fleet-topology
 * Requirement 15). This module is PURE and DISPLAY-ONLY: it derives, from a
 * successful catalog refresh plus the saved route references, a list of flags
 * that `OmniRouteSettings.tsx` renders. It NEVER rewrites a reference and NEVER
 * blocks a request (Requirement 15.5/15.6); callers must leave the saved values
 * untouched (Requirement 15.8).
 *
 * The classification follows the Requirement 15.2 precedence, derived from the
 * published route `kind` metadata (Requirement 4.11) that each catalog entry now
 * carries, matched by exact id INCLUDING letter case (Requirement 15.1):
 *   - a reference that matches a published `public` route or `alias` is valid and
 *     is NOT flagged;
 *   - `internal` — the reference matches a published route whose kind is
 *     `internal` or `diagnostic` (an internal pool / diagnostic route);
 *   - `direct-model` — the reference matches a catalog entry that is a direct
 *     provider model id rather than a route (a model-shaped entry carrying no
 *     route `kind`), i.e. a connection serves it as a provider model id;
 *   - `missing` — every other non-empty reference (not in the catalog at all).
 */

/** The single reason a route reference is flagged, in Requirement 15.2 precedence. */
export type RouteFlagReason = "internal" | "direct-model" | "missing"

/** One rendered route-reference flag (Requirement 15.4). */
export interface RouteReferenceFlag {
	/**
	 * The saved profile name, or a stable sentinel for the codebase-index embedder
	 * setting, that holds the flagged reference (Requirement 15.4).
	 */
	readonly source: string
	/** The setting field that holds the flagged id (Requirement 15.4). */
	readonly setting: string
	/** The flagged id, exactly as saved (Requirement 15.4; never rewritten). */
	readonly id: string
	/** The single flag reason (Requirement 15.2). */
	readonly reason: RouteFlagReason
}

/** A non-empty route reference to validate: where it lives plus the saved id. */
export interface RouteReferenceInput {
	readonly source: string
	readonly setting: string
	readonly id: string | undefined | null
}

/**
 * The URL origin (scheme, host, and port) of a base URL, or `undefined` when the
 * value is empty or unparseable. Used for the same-origin gate in Requirement
 * 15.1 / 15.3: only references whose server URL shares the refreshed catalog's
 * origin are validated.
 */
export function sameOrigin(a: string | undefined, b: string | undefined): boolean {
	if (!a?.trim() || !b?.trim()) return false
	try {
		return new URL(a).origin === new URL(b).origin
	} catch {
		return false
	}
}

/**
 * Index the catalog entries by exact id. The last entry for a given id wins; in
 * practice ids are unique per published catalog.
 */
function indexById(entries: readonly OmniRouteCatalogEntry[]): Map<string, OmniRouteCatalogEntry> {
	const byId = new Map<string, OmniRouteCatalogEntry>()
	for (const entry of entries) {
		byId.set(entry.id, entry)
	}
	return byId
}

/**
 * True when a catalog entry is a selectable published route (a `public` route or
 * a `public`-route `alias`), or a legacy route entry carrying no `kind` and no
 * direct-model shape. A valid route reference is never flagged (Requirement
 * 15.1).
 */
function isValidRoute(entry: OmniRouteCatalogEntry): boolean {
	if (entry.kind === "public" || entry.kind === "alias") return true
	// A legacy entry (older OmniRoute build) carries no kind. Treat it as a valid
	// route UNLESS it is shaped like a direct provider model entry (see below), so
	// a client reading an older catalog does not spuriously flag good routes.
	return entry.kind === undefined && !isDirectModelShaped(entry)
}

/**
 * True when a catalog entry represents a direct provider model id rather than a
 * route: it carries no route `kind` but has model-only metadata (a per-model
 * `url`, a `family`, or token limits) that a combo/route entry does not. This is
 * the catalog-visible signal that a connection serves the id as a provider model
 * id instead of a Public_Route (Requirement 15.2 `direct-model`).
 */
function isDirectModelShaped(entry: OmniRouteCatalogEntry): boolean {
	if (entry.kind !== undefined) return false
	return (
		entry.url !== undefined ||
		entry.family !== undefined ||
		entry.maxInputTokens !== undefined ||
		entry.maxOutputTokens !== undefined
	)
}

/**
 * Classify a single non-empty reference id against the refreshed catalog, in the
 * Requirement 15.2 precedence. Returns `undefined` when the reference is a valid
 * published route (and so is not flagged).
 */
export function classifyReference(
	id: string,
	byId: ReadonlyMap<string, OmniRouteCatalogEntry>,
): RouteFlagReason | undefined {
	const entry = byId.get(id)
	if (entry === undefined) return "missing"
	if (isValidRoute(entry)) return undefined
	if (entry.kind === "internal" || entry.kind === "diagnostic") return "internal"
	if (isDirectModelShaped(entry)) return "direct-model"
	// A matched entry that is neither a valid route, an internal/diagnostic route,
	// nor direct-model shaped is treated as missing (no usable published kind).
	return "missing"
}

/**
 * Compute the display-only route-reference flags for a successful catalog refresh
 * (Requirement 15.1-15.4). The caller is responsible for only invoking this on a
 * SUCCESSFUL refresh that returned at least one published Public_Route, and for
 * keeping the previous flags unchanged on a failed/empty refresh (Requirement
 * 15.6/15.7). Empty or whitespace-only references are skipped (Requirement 15.1
 * "non-empty"). Each reference gets exactly one flag with one reason.
 */
export function computeRouteReferenceFlags(
	references: readonly RouteReferenceInput[],
	entries: readonly OmniRouteCatalogEntry[],
): RouteReferenceFlag[] {
	const byId = indexById(entries)
	const flags: RouteReferenceFlag[] = []
	for (const reference of references) {
		const id = reference.id?.trim()
		if (!id) continue
		const reason = classifyReference(id, byId)
		if (reason === undefined) continue
		flags.push({ source: reference.source, setting: reference.setting, id, reason })
	}
	return flags
}

/** True when the refreshed catalog contains at least one published Public_Route. */
export function hasPublishedPublicRoute(entries: readonly OmniRouteCatalogEntry[]): boolean {
	return entries.some((entry) => entry.kind === "public")
}
