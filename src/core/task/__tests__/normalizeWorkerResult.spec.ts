// Feature: worker-result-prose-salvage — normalizeWorkerResult downgrades
// non-conforming prose into a conforming WorkerResult that preserves the full
// text, instead of hard-failing and truncating to 500 chars.
import { describe, expect, it } from "vitest"

import type { WorkerResult } from "@roo-code/types"

import { buildPathConfirmationBlocker, normalizeWorkerResult } from "../normalizeWorkerResult"

/**
 * Validates the normalizer's three outcomes:
 * 1. Conforming structured output passes through unchanged.
 * 2. Non-conforming prose is salvaged (status inferred, FULL text preserved).
 * 3. Genuinely-empty output stays a failed "empty output" result.
 *
 * The regression guard for the reported bug is that a >500-char prose body is
 * retained in full in `summary`, never truncated.
 */
describe("normalizeWorkerResult", () => {
	const workerName = "gaps-extract-2"

	const assertEmptyArrays = (result: WorkerResult): void => {
		expect(result.findings).toEqual([])
		expect(result.evidence).toEqual([])
		expect(result.changes).toEqual([])
		expect(result.tests).toEqual([])
		expect(result.blockers).toEqual([])
		expect(result.artifacts).toEqual([])
	}

	describe("conforming JSON WorkerResult", () => {
		it("passes a fully-specified result through unchanged", () => {
			const input: WorkerResult = {
				status: "completed",
				summary: "Read all 168 lines of audit-gaps.md",
				findings: [{ claim: "U-1 covered", confidence: 0.9 }],
				evidence: [{ type: "file", reference: "audit-gaps.md", lines: [1, 168] }],
				changes: ["edited audit-gaps.md"],
				tests: ["unit"],
				blockers: [],
				artifacts: ["report.md"],
			}

			const result = normalizeWorkerResult(JSON.stringify(input), { workerName })

			expect(result).toEqual(input)
		})

		it("defaults absent array fields to [] for an otherwise-conforming object", () => {
			const result = normalizeWorkerResult(
				JSON.stringify({ status: "completed", summary: "done" }),
				{ workerName },
			)

			expect(result.status).toBe("completed")
			expect(result.summary).toBe("done")
			assertEmptyArrays(result)
		})
	})

	describe("non-JSON prose salvage", () => {
		it("preserves a long (>500 char) prose body in full without truncating", () => {
			// Build a body well over the old MAX_RAW_SUMMARY_CHARS = 500 limit.
			const body = `# Gap extraction results\n\n${"Found gap set. ".repeat(80)}End of report.`
			expect(body.length).toBeGreaterThan(500)

			const result = normalizeWorkerResult(body, { workerName })

			// Whitespace is collapsed, but no content is dropped.
			const collapsed = body.replace(/\s+/g, " ").trim()
			expect(result.summary).toBe(collapsed)
			expect(result.summary.length).toBeGreaterThan(500)
			expect(result.summary).not.toContain("…")
		})

		it("defaults prose to status 'completed' and empty arrays", () => {
			const result = normalizeWorkerResult("All views audited; everything looks good.", {
				workerName,
			})

			expect(result.status).toBe("completed")
			assertEmptyArrays(result)
		})

		it("infers 'blocked' when the prose signals a blocker", () => {
			const result = normalizeWorkerResult("I am blocked: the web/ directory is missing.", {
				workerName,
			})

			expect(result.status).toBe("blocked")
			expect(result.summary).toContain("blocked")
		})

		it("infers 'failed' when the prose signals a failure", () => {
			const result = normalizeWorkerResult("The task failed because the file could not be read.", {
				workerName,
			})

			expect(result.status).toBe("failed")
		})
	})

	// Feature: file-not-found-as-question (Layer 3). A missing REFERENCED INPUT
	// the worker was told to READ is a recoverable question → blocked; a missing
	// PRODUCED/expected file (or raw write-ENOENT) stays a genuine failure.
	describe("not-found input vs produced classification", () => {
		it("classifies a read-side-framed missing input as 'blocked' with a path-confirmation blocker (AC-7)", () => {
			const result = normalizeWorkerResult("Could not find the input config/app.yaml to read.", {
				workerName,
			})

			expect(result.status).toBe("blocked")
			expect(result.blockers).toHaveLength(1)
			expect(result.blockers[0]).toContain("config/app.yaml")
			expect(result.blockers[0]).toContain("Confirm the correct path")
		})

		it("classifies a verbatim post-collapse Layer-2 notice body as 'blocked' + blocker (finding #1)", () => {
			// `rawToText` collapses the notice's newlines to spaces; the `Not found:`
			// marker must still match.
			const notice =
				"File: config/app.yaml Not found: no file exists at this path. Did you mean one of these? - deploy/app.yaml"
			const result = normalizeWorkerResult(notice, { workerName })

			expect(result.status).toBe("blocked")
			expect(result.blockers).toHaveLength(1)
			expect(result.blockers[0]).toContain("config/app.yaml")
		})

		it("classifies produced-file failure prose as 'failed' (AC-8)", () => {
			expect(normalizeWorkerResult("Failed to create output.json for the report.", { workerName }).status).toBe(
				"failed",
			)
			expect(
				normalizeWorkerResult("The expected output report.md is missing after the run.", { workerName }).status,
			).toBe("failed")
			expect(
				normalizeWorkerResult("Verification failed: dist/bundle.js does not exist.", { workerName }).status,
			).toBe("failed")
		})

		it("classifies a bare raw write-ENOENT as 'failed', never 'blocked' (AC-9, central safety pin)", () => {
			const result = normalizeWorkerResult("ENOENT: no such file or directory, open 'dist/output.json'", {
				workerName,
			})

			expect(result.status).toBe("failed")
			expect(result.blockers).toEqual([])
		})

		it("classifies a narrated write-ENOENT as 'failed' (produced tested first)", () => {
			const result = normalizeWorkerResult(
				"could not write the artifact: ENOENT: no such file or directory, open 'dist/out.json'",
				{ workerName },
			)

			expect(result.status).toBe("failed")
		})

		it("classifies produced-negation phrasings as 'failed' (finding #2 breadth)", () => {
			expect(normalizeWorkerResult("the required artifact was never written", { workerName }).status).toBe(
				"failed",
			)
			expect(normalizeWorkerResult("output was not generated", { workerName }).status).toBe("failed")
			expect(
				normalizeWorkerResult("cannot proceed: the artifact was never written", { workerName }).status,
			).toBe("failed")
		})

		it("short-circuits produced over a 'did you mean' input marker (ordering guard)", () => {
			const result = normalizeWorkerResult("failed to create output.json (did you mean dist/output.json?)", {
				workerName,
			})

			expect(result.status).toBe("failed")
		})

		it("keeps a generic 'blocked' prose as 'blocked' (regression pin, no not-found reinterpretation)", () => {
			const result = normalizeWorkerResult("I am blocked: the web/ directory is missing.", { workerName })

			expect(result.status).toBe("blocked")
			// Not a not-found input → no synthesized blocker entry.
			expect(result.blockers).toEqual([])
		})
	})

	describe("buildPathConfirmationBlocker", () => {
		it("extracts a no-slash path token (config.yaml)", () => {
			const blocker = buildPathConfirmationBlocker("could not find the input config.yaml")

			expect(blocker).toContain("config.yaml")
			expect(blocker).toContain("Confirm the correct path")
		})

		it("prefers the first slash-and-extension token in a two-path-token message", () => {
			const blocker = buildPathConfirmationBlocker(
				"input src/config/app.yaml not found; did you mean config/app.yaml",
			)

			expect(blocker).toContain("Referenced input not found: src/config/app.yaml")
		})

		it("falls back to a generic blocker when no path token is present", () => {
			const blocker = buildPathConfirmationBlocker("referenced input not found")

			expect(blocker).toBe("Referenced input not found (see summary). Confirm the correct path.")
		})
	})

	describe("JSON that fails schema validation", () => {
		it("salvages an object missing required fields, preserving the raw text", () => {
			const raw = JSON.stringify({ status: "completed" }) // missing `summary`

			const result = normalizeWorkerResult(raw, { workerName })

			// Not a bare truncated failure: the original text is preserved.
			expect(result.summary).toBe(raw.replace(/\s+/g, " ").trim())
			assertEmptyArrays(result)
			expect(result.summary).not.toContain("does not conform")
		})

		it("salvages an object with an invalid status value", () => {
			const raw = JSON.stringify({ status: "weird", summary: "x" })

			const result = normalizeWorkerResult(raw, { workerName })

			expect(result.summary).toBe(raw.replace(/\s+/g, " ").trim())
			assertEmptyArrays(result)
		})

		it("salvages a JSON value that is not an object", () => {
			const result = normalizeWorkerResult("42", { workerName })

			expect(result.summary).toBe("42")
			assertEmptyArrays(result)
		})
	})

	describe("genuinely-empty output", () => {
		it("returns an 'empty output' failed result for an empty string", () => {
			const result = normalizeWorkerResult("", { workerName })

			expect(result.status).toBe("failed")
			expect(result.summary).toContain("empty output")
			assertEmptyArrays(result)
		})

		it("returns an 'empty output' failed result for whitespace-only input", () => {
			const result = normalizeWorkerResult("   \n\t ", { workerName })

			expect(result.status).toBe("failed")
			expect(result.summary).toContain("empty output")
		})

		it("returns an 'empty output' failed result for null", () => {
			const result = normalizeWorkerResult(null, { workerName })

			expect(result.status).toBe("failed")
			expect(result.summary).toContain("empty output")
		})

		it("returns an 'empty output' failed result for undefined", () => {
			const result = normalizeWorkerResult(undefined, { workerName })

			expect(result.status).toBe("failed")
			expect(result.summary).toContain("empty output")
		})
	})

	it("never throws for arbitrary input shapes", () => {
		expect(() => normalizeWorkerResult({ nested: { a: 1 } }, { workerName })).not.toThrow()
		expect(() => normalizeWorkerResult(123, { workerName })).not.toThrow()
		expect(() => normalizeWorkerResult([1, 2, 3], { workerName })).not.toThrow()
	})
})
