import {
	analysisRequestSchema,
	type AnalysisFailureKind,
	type AnalysisOutcome,
	type AnalysisRequest,
} from "@roo-code/types"

import { AnalysisCache } from "./AnalysisCache"
import { DEFAULT_ANALYSIS_BUDGET, preflight, type AnalysisBudgetConfig } from "./AnalysisBudget"
import { ANALYSIS_TEMPLATE_VERSION, buildAnalysisMessages, withFormatCorrection } from "./AnalysisPrompt"
import { AnalysisQueue } from "./AnalysisQueue"
import { findStaleEvidence, validateModelText, type EvidenceVerifier } from "./AnalysisValidator"
import { analysisDigest } from "./analysisDigest"
import { applyRiskFloor } from "./riskFloor"
import { AnalysisTransportError, type AnalysisCompletionClient } from "./GraniteAnalysisClient"

export type AnalysisEvent =
	| { type: "cache-hit"; requestId: string }
	| { type: "attempt-failed"; requestId: string; attempt: number; kind: AnalysisFailureKind; reason: string }
	| {
			type: "completed"
			requestId: string
			kind: AnalysisOutcome["kind"]
			attempts: number
			promptTokens?: number
			completionTokens?: number
			suppressedFindings: number
	  }

export interface AnalysisExecutorOptions {
	client: AnalysisCompletionClient
	queue: AnalysisQueue
	cache?: AnalysisCache
	verifyEvidence: EvidenceVerifier
	/** Workspace identity used to namespace the cache. */
	namespace: string
	deadlineMs?: number
	budget?: AnalysisBudgetConfig
	templateVersion?: string
	/** Metrics / audit sink. Receives no source text. */
	onEvent?: (event: AnalysisEvent) => void
}

const MAX_ATTEMPTS = 2

/**
 * Orchestrates one analysis request:
 * schema -> evidence freshness -> cache -> preflight -> bounded queue -> non-stream call ->
 * validation -> (one format retry) -> freshness re-check -> cache.
 *
 * It returns a typed outcome for every failure and never throws for expected conditions.
 * It has no tools, touches no files except through the injected evidence verifier, and a
 * `valid` outcome is evidence-grounded analysis, never a verification verdict.
 */
export class AnalysisExecutor {
	constructor(private readonly options: AnalysisExecutorOptions) {}

	async execute(rawRequest: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisOutcome> {
		const o = this.options
		const fail = (kind: AnalysisFailureKind, reason: string, attempts = 0): AnalysisOutcome => {
			o.onEvent?.({ type: "completed", requestId: rawRequest.requestId, kind, attempts, suppressedFindings: 0 })
			return { kind, requestId: rawRequest.requestId, reason: reason.slice(0, 1_000) || kind }
		}

		const parsed = analysisRequestSchema.safeParse(rawRequest)
		if (!parsed.success) return fail("invalid-schema", `request: ${parsed.error.issues[0]?.message ?? "invalid"}`)
		const request = parsed.data

		const stale = await findStaleEvidence(request, o.verifyEvidence)
		if (stale) return fail("stale-evidence", `evidence ${stale.anchorId} is ${stale.freshness}`)

		const digest = analysisDigest(request, {
			modelId: o.client.model,
			templateVersion: o.templateVersion ?? ANALYSIS_TEMPLATE_VERSION,
		})
		const cached = o.cache?.get(o.namespace, digest)
		if (cached) {
			o.onEvent?.({ type: "cache-hit", requestId: request.requestId })
			return { ...cached, requestId: request.requestId }
		}

		const baseMessages = buildAnalysisMessages(request)
		const budget = o.budget ?? DEFAULT_ANALYSIS_BUDGET
		const check = preflight(baseMessages.map((m) => m.content).join("\n"), request.maxOutputTokens, budget)
		if (!check.ok) return fail("oversize", check.reason)

		let messages = baseMessages
		let promptTokens: number | undefined
		let completionTokens: number | undefined

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			let completion
			try {
				completion = await o.queue.run((s) => o.client.complete(messages, request.maxOutputTokens, s), {
					deadlineMs: o.deadlineMs ?? 60_000,
					signal,
				})
			} catch (error) {
				if (error instanceof AnalysisTransportError) return fail(error.kind, error.message, attempt)
				return fail("unavailable", error instanceof Error ? error.message : "unexpected error", attempt)
			}
			promptTokens = completion.promptTokens
			completionTokens = completion.completionTokens

			const validated = validateModelText(completion.content, request, completion.finishReason)
			if (validated.ok) {
				// The file may have changed while the model was generating.
				const after = await findStaleEvidence(request, o.verifyEvidence)
				if (after) return fail("stale-evidence", `evidence ${after.anchorId} became ${after.freshness} during analysis`, attempt)

				let risk = validated.risk
				const unknowns = [...validated.unknowns]
				if (request.operation === "classify-change-risk") {
					const floored = applyRiskFloor(risk, request.evidence.map((e) => e.excerpt))
					risk = floored.risk
					if (floored.raisedBy) unknowns.push(`risk raised by deterministic floor: ${floored.raisedBy}`)
				}
				const outcome: AnalysisOutcome = {
					kind: "valid",
					requestId: request.requestId,
					operation: request.operation,
					findings: validated.findings,
					unknowns,
					risk,
					digest,
					modelId: o.client.model,
					retried: attempt > 1,
				}
				o.cache?.set(o.namespace, outcome)
				o.onEvent?.({
					type: "completed",
					requestId: request.requestId,
					kind: "valid",
					attempts: attempt,
					promptTokens,
					completionTokens,
					suppressedFindings: validated.suppressed,
				})
				return outcome
			}

			// Keep the earlier failure visible even if the retry succeeds.
			o.onEvent?.({
				type: "attempt-failed",
				requestId: request.requestId,
				attempt,
				kind: validated.kind,
				reason: validated.reason,
			})
			if (attempt === MAX_ATTEMPTS) return fail(validated.kind, validated.reason, attempt)
			messages = withFormatCorrection(baseMessages, validated.reason)
			const retryCheck = preflight(messages.map((m) => m.content).join("\n"), request.maxOutputTokens, budget)
			if (!retryCheck.ok) return fail("oversize", retryCheck.reason, attempt)
		}
		return fail("unavailable", "exhausted attempts", MAX_ATTEMPTS)
	}
}
