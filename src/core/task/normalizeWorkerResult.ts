import { workerResultSchema, type WorkerResult } from "@roo-code/types"

/**
 * Maximum number of raw-output characters embedded in a failed-normalization
 * summary. The full raw output is persisted elsewhere; the summary only needs a
 * descriptive excerpt so the mastermind can reason about the failure.
 */
const MAX_RAW_SUMMARY_CHARS = 500

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
 * Produces a short, single-line excerpt of an arbitrary raw value suitable for
 * embedding in a descriptive failure summary. Objects are JSON-serialized;
 * everything else is coerced to a string. Overly long excerpts are truncated
 * with an ellipsis so the summary stays bounded.
 */
function describeRaw(raw: unknown): string {
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

	const collapsed = text.replace(/\s+/g, " ").trim()

	if (collapsed.length > MAX_RAW_SUMMARY_CHARS) {
		return `${collapsed.slice(0, MAX_RAW_SUMMARY_CHARS)}…`
	}

	return collapsed
}

/**
 * Builds a schema-valid failed {@link WorkerResult} describing non-conforming
 * worker output. The summary references the worker name and an excerpt of the
 * raw output so the failure is diagnosable.
 */
function failedResult(raw: unknown, workerName: string): WorkerResult {
	const excerpt = describeRaw(raw)
	const summary = excerpt
		? `Worker "${workerName}" returned a result that does not conform to the WorkerResult contract. Raw output: ${excerpt}`
		: `Worker "${workerName}" returned a result that does not conform to the WorkerResult contract (empty output).`

	return {
		status: "failed",
		summary,
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
 * Conforming structured output is parsed and defaulted (absent array fields
 * become `[]`); non-conforming output — arbitrary prose, partial JSON, a
 * missing status, or anything else that fails schema validation — is converted
 * into a conforming result with `status: "failed"` and a non-empty descriptive
 * `summary` that references the worker name and the raw output.
 *
 * This function NEVER throws.
 *
 * _Requirements: 7.2, 7.6_
 */
export function normalizeWorkerResult(raw: unknown, context: { workerName: string }): WorkerResult {
	const workerName = context?.workerName ?? "unknown"

	try {
		// Strings may carry a JSON-encoded WorkerResult; objects are used directly.
		let candidate: unknown = raw

		if (typeof raw === "string") {
			try {
				candidate = JSON.parse(raw)
			} catch {
				// Not JSON — treat as non-conforming prose.
				return failedResult(raw, workerName)
			}
		}

		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
			return failedResult(raw, workerName)
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

		return failedResult(raw, workerName)
	} catch {
		// Defensive: no code path above should throw, but the contract is
		// "never throws", so swallow anything unexpected into a failed result.
		return failedResult(raw, workerName)
	}
}
