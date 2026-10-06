import type {
	ExplorationAffordance,
	ExplorationDecision,
	ExplorationPolicyInputs,
} from "./types"

/**
 * Pure advisory exploration policy.
 *
 * The policy biases tool selection toward semantic retrieval before broad
 * filesystem walking, but it never blocks a tool call: every
 * {@link ExplorationDecision} carries the invariant `blocks: false`.
 *
 * Both methods are pure and synchronous — no prompt text, no I/O.
 */
export interface ExplorationPolicy {
	/** Pure, synchronous decision. No prompt text, no I/O. */
	decide(inputs: ExplorationPolicyInputs): ExplorationDecision

	/** Advisory affordance ordering for the current decision. */
	affordancesFor(decision: ExplorationDecision): ExplorationAffordance
}

/**
 * Pure decision core (design: biconditional preference rule).
 *
 * Precedence:
 * 1. `KnownTarget` when `knownTarget.present` — a direct `read_file` is
 *    permitted with `requiresRetrieveBeforeRead: false`. Known-target presence
 *    takes precedence over every other condition.
 * 2. `PreferSemantic` **iff**
 *    `indexAvailability.available && gatewayAvailable && exploringUnseenArea &&
 *    !knownTarget.present`.
 * 3. `AllowWalking` otherwise.
 *
 * `metricEvent`:
 * - `index-unavailable` when `!indexAvailability.available` (the dominant
 *   metric — the index is the first-checked condition, so an unavailable index
 *   wins over an unavailable gateway).
 * - `gateway-unavailable` when the index IS available but `!gatewayAvailable`.
 * - No index/gateway metric is set for `KnownTarget` or `PreferSemantic`.
 *
 * The decision never blocks the tool call (`blocks: false`).
 *
 * Requirements traced: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3, 3.1, 4.6, 4.7, 8.5, 9.3
 */
export function decide(inputs: ExplorationPolicyInputs): ExplorationDecision {
	const { indexAvailability, gatewayAvailable, knownTarget, exploringUnseenArea } = inputs

	// Known-target bypass takes precedence: read directly, no prior retrieve.
	if (knownTarget.present) {
		return {
			outcome: "KnownTarget",
			blocks: false,
			requiresRetrieveBeforeRead: false,
		}
	}

	// Preference holds exactly when all four conditions align (Property 1).
	const preferSemantic =
		indexAvailability.available && gatewayAvailable && exploringUnseenArea && !knownTarget.present

	if (preferSemantic) {
		return {
			outcome: "PreferSemantic",
			blocks: false,
			requiresRetrieveBeforeRead: true,
		}
	}

	// AllowWalking otherwise. Record the dominant unavailability metric: an
	// unavailable index wins over an unavailable gateway (index is checked first).
	let metricEvent: ExplorationDecision["metricEvent"]
	if (!indexAvailability.available) {
		metricEvent = "index-unavailable"
	} else if (!gatewayAvailable) {
		metricEvent = "gateway-unavailable"
	}

	return {
		outcome: "AllowWalking",
		blocks: false,
		requiresRetrieveBeforeRead: false,
		metricEvent,
	}
}

/**
 * Advisory affordance ordering derived purely from the decision outcome
 * (design: Requirement 2 navigation flow).
 *
 * - `PreferSemantic` → semantic retrieval first.
 * - `KnownTarget` → direct read first.
 * - `AllowWalking` → broad walking first (`list_files`/`search_files`).
 *
 * Requirements traced: 2.1, 2.3
 */
export function affordancesFor(decision: ExplorationDecision): ExplorationAffordance {
	switch (decision.outcome) {
		case "PreferSemantic":
			return {
				preferredNext: "semantic_retrieval",
				ordered: ["semantic_retrieval", "read_file", "list_files", "search_files"],
			}
		case "KnownTarget":
			return {
				preferredNext: "known_target_read",
				ordered: ["read_file", "semantic_retrieval", "list_files", "search_files"],
			}
		case "AllowWalking":
			return {
				preferredNext: "broad_walking",
				ordered: ["list_files", "search_files", "read_file", "semantic_retrieval"],
			}
	}
}

/**
 * Shared stateless {@link ExplorationPolicy} instance. Both methods are pure,
 * so a single instance is safe to reuse across tasks and workers.
 */
export const explorationPolicy: ExplorationPolicy = {
	decide,
	affordancesFor,
}
