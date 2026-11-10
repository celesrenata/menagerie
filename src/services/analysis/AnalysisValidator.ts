import {
	OPERATIONS_REQUIRING_MULTI_ANCHOR,
	OPERATIONS_REQUIRING_RISK,
	analysisModelResponseSchema,
	type AnalysisFinding,
	type AnalysisModelResponse,
	type AnalysisRequest,
} from "@roo-code/types"

/**
 * Validation of untrusted model output (MEN-GRANITE-SDD-001 R4.3-R4.5).
 *
 * "Schema-valid" is not "true". Passing this module means: the text was one JSON object of
 * the expected shape, and every kept finding cites only anchors Menagerie itself supplied.
 * Anything else is dropped into `unknowns`, never promoted to a finding.
 */

export type ParseResult =
	| { ok: true; value: unknown }
	| { ok: false; kind: "non-json"; reason: string }

const FENCE_OPEN = /^```(?:json)?[ \t]*\r?\n/i

/**
 * Scans a JSON object from index 0. Returns the end index (exclusive) of the first balanced
 * object, or the stack of closers still owed when the text ended mid-structure.
 */
function scanObject(text: string): { end: number } | { owed: string[]; endedInString: boolean } {
	const stack: string[] = []
	let inString = false
	let escaped = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (inString) {
			if (escaped) escaped = false
			else if (ch === "\\") escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === "{") stack.push("}")
		else if (ch === "[") stack.push("]")
		else if (ch === "}" || ch === "]") {
			if (stack.pop() !== ch) return { owed: [], endedInString: false }
			if (stack.length === 0) return { end: i + 1 }
		}
	}
	return { owed: stack.reverse(), endedInString: inString }
}

export interface ParseNotes {
	/** Characters after the first complete object that were ignored (never interpreted). */
	trailingChars: number
	/** Closing brackets appended because the model stopped just short of them. */
	repairedClosers: number
}

/**
 * Extracts the model's JSON object.
 *
 * The output must START with `{` (optionally after one ```json fence). Only the FIRST balanced
 * object is consumed. Anything after it is discarded unread: the live model habitually appends
 * its own reasoning, and ignoring (not interpreting) trailing text means injected prose can
 * never add content. If the object is missing only trailing closers, and the text ended right
 * after a complete value, those closers are appended (reported in `repairedClosers`). The
 * result is still strictly schema-validated, and `finish_reason: length` is not repairable.
 */
export function parseJsonObject(text: string, options: { allowRepair?: boolean } = {}): ParseResult & { notes?: ParseNotes } {
	let candidate = text.trim()
	const fence = FENCE_OPEN.exec(candidate)
	if (fence) candidate = candidate.slice(fence[0].length).trimStart()
	if (!candidate.startsWith("{")) {
		return { ok: false, kind: "non-json", reason: "output does not start with a JSON object" }
	}

	let json: string
	let notes: ParseNotes
	const scanned = scanObject(candidate)
	if ("end" in scanned) {
		json = candidate.slice(0, scanned.end)
		notes = { trailingChars: candidate.length - scanned.end, repairedClosers: 0 }
	} else {
		// Repair only a bare omission of closers; never close a half-written string or a dangling key/comma.
		const stripped = candidate.trimEnd().replace(/\r?\n```\s*$/, "").trimEnd()
		const endsOnValue = /[}\]"\d]$|true$|false$|null$/.test(stripped)
		if (!options.allowRepair || scanned.endedInString || scanned.owed.length === 0 || !endsOnValue || stripped.length === 0) {
			return { ok: false, kind: "non-json", reason: "JSON object is incomplete" }
		}
		json = stripped + scanned.owed.join("")
		notes = { trailingChars: 0, repairedClosers: scanned.owed.length }
	}
	try {
		return { ok: true, value: JSON.parse(json), notes }
	} catch (error) {
		return { ok: false, kind: "non-json", reason: `JSON parse error: ${error instanceof Error ? error.message : "unknown"}` }
	}
}

const NULLABLE_KEYS = new Set(["confidence", "uncertainty", "recommendation", "unknowns", "risk"])

/**
 * Models often emit `"recommendation": null` for "none". For OPTIONAL keys only, null means
 * absent. Required keys (`claim`, `anchorIds`, `findings`) and unknown keys are untouched, so
 * a null there still fails strict validation.
 */
export function dropNullOptionals(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(dropNullOptionals)
	if (typeof value !== "object" || value === null) return value
	const out: Record<string, unknown> = {}
	for (const [key, v] of Object.entries(value)) {
		if (v === null && NULLABLE_KEYS.has(key)) continue
		out[key] = dropNullOptionals(v)
	}
	return out
}

/**
 * Claims that ASSERT a verification outcome ("all tests pass", "verified", "criteria met"). A
 * model can neither run nor attest tests, so such a claim is never a finding: it is quarantined
 * into `unknowns` for every operation. Requirement-style wording ("tests must pass") is not matched.
 */
const VERIFICATION_ASSERTION = [
	/\ball (?:the )?(?:\w+ )?tests? (?:now |all )?(?:pass|passes|passed|are passing|succeed|succeeded)\b/i,
	/\b(?:tests?|checks?|build|lint|typecheck) (?:has|have|is|are)? ?(?:passed|passing|green)\b/i,
	/\b(?:criteria|requirements?|acceptance) (?:is|are|has been|have been) (?:met|satisfied|fulfilled|verified)\b/i,
	/^\s*(?:verified|approved|pass(?:ed)?|lgtm)\W*$/i,
	/\b(?:is|are|was|been) (?:fully )?verified\b/i,
]

export function isVerificationAssertion(claim: string): boolean {
	return VERIFICATION_ASSERTION.some((re) => re.test(claim))
}

export type ValidatedModelText =
	| {
			ok: true
			findings: AnalysisFinding[]
			unknowns: string[]
			risk: AnalysisModelResponse["risk"]
			/** Findings removed because they cited unknown anchors, none, or too few. */
			suppressed: number
	  }
	| { ok: false; kind: "non-json" | "invalid-schema"; reason: string }

export function validateModelText(
	text: string,
	request: AnalysisRequest,
	finishReason: string | undefined,
): ValidatedModelText {
	const truncated = finishReason === "length"
	// A generation cut off by max_tokens is never repaired. It is still accepted when a complete
	// object was emitted first and only trailing text was cut (the model rambling after its JSON).
	const parsed = parseJsonObject(text, { allowRepair: !truncated })
	if (!parsed.ok) {
		return truncated
			? { ok: false, kind: "invalid-schema", reason: "generation hit max_tokens before a complete JSON object" }
			: parsed
	}

	const schema = analysisModelResponseSchema.safeParse(dropNullOptionals(parsed.value))
	if (!schema.success) {
		const issue = schema.error.issues[0]
		return {
			ok: false,
			kind: "invalid-schema",
			reason: `${issue.path.join(".") || "(root)"}: ${issue.message}`.slice(0, 500),
		}
	}
	const response = schema.data
	if (OPERATIONS_REQUIRING_RISK.has(request.operation) && response.risk === undefined) {
		return { ok: false, kind: "invalid-schema", reason: `operation ${request.operation} requires "risk"` }
	}

	const known = new Set(request.evidence.map((e) => e.anchorId))
	const minAnchors = OPERATIONS_REQUIRING_MULTI_ANCHOR.has(request.operation) ? 2 : 1
	const unknowns = [...(response.unknowns ?? [])]
	const findings: AnalysisFinding[] = []
	let suppressed = 0

	for (const finding of response.findings) {
		if (isVerificationAssertion(finding.claim)) {
			suppressed++
			unknowns.push(`verification assertion quarantined (a model cannot attest results): ${finding.claim}`.slice(0, 1_000))
			continue
		}
		const distinct = [...new Set(finding.anchorIds)]
		const allKnown = distinct.every((id) => known.has(id))
		if (!allKnown || distinct.length < minAnchors) {
			suppressed++
			unknowns.push(
				`ungrounded claim suppressed (${!allKnown ? "unknown citation" : `needs ${minAnchors}+ citations`}): ${finding.claim}`.slice(
					0,
					1_000,
				),
			)
			continue
		}
		findings.push({ ...finding, anchorIds: distinct })
	}

	return { ok: true, findings, unknowns: unknowns.slice(0, 16), risk: response.risk, suppressed }
}

// ---------------------------------------------------------------------------------------
// Evidence freshness
// ---------------------------------------------------------------------------------------

/** Rejects absolute paths, traversal, backslashes, NUL, and drive letters. Pure. */
export function isSafeRelativePath(p: string): boolean {
	if (p.length === 0 || p.includes("\0") || p.includes("\\")) return false
	if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false
	return !p.split("/").some((segment) => segment === ".." || segment === "")
}

export type EvidenceFreshness = "fresh" | "stale" | "missing" | "unsafe"

/** Caller-supplied: checks one request's evidence against the CURRENT workspace snapshot. */
export type EvidenceVerifier = (item: AnalysisRequest["evidence"][number]) => Promise<EvidenceFreshness>

export async function findStaleEvidence(
	request: AnalysisRequest,
	verify: EvidenceVerifier,
): Promise<{ anchorId: string; freshness: Exclude<EvidenceFreshness, "fresh"> } | undefined> {
	for (const item of request.evidence) {
		if (!isSafeRelativePath(item.anchor.path)) return { anchorId: item.anchorId, freshness: "unsafe" }
		const freshness = await verify(item)
		if (freshness !== "fresh") return { anchorId: item.anchorId, freshness }
	}
	return undefined
}
