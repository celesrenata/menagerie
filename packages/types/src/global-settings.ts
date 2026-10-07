import { z } from "zod"

import { codebaseIndexConfigSchema, codebaseIndexModelsSchema } from "./codebase-index.js"
import { experimentsSchema } from "./experiment.js"
import { historyItemSchema } from "./history.js"
import { customModePromptsSchema, customSupportPromptsSchema, modeConfigSchema } from "./mode.js"
import {
	type ProviderSettings,
	PROVIDER_SETTINGS_KEYS,
	providerSettingsEntrySchema,
	providerSettingsSchema,
} from "./provider-settings.js"
import { routeCapabilitySchema } from "./provider-settings/openai.js"
import { telemetrySettingsSchema } from "./telemetry.js"
import { toolNamesSchema } from "./tool.js"
import { type Keys } from "./type-fu.js"
import { languagesSchema } from "./vscode.js"
import { providerIdentifiers } from "./provider-identifiers.js"

/**
 * Default delay in milliseconds after writes to allow diagnostics to detect potential problems.
 * This delay is particularly important for Go and other languages where tools like goimports
 * need time to automatically clean up unused imports.
 */
export const DEFAULT_WRITE_DELAY_MS = 1000

/**
 * Per-request OmniRoute cost-tier ceiling ($..$$$$$), sent as the `X-OmniRoute-Tier`
 * header on OmniRoute chat requests (FEAT-005). Integer 1-5; `undefined` means "use the
 * server default" and emits no header. Shared schema so the global setting, the webview
 * control, and the request-path reader agree on the accepted range.
 */
export const omniRouteTierSchema = z.number().int().min(1).max(5)

/** The number of cost tiers ($ through $$$$$) the OmniRoute tier control offers. */
export const OMNIROUTE_TIER_COUNT = 5

/**
 * The five user-selectable parallelism appetite modes (FEAT-011), stored as their
 * internal enum values (never the user-visible labels). The persisted internal value
 * for the "MAXIMUM CHAOS" label is `"max"`. This expresses a concurrency *ceiling*
 * (how aggressively Menagerie may fan work out), not a GPU or worker count or target.
 */
export const PARALLELISM_MODES = ["conservative", "balanced", "auto", "aggressive", "max"] as const

export type ParallelismMode = (typeof PARALLELISM_MODES)[number]

/**
 * Default parallelism appetite when the user has not selected one. Auto lets the
 * mastermind size useful concurrency and OmniRoute decide physical admission, without
 * manufacturing filler work.
 */
export const DEFAULT_PARALLELISM_MODE: ParallelismMode = "auto"

/**
 * Shared schema for the parallelism appetite mode so the global setting, the webview
 * control, and the request-path reader agree on the accepted values. Any non-member
 * value is treated as unset and resolves to the `"auto"` default downstream.
 */
export const parallelismModeSchema = z.enum(PARALLELISM_MODES)

/**
 * User-adjustable per-capability parallel-task capacity map (replaces the
 * previously hardcoded `STATIC_ROUTE_CAPACITY` as the operator-tunable source).
 * A PARTIAL map keyed by the five route capabilities, each value a positive
 * integer slot count:
 *
 *   - An OMITTED capability falls back to `STATIC_ROUTE_CAPACITY[cap]` (and then
 *     to the bounded unknown-capability default) at batch start, so unset/empty
 *     is a byte-for-byte no-op: today's hardcoded capacity.
 *   - Values are floored to `>= 1` downstream in `createStaticRouteCapacityProvider`;
 *     the schema's `.int().positive()` rejects 0 / negative / non-integer entries
 *     at the persistence boundary so a user cannot reintroduce the 0-lease
 *     deadlock, and the `routeCapabilitySchema` key enum rejects unknown
 *     capabilities.
 *
 * `routeCapabilitySchema` is reused so the key set stays in lockstep with the
 * `RouteCapability` union / `ROUTE_CAPABILITIES` tuple. `z.record` with an enum
 * key is partial: it accepts `{}` and any subset of the five keys.
 */
export const parallelCapacityMapSchema = z.record(routeCapabilitySchema, z.number().int().positive())

/**
 * Default per-worker read-input byte budget (design §C, Lever 2). Counts only
 * the bytes `ReadFileTool` returns from a worker's reads, not env details,
 * preamble, or accumulated turns — so it is NOT directly comparable to the
 * total-prompt token figure. `600_000` bytes (~150k tokens at ~4 chars/token)
 * engages well before read accumulation alone could dominate a prompt, while
 * still permitting a legitimate multi-file first-party investigation. The value
 * is user-adjustable; FR-6 measurement is the authoritative calibration.
 */
export const DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES = 600_000

/**
 * Default per-read line limit applied to budget-crossed reads with no explicit
 * `limit` (design §C). Every clamp site uses `min(computedDefault, 500)`, so the
 * tightening is monotonic — it only lowers (or leaves) the limit, never raises
 * it.
 */
export const BUDGET_TIGHTENED_LINE_LIMIT = 500

/**
 * Hardcoded default read denylist (design §B). The single source of truth for
 * every reader; the user-adjustable `parallelReadDenylist` setting merges over
 * it per-field (see `mergeReadDenylist`). Four fields with distinct match
 * semantics so first-party source is never caught:
 *
 *   - `vendoredDirs` — directory name matched ANYWHERE in the path (unambiguously
 *     third-party / tool-generated).
 *   - `rootDirs` — matched ONLY as the first path segment; an `out-*`-style entry
 *     is prefix-matched. `dist`/`out`/`out-*`/`coverage` are literal `.gitignore`
 *     root outputs; `build` is retained as a conventional root-anchored
 *     build-output name (a harmless no-op here because no root `build/` exists).
 *   - `files` — exact basename (lockfiles).
 *   - `globs` — `ignore`-compiled globs against the full relPath (vendored
 *     typings, minified bundles, source maps scoped to code extensions, and
 *     two-segment build-dependency paths).
 *
 * The default intentionally does NOT deny bare `pkg`/`deps`/`bundle`,
 * anywhere-segment `build`/`out`, a broad map glob, nor all `.d.ts` files —
 * those recur as first-party roots/segments/files.
 */
export const DEFAULT_READ_DENYLIST = {
	vendoredDirs: ["node_modules", "vendor", "Pods", ".pnpm-store", ".stryker-tmp", "__pycache__"],
	rootDirs: ["dist", "out", "out-*", "build", "coverage"],
	files: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
	globs: [
		"**/node_modules/@types/**",
		"**/typescript/lib/*.d.ts",
		"**/*.min.js",
		"**/*.min.css",
		"**/*.js.map",
		"**/*.css.map",
		"target/dependency/**",
		"build/dependencies/**",
	],
} as const

/**
 * Shared schema for the user-adjustable `parallelReadDenylist` setting
 * (precedent: `parallelCapacityMapSchema`). Four OPTIONAL string-array fields;
 * an omitted field inherits the hardcoded `DEFAULT_READ_DENYLIST` while a
 * provided field (including an explicit empty array `[]`) replaces that
 * category — see `mergeReadDenylist`. `{}` and any subset of the four keys are
 * accepted so unset/empty is a byte-for-byte no-op of the default.
 */
export const parallelReadDenylistSchema = z.object({
	vendoredDirs: z.array(z.string()).optional(),
	rootDirs: z.array(z.string()).optional(),
	files: z.array(z.string()).optional(),
	globs: z.array(z.string()).optional(),
})

/**
 * Default values for the "auto-close files Zoo opened" settings.
 *
 * These are defined once here and consumed by every site that reads the setting
 * (DiffViewProvider save/revert, ClineProvider state serialization, and the
 * UISettings checkboxes) so there is a single source of truth for the default
 * behavior. Auto-closing edited tabs is opt-in: by default, files Zoo edits stay
 * open in the editor (the long-standing behavior). Users who want to save
 * context tokens by closing the edited tab after each edit can enable it.
 */
export const DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES = false
export const DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED = false
export const DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES = false

/**
 * Default fuzzy matching threshold for the multi-search-replace diff strategy.
 * A value of 1.0 (exact match) is used by default for safety, especially when
 * auto-approval for writes is enabled. This prevents unintended changes from
 * being applied due to minor mismatches. Users can lower this threshold manually
 * in settings to reduce "Edit Unsuccessful" errors caused by minor whitespace
 * or formatting differences, accepting a higher risk of unintended edits.
 */
export const DEFAULT_DIFF_FUZZY_THRESHOLD = 1.0

export const DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED = false

/**
 * Default automatic condensation threshold.
 *
 * 100% leaves no runway for the summarizer itself, transient token-count
 * underestimation, or a large incoming user/tool result. Condensing at 80%
 * gives the parent coordinator enough headroom to create a good fresh-start
 * summary before context management becomes an emergency operation.
 */
export const DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT = 80

/**
 * Terminal output preview size options for persisted command output.
 *
 * Controls how much command output is kept in memory as a "preview" before
 * the LLM decides to retrieve more via `read_command_output`. Larger previews
 * mean more immediate context but consume more of the context window.
 *
 * - `small`: 5KB preview - Best for long-running commands with verbose output
 * - `medium`: 10KB preview - Balanced default for most use cases
 * - `large`: 20KB preview - Best when commands produce critical info early
 *
 * @see OutputInterceptor - Uses this setting to determine when to spill to disk
 * @see PersistedCommandOutput - Contains the resulting preview and artifact reference
 */
export type TerminalOutputPreviewSize = "small" | "medium" | "large"

/**
 * Byte limits for each terminal output preview size.
 *
 * Maps preview size names to their corresponding byte thresholds.
 * When command output exceeds these thresholds, the excess is persisted
 * to disk and made available via the `read_command_output` tool.
 */
export const TERMINAL_PREVIEW_BYTES: Record<TerminalOutputPreviewSize, number> = {
	small: 5 * 1024, // 5KB
	medium: 10 * 1024, // 10KB
	large: 20 * 1024, // 20KB
}

/**
 * Default terminal output preview size.
 * The "medium" (10KB) setting provides a good balance between immediate
 * visibility and context window conservation for most use cases.
 */
export const DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE: TerminalOutputPreviewSize = "medium"

/**
 * Minimum checkpoint timeout in seconds.
 */
export const MIN_CHECKPOINT_TIMEOUT_SECONDS = 10

/**
 * Maximum checkpoint timeout in seconds.
 */
export const MAX_CHECKPOINT_TIMEOUT_SECONDS = 60

/**
 * Default checkpoint timeout in seconds.
 */
export const DEFAULT_CHECKPOINT_TIMEOUT_SECONDS = 15

/**
 * GlobalSettings
 */

export const globalSettingsSchema = z.object({
	currentApiConfigName: z.string().optional(),
	listApiConfigMeta: z.array(providerSettingsEntrySchema).optional(),
	pinnedApiConfigs: z.record(z.string(), z.boolean()).optional(),

	lastShownAnnouncementId: z.string().optional(),
	customInstructions: z.string().optional(),
	taskHistory: z.array(historyItemSchema).optional(),
	dismissedUpsells: z.array(z.string()).optional(),

	// Image generation settings (experimental) - flattened for simplicity
	imageGenerationProvider: z.enum([providerIdentifiers.openrouter]).optional(),
	openRouterImageApiKey: z.string().optional(),
	openRouterImageGenerationSelectedModel: z.string().optional(),

	customCondensingPrompt: z.string().optional(),

	autoApprovalEnabled: z.boolean().optional(),
	// Temporary high-autonomy policy layered over the saved BRRR toggles.
	yoloModeEnabled: z.boolean().optional(),
	/**
	 * Per-request OmniRoute cost-tier ceiling ($..$$$$$), selected beside the YOLO
	 * control and sent as `X-OmniRoute-Tier` on OmniRoute chat requests (FEAT-005).
	 * Integer 1-5; `undefined` means "use the server default" and emits no header.
	 */
	omniRouteTier: omniRouteTierSchema.optional(),
	/**
	 * Persisted default parallelism appetite (FEAT-011). One of the five
	 * `ParallelismMode` values; `undefined` means "unset" and resolves to the
	 * `DEFAULT_PARALLELISM_MODE` (`"auto"`) default downstream. The per-request
	 * value rides on the request envelope's `parallelism` field and is never
	 * derived from this persisted default at submit time.
	 */
	parallelismMode: parallelismModeSchema.optional(),
	/**
	 * Persisted user-adjustable per-capability parallel-task capacity map. A
	 * PARTIAL `Record<RouteCapability, positive integer>`; `undefined`/empty means
	 * "unset" and resolves to the hardcoded `STATIC_ROUTE_CAPACITY` default
	 * downstream (a no-op for users who never set it). Values are floored to `>= 1`
	 * at the provider; invalid (0/negative/non-integer) and unknown-capability
	 * entries are rejected at this schema boundary.
	 */
	parallelCapacityMap: parallelCapacityMapSchema.optional(),
	/**
	 * Persisted user-adjustable read denylist for the parallel-worker read path
	 * (design §B/§F). Four OPTIONAL string-array fields; an OMITTED field inherits
	 * the hardcoded `DEFAULT_READ_DENYLIST` and a PROVIDED field (including an
	 * explicit empty array `[]`) REPLACES that category downstream via
	 * `mergeReadDenylist`, so `undefined`/`{}` is a byte-for-byte no-op and `[]`
	 * clears a category (how a user re-enables reading, e.g. vendored typings).
	 */
	parallelReadDenylist: parallelReadDenylistSchema.optional(),
	alwaysAllowReadOnly: z.boolean().optional(),
	alwaysAllowReadOnlyOutsideWorkspace: z.boolean().optional(),
	/**
	 * Gitignore-style patterns naming the files that may be read without
	 * approval, even when `alwaysAllowReadOnly` is off. Resolved relative to the
	 * workspace root; absolute patterns are also accepted.
	 */
	allowedReadFiles: z.array(z.string()).optional(),
	alwaysAllowWrite: z.boolean().optional(),
	alwaysAllowWriteOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWriteProtected: z.boolean().optional(),
	/**
	 * Gitignore-style path patterns, relative to the workspace root, whose files
	 * may be created/edited without approval even when `alwaysAllowWrite` is off.
	 *
	 * Lets a user grant a narrow, path-scoped write permission (for example a
	 * scratchpad file) without auto-approving writes to the whole workspace.
	 */
	allowedWriteFiles: z.array(z.string()).optional(),
	writeDelayMs: z.number().min(0).optional(),
	/**
	 * Fuzzy matching threshold for the multi-search-replace diff strategy.
	 * Range: 0.5 (50% minimum similarity) to 1.0 (exact match only).
	 * `@default` 1.0
	 */
	diffFuzzyThreshold: z.number().min(0.5).max(1).optional(),
	requestDelaySeconds: z.number().optional(),
	alwaysAllowMcp: z.boolean().optional(),
	alwaysAllowModeSwitch: z.boolean().optional(),
	alwaysAllowSubtasks: z.boolean().optional(),
	alwaysAllowExecute: z.boolean().optional(),
	destructiveCommandGuardEnabled: z.boolean().optional(),
	alwaysAllowFollowupQuestions: z.boolean().optional(),
	followupAutoApproveTimeoutMs: z.number().optional(),
	allowedCommands: z.array(z.string()).optional(),
	deniedCommands: z.array(z.string()).optional(),
	commandExecutionTimeout: z.number().optional(),
	commandTimeoutAllowlist: z.array(z.string()).optional(),
	preventCompletionWithOpenTodos: z.boolean().optional(),
	allowedMaxRequests: z.number().nullish(),
	allowedMaxCost: z.number().nullish(),
	autoCondenseContext: z.boolean().optional(),
	autoCondenseContextPercent: z.number().optional(),

	/**
	 * Whether to include current time in the environment details
	 * @default true
	 */
	includeCurrentTime: z.boolean().optional(),
	/**
	 * Whether to include current cost in the environment details
	 * @default true
	 */
	includeCurrentCost: z.boolean().optional(),
	/**
	 * Maximum number of git status file entries to include in the environment details.
	 * Set to 0 to disable git status. The header (branch, commits) is always included when > 0.
	 * @default 0
	 */
	maxGitStatusFiles: z.number().optional(),

	/**
	 * Whether to include diagnostic messages (errors, warnings) in tool outputs
	 * @default true
	 */
	includeDiagnosticMessages: z.boolean().optional(),
	/**
	 * Maximum number of diagnostic messages to include in tool outputs
	 * @default 50
	 */
	maxDiagnosticMessages: z.number().optional(),

	enableCheckpoints: z.boolean().optional(),
	checkpointTimeout: z
		.number()
		.int()
		.min(MIN_CHECKPOINT_TIMEOUT_SECONDS)
		.max(MAX_CHECKPOINT_TIMEOUT_SECONDS)
		.optional(),

	ttsEnabled: z.boolean().optional(),
	ttsSpeed: z.number().optional(),
	soundEnabled: z.boolean().optional(),
	soundVolume: z.number().optional(),
	attentionNotificationsEnabled: z.boolean().optional(),

	maxOpenTabsContext: z.number().optional(),
	maxWorkspaceFiles: z.number().optional(),
	showRooIgnoredFiles: z.boolean().optional(),
	enableSubfolderRules: z.boolean().optional(),
	maxImageFileSize: z.number().optional(),
	maxTotalImageSize: z.number().optional(),

	terminalOutputPreviewSize: z.enum(["small", "medium", "large"]).optional(),
	terminalShellIntegrationTimeout: z.number().optional(),
	terminalShellIntegrationDisabled: z.boolean().optional(),
	terminalCommandDelay: z.number().optional(),
	terminalPowershellCounter: z.boolean().optional(),
	terminalZshClearEolMark: z.boolean().optional(),
	terminalZshOhMy: z.boolean().optional(),
	terminalZshP10k: z.boolean().optional(),
	terminalZdotdir: z.boolean().optional(),
	terminalProfile: z.string().optional(),
	execaShellPath: z.string().optional(),

	diagnosticsEnabled: z.boolean().optional(),
	autoCloseZooOpenedFiles: z.boolean().optional(),
	autoCloseZooOpenedFilesAfterUserEdited: z.boolean().optional(),
	autoCloseZooOpenedNewFiles: z.boolean().optional(),

	rateLimitSeconds: z.number().optional(),
	experiments: experimentsSchema.optional(),

	codebaseIndexModels: codebaseIndexModelsSchema.optional(),
	codebaseIndexConfig: codebaseIndexConfigSchema.optional(),

	language: languagesSchema.optional(),

	telemetrySetting: telemetrySettingsSchema.optional(),

	mcpEnabled: z.boolean().optional(),

	mode: z.string().optional(),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),
	customModes: z.array(modeConfigSchema).optional(),
	customModePrompts: customModePromptsSchema.optional(),
	customSupportPrompts: customSupportPromptsSchema.optional(),
	enhancementApiConfigId: z.string().optional(),
	condensingApiConfigId: z.string().optional(),
	includeTaskHistoryInEnhance: z.boolean().optional(),
	historyPreviewCollapsed: z.boolean().optional(),
	reasoningBlockCollapsed: z.boolean().optional(),
	/**
	 * Font size (in pixels) for the Zoo Code chat/webview UI.
	 * When unset (or `null`), the webview inherits VS Code's `--vscode-font-size`.
	 */
	chatFontSize: z.number().int().min(8).max(32).nullish(),
	/**
	 * Controls the keyboard behavior for sending messages in the chat input.
	 * - "send": Enter sends message, Shift+Enter creates newline (default)
	 * - "newline": Enter creates newline, Shift+Enter/Ctrl+Enter sends message
	 * @default "send"
	 */
	enterBehavior: z.enum(["send", "newline"]).optional(),
	profileThresholds: z.record(z.string(), z.number()).optional(),
	hasOpenedModeSelector: z.boolean().optional(),
	lastModeExportPath: z.string().optional(),
	lastModeImportPath: z.string().optional(),
	lastSettingsExportPath: z.string().optional(),
	lastTaskExportPath: z.string().optional(),
	lastImageSavePath: z.string().optional(),

	/**
	 * Path to worktree to auto-open after switching workspaces.
	 * Used by the worktree feature to open the Roo Code sidebar in a new window.
	 */
	worktreeAutoOpenPath: z.string().optional(),
	/**
	 * Whether to show the worktree selector in the home screen.
	 * @default true
	 */
	showWorktreesInHomeScreen: z.boolean().optional(),

	/**
	 * List of native tool names to globally disable.
	 * Tools in this list will be excluded from prompt generation and rejected at execution time.
	 */
	disabledTools: z.array(toolNamesSchema).optional(),
})

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export const GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options

/**
 * RooCodeSettings
 */

export const rooCodeSettingsSchema = providerSettingsSchema.merge(globalSettingsSchema)

export type RooCodeSettings = GlobalSettings & ProviderSettings

/**
 * SecretState
 */
export const SECRET_STATE_KEYS = [
	"apiKey",
	"openRouterApiKey",
	"awsAccessKey",
	"awsApiKey",
	"awsSecretKey",
	"awsSessionToken",
	"openAiApiKey",
	"ollamaApiKey",
	"geminiApiKey",
	"openAiNativeApiKey",
	"deepSeekApiKey",
	"moonshotApiKey",
	"kimiCodeApiKey",
	"mistralApiKey",
	"minimaxApiKey",
	"requestyApiKey",
	"unboundApiKey",
	"xaiApiKey",
	"litellmApiKey",
	"codeIndexOpenAiKey",
	"codeIndexQdrantApiKey",
	"codebaseIndexOpenAiCompatibleApiKey",
	"codebaseIndexGeminiApiKey",
	"codebaseIndexMistralApiKey",
	"codebaseIndexVercelAiGatewayApiKey",
	"codebaseIndexOpenRouterApiKey",
	"sambaNovaApiKey",
	"zaiApiKey",
	"fireworksApiKey",
	"friendliApiKey",
	"vercelAiGatewayApiKey",
	"opencodeGoApiKey",
	"kenariApiKey",
	"nanoGptApiKey",
	"basetenApiKey",
] as const

// Global secrets that are part of GlobalSettings (not ProviderSettings)
export const GLOBAL_SECRET_KEYS = [
	"openRouterImageApiKey", // For image generation
] as const

// Type for the actual secret storage keys
type ProviderSecretKey = (typeof SECRET_STATE_KEYS)[number]
type GlobalSecretKey = (typeof GLOBAL_SECRET_KEYS)[number]

// Type representing all secrets that can be stored
export type SecretState = Pick<ProviderSettings, Extract<ProviderSecretKey, keyof ProviderSettings>> & {
	[K in GlobalSecretKey]?: string
}

export const isSecretStateKey = (key: string): key is Keys<SecretState> =>
	SECRET_STATE_KEYS.includes(key as ProviderSecretKey) || GLOBAL_SECRET_KEYS.includes(key as GlobalSecretKey)

/**
 * GlobalState
 */

export type GlobalState = Omit<RooCodeSettings, Keys<SecretState>>

export const GLOBAL_STATE_KEYS = [...GLOBAL_SETTINGS_KEYS, ...PROVIDER_SETTINGS_KEYS].filter(
	(key: Keys<RooCodeSettings>) => !isSecretStateKey(key),
) as Keys<GlobalState>[]

export const isGlobalStateKey = (key: string): key is Keys<GlobalState> =>
	GLOBAL_STATE_KEYS.includes(key as Keys<GlobalState>)
