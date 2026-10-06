// Feature: retrieval-fabric
//
// Unit and property tests for `decomposeQuery` (Requirement 13): a multi-concern
// engineering question expands into independent retrieval queries only where each
// adds distinct coverage (13.1), and never into exact-duplicate queries (13.3).

import fc from "fast-check"
import { describe, it, expect } from "vitest"

import { decomposeQuery } from "./query-planning"
import type { RetrievalIntent } from "./types"

const INTENTS: readonly RetrievalIntent[] = ["implement", "debug", "explain", "locate", "review"]

describe("decomposeQuery", () => {
	// Req 13.1: the wrong-Kubernetes-certificate question spans several
	// independent areas and must decompose into distinct facet queries.
	it("decomposes a wrong-Kubernetes-certificate question into distinct facets", () => {
		const result = decomposeQuery("the Kubernetes ingress is serving the wrong TLS certificate", "debug")

		expect(result.length).toBeGreaterThanOrEqual(4)
		const joined = result.join(" | ").toLowerCase()
		expect(joined).toContain("ingress tls")
		expect(joined).toContain("cert-manager")
		expect(joined).toContain("clusterissuer")
		expect(joined).toContain("hostname")
	})

	it("applies the certificate expansion regardless of intent", () => {
		for (const intent of INTENTS) {
			const result = decomposeQuery("wrong kubernetes certificate for the ingress hostname", intent)
			expect(result.length).toBeGreaterThanOrEqual(4)
		}
	})

	// Req 13.3: never emit exact-duplicate sub-queries.
	it("never emits exact-duplicate sub-queries", () => {
		const result = decomposeQuery(
			"check the auth middleware and check the auth middleware and refresh the token cache",
			"debug",
		)
		const lowered = result.map((q) => q.toLowerCase())
		expect(new Set(lowered).size).toBe(lowered.length)
	})

	// Req 13.3: no pointless multiplication for a single-concern question.
	it("returns the original query when no meaningful decomposition applies", () => {
		expect(decomposeQuery("fix the login bug", "debug")).toEqual(["fix the login bug"])
	})

	it("does not split a short trailing conjunction into a noise fragment", () => {
		// "and why" is below the substantive-concern threshold.
		expect(decomposeQuery("why does the build fail and why", "explain")).toEqual([
			"why does the build fail and why",
		])
	})

	it("splits an itemized multi-concern question into its concerns", () => {
		const result = decomposeQuery(
			"investigate the slow database query and review the connection pool configuration",
			"debug",
		)
		expect(result).toContain("investigate the slow database query")
		expect(result).toContain("review the connection pool configuration")
	})

	it("is stricter about splitting for narrow intents", () => {
		const query = "find the retry handler and the backoff policy"
		// locate: a single extra clause is treated as noise -> undecomposed.
		expect(decomposeQuery(query, "locate")).toEqual([query])
		// debug: broader coverage wanted -> decomposes.
		expect(decomposeQuery(query, "debug").length).toBeGreaterThanOrEqual(2)
	})

	it("trims surrounding whitespace from the returned query", () => {
		expect(decomposeQuery("   fix the login bug   ", "implement")).toEqual(["fix the login bug"])
	})

	// Property (Req 13.1, 13.3): decomposition is always non-empty and
	// duplicate-free for any query/intent.
	it("always returns a non-empty, duplicate-free set of queries", () => {
		fc.assert(
			fc.property(
				fc.string(),
				fc.constantFrom(...INTENTS),
				(query, intent) => {
					const result = decomposeQuery(query, intent)
					expect(result.length).toBeGreaterThanOrEqual(1)
					const lowered = result.map((q) => q.toLowerCase())
					expect(new Set(lowered).size).toBe(lowered.length)
				},
			),
		)
	})
})
