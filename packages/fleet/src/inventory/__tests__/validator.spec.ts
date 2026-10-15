import { describe, expect, it } from "vitest"

import { createInventoryValidator, type ValidationResult } from "../validator.js"
import type { ParsedDocument, ParsedEntry, ParsedValue } from "../types.js"

// Build a minimal, VALID parsed document that the validator accepts, modeling a
// tiny fleet: one primary instance, two devices, two local endpoints, offerings
// that cover chat/code/read + embed + rerank, a cloud target, and lanes that
// carry the eight baseline names, the four capability lanes, and embed/rerank.
const entry = (index: number, fields: Record<string, ParsedValue>, extra: Partial<ParsedEntry> = {}): ParsedEntry => ({
	index,
	id: typeof fields["id"] === "string" ? (fields["id"] as string) : undefined,
	fields,
	...extra,
})

const ALL_OBJECTIVES = [
	"planner-cloud-share",
	"planner-multi-attempt",
	"code-p50",
	"reader-cloud-share",
	"reader-multi-attempt",
	"cloud-input-tokens",
	"capacity-rejections",
	"embeddings-success",
	"model-switches",
]

function validDoc(): ParsedDocument {
	const addr = (url: string): Record<string, ParsedValue> => ({ instanceId: "cluster", url })
	return {
		devices: [
			entry(0, { id: "gpu0", slotCeiling: 4, hostPreemption: false }),
			entry(1, { id: "arc0", slotCeiling: 6, hostPreemption: false }),
		],
		endpoints: [
			entry(
				0,
				{
					id: "vllm",
					provider: "vllm",
					deviceIds: ["gpu0"],
					addresses: [addr("http://host:2701")] as unknown as ParsedValue,
					secretRef: "vllm_key",
				},
				{ credentialFields: ["secretRef"] },
			),
			entry(1, {
				id: "ovms",
				provider: "ovms",
				deviceIds: ["arc0"],
				addresses: [addr("http://ovms:8000")] as unknown as ParsedValue,
				noCredential: true,
			}),
		],
		residencyGroups: [entry(0, { id: "r0", swapLatencyMs: 0 }), entry(1, { id: "r1", swapLatencyMs: 0 })],
		offerings: [
			entry(0, {
				id: "coder",
				endpointId: "vllm",
				deviceId: "gpu0",
				modelId: "qwen-coder",
				context: 160000,
				slots: 2,
				residencyGroup: "r0",
				tags: ["chat", "code", "read"],
				ranks: [1, 3],
			}),
			entry(1, {
				id: "embed",
				endpointId: "ovms",
				deviceId: "arc0",
				modelId: "qwen-embed",
				context: 4096,
				slots: 3,
				residencyGroup: "r1",
				tags: ["embed"],
				ranks: [1, 1, 1],
			}),
			entry(2, {
				id: "rerank",
				endpointId: "ovms",
				deviceId: "arc0",
				modelId: "qwen-rerank",
				context: 4096,
				slots: 3,
				residencyGroup: "r1",
				tags: ["rerank"],
				ranks: [1, 1, 1],
			}),
		],
		clouds: [
			entry(0, {
				id: "codestral",
				provider: "mistral",
				modelId: "codestral",
				spend: "free",
				context: 256000,
				tags: ["chat", "code"],
			}),
		],
		lanes: [
			lane("code", "hybrid/code", ["chat", "code"], ["coder.primary"]),
			lane("research", "hybrid/research", ["chat", "code"], []),
			lane("fast", "hybrid/fast", ["chat"], []),
			lane("planner", "hybrid/planner", ["chat"], ["reasoning.escalation"]),
			lane("reader", "hybrid/reader", ["chat", "read"], ["reader.fast", "reader.deep"]),
			lane("reviewer", "hybrid/reviewer", ["chat"], []),
			lane("frontier", "hybrid/frontier", ["chat"], []),
			lane("tester", "hybrid/tester", ["chat"], []),
			lane("embed", "memory/embed", ["embed"], []),
			lane("rerank", "memory/rerank", ["rerank"], []),
		],
		instances: [
			entry(
				0,
				{ id: "cluster", role: "primary", address: "https://omniroute", secretRef: "mgmt_key" },
				{ credentialFields: ["secretRef"] },
			),
		],
		diagnostics: [entry(0, { id: "diag/gpu0", deviceId: "gpu0" })],
		alertDestination: entry(0, { url: "https://alerts", secretRef: "alert_key" }, { credentialFields: ["secretRef"] }),
		improvementObjectiveOrder: ALL_OBJECTIVES,
	}
}

function lane(id: string, name: string, caps: string[], capLanes: string[]): ParsedEntry {
	return entry(0, {
		id,
		names: [name],
		capabilities: caps,
		minContext: 1000,
		order: "fill-first",
		maxSpend: "free",
		spillTiers: ["free"],
		failClosed: false,
		capabilityLanes: capLanes,
	})
}

const violate = (doc: ParsedDocument): ValidationResult => createInventoryValidator().validate(doc)

const codes = (r: ValidationResult): string[] => (r.ok ? [] : r.violations.map((x) => x.code))

const paths = (r: ValidationResult): string[] => (r.ok ? [] : r.violations.map((x) => x.fieldPath))

describe("InventoryValidator", () => {
	it("accepts a valid inventory and produces a typed model", () => {
		const result = violate(validDoc())
		if (!result.ok) {
			throw new Error(`expected accept, got: ${JSON.stringify(result.violations)}`)
		}
		expect(result.model.devices).toHaveLength(2)
		expect(result.model.lanes).toHaveLength(10)
	})

	it("rejects an unresolved reference and reports the field path (2.5)", () => {
		const doc = validDoc()
		;(doc.offerings as ParsedEntry[])[0] = {
			...doc.offerings[0]!,
			fields: { ...doc.offerings[0]!.fields, endpointId: "nope" },
		}
		const r = violate(doc)
		expect(codes(r)).toContain("unresolved-ref")
		expect(paths(r)).toContain("offerings[coder].endpointId")
	})

	it("rejects a model-device binding mismatch (2.5)", () => {
		const doc = validDoc()
		;(doc.offerings as ParsedEntry[])[0] = {
			...doc.offerings[0]!,
			fields: { ...doc.offerings[0]!.fields, deviceId: "arc0" },
		}
		const r = violate(doc)
		expect(codes(r)).toContain("model-device-binding")
	})

	it("rejects an out-of-range numeric value with the range (2.6)", () => {
		const doc = validDoc()
		;(doc.devices as ParsedEntry[])[0] = {
			...doc.devices[0]!,
			fields: { ...doc.devices[0]!.fields, slotCeiling: 999 },
		}
		const r = violate(doc)
		expect(codes(r)).toContain("range")
	})

	it("rejects offering slots exceeding the device ceiling (2.7)", () => {
		const doc = validDoc()
		;(doc.offerings as ParsedEntry[])[0] = {
			...doc.offerings[0]!,
			fields: { ...doc.offerings[0]!.fields, slots: 5, ranks: [1, 2, 3, 4, 5] },
		}
		const r = violate(doc)
		expect(codes(r)).toContain("slots-exceed-ceiling")
	})

	it("rejects a duplicate identifier (2.8)", () => {
		const doc = validDoc()
		;(doc.devices as ParsedEntry[]).push(entry(2, { id: "gpu0", slotCeiling: 2, hostPreemption: false }))
		const r = violate(doc)
		expect(codes(r)).toContain("duplicate-id")
	})

	it("rejects an inline credential without echoing the value (2.9)", () => {
		const doc = validDoc()
		;(doc.instances as ParsedEntry[])[0] = {
			...doc.instances[0]!,
			fields: { ...doc.instances[0]!.fields, secretRef: "sk-SUPER SECRET VALUE" },
			credentialFields: ["secretRef"],
		}
		const r = violate(doc)
		expect(codes(r)).toContain("inline-credential")
		const out = JSON.stringify(r)
		expect(out).not.toContain("SUPER SECRET VALUE")
	})

	it("rejects a tokenized URL path segment without echoing the token (2.9/22.5)", () => {
		const doc = validDoc()
		;(doc.instances as ParsedEntry[])[0] = {
			...doc.instances[0]!,
			fields: { ...doc.instances[0]!.fields, address: "https://host/api/v1/vscode/TOKEN123/combos" },
		}
		const r = violate(doc)
		expect(codes(r)).toContain("tokenized-segment")
		expect(JSON.stringify(r)).not.toContain("TOKEN123")
	})

	it("rejects a performance-rank count that differs from the slot count (2.11)", () => {
		const doc = validDoc()
		;(doc.offerings as ParsedEntry[])[0] = {
			...doc.offerings[0]!,
			fields: { ...doc.offerings[0]!.fields, ranks: [1] },
		}
		const r = violate(doc)
		expect(codes(r)).toContain("rank-count")
	})

	it("rejects an unknown field (2.11)", () => {
		const doc = validDoc()
		;(doc.devices as ParsedEntry[])[0] = {
			...doc.devices[0]!,
			fields: { ...doc.devices[0]!.fields, bogus: 1 },
		}
		const r = violate(doc)
		expect(codes(r)).toContain("unknown-field")
	})

	it("rejects a capability tag that names a declared identifier (3.2)", () => {
		const doc = validDoc()
		;(doc.lanes as ParsedEntry[])[0] = lane("code", "hybrid/code", ["chat", "GPU0"], ["coder.primary"])
		const r = violate(doc)
		expect(codes(r)).toContain("capability-names-identifier")
	})

	it("rejects when a baseline name is missing (3.3/3.8)", () => {
		const doc = validDoc()
		;(doc.lanes as ParsedEntry[])[0] = lane("code", "hybrid/other", ["chat", "code"], ["coder.primary"])
		const r = violate(doc)
		expect(codes(r)).toContain("baseline-name-missing")
	})

	it("rejects when a capability lane is unmapped (3.4/3.8)", () => {
		const doc = validDoc()
		;(doc.lanes as ParsedEntry[])[0] = lane("code", "hybrid/code", ["chat", "code"], [])
		const r = violate(doc)
		expect(codes(r)).toContain("capability-lane-unmapped")
	})

	it("rejects when the embeddings lane is absent (3.5)", () => {
		const doc = validDoc()
		;(doc.lanes as ParsedEntry[]) = doc.lanes.filter((l) => l.id !== "embed")
		const r = violate(doc)
		expect(codes(r)).toContain("no-embed-lane")
	})

	it("does NOT require embed/rerank lanes when no embed/rerank offering is declared (memory served out-of-band)", () => {
		// When memory (embeddings/rerank) is served by OmniRoute provider-nodes
		// rather than toolkit-managed offerings, the inventory declares neither an
		// embed/rerank offering nor an embed/rerank lane. The compute-only inventory
		// must still validate (the Requirement 3.5 lane guard is conditional on a
		// declared offering).
		const doc = validDoc()
		;(doc.offerings as ParsedEntry[]) = doc.offerings.filter(
			(o) => o.id !== "embed" && o.id !== "rerank",
		)
		;(doc.lanes as ParsedEntry[]) = doc.lanes.filter((l) => l.id !== "embed" && l.id !== "rerank")
		const r = violate(doc)
		expect(codes(r)).not.toContain("no-embed-lane")
		expect(codes(r)).not.toContain("no-rerank-lane")
	})

	it("rejects an invalid route-name character (4.8)", () => {
		const doc = validDoc()
		;(doc.lanes as ParsedEntry[])[1] = lane("research", "hybrid/RESEARCH", ["chat", "code"], [])
		const r = violate(doc)
		// hybrid/research is now missing (baseline) and the uppercase name is a
		// charset violation.
		expect(codes(r)).toContain("route-name-charset")
	})

	it("rejects more or fewer than one primary instance (10.2)", () => {
		const doc = validDoc()
		;(doc.instances as ParsedEntry[]).push(
			entry(1, { id: "cluster2", role: "primary", address: "https://b", noCredential: true }),
		)
		const r = violate(doc)
		expect(codes(r)).toContain("primary-count")
	})

	it("rejects a diagnostic pinned to an undeclared device (12.7)", () => {
		const doc = validDoc()
		;(doc.diagnostics as ParsedEntry[])[0] = entry(0, { id: "diag/x", deviceId: "ghost" })
		const r = violate(doc)
		expect(codes(r)).toContain("unresolved-ref")
		expect(paths(r)).toContain("diagnostics[diag/x].deviceId")
	})

	it("rejects an improvement-objective order with a missing objective (20.8)", () => {
		const doc: ParsedDocument = { ...validDoc(), improvementObjectiveOrder: ALL_OBJECTIVES.slice(1) }
		const r = violate(doc)
		expect(codes(r)).toContain("missing-objective")
	})

	it("reports every violation in one pass (2.10 totality)", () => {
		const doc = validDoc()
		;(doc.devices as ParsedEntry[])[0] = {
			...doc.devices[0]!,
			fields: { ...doc.devices[0]!.fields, slotCeiling: 999, bogus: 1 },
		}
		;(doc.offerings as ParsedEntry[])[0] = {
			...doc.offerings[0]!,
			fields: { ...doc.offerings[0]!.fields, endpointId: "nope", ranks: [1] },
		}
		const r = violate(doc)
		expect(r.ok).toBe(false)
		// At least: range, unknown-field, unresolved-ref, rank-count all present.
		const found = new Set(codes(r))
		expect(found.has("range")).toBe(true)
		expect(found.has("unknown-field")).toBe(true)
		expect(found.has("unresolved-ref")).toBe(true)
		expect(found.has("rank-count")).toBe(true)
	})
})
