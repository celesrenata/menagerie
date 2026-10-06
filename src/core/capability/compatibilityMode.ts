/**
 * Compatibility path for the Dynamic Capability Broker (FEAT-013), Requirement 14 / 4.5.
 *
 * Existing MCP configurations carry no capability metadata. Before broker
 * adoption an operator observed exactly those tools that were configured, not
 * disabled, and always-allowed. This module reproduces that baseline exactly:
 * it maps the legacy per-server `alwaysAllow` / `disabledTools` config (as
 * resolved by `McpHub` onto each tool's `alwaysAllow` / `enabledForPrompt`
 * flags) into the set of ALLOWED Tool Capabilities, exposing no additional
 * capability beyond what the legacy config permitted.
 *
 * Boundary facts this module relies on (confirmed against
 * `src/services/mcp/McpHub.ts` and `packages/types/src/mcp.ts`):
 *   - `McpHub.getServers()` returns only *enabled* servers (disabled servers
 *     are already filtered out), deduplicated by name with project winning.
 *   - Per-server config `alwaysAllow: string[]` (may contain `"*"`) and
 *     `disabledTools: string[]` are resolved by the hub onto each `McpTool`:
 *       `tool.alwaysAllow = hasWildcard || alwaysAllow.includes(tool.name)`
 *       `tool.enabledForPrompt = !disabledTools.includes(tool.name)`
 *   - A tool contributes to the compatibility baseline iff it is configured
 *     (present on an enabled server), NOT disabled (`enabledForPrompt !== false`),
 *     AND always-allowed (`alwaysAllow === true`).
 *
 * Pure and deterministic: no I/O, no mutation of the hub. The hub is consumed
 * through a narrow passed-in interface so this is testable with a fake, mirroring
 * the `McpHubLike` pattern in `providerRegistry.ts`.
 */

import type { ToolCapabilityId } from "./toolCapability"
import type { CapabilityCatalog } from "./capabilityCatalog"

/**
 * The narrow slice of `McpHub` the compatibility path depends on, extending the
 * `providerRegistry` `McpHubLike` surface with the per-tool `alwaysAllow` flag
 * the legacy baseline needs. Passing the hub through this interface (rather than
 * importing the concrete `McpHub`) keeps the mapping testable with a faked hub
 * and documents the exact surface consumed: the enabled server list, each
 * server's declared tools, and each tool's always-allowed / enabled-for-prompt
 * flags.
 */
export interface LegacyMcpHubLike {
	/** Enabled, deduplicated servers (mirrors `McpHub.getServers()`). */
	getServers(): LegacyMcpServerLike[]
}

/** The server metadata the compatibility path reads from the hub. */
export interface LegacyMcpServerLike {
	name: string
	tools?: LegacyMcpToolLike[]
}

/**
 * The tool metadata the compatibility path reads from the hub. `alwaysAllow`
 * and `enabledForPrompt` are the per-tool flags the hub derives from the legacy
 * per-server `alwaysAllow` / `disabledTools` config.
 */
export interface LegacyMcpToolLike {
	name: string
	/** True when the tool is always-allowed (wildcard `"*"` or listed by name). */
	alwaysAllow?: boolean
	/** False only when the tool is listed in the server's `disabledTools`. */
	enabledForPrompt?: boolean
}

/** The concrete tools of one server that reproduce the legacy baseline. */
export interface LegacyAllowedServer {
	/** The Tool Capability the server maps to (default `mcp.<serverName>`). */
	capability: ToolCapabilityId
	/** The `McpHub` server name. */
	serverName: string
	/** Tool names that are configured, non-disabled, and always-allowed. */
	toolNames: string[]
}

/**
 * The compatibility baseline: the set of ALLOWED Tool Capabilities and, for
 * each, the exact per-server allowed tool names that reproduce current behavior.
 */
export interface LegacyAllowedCapabilities {
	/** Deterministically ordered ALLOWED Tool Capability ids (ascending, unique). */
	capabilities: ToolCapabilityId[]
	/** Per-server allowed tool detail, ordered by (capability, serverName). */
	servers: LegacyAllowedServer[]
}

/**
 * Decide whether a tool contributes to the compatibility baseline. A tool is
 * exposed iff it is configured (present on an enabled server), NOT disabled
 * (`enabledForPrompt !== false`), AND always-allowed (`alwaysAllow === true`).
 * Tightening the config (dropping an `alwaysAllow` entry → `alwaysAllow`
 * becomes `false`, or disabling a tool → `enabledForPrompt` becomes `false`)
 * can only make this predicate go from `true` to `false`, so tightening only
 * ever removes a capability, never adds one (Req 14.2).
 */
function isLegacyAllowed(tool: LegacyMcpToolLike): boolean {
	return tool.alwaysAllow === true && tool.enabledForPrompt !== false
}

/**
 * Map legacy `McpHub` configuration into the set of ALLOWED Tool Capabilities,
 * reproducing current behavior for configs that carry no capability metadata
 * (Req 4.5, 14.1).
 *
 * Each enabled server maps to the Tool Capabilities named by `capabilitiesFor`
 * (default `mcp.<serverName>`, matching `registerMcpProviders`). A server
 * contributes a capability as ALLOWED only if the server has at least one tool
 * that is configured, non-disabled, and always-allowed. No additional
 * capability beyond those is ever exposed.
 *
 * When a `catalog` is supplied, only capabilities present in the catalog are
 * exposed; a server mapping to a capability absent from the catalog is skipped,
 * so the baseline can never widen past the known capability vocabulary.
 *
 * The result is deterministic: capabilities are unique and ascending; per-server
 * detail is ordered by (capability, serverName) and tool names ascending.
 */
export function allowedCapabilitiesFromLegacyConfig(
	mcpHub: LegacyMcpHubLike,
	catalog?: CapabilityCatalog,
	capabilitiesFor: (serverName: string) => ToolCapabilityId[] = (serverName) => [`mcp.${serverName}`],
): LegacyAllowedCapabilities {
	const servers: LegacyAllowedServer[] = []
	const capabilitySet = new Set<ToolCapabilityId>()

	for (const server of mcpHub.getServers()) {
		const allowedToolNames = (server.tools ?? [])
			.filter(isLegacyAllowed)
			.map((tool) => tool.name)
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

		if (allowedToolNames.length === 0) {
			// No configured, non-disabled, always-allowed tool → the server
			// exposes nothing, so it maps to no capability.
			continue
		}

		for (const capability of capabilitiesFor(server.name)) {
			// Restrict to the known vocabulary when a catalog is supplied so the
			// baseline never widens past catalogued capabilities.
			if (catalog && !catalog.get(capability)) {
				continue
			}
			servers.push({ capability, serverName: server.name, toolNames: allowedToolNames })
			capabilitySet.add(capability)
		}
	}

	// Deterministic order: capabilities ascending; per-server detail by
	// (capability, serverName).
	servers.sort((left, right) =>
		left.capability < right.capability
			? -1
			: left.capability > right.capability
				? 1
				: left.serverName < right.serverName
					? -1
					: left.serverName > right.serverName
						? 1
						: 0,
	)
	const capabilities = Array.from(capabilitySet).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

	return { capabilities, servers }
}

/**
 * An error indication naming the Tool Capabilities a tightening change would
 * have *added* relative to the compatibility baseline. Tightening may only ever
 * remove exposure (Req 14.2); a change that would add a capability is rejected
 * and the prior baseline is retained (Req 14.3).
 */
export interface CompatibilityTighteningRejection {
	readonly ok: false
	/** Capabilities present in the candidate but absent from the baseline. */
	readonly addedCapabilities: ToolCapabilityId[]
	readonly error: Error
}

/** A tightening change accepted because it adds no capability beyond the baseline. */
export interface CompatibilityTighteningAccepted {
	readonly ok: true
	/** The resulting (subset-or-equal) exposed capability set. */
	readonly capabilities: ToolCapabilityId[]
}

export type CompatibilityTighteningResult = CompatibilityTighteningAccepted | CompatibilityTighteningRejection

/**
 * Validate a candidate (post-change) exposed capability set against the
 * compatibility baseline. A tightening change must produce a set that is a
 * subset of (or equal to) the baseline, adding zero capabilities not already
 * present in it (Req 14.2). If the candidate would add one or more capabilities,
 * the change is rejected: the prior baseline is retained and an error naming the
 * would-be-added capabilities is returned (Req 14.3).
 */
export function validateTightening(
	baseline: LegacyAllowedCapabilities,
	candidate: LegacyAllowedCapabilities,
): CompatibilityTighteningResult {
	const baselineSet = new Set<ToolCapabilityId>(baseline.capabilities)
	const added = candidate.capabilities.filter((capability) => !baselineSet.has(capability))

	if (added.length > 0) {
		const addedCapabilities = Array.from(new Set(added)).sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		)
		return {
			ok: false,
			addedCapabilities,
			error: new Error(
				`Tightening change would add capabilities not present in the compatibility baseline: ${addedCapabilities.join(", ")}`,
			),
		}
	}

	// Subset-or-equal: retain the candidate (which only removed capabilities).
	return { ok: true, capabilities: candidate.capabilities.slice() }
}
