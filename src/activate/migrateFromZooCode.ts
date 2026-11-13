import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import path from "node:path"

/**
 * One-time import from the Zoo Code extension this fork used to ship as.
 *
 * Menagerie now has its own extension id (celesrenata.menagerie), so VS Code gives it fresh
 * storage. This moves Zoo's global-storage entries (task history, custom modes, MCP
 * settings, caches) into Menagerie's folder and copies `zoo-code.*` user/workspace settings
 * to `menagerie.*`. API keys live in per-extension secret storage and cannot be moved; the
 * existing settings import (`menagerie.autoImportSettingsPath`) restores them.
 */

export const LEGACY_EXTENSION_ID = "ZooCodeOrganization.zoo-code"
export const LEGACY_SETTINGS_PREFIX = "zoo-code"
export const MIGRATION_STATE_KEY = "menagerie.migratedFromZooCode.v1"

/**
 * Entries left where they are. Parallel-worker history refers to its worktrees by absolute
 * path, and task-board snapshots are per-process scratch files.
 */
export const STORAGE_ENTRIES_LEFT_IN_PLACE = new Set(["parallel-tasks", "task-boards"])

export interface StorageMoveResult {
	moved: string[]
	skipped: string[]
}

const isDirectory = (target: string) =>
	fs
		.lstat(target)
		.then((stat) => stat.isDirectory())
		.catch(() => false)

const pathExists = (target: string) =>
	fs
		.lstat(target)
		.then(() => true)
		.catch(() => false)

/**
 * Move entries from the legacy storage folder into the new one with rename(), which is
 * instant on the same volume. A folder that already exists on both sides (for example a
 * `settings/` folder seeded by Nix before first start) is merged one level deep. Existing
 * files always win, and nothing is copied: an entry that cannot be renamed (for example
 * across volumes) is left in place. Results are paths relative to the storage root.
 */
export async function moveLegacyStorage(legacyDir: string, targetDir: string): Promise<StorageMoveResult> {
	const result: StorageMoveResult = { moved: [], skipped: [] }
	const merge = async (from: string, to: string, prefix: string, depth: number) => {
		let entries: string[]
		try {
			entries = await fs.readdir(from)
		} catch {
			return
		}
		await fs.mkdir(to, { recursive: true })
		for (const entry of entries) {
			const name = prefix ? `${prefix}/${entry}` : entry
			if (!prefix && STORAGE_ENTRIES_LEFT_IN_PLACE.has(entry)) {
				result.skipped.push(name)
				continue
			}
			const source = path.join(from, entry)
			const target = path.join(to, entry)
			if (await pathExists(target)) {
				if (depth > 0 && (await isDirectory(source)) && (await isDirectory(target))) {
					await merge(source, target, name, depth - 1)
				} else {
					result.skipped.push(name)
				}
				continue
			}
			try {
				await fs.rename(source, target)
				result.moved.push(name)
			} catch {
				result.skipped.push(name)
			}
		}
	}
	if (!(await isDirectory(legacyDir))) return result
	await merge(legacyDir, targetDir, "", 1)
	return result
}

/** Copy `zoo-code.<key>` to `<prefix>.<key>` in one scope wherever the new key is not already set. */
export async function migrateSettings(
	keys: string[],
	newPrefix: string,
	configuration: Pick<vscode.WorkspaceConfiguration, "inspect" | "update">,
	scope: "user" | "workspace",
): Promise<string[]> {
	const field = scope === "user" ? "globalValue" : "workspaceValue"
	const target = scope === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace
	const migrated: string[] = []
	for (const key of keys) {
		const value = configuration.inspect(`${LEGACY_SETTINGS_PREFIX}.${key}`)?.[field]
		if (value === undefined || configuration.inspect(`${newPrefix}.${key}`)?.[field] !== undefined) continue
		await configuration.update(`${newPrefix}.${key}`, value, target)
		migrated.push(key)
	}
	return migrated
}

/** Setting keys (without prefix) contributed by this extension's manifest. */
export function contributedSettingKeys(packageJSON: unknown, prefix: string): string[] {
	const configuration = (packageJSON as { contributes?: { configuration?: unknown } })?.contributes?.configuration
	const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : []
	const keys = new Set<string>()
	for (const section of sections) {
		const properties = (section as { properties?: Record<string, unknown> })?.properties ?? {}
		for (const key of Object.keys(properties)) {
			if (key.startsWith(`${prefix}.`)) keys.add(key.slice(prefix.length + 1))
		}
	}
	return [...keys]
}

export async function migrateFromZooCode(
	context: vscode.ExtensionContext,
	prefix: string,
	log: (message: string) => void,
): Promise<void> {
	const globalDone = context.globalState.get<boolean>(MIGRATION_STATE_KEY) === true
	const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
	const workspaceDone = !hasWorkspace || context.workspaceState.get<boolean>(MIGRATION_STATE_KEY) === true
	if (globalDone && workspaceDone) return

	if (vscode.extensions.getExtension(LEGACY_EXTENSION_ID)) {
		// Moving storage out from under a running Zoo Code would corrupt its history.
		log("[migrate] Zoo Code is still installed; skipping the import until it is removed.")
		void vscode.window.showInformationMessage(
			"Menagerie can import your Zoo Code history and settings once the Zoo Code extension is uninstalled.",
		)
		return
	}

	const keys = contributedSettingKeys(context.extension?.packageJSON, prefix)
	const configuration = vscode.workspace.getConfiguration()
	try {
		if (!globalDone) {
			const targetDir = context.globalStorageUri.fsPath
			const legacyDir = path.join(path.dirname(targetDir), LEGACY_EXTENSION_ID.toLowerCase())
			const storage = await moveLegacyStorage(legacyDir, targetDir)
			const settings = await migrateSettings(keys, prefix, configuration, "user")
			log(
				`[migrate] Imported from Zoo Code. Moved storage: ${storage.moved.join(", ") || "none"}. ` +
					`Left in place: ${storage.skipped.join(", ") || "none"}. User settings: ${settings.join(", ") || "none"}.`,
			)
			await context.globalState.update(MIGRATION_STATE_KEY, true)
			if (storage.moved.length > 0 || settings.length > 0) {
				void vscode.window.showInformationMessage(
					"Menagerie imported your Zoo Code task history and settings. Re-enter API keys, or set menagerie.autoImportSettingsPath to restore them.",
				)
			}
		}
		if (!workspaceDone) {
			const settings = await migrateSettings(keys, prefix, configuration, "workspace")
			if (settings.length > 0) log(`[migrate] Workspace settings imported from Zoo Code: ${settings.join(", ")}.`)
			await context.workspaceState.update(MIGRATION_STATE_KEY, true)
		}
	} catch (error) {
		// Leave the flags unset so the next activation retries.
		log(`[migrate] Zoo Code import failed: ${error instanceof Error ? error.message : String(error)}`)
	}
}
