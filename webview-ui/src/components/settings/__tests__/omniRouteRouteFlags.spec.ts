import { describe, it, expect } from "vitest"

import type { OmniRouteCatalogEntry } from "@roo-code/types"

import {
	classifyReference,
	computeRouteReferenceFlags,
	hasPublishedPublicRoute,
	sameOrigin,
	type RouteReferenceInput,
} from "../omniRouteRouteFlags"

const byId = (entries: OmniRouteCatalogEntry[]) => new Map(entries.map((e) => [e.id, e]))

describe("omniRouteRouteFlags.classifyReference (Requirement 15.2 precedence)", () => {
	const catalog = byId([
		{ id: "hybrid/code", kind: "public" },
		{ id: "code", kind: "alias" },
		{ id: "pool/tier2/reader", kind: "internal" },
		{ id: "diag/probe", kind: "diagnostic" },
		{ id: "ollama/model", name: "Ollama", family: "ollama" },
		{ id: "legacy/route" },
	])

	it("does not flag a published public route or alias (exact case)", () => {
		expect(classifyReference("hybrid/code", catalog)).toBeUndefined()
		expect(classifyReference("code", catalog)).toBeUndefined()
	})

	it("flags an internal or diagnostic route as internal", () => {
		expect(classifyReference("pool/tier2/reader", catalog)).toBe("internal")
		expect(classifyReference("diag/probe", catalog)).toBe("internal")
	})

	it("flags a model-shaped entry as direct-model", () => {
		expect(classifyReference("ollama/model", catalog)).toBe("direct-model")
	})

	it("treats a legacy kindless, non-model entry as a valid route", () => {
		expect(classifyReference("legacy/route", catalog)).toBeUndefined()
	})

	it("flags an id absent from the catalog as missing", () => {
		expect(classifyReference("auto/gemma", catalog)).toBe("missing")
	})

	it("is case-sensitive: a case mismatch is missing", () => {
		expect(classifyReference("Hybrid/Code", catalog)).toBe("missing")
	})
})

describe("omniRouteRouteFlags.computeRouteReferenceFlags", () => {
	const entries: OmniRouteCatalogEntry[] = [
		{ id: "hybrid/code", kind: "public" },
		{ id: "pool/x", kind: "internal" },
	]

	it("skips empty/whitespace references and flags only invalid ones", () => {
		const refs: RouteReferenceInput[] = [
			{ source: "p", setting: "a", id: "hybrid/code" }, // valid, no flag
			{ source: "p", setting: "b", id: "pool/x" }, // internal
			{ source: "p", setting: "c", id: "   " }, // blank, skipped
			{ source: "p", setting: "d", id: undefined }, // empty, skipped
			{ source: "p", setting: "e", id: "missing/one" }, // missing
		]
		const flags = computeRouteReferenceFlags(refs, entries)
		expect(flags).toEqual([
			{ source: "p", setting: "b", id: "pool/x", reason: "internal" },
			{ source: "p", setting: "e", id: "missing/one", reason: "missing" },
		])
	})

	it("trims the reference id before classifying and reporting", () => {
		const flags = computeRouteReferenceFlags([{ source: "p", setting: "a", id: "  missing/one  " }], entries)
		expect(flags).toEqual([{ source: "p", setting: "a", id: "missing/one", reason: "missing" }])
	})
})

describe("omniRouteRouteFlags.sameOrigin", () => {
	it("compares scheme, host, and port", () => {
		expect(sameOrigin("https://a.example/v1", "https://a.example/combos")).toBe(true)
		expect(sameOrigin("https://a.example", "http://a.example")).toBe(false)
		expect(sameOrigin("https://a.example:443", "https://a.example")).toBe(true)
		expect(sameOrigin("https://a.example:8080", "https://a.example")).toBe(false)
	})

	it("returns false for empty or unparseable inputs", () => {
		expect(sameOrigin(undefined, "https://a.example")).toBe(false)
		expect(sameOrigin("", "https://a.example")).toBe(false)
		expect(sameOrigin("not a url", "https://a.example")).toBe(false)
	})
})

describe("omniRouteRouteFlags.hasPublishedPublicRoute", () => {
	it("is true only when at least one entry has kind public", () => {
		expect(hasPublishedPublicRoute([{ id: "x", kind: "public" }])).toBe(true)
		expect(hasPublishedPublicRoute([{ id: "x", kind: "alias" }])).toBe(false)
		expect(hasPublishedPublicRoute([{ id: "x", kind: "internal" }])).toBe(false)
		expect(hasPublishedPublicRoute([{ id: "x" }])).toBe(false)
		expect(hasPublishedPublicRoute([])).toBe(false)
	})
})
