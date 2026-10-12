import type { ApiMessage } from "../task-persistence/apiMessages"

/**
 * Resilient Context Recovery — Deterministic_Reduction / Convergent_Reduction.
 *
 * A model-free, lane-free token-counted truncation of an over-window transcript to a target
 * token count. It depends on no model and no Capability_Lane: `countTokens` is its only external
 * dependency and is never an LLM call. Because it targets an absolute token count rather than a
 * fixed fraction of the current size, a single bounded pass reaches `targetTokens` for any starting
 * `Over_Size_Ratio` (Req 2.2, 2.3, 3.1, 3.3, 3.4).
 *
 * The reduction preserves the first task message and the two newest visible messages, matching the
 * `getAdaptiveTruncationMessageCount` discipline in `src/core/context-management/index.ts`. When even
 * that minimal irreducible transcript still exceeds `targetTokens`, the result reports
 * `converged: false` — the Req 5.1 terminal condition handled by the recovery classifier.
 */

export interface ConvergentReductionInput {
	messages: ApiMessage[]
	/** Current counted token total of `messages`. */
	currentTokens: number
	/** The target the transcript must land at or below (Servable_Input_Budget or Recovery_Input_Bound). */
	targetTokens: number
	/** Token counter (e.g. apiHandler.countTokens over a message set) — the only external dependency; no model call. */
	countTokens: (messages: ApiMessage[]) => Promise<number>
}

export interface ConvergentReductionResult {
	messages: ApiMessage[]
	/** Counted tokens after reduction; ≤ targetTokens unless the irreducible core exceeds it. */
	resultTokens: number
	/** True iff resultTokens ≤ targetTokens (converged); false iff the irreducible core exceeds target. */
	converged: boolean
	/** Pre-reduction token total, for telemetry (Req 6.3). */
	prevTokens: number
}

/**
 * Returns the indices of messages that are visible to the model — i.e. not hidden behind a prior
 * truncation and not themselves a truncation boundary marker. Mirrors the visibility test used by
 * the sliding-window truncation in `context-management/index.ts`.
 */
function getVisibleMessageIndices(messages: ApiMessage[]): number[] {
	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})
	return visibleIndices
}

/**
 * Removes oldest removable history (preserving the first task message and the two newest visible
 * messages) until the counted token total is at or below `targetTokens`, in a single bounded pass.
 *
 * Removal proceeds in complete pairs from the oldest removable visible message, re-counting the
 * surviving transcript after each pair so the pass stops as soon as the target is reached. When the
 * irreducible core (first task message + two newest visible messages) already satisfies the target,
 * reduction converges; when that core still exceeds the target, the result reports `converged: false`.
 */
export async function convergentReduction(input: ConvergentReductionInput): Promise<ConvergentReductionResult> {
	const { messages, currentTokens, targetTokens, countTokens } = input
	const prevTokens = currentTokens

	// Already within budget — nothing to remove.
	if (currentTokens <= targetTokens) {
		return { messages, resultTokens: currentTokens, converged: true, prevTokens }
	}

	const visibleIndices = getVisibleMessageIndices(messages)
	// Preserve the first task message plus the two newest visible messages.
	const removable = Math.max(0, visibleIndices.length - 3)
	const maxEvenRemovable = removable - (removable % 2)

	// Build the irreducible core up front: everything that is NOT a removable-visible message, which
	// retains the first visible (task) message, the two newest visible messages, and any hidden/marker
	// messages interleaved among them. This is the floor the single pass can reach.
	const removableVisibleSet = new Set<number>(visibleIndices.slice(1, 1 + maxEvenRemovable))

	// Walk the removable pairs from oldest to newest, dropping each pair and re-counting until the
	// surviving transcript is at or below the target.
	for (let count = 2; count <= maxEvenRemovable; count += 2) {
		const dropped = new Set<number>(visibleIndices.slice(1, 1 + count))
		const candidate = messages.filter((_, index) => !dropped.has(index))
		const candidateTokens = await countTokens(candidate)
		if (candidateTokens <= targetTokens) {
			return { messages: candidate, resultTokens: candidateTokens, converged: true, prevTokens }
		}
	}

	// Nothing more can be removed without touching the preserved core. Count the irreducible core and
	// report whether it fits. When it still exceeds the target this is the Req 5.1 terminal condition.
	const irreducible = messages.filter((_, index) => !removableVisibleSet.has(index))
	const irreducibleTokens = await countTokens(irreducible)
	return {
		messages: irreducible,
		resultTokens: irreducibleTokens,
		converged: irreducibleTokens <= targetTokens,
		prevTokens,
	}
}
