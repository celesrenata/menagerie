import { describe, it, expect } from "vitest"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { roleDefault, resolveWorkerModelId, READER_MODES } from "../parallelWorkerRouting"

const profile = (overrides: Partial<ProviderSettings> = {}): ProviderSettings => ({
	apiProvider: providerIdentifiers.openai,
	...overrides,
})

describe("roleDefault", () => {
	it("maps reader modes to the reader route id", () => {
		expect(roleDefault("project-reader", profile({ openAiOmniRouteReaderRouteId: "fast" }))).toBe("fast")
	})

	it("maps every other mode to the reasoner route id", () => {
		expect(roleDefault("code", profile({ openAiOmniRouteReasonerRouteId: "big" }))).toBe("big")
		expect(roleDefault("architect", profile({ openAiOmniRouteReasonerRouteId: "big" }))).toBe("big")
	})

	it("returns undefined when the relevant mapping field is unset", () => {
		expect(roleDefault("project-reader", profile())).toBeUndefined()
		expect(roleDefault("code", profile())).toBeUndefined()
	})

	it("treats project-reader as the reader role", () => {
		expect(READER_MODES.has("project-reader")).toBe(true)
	})

	// Two-field OmniRoute profile -> three-tier intent:
	//   reader field  (openAiOmniRouteReaderRouteId)   = LOW/9B  -> project-reader only
	//   reasoner field (openAiOmniRouteReasonerRouteId) = HIGH/27B -> code AND project-research
	// project-research is deliberately NOT a reader mode so it falls through to the
	// reasoner (HIGH/27B) field. These assertions lock that confirmed mapping.
	describe("confirmed field->tier mapping (regression lock)", () => {
		const reader = profile({ openAiOmniRouteReaderRouteId: "9b", openAiOmniRouteReasonerRouteId: "27b" })

		it("routes project-reader to the reader route (LOW/9B field)", () => {
			expect(roleDefault("project-reader", reader)).toBe("9b")
		})

		it("routes project-research to the reasoner route (HIGH/27B field)", () => {
			expect(roleDefault("project-research", reader)).toBe("27b")
		})

		it("routes code to the reasoner route (HIGH/27B field)", () => {
			expect(roleDefault("code", reader)).toBe("27b")
		})

		it("falls back to the parent model when both route fields are unset", () => {
			expect(resolveWorkerModelId(null, "project-reader", profile(), "parent-model")).toBe("parent-model")
			expect(resolveWorkerModelId(null, "project-research", profile(), "parent-model")).toBe("parent-model")
			expect(resolveWorkerModelId(null, "code", profile(), "parent-model")).toBe("parent-model")
		})

		it("pins project-research as intentionally NOT a reader-field member", () => {
			expect(READER_MODES.has("project-research")).toBe(false)
		})
	})
})

describe("resolveWorkerModelId (three-tier precedence)", () => {
	it("uses an explicit route above everything else", () => {
		expect(
			resolveWorkerModelId(
				"explicit-id",
				"project-reader",
				profile({ openAiOmniRouteReaderRouteId: "fast" }),
				"parent-model",
			),
		).toBe("explicit-id")
	})

	it("falls back to the reader role default for a reader worker with no route", () => {
		expect(
			resolveWorkerModelId(null, "project-reader", profile({ openAiOmniRouteReaderRouteId: "fast" }), "parent"),
		).toBe("fast")
	})

	it("falls back to the reasoner role default for a non-reader worker with no route", () => {
		expect(
			resolveWorkerModelId(undefined, "code", profile({ openAiOmniRouteReasonerRouteId: "big" }), "parent"),
		).toBe("big")
	})

	it("falls back to the parent model when no route and no role default", () => {
		expect(resolveWorkerModelId(null, "code", profile(), "parent-model")).toBe("parent-model")
		expect(resolveWorkerModelId(undefined, "project-reader", profile(), "parent-model")).toBe("parent-model")
	})

	it("runs a worker on its own saved profile model when it differs from the parent", () => {
		// project-reader's profile is hybrid/reader with no role routes; it must not inherit the GLM planner.
		expect(
			resolveWorkerModelId(null, "project-reader", profile({ openAiModelId: "hybrid/reader" }), "hybrid/planner"),
		).toBe("hybrid/reader")
		expect(
			resolveWorkerModelId(
				null,
				"project-research",
				profile({ openAiModelId: "hybrid/research", openAiOmniRouteReasonerRouteId: "hybrid/code" }),
				"hybrid/planner",
			),
		).toBe("hybrid/research")
	})

	it("keeps the role default when the worker shares the parent's profile model", () => {
		expect(
			resolveWorkerModelId(
				null,
				"project-reader",
				profile({ openAiModelId: "hybrid/planner", openAiOmniRouteReaderRouteId: "hybrid/reader" }),
				"hybrid/planner",
			),
		).toBe("hybrid/reader")
	})

	it("still lets an explicit route override the worker's own profile model", () => {
		expect(
			resolveWorkerModelId(
				"hybrid/frontier",
				"code",
				profile({ openAiModelId: "hybrid/code" }),
				"hybrid/planner",
			),
		).toBe("hybrid/frontier")
	})
})
