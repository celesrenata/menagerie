// Feature: retrieval-fabric
//
// Pure query-planning logic for the logical Retrieval Gateway.
//
// `planHybridQuery` decides which retrieval modes a query needs. It always
// includes dense embedding similarity, and additionally includes exact
// identifier/lexical and symbol/file/path retrieval whenever the query carries
// an exact token — an identifier, an error string, a named resource, a file
// path, or a UUID — so retrieval never relies on dense similarity alone
// (Req 11.1, 11.2, 11.3).
//
// This module is pure: it performs no I/O and depends only on its input query.

import type { HybridQueryPlan, RetrievalIntent, RetrievalMode } from "./types"

/**
 * Standard RFC 4122 UUID (any version), e.g.
 * `123e4567-e89b-12d3-a456-426614174000`.
 */
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i

/**
 * CONSTANT_CASE identifiers: two or more uppercase/digit segments joined by
 * underscores, e.g. `AUTO_READER_NAME`, `MAX_RETRIES_2`. Requires at least one
 * underscore so a bare word like `HTTP` is not treated as an identifier here.
 */
const CONSTANT_CASE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/

/**
 * Multi-word PascalCase / CamelCase identifiers, e.g. `FooFactory`,
 * `getUserName`. Requires an internal uppercase boundary (a lowercase/digit
 * followed by an uppercase letter) so single words like `Factory` or a
 * sentence-initial `The` are not matched.
 */
const CAMEL_PASCAL_CASE_PATTERN = /\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/

/**
 * Error strings carrying a status/code, e.g. `HTTP 502`, `status 404`,
 * `error 500`. Captures the whole phrase so the numeric code travels with its
 * label.
 */
const ERROR_STRING_PATTERN = /\b(?:HTTP|HTTPS|status|error|code|exit)\s+\d{3}\b/i

/**
 * Hyphenated named resources, e.g. `celestium-le-production`, `qdrant-0`.
 * Requires at least one hyphen joining alphanumeric segments.
 */
const HYPHENATED_RESOURCE_PATTERN = /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/

/**
 * File paths: either a path containing a `/` separator (e.g. `src/index.ts`,
 * `sources/kube/omniroute-memory/`) or a bare filename carrying a recognizable
 * extension (e.g. `vector-store-factory.ts`, `README.md`).
 */
const SLASH_PATH_PATTERN = /\b[\w.-]*\/[\w./-]+\b/
const FILE_EXTENSION_PATTERN = /\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|md|yaml|yml|json|sh|toml|txt|sql)\b/i

/**
 * Ordered set of exact-token detectors. Each detector contributes any matches
 * it finds to the plan's `exactTokens`. UUID detection runs first so a UUID is
 * not fragmented by the hyphenated-resource detector.
 */
const EXACT_TOKEN_PATTERNS: readonly RegExp[] = [
	UUID_PATTERN,
	CONSTANT_CASE_PATTERN,
	CAMEL_PASCAL_CASE_PATTERN,
	ERROR_STRING_PATTERN,
	SLASH_PATH_PATTERN,
	FILE_EXTENSION_PATTERN,
	HYPHENATED_RESOURCE_PATTERN,
]

/**
 * Collect every exact token detected in `query`, preserving first-seen order
 * and deduplicating case-insensitively so the same token surfaced by two
 * detectors (e.g. a filename matched by both the slash and extension patterns)
 * appears once.
 */
function detectExactTokens(query: string): string[] {
	const seen = new Set<string>()
	const tokens: string[] = []

	for (const pattern of EXACT_TOKEN_PATTERNS) {
		const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
		for (const match of query.matchAll(globalPattern)) {
			const token = match[0]
			const key = token.toLowerCase()
			if (!seen.has(key)) {
				seen.add(key)
				tokens.push(token)
			}
		}
	}

	return tokens
}

/**
 * Decide which retrieval modes a query needs.
 *
 * The returned plan always includes `"dense"`. When the query carries one or
 * more exact tokens, the plan additionally includes `"lexical"` (exact
 * identifier/lexical search) and `"symbol"` (symbol/file/path relevance) so
 * retrieval never relies on dense similarity alone (Req 11.1, 11.2, 11.3). The
 * detected tokens are returned in `exactTokens`.
 *
 * Pure function: no I/O, deterministic for a given query.
 */
export function planHybridQuery(query: string): HybridQueryPlan {
	const exactTokens = detectExactTokens(query)
	const modes: RetrievalMode[] = ["dense"]

	if (exactTokens.length > 0) {
		modes.push("lexical", "symbol")
	}

	return { query, modes, exactTokens }
}

/**
 * A multi-concern domain expansion. When `triggers` all match the query, the
 * question is known to span several independent areas, so the query expands
 * into the fixed `facets` — one focused retrieval query per distinct concern.
 *
 * This is the data-driven form of Req 13.1: a wrong-Kubernetes-certificate
 * question spans ingress TLS, cert-manager `Certificate` resources,
 * `ClusterIssuer`, and hostname config, which no single query covers well.
 */
interface DomainExpansion {
	/** All of these must match the query for the expansion to apply. */
	triggers: readonly RegExp[]
	/** Distinct, self-contained retrieval queries, one per independent concern. */
	facets: readonly string[]
}

/**
 * Known multi-concern domains. Kept intentionally small and data-driven: each
 * entry only earns its place when its facets add distinct retrieval coverage
 * that an undecomposed query would miss (Req 13.1, 13.3).
 */
const DOMAIN_EXPANSIONS: readonly DomainExpansion[] = [
	{
		// Wrong / failing Kubernetes certificate: TLS is served by ingress, the
		// cert itself is a cert-manager `Certificate`, issued by a `ClusterIssuer`,
		// for a specific hostname — four distinct places to look.
		triggers: [/\bk8s\b|\bkubernetes\b|\bingress\b|\bcert-manager\b/i, /\bcert(?:ificate)?s?\b|\btls\b|\bssl\b/i],
		facets: [
			"ingress TLS configuration",
			"cert-manager Certificate resource",
			"ClusterIssuer configuration",
			"hostname and DNS name configuration for the certificate",
		],
	},
]

/**
 * Explicit concern separators: a conjunction (` and `), a comma or semicolon,
 * an enumeration marker (`1.`, `2.`), or a leading bullet (`-`, `*`). Splitting
 * on these turns an itemized question into its component concerns.
 */
const CONCERN_SEPARATOR_PATTERN = /\s+and\s+|[,;]|(?:^|\s)\d+\.\s+|(?:^|\s)[-*]\s+/i

/**
 * Minimum word count for a split fragment to count as a substantive concern.
 * Shorter fragments (e.g. a stray ` and then?`) do not add distinct coverage
 * and would only multiply queries pointlessly (Req 13.3).
 */
const MIN_CONCERN_WORDS = 3

/**
 * Deduplicate queries case-insensitively, preserving first-seen order and the
 * original casing of each kept query. Prevents emitting exact-duplicate
 * retrieval queries (Req 13.3).
 */
function dedupeQueries(queries: readonly string[]): string[] {
	const seen = new Set<string>()
	const result: string[] = []

	for (const query of queries) {
		const key = query.toLowerCase()
		if (!seen.has(key)) {
			seen.add(key)
			result.push(query)
		}
	}

	return result
}

/**
 * Split `query` on explicit concern separators and keep only the fragments
 * substantive enough to carry distinct retrieval coverage.
 */
function splitIntoConcerns(query: string): string[] {
	return query
		.split(CONCERN_SEPARATOR_PATTERN)
		.map((fragment) => fragment.trim())
		.filter((fragment) => fragment.length > 0 && fragment.split(/\s+/).length >= MIN_CONCERN_WORDS)
}

/**
 * Expand a multi-concern engineering question into independent retrieval
 * queries, but only where each sub-query adds distinct coverage (Req 13.1), and
 * never emitting exact-duplicate queries (Req 13.3).
 *
 * Strategy:
 * 1. If the query matches a known multi-concern domain (e.g. a wrong-Kubernetes
 *    -certificate question), expand into that domain's distinct facet queries.
 * 2. Otherwise, split on explicit concern separators (conjunctions, commas,
 *    enumerations, bullets) and keep only substantive fragments.
 * 3. Deduplicate case-insensitively.
 * 4. If no meaningful decomposition applies, return the original query as the
 *    sole sub-query so the caller always has at least one query to run.
 *
 * `intent` gates how eagerly a fragmentary split is accepted: debugging and
 * explanation questions benefit from broader coverage, so a single extra
 * concern is enough to decompose; for narrower intents (locate/implement/
 * review) a lone trailing clause is treated as noise and left undecomposed to
 * avoid pointless query multiplication (Req 13.3).
 *
 * Pure function: no I/O, deterministic for a given `(query, intent)`.
 */
export function decomposeQuery(query: string, intent: RetrievalIntent): string[] {
	const trimmed = query.trim()

	for (const expansion of DOMAIN_EXPANSIONS) {
		if (expansion.triggers.every((trigger) => trigger.test(trimmed))) {
			return dedupeQueries(expansion.facets)
		}
	}

	const concerns = dedupeQueries(splitIntoConcerns(trimmed))
	const wantsBroadCoverage = intent === "debug" || intent === "explain"
	const minConcerns = wantsBroadCoverage ? 2 : 3

	if (concerns.length >= minConcerns) {
		return concerns
	}

	return [trimmed]
}
