import { SKILL_HUB_FORBIDDEN_MESSAGE, SkillHubClient, SkillHubError } from "../SkillHubClient"

const KEY = "sk-secondary-test-key"

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const makeClient = (fetchImpl: typeof fetch, extra: { timeoutMs?: number } = {}) =>
	new SkillHubClient({ baseUrl: "http://hub.test:20128/", apiKey: KEY, fetchImpl, ...extra })

describe("SkillHubClient", () => {
	it("searches with a Bearer key, a bounded query and a clamped limit", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ results: [{ id: "1", name: "alpha", description: "d", extra: "ignored" }] }),
		)
		const result = await makeClient(fetchImpl as unknown as typeof fetch).search("x".repeat(900), 99)

		expect(result).toEqual([{ id: "1", name: "alpha", description: "d" }])
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		const parsed = new URL(url)
		expect(parsed.origin + parsed.pathname).toBe("http://hub.test:20128/api/skills/catalog")
		expect(parsed.searchParams.get("query")).toHaveLength(500)
		expect(parsed.searchParams.get("limit")).toBe("20")
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
	})

	it("does not call the hub for a blank task query", async () => {
		const fetchImpl = vi.fn()
		expect(await makeClient(fetchImpl as unknown as typeof fetch).search("   ", 5)).toEqual([])
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("loads a skill with POST action load", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ found: true, id: "1", name: "alpha", description: "d", content: "# body" }),
		)
		const loaded = await makeClient(fetchImpl as unknown as typeof fetch).load("1")
		expect(loaded.content).toBe("# body")
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(init.method).toBe("POST")
		expect(JSON.parse(init.body as string)).toEqual({ action: "load", id: "1" })
	})

	it.each([
		[401, "auth"],
		[403, "forbidden"],
		[404, "not_found"],
		[500, "http"],
	])("maps HTTP %i to a typed %s error without leaking the key", async (status, code) => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: `boom ${KEY}` }, status))
		const error = await makeClient(fetchImpl as unknown as typeof fetch)
			.list()
			.catch((e) => e)
		expect(error).toBeInstanceOf(SkillHubError)
		expect((error as SkillHubError).code).toBe(code)
		expect((error as SkillHubError).message).not.toContain(KEY)
	})

	it("explains a 403 as a missing scope or a server without scoped-key support, without overclaiming", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "forbidden" }, 403))
		const error = (await makeClient(fetchImpl as unknown as typeof fetch)
			.list()
			.catch((e) => e)) as SkillHubError
		expect(error.message).toBe(SKILL_HUB_FORBIDDEN_MESSAGE)
		expect(error.message).toContain("read:catalog")
		expect(error.message).toMatch(/may not support scoped keys/)
		expect(error.message).toMatch(/may lack/)
		expect(error.status).toBe(403)
	})
	it("asks for the server maximum when listing the whole catalog", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))
		await makeClient(fetchImpl as unknown as typeof fetch).list()
		const calls = fetchImpl.mock.calls as unknown as [string][]
		expect(calls[0][0]).toContain("limit=2000")
	})
	it("reports an unreachable hub as a network error", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError(`fetch failed for ${KEY}`)
		})
		const error = await makeClient(fetchImpl as unknown as typeof fetch)
			.list()
			.catch((e) => e)
		expect((error as SkillHubError).code).toBe("network")
		expect((error as SkillHubError).message).not.toContain(KEY)
	})

	it("times out a hung hub", async () => {
		const fetchImpl = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						const abort = new Error("aborted")
						abort.name = "AbortError"
						reject(abort)
					})
				}),
		)
		const error = await makeClient(fetchImpl as unknown as typeof fetch, { timeoutMs: 10 })
			.list()
			.catch((e) => e)
		expect((error as SkillHubError).code).toBe("timeout")
	})

	it("rejects an unexpected response shape", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ nope: true }))
		const error = await makeClient(fetchImpl as unknown as typeof fetch)
			.list()
			.catch((e) => e)
		expect((error as SkillHubError).code).toBe("invalid")
	})
})
