import { describe, it, expect } from "vitest"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import {
	roleDefault,
	resolveWorkerModelId,
	READER_MODES,
	collectCodeCapableRouteIds,
	resolveLaneRouteId,
} from "../parallelWorkerRouting"

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

describe("collectCodeCapableRouteIds", () => {
	it("includes the reasoner route id when set", () => {
		expect(collectCodeCapableRouteIds(profile({ openAiOmniRouteReasonerRouteId: "hybrid/code" }), undefined)).toEqual(
			["hybrid/code"],
		)
	})

	it("includes custom routes classified reasoner or general, preserving config order", () => {
		const p = profile({
			openAiOmniRouteReasonerRouteId: "hybrid/code",
			openAiOmniRouteCustomRoutes: [
				{ name: "overflow", modelId: "ollama/code", capability: "reasoner" },
				{ name: "mech", modelId: "llama/general", capability: "general" },
			],
		})
		expect(collectCodeCapableRouteIds(p, undefined)).toEqual(["hybrid/code", "ollama/code", "llama/general"])
	})

	it("excludes reader/long-context/vision and unclassified custom routes", () => {
		const p = profile({
			openAiOmniRouteReasonerRouteId: "hybrid/code",
			openAiOmniRouteCustomRoutes: [
				{ name: "reader", modelId: "ollama/reader", capability: "reader" },
				{ name: "long", modelId: "ollama/long", capability: "long-context" },
				{ name: "vis", modelId: "ollama/vis", capability: "vision" },
				{ name: "legacy", modelId: "ollama/legacy" },
			],
		})
		expect(collectCodeCapableRouteIds(p, undefined)).toEqual(["hybrid/code"])
	})

	it("de-duplicates repeated route ids", () => {
		const p = profile({
			openAiOmniRouteReasonerRouteId: "hybrid/code",
			openAiOmniRouteCustomRoutes: [{ name: "dup", modelId: "hybrid/code", capability: "reasoner" }],
		})
		expect(collectCodeCapableRouteIds(p, undefined)).toEqual(["hybrid/code"])
	})

	it("falls back to the parent model id when nothing is configured", () => {
		expect(collectCodeCapableRouteIds(profile(), "parent-model")).toEqual(["parent-model"])
		expect(collectCodeCapableRouteIds(profile(), undefined)).toEqual([])
	})
})

describe("resolveLaneRouteId (lane → route-id spread)", () => {
	const base = {
		taskType: "implementation" as const,
		route: undefined,
		parentModelId: "parent",
		coderOrdinal: undefined,
		codeCapableRouteIds: [] as string[],
	}

	it("uses an explicit route verbatim above everything else", () => {
		expect(
			resolveLaneRouteId({
				...base,
				lane: "coder.primary",
				profile: profile({ openAiOmniRouteReasonerRouteId: "big" }),
				route: "explicit-id",
				codeCapableRouteIds: ["a", "b"],
				coderOrdinal: 0,
			}),
		).toBe("explicit-id")
	})

	it("routes reader lanes to the reader route id", () => {
		expect(
			resolveLaneRouteId({ ...base, lane: "reader.fast", profile: profile({ openAiOmniRouteReaderRouteId: "9b" }) }),
		).toBe("9b")
		expect(
			resolveLaneRouteId({ ...base, lane: "reader.deep", profile: profile({ openAiOmniRouteReaderRouteId: "9b" }) }),
		).toBe("9b")
	})

	it("returns the single reasoner id unchanged for a reasoning-typed coder (no-regression)", () => {
		const p = profile({ openAiOmniRouteReasonerRouteId: "hybrid/code" })
		expect(
			resolveLaneRouteId({
				...base,
				lane: "coder.primary",
				taskType: "implementation",
				profile: p,
				codeCapableRouteIds: collectCodeCapableRouteIds(p, "parent"),
				coderOrdinal: 0,
			}),
		).toBe("hybrid/code")
	})

	it("round-robins a reasoning-typed coder across multiple code routes by coderOrdinal (finding #1)", () => {
		const codeCapableRouteIds = ["hybrid/code", "ollama/code"]
		const p = profile({ openAiOmniRouteReasonerRouteId: "hybrid/code" })
		const resolveAt = (coderOrdinal: number) =>
			resolveLaneRouteId({
				...base,
				lane: "coder.primary",
				taskType: "implementation", // the DEFAULT reasoning-typed coder spreads
				profile: p,
				codeCapableRouteIds,
				coderOrdinal,
			})
		expect(resolveAt(0)).toBe("hybrid/code")
		expect(resolveAt(1)).toBe("ollama/code")
		expect(resolveAt(2)).toBe("hybrid/code")
		expect(resolveAt(3)).toBe("ollama/code")
	})

	it("spreads regardless of task type (mechanical/general coder also spreads)", () => {
		const codeCapableRouteIds = ["hybrid/code", "ollama/code"]
		const p = profile({ openAiOmniRouteReasonerRouteId: "hybrid/code" })
		expect(
			resolveLaneRouteId({
				...base,
				lane: "coder.primary",
				taskType: "lookup",
				profile: p,
				codeCapableRouteIds,
				coderOrdinal: 1,
			}),
		).toBe("ollama/code")
	})

	it("routes reasoning.escalation to the reasoner route id", () => {
		expect(
			resolveLaneRouteId({
				...base,
				lane: "reasoning.escalation",
				taskType: "adjudication",
				profile: profile({ openAiOmniRouteReasonerRouteId: "big" }),
			}),
		).toBe("big")
		expect(
			resolveLaneRouteId({
				...base,
				lane: "reasoning.escalation",
				taskType: "long-horizon",
				profile: profile({ openAiOmniRouteReasonerRouteId: "big" }),
			}),
		).toBe("big")
	})

	it("falls back to the parent model id when no lane route is configured", () => {
		expect(resolveLaneRouteId({ ...base, lane: "coder.primary", profile: profile() })).toBe("parent")
		expect(resolveLaneRouteId({ ...base, lane: "reader.fast", profile: profile() })).toBe("parent")
	})
})
