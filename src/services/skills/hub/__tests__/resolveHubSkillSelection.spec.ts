import type { SkillHubSkillMode } from "@roo-code/types"

import { resolveHubSkillSelection } from "../resolveHubSkillSelection"
import type { HubSkillSummary } from "../SkillHubClient"

const skill = (id: string, name = id): HubSkillSummary => ({ id, name, description: `${name} description` })

const base = {
	catalog: [skill("a"), skill("b"), skill("c"), skill("d")],
	autoHits: [skill("b"), skill("c"), skill("d")],
	maxSkills: 8,
	localSkillNames: [] as string[],
}

const ids = (list: HubSkillSummary[]) => list.map((s) => s.id)

describe("resolveHubSkillSelection", () => {
	it("manual on comes first, then auto fills the remaining slots in rank order", () => {
		const modes: Record<string, SkillHubSkillMode> = { a: "on" }
		expect(ids(resolveHubSkillSelection({ ...base, modes, maxSkills: 3 }))).toEqual(["a", "b", "c"])
	})

	it("manual on beats auto: an on skill outside the hits is still included", () => {
		const modes: Record<string, SkillHubSkillMode> = { a: "on" }
		expect(ids(resolveHubSkillSelection({ ...base, modes }))).toContain("a")
	})

	it("manual off beats auto: an off skill is never included even when auto finds it", () => {
		const modes: Record<string, SkillHubSkillMode> = { b: "off" }
		expect(ids(resolveHubSkillSelection({ ...base, modes }))).toEqual(["c", "d"])
	})

	it("treats auto and unset the same", () => {
		const withAuto = resolveHubSkillSelection({ ...base, modes: { b: "auto" } })
		const unset = resolveHubSkillSelection({ ...base, modes: undefined })
		expect(ids(withAuto)).toEqual(ids(unset))
		expect(ids(unset)).toEqual(["b", "c", "d"])
	})

	it("auto stops at the budget", () => {
		expect(ids(resolveHubSkillSelection({ ...base, modes: {}, maxSkills: 2 }))).toEqual(["b", "c"])
	})

	it("keeps every manual-on skill when they exceed the budget and adds no auto skill", () => {
		const modes: Record<string, SkillHubSkillMode> = { a: "on", b: "on", c: "on" }
		expect(ids(resolveHubSkillSelection({ ...base, modes, maxSkills: 2 }))).toEqual(["a", "b", "c"])
	})

	it("does not duplicate a skill that is both on and an auto hit", () => {
		const result = resolveHubSkillSelection({ ...base, modes: { b: "on" } })
		expect(ids(result).filter((id) => id === "b")).toHaveLength(1)
	})

	it("dedupes by name across ids", () => {
		const result = resolveHubSkillSelection({
			...base,
			catalog: [],
			autoHits: [skill("x1", "same"), skill("x2", "Same")],
			modes: {},
		})
		expect(ids(result)).toEqual(["x1"])
	})

	it("lets a local skill with the same name win over the hub skill", () => {
		const result = resolveHubSkillSelection({
			...base,
			modes: { a: "on" },
			localSkillNames: ["A", "c"],
		})
		expect(ids(result)).toEqual(["b", "d"])
	})

	it("offers only manual-on skills when auto produced nothing (hub search failed)", () => {
		const result = resolveHubSkillSelection({ ...base, autoHits: [], modes: { a: "on" } })
		expect(ids(result)).toEqual(["a"])
	})

	it("offers nothing with a zero budget unless a skill is manually on", () => {
		expect(ids(resolveHubSkillSelection({ ...base, modes: {}, maxSkills: 0 }))).toEqual([])
		expect(ids(resolveHubSkillSelection({ ...base, modes: { a: "on" }, maxSkills: 0 }))).toEqual(["a"])
	})
})
