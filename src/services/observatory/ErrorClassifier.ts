import type { ErrorClassification } from "@roo-code/types"

/**
 * A single prior failure record used for loop detection. Captures the minimal
 * read-only fields the classifier needs to decide whether a new failure is a
 * repetition of a previous one.
 */
export interface PriorFailure {
	/** Tool name for a prior `TaskToolFailed` emission, if the prior failure was a tool failure. */
	tool?: string
	/** The prior failure's error message. */
	errorMessage: string
	/** The prior failure's HTTP status code, if applicable. */
	httpStatus?: number
}

/**
 * A signal describing an error observed by the Task Observatory.
 *
 * This is the raw, read-only input consumed by {@link classify}, which maps it
 * to one of the `ErrorClassification` values (or `undefined` when the signal is
 * not considered an error at all, e.g. external-system polling). The signal
 * carries the sequence/history context (`priorFailures`, `credentialChanged`,
 * `interveningStateChange`, `isPolling`) the classifier needs for loop
 * detection and polling exclusion.
 */
export interface ErrorSignal {
	/** The kind of error signal. */
	kind: "network" | "model" | "tool" | "validation" | "auth" | "infrastructure" | "ask" | "unknown"
	/** HTTP status code if applicable (e.g. 401, 403, 500). */
	httpStatus?: number
	/** Error message string (from a `TaskToolFailed` emission or provider error). */
	errorMessage: string
	/** Tool name if this is a tool failure (from the `TaskToolFailed` event `tool` field). */
	tool?: string
	/** Whether this activity is external-system polling (e.g. Kubernetes status checks). */
	isPolling?: boolean
	/** Whether a transient failure later succeeded on retry. */
	retriedSuccessfully?: boolean
	/** History of prior failures, used for loop detection. */
	priorFailures?: PriorFailure[]
	/** Whether credentials changed since the last auth failure (resets an auth loop). */
	credentialChanged?: boolean
	/**
	 * Whether an intervening state change (new `Message`, task progress, or
	 * checklist change) occurred since the last failure. A state change breaks a
	 * loop.
	 */
	interveningStateChange?: boolean
}

/**
 * Minimum number of matching prior failures required to detect a tool loop
 * (a repeated identical tool failure with no intervening state change). Auth
 * loops require at least one matching prior 401/403 failure.
 */
export const LOOP_THRESHOLD = 2

/**
 * Checks whether an HTTP status code indicates an authentication/authorization
 * failure (401 Unauthorized or 403 Forbidden).
 */
function isAuthStatus(httpStatus: number | undefined): boolean {
	return httpStatus === 401 || httpStatus === 403
}

/**
 * Checks whether an HTTP status code indicates a server-side (5xx) failure.
 */
function is5xxStatus(httpStatus: number | undefined): boolean {
	return typeof httpStatus === "number" && httpStatus >= 500 && httpStatus <= 599
}

/**
 * Detects an auth loop: a repeated 401/403 auth failure where neither the
 * credentials changed nor any intervening state change occurred since the prior
 * matching failure. A credential change resets the loop and reverts
 * classification to a fresh AUTH failure.
 */
function isAuthLoop(signal: ErrorSignal): boolean {
	if (signal.kind !== "auth" || !isAuthStatus(signal.httpStatus)) {
		return false
	}

	const matchingPriorFailures = (signal.priorFailures ?? []).filter((failure) => isAuthStatus(failure.httpStatus))

	return matchingPriorFailures.length > 0 && signal.credentialChanged !== true && signal.interveningStateChange !== true
}

/**
 * Detects a tool loop: repeated `TaskToolFailed` emissions with the same tool
 * and same error message, with no intervening state change between them.
 */
function isToolLoop(signal: ErrorSignal): boolean {
	if (signal.kind !== "tool" || signal.tool === undefined) {
		return false
	}

	const matchingPriorFailures = (signal.priorFailures ?? []).filter(
		(failure) => failure.tool === signal.tool && failure.errorMessage === signal.errorMessage,
	)

	return matchingPriorFailures.length >= LOOP_THRESHOLD && signal.interveningStateChange !== true
}

/**
 * Classifies an error signal into an {@link ErrorClassification} category.
 *
 * The function is pure, total, and side-effect-free: it never mutates its input
 * and always returns a classification for any non-polling signal. For external
 * polling activity (`signal.isPolling === true`) it returns `undefined`,
 * signalling that the signal is normal progress and must never be treated as an
 * error (Requirement 12.2).
 *
 * Order of operations:
 * 1. Polling exclusion — polling signals are never errors (returns `undefined`).
 * 2. Loop detection — a repeated identical failure (same tool/error with no
 *    intervening state change, or a repeated 401 with no credential change) is
 *    classified as `LOOP` before single-occurrence classification, so a
 *    repeated auth failure reports as a loop rather than plain `AUTH`
 *    (Requirements 12.1, 12.3).
 * 3. Single-occurrence classification — maps the signal kind (and HTTP status)
 *    to its category per the design mapping table, falling back to `TRANSIENT`
 *    for unknown signals.
 */
export function classify(signal: ErrorSignal): ErrorClassification | undefined {
	// 1. Polling exclusion: external-system polling is never an error.
	if (signal.isPolling === true) {
		return undefined
	}

	// 2. Loop detection (checked before single-occurrence classification).
	if (isAuthLoop(signal) || isToolLoop(signal)) {
		return "LOOP"
	}

	// 3. Single-occurrence classification.
	switch (signal.kind) {
		case "ask":
			// Waiting on the user for input; blocks progress but is not a failure.
			return "USER_INPUT_REQUIRED"
		case "auth":
			// First-occurrence 401/403 auth/authz failure.
			return "AUTH"
		case "network":
			// Network timeout/5xx that later succeeds, or a single retryable
			// failure, is transient (Requirement 12.1 design mapping). A
			// network signal has no non-transient outcome in the mapping table.
			return "TRANSIENT"
		case "model":
			// Model/provider error (bad response, model unavailable).
			return "MODEL"
		case "tool":
			// Single/non-repeating tool-execution failure.
			return "TOOL"
		case "validation":
			// Schema/argument/validation rejection.
			return "VALIDATION"
		case "infrastructure":
			// Worktree/filesystem/process/environment failure.
			return "INFRASTRUCTURE"
		case "unknown":
		default:
			// Safe total fallback: treat an unrecognized failure as transient.
			return "TRANSIENT"
	}
}
