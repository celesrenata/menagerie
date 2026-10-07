import { workerResultSchema, type WorkerResult } from "@roo-code/types"

/**
 * Fields of {@link WorkerResult} that are always-present arrays. When a
 * conforming object omits them, they default to `[]` before validation.
 */
const WORKER_RESULT_ARRAY_FIELDS = [
	"findings",
	"evidence",
	"changes",
	"tests",
	"blockers",
	"artifacts",
] as const

/**
 * Collapses runs of whitespace in an arbitrary raw value to a single-line
 * string. Objects are JSON-serialized; everything else is coerced to a string.
 * Content is preserved in full — nothing is truncated.
 */
function rawToText(raw: unknown): string {
	let text: string

	if (typeof raw === "string") {
		text = raw
	} else if (raw === undefined) {
		text = "undefined"
	} else {
		try {
			text = JSON.stringify(raw)
		} catch {
			text = String(raw)
		}
	}

	// JSON.stringify can return undefined (e.g. for a bare function); guard it.
	if (typeof text !== "string") {
		text = String(text)
	}

	return text.replace(/\s+/g, " ").trim()
}

/**
 * Builds a schema-valid failed {@link WorkerResult} for genuinely-empty worker
 * output (empty/whitespace-only string, `null`, or `undefined`). The summary
 * references the worker name so the failure is diagnosable.
 */
function emptyOutputResult(workerName: string): WorkerResult {
	return {
		status: "failed",
		summary: `Worker "${workerName}" returned a result that does not conform to the WorkerResult contract (empty output).`,
		findings: [],
		evidence: [],
		changes: [],
		tests: [],
		blockers: [],
		artifacts: [],
	}
}

/**
 * Detects whether salvaged prose clearly signals that the worker failed or was
 * blocked. A worker that reaches `attempt_completion` normally means it
 * finished, so prose defaults to "completed"; this heuristic only overrides
 * that default when the text contains an unambiguous failure/blocker phrase.
 *
 * The rule is intentionally simple (no NLP): it matches a small set of explicit
 * status phrases a worker emits when it could not finish. When uncertain we
 * prefer "completed" so legitimate work is never discarded.
 */
function inferProseStatus(text: string): "completed" | "failed" | "blocked" {
	const lowered = text.toLowerCase()

	// Blocked takes precedence: a blocked worker often also mentions failure,
	// but "blocked" is the more specific, actionable signal for the parent.
	if (/\bblocked\b|\bblocker:|\bcannot proceed\b|\bunable to proceed\b/.test(lowered)) {
		return "blocked"
	}

	if (/\btask failed\b|\bi failed\b|\bfailed to\b|\bcould not complete\b|\bunable to complete\b/.test(lowered)) {
		return "failed"
	}

	// Default: a worker reaching attempt_completion finished its work.
	return "completed"
}

/**
 * Builds a schema-valid {@link WorkerResult} that SALVAGES non-conforming prose
 * output, preserving the FULL text in `summary` so no legitimate work is lost.
 * The status is inferred from the prose (see {@link inferProseStatus}); all six
 * array fields are empty because structured items cannot be reliably parsed out
 * of free prose.
 */
function salvagedResult(raw: unknown, workerName: string): WorkerResult {
	const text = rawToText(raw)

	return {
		status: inferProseStatus(text),
		summary: text,
		findings: [],
		evidence: [],
		changes: [],
		tests: [],
		blockers: [],
		artifacts: [],
	}
}

/**
 * Normalizes arbitrary worker output into a schema-valid {@link WorkerResult}.
 *
 * Three outcomes:
 * 1. Conforming structured output (a JSON-encoded WorkerResult, or an object)
 *    is parsed and defaulted (absent array fields become `[]`) and returned as
 *    validated.
 * 2. Genuinely-empty output (empty/whitespace-only string, `null`, or
 *    `undefined`) becomes a failed result with the "empty output" summary.
 * 3. Any other non-conforming output — arbitrary prose, partial JSON, a JSON
 *    object that fails schema validation, a non-object JSON value — is SALVAGED
 *    into a conforming result whose `summary` preserves the FULL text (never
 *    truncated), with a status inferred from the prose. Workers emit their
 *    `attempt_completion` as markdown prose rather than JSON, and the parent
 *    cannot change that; salvaging here keeps correct work from being discarded.
 *    Parent-side compaction clips the text for display, so the normalizer must
 *    retain the complete text to keep it recoverable.
 *
 * This function NEVER throws.
 *
 * _Requirements: 7.2, 7.6_
 */
export function normalizeWorkerResult(raw: unknown, context: { workerName: string }): WorkerResult {
	const workerName = context?.workerName ?? "unknown"

	try {
		// Genuinely-empty output is a failure, not salvageable prose.
		if (raw === null || raw === undefined) {
			return emptyOutputResult(workerName)
		}

		if (typeof raw === "string" && raw.trim().length === 0) {
			return emptyOutputResult(workerName)
		}

		// Strings may carry a JSON-encoded WorkerResult; objects are used directly.
		let candidate: unknown = raw

		if (typeof raw === "string") {
			try {
				candidate = JSON.parse(raw)
			} catch {
				// Not JSON at all — treat as non-conforming prose and salvage it.
				return salvagedResult(raw, workerName)
			}
		}

		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
			// JSON that parses to a non-object value (string, number, array, null)
			// is non-conforming — salvage the original raw text rather than fail.
			return salvagedResult(raw, workerName)
		}

		// Fill default arrays for a conforming object missing optional arrays.
		const withDefaults: Record<string, unknown> = { ...(candidate as Record<string, unknown>) }

		for (const field of WORKER_RESULT_ARRAY_FIELDS) {
			if (withDefaults[field] === undefined) {
				withDefaults[field] = []
			}
		}

		const parsed = workerResultSchema.safeParse(withDefaults)

		if (parsed.success) {
			return parsed.data
		}

		// Parsed to an object but failed schema validation: a judgment call that
		// we resolve toward salvage so no legitimate output is lost.
		return salvagedResult(raw, workerName)
	} catch {
		// Defensive: no code path above should throw, but the contract is
		// "never throws", so swallow anything unexpected into a salvaged result.
		return salvagedResult(raw, workerName)
	}
}
