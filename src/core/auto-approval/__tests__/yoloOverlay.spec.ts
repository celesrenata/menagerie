import { checkAutoApproval } from "../index"

const followup = JSON.stringify({ question: "q?", suggest: [{ answer: "a" }] })
const outsideWrite = JSON.stringify({ tool: "editedExistingFile", path: "/elsewhere/x.ts", isOutsideWorkspace: true })

describe("YOLO overlay options", () => {
	it("auto-answers followups by default and when true", async () => {
		for (const flag of [undefined, true]) {
			const result = await checkAutoApproval({
				state: { yoloModeEnabled: true, yoloAutoAnswerFollowups: flag },
				ask: "followup",
				text: followup,
			})
			expect(result.decision).toBe("timeout")
		}
	})

	it("does not auto-answer followups when yoloAutoAnswerFollowups is false", async () => {
		const result = await checkAutoApproval({
			state: { yoloModeEnabled: true, yoloAutoAnswerFollowups: false },
			ask: "followup",
			text: followup,
		})
		expect(result.decision).toBe("ask")
	})

	it("approves outside-workspace writes by default and asks when yoloApproveOutsideWorkspace is false", async () => {
		const on = await checkAutoApproval({ state: { yoloModeEnabled: true }, ask: "tool", text: outsideWrite })
		expect(on.decision).toBe("approve")
		const off = await checkAutoApproval({
			state: { yoloModeEnabled: true, yoloApproveOutsideWorkspace: false },
			ask: "tool",
			text: outsideWrite,
		})
		expect(off.decision).toBe("ask")
	})
})
