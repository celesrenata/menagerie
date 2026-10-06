// Feature: menagerie-branding-migration
//
// Carve-out allowlist for the Menagerie rebrand acceptance scan.
//
// The acceptance scan (Property 3) searches rendered user-facing strings and
// published package metadata for Prohibited_Branding tokens. Any match it finds
// MUST be a member of this allowlist, which contains only genuine
// Compatibility_Boundary identifiers — Extension_Identity fields and
// Persisted_Identifier values that are retained byte-for-byte because changing
// them would break settings, global storage, command compatibility, persisted
// profiles, task histories, or VS Code install/upgrade continuity.
//
// This module is the single source of truth for both the carve-out allowlist
// and the Prohibited_Branding token patterns, so the scan and the property
// tests classify branding identically.

/**
 * Why a retained `zoo-code`/`ZooCodeOrganization` token is permitted to appear
 * in a surface the acceptance scan inspects.
 *
 * - `extension-identity`: the VS Code marketplace identity fields (`name`,
 *   `publisher`) that determine install/upgrade continuity.
 * - `persisted-identifier`: a stable key that persists user state or wiring
 *   across sessions (command/view IDs, the views-container id, and on-disk
 *   config-path tokens).
 */
export type CarveOutReason = "extension-identity" | "persisted-identifier"

/**
 * A single Compatibility_Boundary token the acceptance scan is permitted to
 * find because it is retained unchanged by this feature.
 */
export interface CarveOutEntry {
	/** The retained token exactly as it appears, e.g. "zoo-code", "zoo-code-ActivityBar". */
	token: string
	/** Why the token is a Compatibility_Boundary and therefore permitted. */
	reason: CarveOutReason
	/** Where the retained token legitimately appears. */
	location: string
}

/**
 * The complete carve-out allowlist. Every entry is a substantiated
 * Compatibility_Boundary token (Extension_Identity or Persisted_Identifier);
 * the allowlist contains no User_Visible_String, so it cannot mask a real
 * branding leak.
 */
export const carveOutAllowlist: readonly CarveOutEntry[] = [
	// Extension_Identity fields (Requirement 3.1).
	{
		token: "zoo-code",
		reason: "extension-identity",
		location: "src/package.json#name",
	},
	{
		token: "ZooCodeOrganization",
		reason: "extension-identity",
		location: "src/package.json#publisher",
	},
	// Persisted_Identifier: the views container id (Requirement 3.2).
	{
		token: "zoo-code-ActivityBar",
		reason: "persisted-identifier",
		location: "src/package.json#contributes.viewsContainers/views container id",
	},
	// Persisted_Identifier: retained zoo-code.* command/view IDs (Requirement 3.2).
	{
		token: "zoo-code.SidebarProvider",
		reason: "persisted-identifier",
		location: "src/package.json#contributes.views view id",
	},
	{
		token: "zoo-code.taskBoard",
		reason: "persisted-identifier",
		location: "src/package.json#contributes.views view id",
	},
	// NOTE: the former "zoo-code.taskBoardTaskDetails" webview panel view type was
	// removed when the task detail panel was dropped in the taskBoard refactor, so
	// it no longer appears in any surface. It is intentionally omitted here: the
	// acceptance scan's allowlist-substantiation check (Requirement 6.3) rejects
	// tokens that appear nowhere, since a stale carve-out could mask a future leak.
	// Persisted_Identifier: on-disk config-path tokens (Requirement 6.3). These
	// are filesystem/config compatibility-boundary tokens referenced in the
	// root-resolution setting description, not product brand words.
	{
		token: ".roomodes",
		reason: "persisted-identifier",
		location: "src/package.nls.json#settings.workspace.rootResolution.description",
	},
	{
		token: ".roo/mcp.json",
		reason: "persisted-identifier",
		location: "src/package.nls.json#settings.workspace.rootResolution.description",
	},
	{
		token: ".roo/rules/",
		reason: "persisted-identifier",
		location: "src/package.nls.json#settings.workspace.rootResolution.description",
	},
]

/**
 * The Prohibited_Branding token patterns: the brand strings "Zoo Code" and
 * "Roo Code", plus the standalone product words "Zoo" and "Roo" used as
 * product branding.
 *
 * The standalone-word patterns are bounded so they match product usage
 * ("ask Zoo to …") rather than substrings of carve-out identifiers:
 *   - `(?<![\w.-])` — not preceded by a word character, a dot, or a hyphen, so
 *     they do not match inside `ZooCodeOrganization`, `zoocode`, `.roomodes`,
 *     `.roo/mcp.json`, or `.roo/rules/`.
 *   - `(?![\w-])` — not followed by a word character or a hyphen, so they do not
 *     match inside `zoocode`, `zoo-code`, `zoo-code-ActivityBar`, or the
 *     `zoo-code.*` command/view IDs.
 * All patterns are case-insensitive and global so the scan can enumerate every
 * occurrence.
 *
 * This is the single source of truth shared by the acceptance scan and the
 * property tests.
 */
export const prohibitedBrandingPatterns: readonly RegExp[] = [
	/Zoo Code/gi,
	/Roo Code/gi,
	/(?<![\w.-])Zoo(?![\w-])/gi,
	/(?<![\w.-])Roo(?![\w-])/gi,
]
