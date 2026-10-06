import {
	type OrchestrationReasoningEffort,
	type WorkerReasoningPolicy,
	orchestrationReasoningEfforts,
	orchestrationReasoningRank,
	resolveEffortCeiling,
} from "@roo-code/types"

/**
 * Triggers that may prompt a worker to escalate its applied reasoning effort.
 */
export type EscalationTrigger = "ambiguity" | "conflicting-evidence" | "repeated-failure" | "low-confidence"

/**
 * Reasoning telemetry reported by a worker after execution.
 *
 * - `requested` is the baseline `effort` the mastermind asked for.
 * - `used` is the highest applied effort reached during execution.
 * - `escalations` is the count of escalations that actually changed the applied effort.
 */
export interface ReasoningTelemetry {
	requested: OrchestrationReasoningEffort
	used: OrchestrationReasoningEffort
	escalations: number
}

/**
 * Per-worker controller for adaptive reasoning effort.
 *
 * The applied effort begins at `policy.effort` and may escalate one rank at a time
 * toward `resolveEffortCeiling(policy)` on defined triggers. It never exceeds the
 * ceiling and holds steady when `adaptive` is false/unset. Escalations that change
 * the applied effort are counted for telemetry.
 */
export class AdaptiveReasoningController {
	private readonly policy: WorkerReasoningPolicy
	private readonly ceilingRank: number
	private appliedEffort: OrchestrationReasoningEffort
	private escalationCount = 0

	constructor(policy: WorkerReasoningPolicy) {
		this.policy = policy
		this.appliedEffort = policy.effort
		this.ceilingRank = orchestrationReasoningRank[resolveEffortCeiling(policy)]
	}

	/** The current applied reasoning effort. Never above the resolved ceiling. */
	get applied(): OrchestrationReasoningEffort {
		return this.appliedEffort
	}

	/**
	 * Escalate the applied effort by one rank toward the ceiling.
	 *
	 * Holds steady when `adaptive` is false/unset or when already at the ceiling.
	 * Only counts the escalation when the applied effort actually changes.
	 */
	escalate(_trigger: EscalationTrigger): void {
		if (!this.policy.adaptive) {
			return
		}

		const currentRank = orchestrationReasoningRank[this.appliedEffort]

		if (currentRank >= this.ceilingRank) {
			return
		}

		const nextEffort = orchestrationReasoningEfforts[currentRank + 1]

		if (nextEffort === undefined || nextEffort === this.appliedEffort) {
			return
		}

		this.appliedEffort = nextEffort
		this.escalationCount += 1
	}

	/** Telemetry describing the requested, highest-applied, and escalation count. */
	telemetry(): ReasoningTelemetry {
		return {
			requested: this.policy.effort,
			used: this.appliedEffort,
			escalations: this.escalationCount,
		}
	}
}
