import * as fs from "node:fs/promises"
import * as os from "node:os"
import path from "node:path"
import type * as vscode from "vscode"

vi.mock("vscode", () => ({
	ConfigurationTarget: { Global: 1, Workspace: 2 },
}))

import { contributedSettingKeys, migrateSettings, moveLegacyStorage } from "../migrateFromZooCode"

describe("moveLegacyStorage", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "menagerie-migrate-"))
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("moves storage entries, leaves worktrees and board snapshots, and never overwrites", async () => {
		const legacy = path.join(root, "zoocodeorganization.zoo-code")
		const target = path.join(root, "celesrenata.menagerie")
		for (const dir of ["tasks/t1", "settings", "parallel-tasks/batch", "task-boards"]) {
			await fs.mkdir(path.join(legacy, dir), { recursive: true })
		}
		await fs.writeFile(path.join(legacy, "tasks/t1/ui_messages.json"), "[]")
		await fs.writeFile(path.join(legacy, "settings/custom_modes.yaml"), "legacy")
		await fs.writeFile(path.join(legacy, "settings/mcp_settings.json"), "{}")
		// Nix seeded Menagerie's settings before first start; existing files must win.
		await fs.mkdir(path.join(target, "settings"), { recursive: true })
		await fs.writeFile(path.join(target, "settings/custom_modes.yaml"), "current")

		const result = await moveLegacyStorage(legacy, target)

		expect(result.moved.sort()).toEqual(["settings/mcp_settings.json", "tasks"])
		expect(result.skipped.sort()).toEqual(["parallel-tasks", "settings/custom_modes.yaml", "task-boards"])
		// Missing files in a folder that exists on both sides are merged in.
		expect(await fs.readFile(path.join(target, "settings/mcp_settings.json"), "utf8")).toBe("{}")
		expect(await fs.readFile(path.join(target, "tasks/t1/ui_messages.json"), "utf8")).toBe("[]")
		expect(await fs.readFile(path.join(target, "settings/custom_modes.yaml"), "utf8")).toBe("current")
		// Worktrees stay where their absolute paths point.
		await expect(fs.access(path.join(legacy, "parallel-tasks/batch"))).resolves.toBeUndefined()
		await expect(fs.access(path.join(legacy, "tasks"))).rejects.toThrow()
	})

	it("does nothing when there is no legacy folder", async () => {
		const result = await moveLegacyStorage(path.join(root, "missing"), path.join(root, "target"))
		expect(result).toEqual({ moved: [], skipped: [] })
	})
})

describe("migrateSettings", () => {
	const makeConfiguration = (values: Record<string, { globalValue?: unknown; workspaceValue?: unknown }>) => {
		const update = vi.fn(async (key: string, value: unknown, target: number) => {
			values[key] = { ...values[key], [target === 1 ? "globalValue" : "workspaceValue"]: value }
		})
		const configuration = {
			inspect: (key: string) => values[key],
			update,
		} as unknown as Pick<vscode.WorkspaceConfiguration, "inspect" | "update">
		return { configuration, update }
	}

	it("copies user settings that are not already set under the new prefix", async () => {
		const { configuration, update } = makeConfiguration({
			"zoo-code.autoImportSettingsPath": { globalValue: "/home/me/profiles.json" },
			"zoo-code.apiRequestTimeout": { globalValue: 60 },
			"menagerie.apiRequestTimeout": { globalValue: 90 },
			"zoo-code.allowedCommands": { workspaceValue: ["git"] },
		})
		const migrated = await migrateSettings(
			["autoImportSettingsPath", "apiRequestTimeout", "allowedCommands"],
			"menagerie",
			configuration,
			"user",
		)
		expect(migrated).toEqual(["autoImportSettingsPath"])
		expect(update).toHaveBeenCalledWith("menagerie.autoImportSettingsPath", "/home/me/profiles.json", 1)
	})

	it("copies workspace settings only in the workspace scope", async () => {
		const { configuration, update } = makeConfiguration({
			"zoo-code.allowedCommands": { globalValue: ["ls"], workspaceValue: ["git"] },
		})
		expect(await migrateSettings(["allowedCommands"], "menagerie", configuration, "workspace")).toEqual([
			"allowedCommands",
		])
		expect(update).toHaveBeenCalledWith("menagerie.allowedCommands", ["git"], 2)
	})
})

describe("contributedSettingKeys", () => {
	it("reads keys from object or array configuration contributions", () => {
		const single = { contributes: { configuration: { properties: { "menagerie.a": {}, "other.b": {} } } } }
		const multi = {
			contributes: {
				configuration: [{ properties: { "menagerie.a": {} } }, { properties: { "menagerie.b.c": {} } }],
			},
		}
		expect(contributedSettingKeys(single, "menagerie")).toEqual(["a"])
		expect(contributedSettingKeys(multi, "menagerie")).toEqual(["a", "b.c"])
		expect(contributedSettingKeys(undefined, "menagerie")).toEqual([])
	})
})
