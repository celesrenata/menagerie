/**
 * Small, deterministic text helpers for the follow-up question memory. No model and no I/O:
 * the same inputs always give the same decision, which keeps "why was I (not) asked?" explainable.
 */
const STOPWORDS = new Set(
	`a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours please want need like use using used should shall may might must let lets let's get got make made one two`.split(
		/\s+/,
	),
)

/** Content tokens: lowercase alphanumerics (keeping `-`/`_`/`.` inside identifiers), >=2 chars (so ci, db, ui survive), minus stopwords. */
export function contentTokens(text: string): string[] {
	const out: string[] = []
	for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9_.\-/]*[a-z0-9]|[a-z0-9]/g) ?? []) {
		const t = raw.replace(/[.\-/]+$/, "")
		if (t.length >= 2 && !STOPWORDS.has(t)) out.push(stem(t))
	}
	return out
}

/** Very light plural/gerund folding so "databases" matches "database". Deliberately not a full stemmer. */
function stem(t: string): string {
	if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3)
	// "boxes"/"matches"/"classes" -> drop "es"; "databases"/"types" -> drop only "s".
	if (t.length > 4 && /(ss|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2)
	if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1)
	return t
}

export function tokenSet(text: string): Set<string> {
	return new Set(contentTokens(text))
}

/** Normalized form used as a stable identity for a question. */
export function normalizeQuestion(text: string): string {
	return [...tokenSet(text)].sort().join(" ")
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0
	let shared = 0
	for (const t of a) if (b.has(t)) shared++
	return shared / (a.size + b.size - shared)
}

/**
 * How alike two questions are, in [0, 1]. Both need at least two content tokens (a single shared word
 * is too ambiguous). A question wholly contained in a longer one counts as a match when they still
 * overlap substantially, so "which test framework" matches "which test framework for the project".
 */
export function questionSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size < 2 || b.size < 2) return 0
	const j = jaccard(a, b)
	let shared = 0
	for (const t of a) if (b.has(t)) shared++
	const contained = shared === Math.min(a.size, b.size)
	return contained && j >= 0.6 ? Math.max(j, 0.75) : j
}

/** Fraction of `needle` tokens present in `haystack` (how much of the question a passage covers). */
export function coverage(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): { shared: number; ratio: number } {
	if (needle.size === 0) return { shared: 0, ratio: 0 }
	let shared = 0
	for (const t of needle) if (haystack.has(t)) shared++
	return { shared, ratio: shared / needle.size }
}

/** True when an answer or note looks like it contains a credential. Such text is never persisted. */
export function looksSecret(text: string): boolean {
	return (
		/\b(sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|ASIA)[-_A-Za-z0-9]{12,}/.test(text) ||
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
		/\b(password|passwd|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S{6,}/i.test(text) ||
		/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/.test(text)
	)
}
