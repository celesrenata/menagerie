// Feature: semantic-first-retrieval, Property 2: Unavailability and failed conditions allow walking without blocking and record the right metric

import fc from "fast-check"
import { describe, it } from "vitest"

import { decide } from "../explorationPolicy"
import { explorationPolicyInputsArb } from "./arbitraries"

/**
 * Property 2: Unavailability and failed conditions allow walking without blocking
 * and record the right metric.
 *
 * For any `ExplorationPolicyInputs` in which the index snapshot is unavailable OR
 * the gateway is unavailable OR the task is not exploring an unseen area — and no
 * known target applies, because a known target would route to `KnownTarget` — the
 * decision allows broad filesystem walking (`AllowWalking`), never blocks the tool
 * call, and records the correct metric event:
 *   - `index-unavailable` when the index snapshot is unavailable (dominant, since
 *     the index is the first-checked condition).
 *   - `gateway-unavailable` when the index IS available but the gateway is not.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 8.5
 */
describe("ExplorationPolicy — Property 2: fallback allows walking without blocking", () => {
	it("allows walking, never blocks, and records the correct metric when a preference condition fails", () => {
		fc.assert(
			fc.property(explorationPolicyInputsArb, (inputs) => {
				const decision = decide(inputs)

				// The policy never blocks a tool call, in any outcome (Req 4.6).
				if (decision.blocks !== false) {
					throw new Error(`decision.blocks must always be false, got ${String(decision.blocks)}`)
				}

				// Known-target presence routes to KnownTarget, which is outside this
				// property's scope — skip it so we test the fallback path cleanly.
				fc.pre(!inputs.knownTarget.present)

				const { available } = inputs.indexAvailability
				const preferSemantic = available && inputs.gatewayAvailable && inputs.exploringUnseenArea

				// This property targets inputs where PreferSemantic does NOT hold.
				fc.pre(!preferSemantic)

				// Fallback: broad filesystem walking is allowed (Req 4.1-4.5, 8.5).
				if (decision.outcome !== "AllowWalking") {
					throw new Error(
						`expected AllowWalking when no preference condition holds, got ${decision.outcome}`,
					)
				}

				// A direct read is never required on the walking path.
				if (decision.requiresRetrieveBeforeRead !== false) {
					throw new Error("AllowWalking must not require a retrieve before read")
				}

				// Metric event: an unavailable index is the dominant/first-checked
				// condition and wins over an unavailable gateway (Req 4.7, 8.5).
				if (!available) {
					if (decision.metricEvent !== "index-unavailable") {
						throw new Error(
							`expected index-unavailable metric when the index is unavailable, got ${String(
								decision.metricEvent,
							)}`,
						)
					}
				} else if (!inputs.gatewayAvailable) {
					// Index available but gateway unavailable.
					if (decision.metricEvent !== "gateway-unavailable") {
						throw new Error(
							`expected gateway-unavailable metric when the gateway is unavailable, got ${String(
								decision.metricEvent,
							)}`,
						)
					}
				} else {
					// Index and gateway both available but not exploring an unseen area:
					// walking is allowed and no index/gateway metric is recorded.
					if (decision.metricEvent !== undefined) {
						throw new Error(
							`expected no metric event when index and gateway are available, got ${String(
								decision.metricEvent,
							)}`,
						)
					}
				}
			}),
			{ numRuns: 300 },
		)
	})
})
