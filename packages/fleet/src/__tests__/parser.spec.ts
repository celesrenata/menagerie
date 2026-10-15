// Example-based tests for the Inventory_Parser (Requirements 2.1, 2.2).
//
// Property tests (round-trip, printer stability, validator totality) live in
// task 2.4's `inventory.properties.spec.ts`; these cover the parser's own two
// behaviors: loose retention of every declared field (2.1) and a value-free
// `ParseError` with 1-based line/column and element kind on a syntax fault
// (2.2).

import { describe, expect, it } from "vitest"

import { parse } from "../inventory/parser.js"
import type { ParsedEntry } from "../inventory/parsed-document.js"

function expectOk(doc: string) {
	const result = parse(doc)
	if (!result.ok) {
		throw new Error(`expected parse to succeed, got error at ${result.error.line}:${result.error.column}`)
	}
	return result.value
}

function expectErr(doc: string) {
	const result = parse(doc)
	if (result.ok) {
		throw new Error("expected parse to fail")
	}
	return result.error
}

function entryById(entries: ParsedEntry[], kind: string, id: string): ParsedEntry {
	const found = entries.find((e) => e.kind === kind && e.id === id)
	if (!found) {
		throw new Error(`no ${kind} entry with id ${id}`)
	}
	return found
}

describe("InventoryParser.parse — success (Requirement 2.1)", () => {
	it("retains every declared top-level entry in document order and by kind", () => {
		const doc = `
revision-note "free form"
device "rtx5090" slot-ceiling=2 host-preemption=#true
device "rtx4070ti" slot-ceiling=4 host-preemption=#false
endpoint "esnixi-vllm" provider="vllm" devices="rtx5090"
instance "cluster" role="primary" address="https://omniroute.example"
`
		const parsed = expectOk(doc)

		expect(parsed.entries.map((e) => e.kind)).toEqual([
			"revision-note",
			"device",
			"device",
			"endpoint",
			"instance",
		])
		expect(parsed.byKind["device"]?.map((e) => e.id)).toEqual(["rtx5090", "rtx4070ti"])
		expect(parsed.byKind["device"]?.[0]).toBe(parsed.entries[1])
	})

	it("keeps positional args, key=value properties, and nested children verbatim", () => {
		const doc = `
model "coder-5090" endpoint="esnixi-vllm" device="rtx5090" id="qwen3.8-27b-nvfp4" context=163840 slots=2 residency="r-5090" tags="chat code reasoning tools" {
  rank 1
  rank 6
}
lane "code" names="hybrid/code" min-context=60000 fail-closed=#false {
  spill "free"
  spill "low-budget"
}
`
		const parsed = expectOk(doc)

		const model = entryById(parsed.entries, "model", "coder-5090")
		expect(model.properties).toEqual({
			endpoint: "esnixi-vllm",
			device: "rtx5090",
			id: "qwen3.8-27b-nvfp4",
			context: 163840,
			slots: 2,
			residency: "r-5090",
			tags: "chat code reasoning tools",
		})
		expect(model.children.map((c) => ({ kind: c.kind, values: c.values }))).toEqual([
			{ kind: "rank", values: [1] },
			{ kind: "rank", values: [6] },
		])

		const lane = entryById(parsed.entries, "lane", "code")
		expect(lane.children.map((c) => c.values[0])).toEqual(["free", "low-budget"])
	})

	it("retains fields the validator will later reject without coercing them", () => {
		// Out-of-range numbers, unknown fields, and a wrong-length rank list are
		// all kept so the validator can report every violation in one pass.
		const doc = `
device "bad" slot-ceiling=9999 host-preemption=#true unknown-field="kept"
model "m" slots=2 context=0 {
  rank 1
}
`
		const parsed = expectOk(doc)

		const device = entryById(parsed.entries, "device", "bad")
		expect(device.properties["slot-ceiling"]).toBe(9999)
		expect(device.properties["unknown-field"]).toBe("kept")

		const model = entryById(parsed.entries, "model", "m")
		expect(model.properties["context"]).toBe(0)
		// ranks.length (1) !== slots (2): kept as declared for the validator.
		expect(model.children.filter((c) => c.kind === "rank")).toHaveLength(1)
	})

	it("parses an empty document into an empty entry set", () => {
		const parsed = expectOk("")
		expect(parsed.entries).toEqual([])
		expect(parsed.byKind).toEqual({})
	})

	it("records id as undefined when the leading argument is not a string", () => {
		const parsed = expectOk(`rank 3`)
		const [entry] = parsed.entries
		expect(entry?.kind).toBe("rank")
		expect(entry?.id).toBeUndefined()
		expect(entry?.values).toEqual([3])
	})
})

describe("InventoryParser.parse — syntax errors (Requirement 2.2)", () => {
	it("reports an unterminated children block as missing with a 1-based position", () => {
		const error = expectErr(`device "rtx5090" {`)
		expect(error.elementKind).toBe("missing")
		expect(error.line).toBeGreaterThanOrEqual(1)
		expect(error.column).toBeGreaterThanOrEqual(1)
		expect(Number.isInteger(error.line)).toBe(true)
		expect(Number.isInteger(error.column)).toBe(true)
	})

	it("reports trailing/unexpected input as unexpected with the offending position", () => {
		const error = expectErr(`123 = {{{`)
		expect(error.elementKind).toBe("unexpected")
		expect(error.line).toBe(1)
		expect(error.column).toBe(1)
	})

	it("gives a 1-based line/column for a fault on a later line", () => {
		const doc = `device "ok"\nendpoint "e" {`
		const error = expectErr(doc)
		expect(error.line).toBe(2)
		expect(error.column).toBeGreaterThanOrEqual(1)
	})

	it("never includes any field value from the document in the error", () => {
		const secretish = "sk-super-secret-value-123"
		const error = expectErr(`endpoint "e" key="${secretish}" {`)
		const serialized = JSON.stringify(error)
		expect(serialized).not.toContain(secretish)
		expect(serialized).not.toContain("super-secret")
		// The message describes a syntax-element kind, not a document value.
		expect(error.message).toMatch(/syntax element/)
	})
})
