// Feature: menagerie-branding-migration
//
// Declarative backbone for the Menagerie rebrand. This module enumerates every
// brand-bearing surface in the extension (the Branding_Surface inventory) and the
// derived-asset manifest. The inventory-driven sweep edits these surfaces and the
// acceptance scan / property tests read this data as the single source of truth.
//
// Taxonomy (see design.md): each surface is either a User_Visible_String
// (isCompatibilityBoundary === false, MUST read "Menagerie") or a
// Compatibility_Boundary identifier (isCompatibilityBoundary === true, retained
// byte-for-byte). The rebrand changes the first class and never the second.

/**
 * The kind of brand-bearing surface a {@link BrandingSurface} describes.
 *
 * - `metadata`      — `package.json` fields (author, repository, homepage, keywords)
 * - `nls`           — `package.nls.json` resolved strings (displayName, description)
 * - `command-title` — user-visible command palette label
 * - `settings-desc` — settings description shown to the user
 * - `label`         — code-constructed UI label (e.g. a task board label)
 * - `asset`         — image/icon surface
 */
export type BrandingSurfaceKind =
	| "metadata"
	| "nls"
	| "command-title"
	| "settings-desc"
	| "label"
	| "asset"

/**
 * One brand-bearing surface in the extension. Drives both the sweep and the
 * acceptance check.
 */
export interface BrandingSurface {
	/** File path + field/line, e.g. "src/package.json#author.name". */
	location: string
	kind: BrandingSurfaceKind
	/** Value before this feature. */
	currentValue: string
	/** Value after this feature (Menagerie-branded, or retained unchanged). */
	targetValue: string
	/** When true the value is retained byte-for-byte; a carve-out is permitted. */
	isCompatibilityBoundary: boolean
}

/**
 * One entry in the derived-asset manifest. Every derived extension image traces
 * back to the canonical `menagerie.png`.
 */
export interface DerivedAsset {
	/** Always the canonical brand asset, `"menagerie.png"`. */
	source: string
	/** Output path, e.g. "src/assets/icons/menagerie.png" or the activity bar icon. */
	target: string
	surface:
		| "extension-icon"
		| "activity-bar"
		| "sidebar-header"
		| "welcome"
		| "task-surface"
		| "marketplace"
}

/**
 * Every brand-bearing surface in the extension.
 *
 * Package metadata and NLS strings reflect the current (pre-edit) `currentValue`
 * and the Menagerie-branded `targetValue` the sweep will produce. The three
 * `src/activate/taskBoard.ts` label surfaces reflect the file's current refactored
 * state: the `getActivityLabel()` / `Zoo ·` / panel-title labels described in the
 * original spec no longer exist, so the closest actual rendered labels are recorded
 * here (all already read "Menagerie").
 */
export const brandingSurfaces: readonly BrandingSurface[] = [
	// --- src/package.json metadata (User_Visible_String) ---
	{
		location: "src/package.json#author.name",
		kind: "metadata",
		currentValue: "Zoo Code",
		targetValue: "Menagerie",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.json#repository.url",
		kind: "metadata",
		currentValue: "https://github.com/Zoo-Code-Org/Zoo-Code",
		targetValue: "https://github.com/celesrenata/menagerie",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.json#homepage",
		kind: "metadata",
		currentValue: "https://zoocode.dev",
		targetValue: "https://github.com/celesrenata/menagerie",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.json#keywords",
		kind: "metadata",
		currentValue:
			'["cline","claude","dev","mcp","openrouter","coding","agent","autonomous","chatgpt","sonnet","ai","llama","zoo code","zoocode"]',
		targetValue:
			'["cline","claude","dev","mcp","openrouter","coding","agent","autonomous","chatgpt","sonnet","ai","llama","menagerie"]',
		isCompatibilityBoundary: false,
	},

	// --- src/package.nls.json resolved strings (User_Visible_String) ---
	{
		location: "src/package.nls.json#extension.displayName",
		kind: "nls",
		currentValue: "Menagerie",
		targetValue: "Menagerie",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.nls.json#extension.description",
		kind: "nls",
		currentValue: "A whole dev team of AI agents in your editor.",
		targetValue: "A whole dev team of AI agents in your editor.",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.nls.json#settings.enableCodeActions.description",
		kind: "settings-desc",
		currentValue: "Enable Zoo Code quick fixes",
		targetValue: "Enable Menagerie quick fixes",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.nls.json#settings.customStoragePath.description",
		kind: "settings-desc",
		currentValue:
			"Custom storage path. Leave empty to use the default location. Supports absolute paths (e.g. 'D:\\ZooCodeStorage')",
		targetValue:
			"Custom storage path. Leave empty to use the default location. Supports absolute paths (e.g. 'D:\\MenagerieStorage')",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.nls.json#settings.autoImportSettingsPath.description",
		kind: "settings-desc",
		currentValue:
			"Path to a ZooCode configuration file to automatically import on extension startup. Supports absolute paths and paths relative to the home directory (e.g. '~/Documents/zoo-code-settings.json'). Leave empty to disable auto-import.",
		targetValue:
			"Path to a Menagerie configuration file to automatically import on extension startup. Supports absolute paths and paths relative to the home directory (e.g. '~/Documents/menagerie-settings.json'). Leave empty to disable auto-import.",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.nls.json#settings.workspace.rootResolution.description",
		kind: "settings-desc",
		currentValue:
			"How Zoo resolves the workspace root in a multi-root workspace. The root is used to locate `.roomodes`, `.roo/mcp.json`, `.roo/rules/`, and other project-scoped configuration. Changing this setting only affects future lookups; running tasks keep their original root.",
		targetValue:
			"How Menagerie resolves the workspace root in a multi-root workspace. The root is used to locate `.roomodes`, `.roo/mcp.json`, `.roo/rules/`, and other project-scoped configuration. Changing this setting only affects future lookups; running tasks keep their original root.",
		isCompatibilityBoundary: false,
	},

	// --- src/activate/taskBoard.ts code-constructed labels (User_Visible_String) ---
	// The original `getActivityLabel()` / `Zoo ·` prefix / `Zoo Task ·` panel title
	// labels no longer exist in the refactored file. The closest actual rendered
	// labels are recorded below; all already read "Menagerie".
	{
		location: "src/activate/taskBoard.ts#checklist-empty-state-hint",
		kind: "label",
		currentValue: "No checklist yet — ask Menagerie to use update_todo_list.",
		targetValue: "No checklist yet — ask Menagerie to use update_todo_list.",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/activate/taskBoard.ts#tree-item-tooltip",
		kind: "label",
		currentValue: "Inspect tasks in the Menagerie Task Observatory.",
		targetValue: "Inspect tasks in the Menagerie Task Observatory.",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/activate/taskBoard.ts#task-observatory-landmark",
		kind: "label",
		currentValue: "The Menagerie Task Observatory webview is the primary inspection surface.",
		targetValue: "The Menagerie Task Observatory webview is the primary inspection surface.",
		isCompatibilityBoundary: false,
	},

	// --- src/package.json command palette titles (User_Visible_String) ---
	// Found by the inventory-driven sweep (task 6.1): residual "Zoo:" prefixes on
	// the task-board command titles. The command IDs (zoo-code.showTaskBoard /
	// zoo-code.exportTaskBoard) are retained Persisted_Identifiers; only the
	// user-visible Command_Title text is rebranded.
	{
		location: "src/package.json#contributes.commands[zoo-code.showTaskBoard].title",
		kind: "command-title",
		currentValue: "Zoo: Show Task Board",
		targetValue: "Menagerie: Show Task Board",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.json#contributes.commands[zoo-code.exportTaskBoard].title",
		kind: "command-title",
		currentValue: "Zoo: Export Task Board JSON",
		targetValue: "Menagerie: Export Task Board JSON",
		isCompatibilityBoundary: false,
	},

	// --- src/services/ripgrep/diagnostic.ts rendered diagnostic strings (User_Visible_String) ---
	// Found by the sweep (task 6.1): the ripgrep diagnostic output-channel name,
	// report header line, and clipboard info toast all rendered "Zoo Code".
	{
		location: "src/services/ripgrep/diagnostic.ts#output-channel-name",
		kind: "label",
		currentValue: "Zoo Code Ripgrep Diagnostic",
		targetValue: "Menagerie Ripgrep Diagnostic",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/services/ripgrep/diagnostic.ts#report-header",
		kind: "label",
		currentValue: "Zoo Code Ripgrep Diagnostic (<timestamp>)",
		targetValue: "Menagerie Ripgrep Diagnostic (<timestamp>)",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/services/ripgrep/diagnostic.ts#clipboard-info-toast",
		kind: "label",
		currentValue: "Zoo Code: ripgrep diagnostic copied to clipboard.",
		targetValue: "Menagerie: ripgrep diagnostic copied to clipboard.",
		isCompatibilityBoundary: false,
	},

	// --- src/services/rules/rules.ts generated rule-file template (User_Visible_String) ---
	// Found by the sweep (task 6.1): the scaffolded rule file body named the product.
	{
		location: "src/services/rules/rules.ts#createRuleTemplate-body",
		kind: "label",
		currentValue: "Add Zoo Code rule guidance here.",
		targetValue: "Add Menagerie rule guidance here.",
		isCompatibilityBoundary: false,
	},

	// --- Image/icon surfaces (User_Visible_String) ---
	{
		location: "src/package.json#icon",
		kind: "asset",
		currentValue: "assets/icons/menagerie.png",
		targetValue: "assets/icons/menagerie.png",
		isCompatibilityBoundary: false,
	},
	{
		location: "src/package.json#contributes.viewsContainers.activitybar[zoo-code-ActivityBar].icon",
		kind: "asset",
		currentValue: "assets/icons/icon.svg",
		targetValue: "assets/icons/menagerie-activitybar.png",
		isCompatibilityBoundary: false,
	},
] as const

/**
 * The `asset`-kind subset of the inventory, consumed by the asset pipeline and the
 * provenance check. Every entry derives from the canonical `menagerie.png`.
 */
export const derivedAssets: readonly DerivedAsset[] = [
	{
		source: "menagerie.png",
		target: "src/assets/icons/menagerie.png",
		surface: "extension-icon",
	},
	{
		source: "menagerie.png",
		target: "src/assets/icons/menagerie-activitybar.png",
		surface: "activity-bar",
	},
] as const
