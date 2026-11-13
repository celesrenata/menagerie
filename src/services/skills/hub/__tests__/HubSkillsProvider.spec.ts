import type { SkillHubSkillMode } from "@roo-code/types"

import { HubSkillsProvider, originOf, type HubSkillsConfig } from "../HubSkillsProvider"
import { SkillHubError, type HubSkillSummary } from "../SkillHubClient"

const skill = (id: string, name = id): HubSkillSummary => ({ id, name, description: `${name} d` })

function setup(config: Partial<HubSkillsConfig> = {}, overrides: Record<string, unknown> = {}) {
	const client = {
		search: vi.fn(async () => [skill("b"), skill("c")]),
		list: vi.fn(async () => [skill("a"), skill("b"), skill("c")]),
		load: vi.fn(async (id: string) => ({ ...skill(id), content: `body of ${id}` })),
		...overrides,
	}
	const full: HubSkillsConfig = { enabled: true, apiKey: "k", baseUrl: "http://hub", maxSkills: 8, ...config }
	const provider = new HubSkillsProvider({ getConfig: () => full, clientFactory: () => client })
	return { client, provider, full }
}

describe("HubSkillsProvider", () => {
	it("offers nothing and makes no request when disabled", async () => {
		const { client, provider } = setup({ enabled: false })
		expect(await provider.resolveForTask("t1", "fix bug", [])).toEqual([])
		expect(client.search).not.toHaveBeenCalled()
	})

	it("combines manual on with auto hits and searches once per task", async () => {
		const modes: Record<string, SkillHubSkillMode> = { a: "on", c: "off" }
		const { client, provider } = setup({ modes })
		const first = await provider.resolveForTask("t1", "fix bug", [])
		await provider.resolveForTask("t1", "fix bug", [])
		expect(first.map((s) => s.id)).toEqual(["a", "b"])
		expect(client.search).toHaveBeenCalledTimes(1)
		await provider.resolveForTask("t2", "other", [])
		expect(client.search).toHaveBeenCalledTimes(2)
	})

	it("applies a changed mode on the next call without re-searching", async () => {
		const config: HubSkillsConfig = { enabled: true, apiKey: "k", baseUrl: "http://hub", maxSkills: 8, modes: {} }
		const client = {
			search: vi.fn(async () => [skill("b"), skill("c")]),
			list: vi.fn(async () => [skill("a"), skill("b"), skill("c")]),
			load: vi.fn(),
		}
		const provider = new HubSkillsProvider({ getConfig: () => config, clientFactory: () => client })
		expect((await provider.resolveForTask("t", "q", [])).map((s) => s.id)).toEqual(["b", "c"])
		config.modes = { b: "off" }
		expect((await provider.resolveForTask("t", "q", [])).map((s) => s.id)).toEqual(["c"])
		expect(client.search).toHaveBeenCalledTimes(1)
	})

	it("degrades to manual on when the hub search fails", async () => {
		const { provider } = setup(
			{ modes: { a: "on" } },
			{
				search: vi.fn(async () => {
					throw new SkillHubError("network", "down")
				}),
			},
		)
		const result = await provider.resolveForTask("t", "q", [])
		expect(result.map((s) => s.id)).toEqual(["a"])
	})

	it("returns an empty list when both catalog and search fail, never throwing", async () => {
		const boom = async () => {
			throw new SkillHubError("auth", "401", 401)
		}
		const { provider } = setup({ modes: { a: "on" } }, { search: boom, list: boom })
		await expect(provider.resolveForTask("t", "q", [])).resolves.toEqual([])
	})

	it("does not cache a failed auto search, so the next turn retries", async () => {
		const search = vi
			.fn()
			.mockRejectedValueOnce(new Error("blip"))
			.mockResolvedValue([skill("b")])
		const { provider } = setup({}, { search })
		expect(await provider.resolveForTask("t1", "fix bug", [])).toEqual([])
		expect((await provider.resolveForTask("t1", "fix bug", [])).map((s) => s.id)).toEqual(["b"])
		expect(search).toHaveBeenCalledTimes(2)
	})
	it("refuses non-http(s) base URLs so the key is never sent there", async () => {
		const { client, provider } = setup({ baseUrl: "file:///etc/hub" })
		expect(await provider.resolveForTask("t1", "fix bug", [])).toEqual([])
		expect(client.search).not.toHaveBeenCalled()
	})
	it("returns nothing without a key or URL", async () => {
		const { client, provider } = setup({ apiKey: "" })
		expect(await provider.resolveForTask("t", "q", [])).toEqual([])
		expect(client.search).not.toHaveBeenCalled()
	})

	it("uses the fallback origin when the base URL is blank", async () => {
		const factory = vi.fn(() => ({ search: vi.fn(async () => []), list: vi.fn(), load: vi.fn() }))
		const provider = new HubSkillsProvider({
			getConfig: () => ({ enabled: true, apiKey: "k", baseUrl: "  " }),
			getFallbackBaseUrl: () => "http://omniroute:20128",
			clientFactory: factory,
		})
		await provider.resolveForTask("t", "q", [])
		expect(factory).toHaveBeenCalledWith({ baseUrl: "http://omniroute:20128", apiKey: "k" })
	})

	it("caches the catalog within the TTL and refreshes on demand", async () => {
		let now = 0
		const { client } = setup()
		const provider = new HubSkillsProvider({
			getConfig: () => ({ enabled: true, apiKey: "k", baseUrl: "http://hub" }),
			clientFactory: () => client,
			catalogTtlMs: 100,
			now: () => now,
		})
		await provider.getCatalog()
		await provider.getCatalog()
		expect(client.list).toHaveBeenCalledTimes(1)
		now = 200
		await provider.getCatalog()
		expect(client.list).toHaveBeenCalledTimes(2)
		await provider.getCatalog(true)
		expect(client.list).toHaveBeenCalledTimes(3)
	})

	it("loads by omniroute-hub location and by a known name, but never an off skill", async () => {
		const { client, provider, full } = setup()
		await provider.resolveForTask("t", "q", [])
		expect((await provider.load("omniroute-hub:zzz"))?.content).toBe("body of zzz")
		expect((await provider.load("c"))?.source).toBe("omniroute-hub")
		full.modes = { c: "off" }
		expect(await provider.load("c")).toBeNull()
		expect(client.load).toHaveBeenCalledTimes(2)
	})

	it("returns null for an unknown name and for a 404", async () => {
		const { provider } = setup(
			{},
			{
				load: vi.fn(async () => {
					throw new SkillHubError("not_found", "nf", 404)
				}),
			},
		)
		expect(await provider.load("never-seen")).toBeNull()
		expect(await provider.load("omniroute-hub:gone")).toBeNull()
	})

	it("surfaces a typed error when a load is rejected", async () => {
		const { provider } = setup(
			{},
			{
				load: vi.fn(async () => {
					throw new SkillHubError("forbidden", "403", 403)
				}),
			},
		)
		await expect(provider.load("omniroute-hub:x")).rejects.toMatchObject({ code: "forbidden" })
	})
})

describe("originOf", () => {
	it("extracts the origin of an OpenAI base URL", () => {
		expect(originOf("http://host:20128/v1")).toBe("http://host:20128")
		expect(originOf("not a url")).toBeUndefined()
		expect(originOf(undefined)).toBeUndefined()
	})
})
