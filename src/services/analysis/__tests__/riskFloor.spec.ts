import { applyRiskFloor } from "../riskFloor"

describe("applyRiskFloor", () => {
	it.each([
		["Change: migration drops the users.email column and backfills nothing.", "high"],
		["Change: remove the isAdmin() check from the export route.", "high"],
		["Change: delete the retry-with-backoff wrapper around the payment call.", "high"],
		["Change: switch chargeCents to dollars. 14 call sites.", "high"],
		["Change: add an optional parameter. 4 callers updated.", "medium"],
	])("raises %j to at least %s when the model abstains", (text, level) => {
		expect(applyRiskFloor("unknown", [text]).risk).toBe(level)
		expect(applyRiskFloor(undefined, [text]).risk).toBe(level)
	})

	it("raises an under-rating model, and reports it", () => {
		const r = applyRiskFloor("medium", ["Change: remove the isAdmin() check from the route."])
		expect(r).toMatchObject({ risk: "high" })
		expect(r.raisedBy).toContain("model said medium")
	})

	it("never lowers a model answer and never produces low", () => {
		expect(applyRiskFloor("high", ["Change: add a debug log line."]).risk).toBe("high")
		expect(applyRiskFloor("medium", ["Change: drop a column"]).risk).toBe("high")
		expect(applyRiskFloor("unknown", ["Change: fix a typo in a comment."]).risk).toBe("unknown")
		expect(applyRiskFloor(undefined, ["Change: fix a typo in a comment."]).risk).toBeUndefined()
		expect(applyRiskFloor("low", ["Change: rename a local variable. No behaviour change."]).risk).toBe("low")
	})

	it("leaves a model answer alone when it already meets the floor", () => {
		expect(applyRiskFloor("high", ["Change: drop a column"])).toEqual({ risk: "high" })
	})
})
