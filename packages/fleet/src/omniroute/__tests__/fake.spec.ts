import { describe, expect, it, vi } from "vitest"

import {
	OmniRouteApiError,
	type AdvertisedModel,
	type CallLogRecord,
	type Combo,
	type ComboInput,
	type Connection,
	type ContextOverride,
} from "../client.js"
import { FakeOmniRouteClient } from "../fake.js"

const comboInput = (name: string, context_length = 131072): ComboInput => ({
	name,
	strategy: "priority",
	models: [{ id: "m1", kind: "model", model: "glm", providerId: "vllm", connectionId: "c1", weight: 1 }],
	config: { fleetRevision: "rev-1" },
	context_length,
	isHidden: false,
})

const connection = (id: string): Connection => ({
	id,
	provider: "vllm",
	address: "http://host:8000",
	isActive: true,
	maxConcurrent: 2,
})

describe("FakeOmniRouteClient — in-memory round-trip", () => {
	it("createCombo assigns a deterministic id and stores it", async () => {
		const fake = new FakeOmniRouteClient()
		const created = await fake.createCombo(comboInput("code"))
		expect(created.id).toBe("cmb-fake-1")

		const second = await fake.createCombo(comboInput("research"))
		expect(second.id).toBe("cmb-fake-2")

		const stored = await fake.listCombos()
		expect(stored.map((c) => c.id).sort()).toEqual(["cmb-fake-1", "cmb-fake-2"])
	})

	it("readback returns the stored object, not the write argument reference", async () => {
		const fake = new FakeOmniRouteClient()
		const created = await fake.createCombo(comboInput("code"))

		const [readBack] = await fake.listCombos()
		expect(readBack).toEqual(created)
		// Distinct references: mutating a returned object cannot corrupt the store.
		expect(readBack).not.toBe(created)
	})

	it("updateCombo replaces by id and the readback reflects the new value", async () => {
		const fake = new FakeOmniRouteClient()
		const created = await fake.createCombo(comboInput("code", 131072))

		const updated = await fake.updateCombo(created.id, comboInput("code", 262144))
		expect(updated.id).toBe(created.id)
		expect(updated.context_length).toBe(262144)

		const [readBack] = await fake.listCombos()
		expect(readBack?.context_length).toBe(262144)
	})

	it("deleteCombo removes the object from the store", async () => {
		const fake = new FakeOmniRouteClient()
		const created = await fake.createCombo(comboInput("code"))

		await fake.deleteCombo(created.id)

		expect(await fake.listCombos()).toEqual([])
	})

	it("patchConnection merges the patch into the stored connection", async () => {
		const fake = new FakeOmniRouteClient({ connections: [connection("c1")] })

		const patched = await fake.patchConnection("c1", { maxConcurrent: 8, isActive: false })
		expect(patched.maxConcurrent).toBe(8)
		expect(patched.isActive).toBe(false)
		// Un-patched fields are preserved.
		expect(patched.provider).toBe("vllm")

		const [readBack] = await fake.listConnections()
		expect(readBack?.maxConcurrent).toBe(8)
		expect(readBack?.isActive).toBe(false)
	})

	it("patchContextOverrides applies upserts and removes", async () => {
		const seed: ContextOverride[] = [
			{ model: "glm", contextLength: 131072 },
			{ model: "qwen", contextLength: 32768 },
		]
		const fake = new FakeOmniRouteClient({ contextOverrides: seed })

		const result = await fake.patchContextOverrides({
			upserts: [{ model: "glm", contextLength: 262144 }],
			removes: ["qwen"],
		})

		const byModel = Object.fromEntries(result.map((o) => [o.model, o.contextLength]))
		expect(byModel).toEqual({ glm: 262144 })

		const readBack = await fake.getContextOverrides()
		expect(readBack).toEqual([{ model: "glm", contextLength: 262144 }])
	})
})

describe("FakeOmniRouteClient — seed and reads", () => {
	it("seeds a complete Live_Route_State readable per object", async () => {
		const combo: Combo = { id: "cmb-seed", ...comboInput("code") }
		const advertised: AdvertisedModel[] = [{ id: "glm", contextLength: 131072 }]
		const log: CallLogRecord = {
			timestamp: "2026-10-14T00:00:00Z",
			status: 200,
			provider: "vllm",
			model: "glm",
			comboName: "code",
			correlationId: "corr-1",
		}
		const fake = new FakeOmniRouteClient({
			combos: [combo],
			connections: [connection("c1")],
			advertisedModels: { c1: advertised },
			comboTraces: { "req-1": { id: "req-1", steps: [{ pick: "glm" }] } },
			callLogs: [log],
		})

		expect(await fake.listCombos()).toEqual([combo])
		expect(await fake.getAdvertisedModels("c1")).toEqual(advertised)
		expect((await fake.getComboTrace("req-1")).id).toBe("req-1")
		expect(await fake.readCallLogs({ status: 200 })).toEqual([log])
		expect(await fake.readCallLogs({ status: 500 })).toEqual([])
	})
})

describe("FakeOmniRouteClient — scripted failures (write/readback/timeout)", () => {
	it("a scripted write-failure throws an OmniRouteApiError and leaves the store untouched", async () => {
		const fake = new FakeOmniRouteClient()
		fake.scriptFailure({ operation: "createCombo", kind: "writeError", status: 500 })

		await expect(fake.createCombo(comboInput("code"))).rejects.toBeInstanceOf(OmniRouteApiError)
		// Fail-closed: nothing was written.
		expect(await fake.listCombos()).toEqual([])
	})

	it("targets a write-failure by object id", async () => {
		const fake = new FakeOmniRouteClient({ combos: [{ id: "cmb-a", ...comboInput("a") }, { id: "cmb-b", ...comboInput("b") }] })
		fake.scriptFailure({ operation: "updateCombo", kind: "writeError", objectId: "cmb-b" })

		// The non-targeted id succeeds.
		await expect(fake.updateCombo("cmb-a", comboInput("a", 262144))).resolves.toMatchObject({ id: "cmb-a" })
		// The targeted id fails.
		await expect(fake.updateCombo("cmb-b", comboInput("b", 262144))).rejects.toBeInstanceOf(OmniRouteApiError)
	})

	it("a scripted readback-mismatch returns a value different from what was written", async () => {
		const fake = new FakeOmniRouteClient()
		fake.scriptFailure({
			operation: "createCombo",
			kind: "readbackMismatch",
			mutate: (real) => ({ ...(real as Combo), context_length: 999 }),
		})

		const returned = await fake.createCombo(comboInput("code", 131072))
		// The returned value is corrupted …
		expect(returned.context_length).toBe(999)
		// … but the store holds the real written value, so an apply readback-compare
		// (returned vs stored) detects the mismatch.
		const [stored] = await fake.listCombos()
		expect(stored?.context_length).toBe(131072)
		expect(returned.context_length).not.toBe(stored?.context_length)
	})

	it("targets a failure by call count", async () => {
		const fake = new FakeOmniRouteClient()
		fake.scriptFailure({ operation: "createCombo", kind: "writeError", onCall: 2 })

		await expect(fake.createCombo(comboInput("a"))).resolves.toMatchObject({ id: "cmb-fake-1" })
		await expect(fake.createCombo(comboInput("b"))).rejects.toBeInstanceOf(OmniRouteApiError)
		await expect(fake.createCombo(comboInput("c"))).resolves.toMatchObject({ id: "cmb-fake-2" })
	})

	it("a scripted timeout never resolves within the deadline", async () => {
		vi.useFakeTimers()
		try {
			const fake = new FakeOmniRouteClient()
			fake.scriptFailure({ operation: "createCombo", kind: "timeout" })

			let settled = false
			const pending = fake
				.createCombo(comboInput("code"))
				.then(() => {
					settled = true
				})
				.catch(() => {
					settled = true
				})
			void pending

			// Advance well past any realistic readback deadline; the promise stays pending.
			await vi.advanceTimersByTimeAsync(60_000)
			expect(settled).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("a scripted timeout with rejectAfterMs eventually rejects", async () => {
		vi.useFakeTimers()
		try {
			const fake = new FakeOmniRouteClient({ connections: [connection("c1")] })
			fake.scriptFailure({ operation: "patchConnection", kind: "timeout", rejectAfterMs: 30_000 })

			const assertion = expect(fake.patchConnection("c1", { maxConcurrent: 4 })).rejects.toBeInstanceOf(
				OmniRouteApiError,
			)
			await vi.advanceTimersByTimeAsync(30_000)
			await assertion
		} finally {
			vi.useRealTimers()
		}
	})

	it("scriptFailure rejects a readbackMismatch without a mutate function", () => {
		const fake = new FakeOmniRouteClient()
		expect(() => fake.scriptFailure({ operation: "createCombo", kind: "readbackMismatch" })).toThrow(
			/requires a `mutate`/,
		)
	})

	it("records the sequence of calls for call-site assertions", async () => {
		const fake = new FakeOmniRouteClient()
		await fake.listCombos()
		await fake.createCombo(comboInput("code"))
		expect(fake.calls()).toEqual([
			{ operation: "listCombos", objectId: undefined },
			{ operation: "createCombo", objectId: undefined },
		])
	})
})
