import { DEFAULT_TENACITY_MAX_TRIES } from "@roo-code/types"

/** Give-up points that Tenacity can continue past, each with its own counter. */
export type TenacityKind = "no_tool_use" | "loop_detector" | "context_recovery" | "output_token_limit"

export const TENACITY_KINDS: readonly TenacityKind[] = [
	"no_tool_use",
	"loop_detector",
	"context_recovery",
	"output_token_limit",
]

export type TenacityPolicy = { mode: "off" } | { mode: "finite"; limit: number } | { mode: "unlimited" }

export interface TenacityPolicyInput {
	enabled: boolean
	maxTries?: number
	unlimited: boolean
	/** True only when the task is locked to OmniRoute `pool/tier1/*`; any other tier costs money. */
	lockedToTier1: boolean
}

/**
 * Resolves the Tenacity policy. "Unlimited" is honored only while locked to
 * `pool/tier1/*`; everywhere else `maxTries` (default {@link DEFAULT_TENACITY_MAX_TRIES}) caps it.
 */
export function resolveTenacityPolicy(input: TenacityPolicyInput): TenacityPolicy {
	if (!input.enabled) {
		return { mode: "off" }
	}
	if (input.unlimited && input.lockedToTier1) {
		return { mode: "unlimited" }
	}
	const tries = input.maxTries
	const limit = typeof tries === "number" && Number.isFinite(tries) && tries >= 1 ? Math.floor(tries) : undefined
	return { mode: "finite", limit: limit ?? DEFAULT_TENACITY_MAX_TRIES }
}

/**
 * Extra retries Tenacity grants beyond a give-up point's legacy allowance, or `undefined`
 * when unlimited. Tenacity never lowers the legacy limit: the total is `max(legacy, tries)`.
 */
export function tenacityExtraRetries(policy: TenacityPolicy, legacyLimit: number): number | undefined {
	switch (policy.mode) {
		case "off":
			return 0
		case "unlimited":
			return undefined
		case "finite":
			return Math.max(legacyLimit, policy.limit) - legacyLimit
	}
}

export const TENACITY_SMALLER_OUTPUT_NOTE =
	"Your previous response hit the output token limit and was cut off. Produce smaller outputs: work in smaller steps, write files in pieces, and avoid long explanations."

export const TENACITY_REPLAN_NOTE = (toolName: string): string =>
	`Tool call repetition detected for ${toolName}. Stop repeating it: re-read the task, pick a different approach, and make concrete progress with a different tool or different arguments.`
