import { ObservatoryMessageRouter } from "../ObservatoryMessageRouter"

describe("ObservatoryMessageRouter command dispatch hook", () => {
	it("forwards openObservedTask without touching lifecycle", async () => {
		const openTask = vi.fn()
		const router = new ObservatoryMessageRouter({
			service: { reconcile: vi.fn(), getEventWindow: vi.fn() } as never,
			provider: { postMessageToWebview: vi.fn() } as never,
			getAllInstances: () => [],
			parallelTasksDir: "/tmp",
		})
		expect(await router.openObservedTask("task-1")).toBe(false)
		router.setCommandDispatch(openTask)
		expect(await router.openObservedTask("task-1")).toBe(true)
		expect(openTask).toHaveBeenCalledWith("task-1")
	})
})
