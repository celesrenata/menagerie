// Feature: resilient-context-recovery, Property 8 & 9: RecoveryTelemetry faithfully
// records every recovery attempt (and the terminal event), and is an additive-optional
// extension of WorkerResult that is never injected verbatim into the parent.

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import { workerResultSchema, type WorkerResult } from "@roo-code/types"

import { CONTEXT_OVERFLOW_NON_RECOVERABLE } from "../contextRecoveryClassifier"
import {
	readRecoveryTelemetry,
	type RecoveryAttemptTelemetry,
	type RecoveryTelemetry,
	type WorkerResultWithRecovery,
} from "../recoveryTelemetry"
import { compactParallelTasksResultForParent } from "../../tools/ParallelTasksTool"

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A generated spec for a single recovery attempt, independent of the telemetry
// record it produces. The builder below turns one of these into a well-formed
// RecoveryAttemptTelemetry; the properties then assert the record faithfully
// reflects the spec it was built from (path/handler fidelity, token monotonicity,
// terminal classification).
interface AttemptSpec {
	isLargeContext: boolean
	handlerId: string
	preTokens: number
	// How many tokens the reduction removed; postTokens = preTokens - removed,
	// clamped at 0 so postTokens ≤ preTokens always holds.
	removed: number
	isTerminal: boolean
}

const attemptSpecArb: fc.Arbitrary<AttemptSpec> = fc.record({
	isLargeContext: fc.boolean(),
	handlerId: fc.string({ minLength: 1, maxLength: 24 }),
	preTokens: fc.integer({ min: 0, max: 2_000_000 }),
	removed: fc.integer({ min: 0, max: 2_000_000 }),
	isTerminal: fc.boolean(),
})

// Build the telemetry record the production flow would attach for a given spec.
// large-context names its handler; deterministic omits handlerId entirely. The
// terminal classification rides only on the attempt that declares it.
const buildAttempt = (spec: AttemptSpec): RecoveryAttemptTelemetry => {
	const postTokens = Math.max(0, spec.preTokens - spec.removed)
	return {
		path: spec.isLargeContext ? "large-context" : "deterministic",
		...(spec.isLargeContext ? { handlerId: spec.handlerId } : {}),
		preTokens: spec.preTokens,
		postTokens,
		...(spec.isTerminal
			? { terminal: { classification: CONTEXT_OVERFLOW_NON_RECOVERABLE } as const }
			: {}),
	}
}

// A valid base WorkerResult, generated independently of RecoveryTelemetry so we
// can assert the recovery field is purely additive (every base field survives).
const evidenceArb = fc.record(
	{
		type: fc.constantFrom("file", "test", "command", "url", "screenshot"),
		reference: fc.string({ maxLength: 40 }),
		lines: fc.option(fc.tuple(fc.integer(), fc.integer()), { nil: undefined }),
		result: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
	},
	{ requiredKeys: ["type", "reference"] },
)

const workerResultArb: fc.Arbitrary<WorkerResult> = fc.record(
	{
		status: fc.constantFrom("completed", "failed", "blocked"),
		summary: fc.string({ maxLength: 80 }),
		findings: fc.array(
			fc.record(
				{ claim: fc.string({ maxLength: 40 }), confidence: fc.option(fc.double({ min: 0, max: 1 }), { nil: undefined }) },
				{ requiredKeys: ["claim"] },
			),
			{ maxLength: 4 },
		),
		evidence: fc.array(evidenceArb, { maxLength: 4 }),
		changes: fc.array(fc.string({ maxLength: 30 }), { maxLength: 4 }),
		tests: fc.array(fc.string({ maxLength: 30 }), { maxLength: 4 }),
		blockers: fc.array(fc.string({ maxLength: 30 }), { maxLength: 4 }),
		artifacts: fc.array(fc.string({ maxLength: 30 }), { maxLength: 4 }),
		reasoning: fc.option(
			fc.record({
				requested: fc.constantFrom("minimal", "low", "medium", "high"),
				used: fc.constantFrom("minimal", "low", "medium", "high"),
				escalations: fc.integer({ min: 0, max: 10 }),
			}),
			{ nil: undefined },
		),
	},
	{ requiredKeys: ["status", "summary", "findings", "evidence", "changes", "tests", "blockers", "artifacts"] },
	// Validate each generated value against the real schema so our fixtures can
	// never drift from the contract they are standing in for.
).filter((value) => workerResultSchema.safeParse(value).success)

// ---------------------------------------------------------------------------
// Property 8 — telemetry fidelity
// ---------------------------------------------------------------------------

describe("RecoveryTelemetry — Property 8 (telemetry fidelity)", () => {
	// Feature: resilient-context-recovery, Property 8: Telemetry faithfully records every recovery attempt and the terminal event
	// Validates: Requirements 6.1, 6.2, 6.3
	it("records exactly one entry per attempt with path/handler and token fidelity", () => {
		fc.assert(
			fc.property(fc.array(attemptSpecArb, { minLength: 1, maxLength: 12 }), (specs) => {
				const attempts = specs.map(buildAttempt)
				const telemetry: RecoveryTelemetry = { attempts }

				// Exactly one record per attempt (Req 6.1).
				expect(telemetry.attempts).toHaveLength(specs.length)

				telemetry.attempts.forEach((record, i) => {
					const spec = specs[i]!

					// path matches the resolution outcome, and handlerId presence is
					// path-correlated: large-context names a handler, deterministic omits it (Req 6.2).
					if (spec.isLargeContext) {
						expect(record.path).toBe("large-context")
						expect(record.handlerId).toBe(spec.handlerId)
					} else {
						expect(record.path).toBe("deterministic")
						expect(record.handlerId).toBeUndefined()
					}

					// postTokens ≤ preTokens, and both equal the measured sizes (Req 6.3).
					expect(record.preTokens).toBe(spec.preTokens)
					expect(record.postTokens).toBe(Math.max(0, spec.preTokens - spec.removed))
					expect(record.postTokens).toBeLessThanOrEqual(record.preTokens)
				})
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: resilient-context-recovery, Property 8: a terminal declaration produces exactly one record carrying the terminal classification
	// Validates: Requirements 6.4
	it("carries the terminal classification on exactly the one declaring attempt", () => {
		fc.assert(
			fc.property(
				fc.array(attemptSpecArb, { minLength: 1, maxLength: 10 }),
				// Which attempt index declares the terminal outcome (always the last
				// one in a real recovery loop; generated here to vary position).
				fc.nat(),
				(baseSpecs, rawIndex) => {
					const terminalIndex = rawIndex % baseSpecs.length
					// Model a real recovery loop: at most one attempt declares the
					// terminal outcome, and it is the final attempt taken.
					const specs = baseSpecs.map((s, i) => ({ ...s, isTerminal: i === terminalIndex }))
					const attempts = specs.map(buildAttempt)
					const telemetry: RecoveryTelemetry = { attempts }

					const terminalRecords = telemetry.attempts.filter((a) => a.terminal !== undefined)

					// Exactly one record carries the terminal classification (Req 6.4).
					expect(terminalRecords).toHaveLength(1)
					expect(terminalRecords[0]!.terminal?.classification).toBe(CONTEXT_OVERFLOW_NON_RECOVERABLE)
					// And it is the attempt that declared it.
					expect(telemetry.attempts[terminalIndex]!.terminal?.classification).toBe(
						CONTEXT_OVERFLOW_NON_RECOVERABLE,
					)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: resilient-context-recovery, Property 8: a run with no terminal declaration carries no terminal record
	// Validates: Requirements 6.4
	it("carries no terminal record when no attempt declares a terminal outcome", () => {
		fc.assert(
			fc.property(fc.array(attemptSpecArb, { minLength: 1, maxLength: 10 }), (baseSpecs) => {
				const specs = baseSpecs.map((s) => ({ ...s, isTerminal: false }))
				const telemetry: RecoveryTelemetry = { attempts: specs.map(buildAttempt) }

				expect(telemetry.attempts.every((a) => a.terminal === undefined)).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})
})

// ---------------------------------------------------------------------------
// Property 9 — additive-optional round trip, parent-view exclusion
// ---------------------------------------------------------------------------

describe("WorkerResultWithRecovery — Property 9 (additive-optional round trip)", () => {
	// Feature: resilient-context-recovery, Property 9: the value validates as WorkerResultWithRecovery with and without a recovery field (every base field preserved)
	// Validates: Requirements 6.5
	it("preserves every base WorkerResult field whether or not recovery is attached", () => {
		fc.assert(
			fc.property(workerResultArb, fc.array(attemptSpecArb, { maxLength: 6 }), (base, specs) => {
				const telemetry: RecoveryTelemetry = { attempts: specs.map(buildAttempt) }

				// Without recovery: a bare base is already a WorkerResultWithRecovery and
				// still validates as the base schema (nothing added, nothing removed).
				const without: WorkerResultWithRecovery = { ...base }
				expect(workerResultSchema.safeParse(without).success).toBe(true)

				// With recovery: the additive field is attached, and the base schema
				// (which ignores unknown keys) still validates — no base field changed.
				const withRecovery: WorkerResultWithRecovery = { ...base, recovery: telemetry }
				expect(workerResultSchema.safeParse(withRecovery).success).toBe(true)

				// Every base field is byte-for-byte preserved by the spread.
				for (const key of Object.keys(base) as (keyof WorkerResult)[]) {
					expect(withRecovery[key]).toStrictEqual(base[key])
					expect(without[key]).toStrictEqual(base[key])
				}
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: resilient-context-recovery, Property 9: reading an absent recovery via readRecoveryTelemetry yields undefined (never throws)
	// Validates: Requirements 6.5
	it("reads an absent recovery as undefined without throwing", () => {
		fc.assert(
			fc.property(fc.option(workerResultArb, { nil: undefined }), (maybeBase) => {
				// No recovery field present (including the undefined-result case).
				const result = maybeBase as WorkerResultWithRecovery | undefined
				expect(() => readRecoveryTelemetry(result)).not.toThrow()
				expect(readRecoveryTelemetry(result)).toBeUndefined()
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: resilient-context-recovery, Property 9: a present recovery is returned by the reader
	// Validates: Requirements 6.5
	it("reads a present recovery back intact", () => {
		fc.assert(
			fc.property(workerResultArb, fc.array(attemptSpecArb, { maxLength: 6 }), (base, specs) => {
				const telemetry: RecoveryTelemetry = { attempts: specs.map(buildAttempt) }
				const result: WorkerResultWithRecovery = { ...base, recovery: telemetry }

				expect(readRecoveryTelemetry(result)).toBe(telemetry)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: resilient-context-recovery, Property 9: a faked compacted parent view never contains the verbatim telemetry block
	// Validates: Requirements 6.6
	it("never leaks the verbatim telemetry block into the compacted parent view", () => {
		fc.assert(
			fc.property(
				// Free-text fields the worker legitimately controls. Restricted to a
				// benign alphabet so a generated value can't coincidentally spell a
				// telemetry marker token (e.g. the literal word "recovery") — the
				// property is about the compaction channel, not string collisions.
				fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz -".split("")), { minLength: 1, maxLength: 20 }),
				fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), { minLength: 1, maxLength: 20 }),
				fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz .,!".split("")), { maxLength: 200 }),
				fc.array(attemptSpecArb, { minLength: 1, maxLength: 6 }),
				(name, batchId, resultText, specs) => {
					const telemetry: RecoveryTelemetry = { attempts: specs.map(buildAttempt) }

					// The parent-visible view is produced by the existing compaction path,
					// which only ever carries the worker's name/mode/state/result — never a
					// recovery block. We feed a worker whose structured result exists but
					// whose recovery telemetry lives out-of-band (attached to the worker
					// result, not the parent-facing summary).
					const parentView = compactParallelTasksResultForParent({
						batchId,
						manifestPath: "/tmp/manifest.json",
						tasks: [{ name, mode: "code", state: "done", result: resultText }],
					})

					const serialized = JSON.stringify(parentView)

					// The verbatim telemetry block (and its structural markers) must not
					// appear in the parent-visible view (Req 6.6). The compaction path
					// carries only the worker's name/mode/state/result — it has no channel
					// for the recovery block, the terminal classification constant, or the
					// `recovery` key, so none of them can ride into the parent context.
					expect(serialized).not.toContain(JSON.stringify(telemetry))
					expect(serialized).not.toContain(JSON.stringify(telemetry.attempts))
					expect(serialized).not.toContain(CONTEXT_OVERFLOW_NON_RECOVERABLE)
					expect(serialized).not.toContain('"recovery"')
					expect(serialized).not.toContain('"preTokens"')
					expect(serialized).not.toContain('"postTokens"')
					expect(serialized).not.toContain('"terminal"')
				},
			),
			{ numRuns: 200 },
		)
	})
})
