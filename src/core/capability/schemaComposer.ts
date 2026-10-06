/**
 * Deterministic Schema Composer for the Dynamic Capability Broker (FEAT-013).
 *
 * The composer produces the effective tool surface fed into
 * `SYSTEM_PROMPT`/`generatePrompt`: the always-resident core prefix plus the
 * tools of every Tool Capability whose lease state is `active`, and nothing
 * else. Enforcement is runtime, not prompt — a capability that is only
 * configured, only ALLOWED, `released`, or `denied` contributes zero tools.
 *
 * Composition is a pure function of the ACTIVE set:
 *
 *   outbound tool schemas =
 *       [ stable CORE prefix ]                               (fixed every turn)
 *     ++ [ leased NATIVE tools, sorted by ToolCapabilityId ]
 *     ++ [ leased MCP tools, sorted by (ToolCapabilityId, serverName, toolName) ]
 *
 * Because the ordering is total and stable and the core prefix is byte-stable,
 * the same ACTIVE set yields byte-identical output across turns (preserving
 * prefix/prompt caching), and a single activation appends after the existing
 * leased entries without disturbing prior byte offsets.
 *
 * The module is pure: no I/O, no McpHub, no auto-approval. The catalog is used
 * only to identify the Always-Resident-Core members and to enumerate every
 * known capability for the `disabledTools` computation.
 */

import { SEED_CAPABILITY_CATALOG, type CapabilityCatalog } from "./capabilityCatalog"
import type { WorkerCapabilityState } from "./capabilityLease"
import type { ProviderRegistry, ResolvedTool } from "./providerRegistry"
import type { ToolCapabilityId } from "./toolCapability"

/**
 * The composed tool surface handed to the prompt layer. `corePrefix` is
 * byte-stable across turns; `leasedNative`/`leasedMcp` carry only the tools of
 * ACTIVE leases in deterministic order; `disabledTools` suppresses every
 * unleased native/MCP tool when threaded into the existing `SYSTEM_PROMPT`
 * argument.
 */
export interface ComposedToolSurface {
	/** Byte-stable core prefix (identical every turn) → cache-friendly. */
	corePrefix: ResolvedTool[]
	/** Leased native tools, sorted ascending by ToolCapabilityId. */
	leasedNative: ResolvedTool[]
	/** Leased MCP tools, sorted ascending by (ToolCapabilityId, serverName, toolName). */
	leasedMcp: ResolvedTool[]
	/** disabledTools filter to pass into SYSTEM_PROMPT for everything unleased. */
	disabledTools: string[]
}

export interface SchemaComposer {
	/**
	 * Deterministic composition from a worker's state. Identical ACTIVE sets
	 * yield byte-identical surfaces across repeated calls.
	 */
	compose(state: WorkerCapabilityState, registry: ProviderRegistry): ComposedToolSurface
}

/**
 * Resolve the concrete tools for a core capability. Core tools are always
 * present regardless of whether any provider is registered for them: if the
 * registry has no provider for a core capability, a stable native
 * `ResolvedTool` is derived from the capability id so the core prefix stays
 * byte-stable turn to turn and across deployments with different provider
 * registrations.
 */
function resolveCoreTools(capability: ToolCapabilityId, registry: ProviderRegistry): ResolvedTool[] {
	const resolved = registry.resolve(capability)
	if (resolved.length > 0) {
		return resolved
	}
	// Derive a stable native tool from the capability id. The provider id is the
	// capability itself and the tool name is the capability's leaf segment, so
	// the derived tool is identical for the same capability every call.
	const leaf = capability.includes(".") ? capability.slice(capability.lastIndexOf(".") + 1) : capability
	return [
		{
			providerClass: "native",
			providerId: capability,
			toolName: leaf,
			schemaRef: { native: capability } as const,
		},
	]
}

/** Ascending comparison of ToolCapabilityId strings (byte-stable total order). */
function byCapabilityId(a: ToolCapabilityId, b: ToolCapabilityId): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Ascending comparison of resolved MCP tools by (serverName/providerId, then
 * toolName). The capability key is applied before this comparator, so this only
 * needs to break ties within a single capability's resolved tools.
 */
function byMcpTool(a: ResolvedTool, b: ResolvedTool): number {
	if (a.providerId !== b.providerId) {
		return a.providerId < b.providerId ? -1 : 1
	}
	if (a.toolName !== b.toolName) {
		return a.toolName < b.toolName ? -1 : 1
	}
	return 0
}

/**
 * Build a `SchemaComposer`. The catalog defaults to `SEED_CAPABILITY_CATALOG`
 * and is used only to identify core members (`core: true`) and to enumerate the
 * universe of known capabilities for the `disabledTools` computation; callers
 * with registry-registered extensions may pass a composed catalog.
 */
export function createSchemaComposer(catalog: CapabilityCatalog = SEED_CAPABILITY_CATALOG): SchemaComposer {
	const entries = catalog.list()
	// Core members in catalog (insertion) order so the prefix is byte-stable.
	const coreCapabilities: ToolCapabilityId[] = entries.filter((entry) => entry.core === true).map((entry) => entry.id)
	const coreSet = new Set<ToolCapabilityId>(coreCapabilities)

	return {
		compose(state: WorkerCapabilityState, registry: ProviderRegistry): ComposedToolSurface {
			// 1. Byte-stable core prefix: core members in catalog order, each
			//    resolved deterministically (derived when no provider exists).
			const corePrefix: ResolvedTool[] = coreCapabilities.flatMap((capability) =>
				resolveCoreTools(capability, registry),
			)

			// 2. Leased capabilities: exactly the ACTIVE set, minus any core
			//    members (core is served by the prefix, never leased).
			const leasedCapabilities = state.active
				.filter((capability) => !coreSet.has(capability))
				.slice()
				.sort(byCapabilityId)

			const leasedNative: ResolvedTool[] = []
			const leasedMcp: ResolvedTool[] = []
			// Tool names kept active, to subtract from the disabled set.
			const activeToolNames = new Set<string>()

			for (const capability of leasedCapabilities) {
				const tools = registry.resolve(capability)
				// Native tools: sorted at the capability level (already) and
				// appended in resolve order within the capability.
				for (const tool of tools) {
					activeToolNames.add(tool.toolName)
					if (tool.providerClass === "native") {
						leasedNative.push(tool)
					}
				}
				// MCP tools for this capability, ordered by (serverName, toolName)
				// within the capability; the outer capability loop supplies the
				// leading ToolCapabilityId ordering.
				const mcpForCapability = tools.filter((tool) => tool.providerClass === "mcp").sort(byMcpTool)
				for (const tool of mcpForCapability) {
					leasedMcp.push(tool)
				}
			}

			// 3. disabledTools: every tool name available from providers for any
			//    known capability, minus the names kept active above. Core tools
			//    are never disabled. Enumeration follows catalog order and each
			//    capability's resolve order for determinism; duplicates collapse
			//    via the Set, and the result is sorted for byte-stable output.
			const disabled = new Set<string>()
			for (const entry of entries) {
				if (entry.core === true) {
					continue
				}
				for (const tool of registry.resolve(entry.id)) {
					if (!activeToolNames.has(tool.toolName)) {
						disabled.add(tool.toolName)
					}
				}
			}
			const disabledTools = Array.from(disabled).sort()

			return { corePrefix, leasedNative, leasedMcp, disabledTools }
		},
	}
}
