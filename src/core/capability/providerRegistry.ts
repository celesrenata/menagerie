/**
 * Provider Registry for the Dynamic Capability Broker (FEAT-013).
 *
 * MCP servers and native tool providers register *which* Tool Capabilities they
 * satisfy. Multiple implementations may satisfy the same capability class (e.g.
 * two Kubernetes MCP servers both satisfying `cluster.read`) without changing
 * any mastermind prompt. The registry is the lookup the broker uses to resolve
 * the concrete tools to serialize for an ACTIVE lease and to enumerate
 * alternates for remap/failover when a provider becomes unavailable.
 *
 * Registration reads server/tool metadata from `McpHub` (connections, tool
 * lists); it does NOT duplicate schema storage. The `schemaRef` on a resolved
 * tool is an opaque handle sourced from the hub, so the hub remains the single
 * source of concrete tool schemas.
 */

import type { ProviderClass, ToolCapabilityId } from "./toolCapability"

/**
 * A concrete tool to serialize for an ACTIVE lease. `schemaRef` is an opaque
 * handle to the schema owned by `McpHub` (or the native tool registry); the
 * registry never copies or stores schema bytes itself.
 */
export interface ResolvedTool {
	providerClass: ProviderClass
	/** `McpHub` server name (MCP) or a native provider id (native). */
	providerId: string
	toolName: string
	/** Opaque handle to the schema sourced from McpHub / the native registry. */
	schemaRef: unknown
}

/**
 * A provider that satisfies one or more Tool Capabilities. For MCP providers
 * `providerId` is the `McpHub` server name; for native providers it is a native
 * provider id.
 */
export interface CapabilityProvider {
	providerClass: ProviderClass
	providerId: string
	satisfies: ToolCapabilityId[]
	/**
	 * The concrete tools this provider exposes for a capability, resolved
	 * against `McpHub` tool lists (MCP) or the native tool registry.
	 */
	toolsFor(capability: ToolCapabilityId): ResolvedTool[]
}

export interface ProviderRegistry {
	/** Register a provider. Insertion order is preserved for deterministic resolution. */
	register(provider: CapabilityProvider): void
	/** Every provider that can satisfy a capability, in insertion order (for remap/failover). */
	providersFor(capability: ToolCapabilityId): CapabilityProvider[]
	/**
	 * Resolve the concrete tools to serialize for an ACTIVE lease. Prefers
	 * `preferredProviderId` when supplied and registered for the capability;
	 * otherwise uses the first provider in insertion order.
	 */
	resolve(capability: ToolCapabilityId, preferredProviderId?: string): ResolvedTool[]
}

/**
 * Create a `ProviderRegistry` backed by an insertion-stable list. `providersFor`
 * returns every provider satisfying a capability in registration order so
 * `resolve`'s default (first provider) and failover enumeration are both
 * deterministic.
 */
export function createProviderRegistry(): ProviderRegistry {
	// Insertion-stable: order of registration is the order of enumeration.
	const providers: CapabilityProvider[] = []

	const providersFor = (capability: ToolCapabilityId): CapabilityProvider[] =>
		providers.filter((provider) => provider.satisfies.includes(capability))

	return {
		register(provider: CapabilityProvider): void {
			providers.push(provider)
		},
		providersFor,
		resolve(capability: ToolCapabilityId, preferredProviderId?: string): ResolvedTool[] {
			const candidates = providersFor(capability)
			if (candidates.length === 0) {
				return []
			}
			const preferred =
				preferredProviderId !== undefined
					? candidates.find((provider) => provider.providerId === preferredProviderId)
					: undefined
			const chosen = preferred ?? candidates[0]
			return chosen.toolsFor(capability)
		},
	}
}

/**
 * The narrow slice of `McpHub` the registry depends on. Passing the hub through
 * this interface (rather than importing the concrete `McpHub`) keeps the
 * registry testable with a faked hub and documents the exact surface consumed:
 * the enabled server list, each server's declared tools, and whether a tool is
 * enabled for the prompt.
 */
export interface McpHubLike {
	/** Enabled, deduplicated servers (mirrors `McpHub.getServers()`). */
	getServers(): McpServerLike[]
}

/** The server metadata the registry reads from the hub. */
export interface McpServerLike {
	name: string
	tools?: McpToolLike[]
}

/** The tool metadata the registry reads from the hub. */
export interface McpToolLike {
	name: string
	enabledForPrompt?: boolean
}

/**
 * Register each configured MCP server as a `CapabilityProvider`. The provider's
 * `providerId` is the hub server name and `providerClass` is `"mcp"`. Each
 * resolved tool's `schemaRef` is an opaque handle whose value is read lazily
 * from the hub at resolve time — the registry never copies schema bytes, so the
 * hub stays the single source of concrete schemas.
 *
 * A server is mapped to the Tool Capabilities named by `capabilitiesFor`
 * (supplied by the caller from capability metadata). When `capabilitiesFor` is
 * omitted, each server is registered under a single capability named for the
 * server (`mcp.<serverName>`) — the compatibility default for configs that
 * carry no capability metadata. Servers that map to no capability are skipped.
 * Only tools whose `enabledForPrompt` is not `false` are exposed, matching the
 * hub's own prompt-serialization filter.
 */
export function registerMcpProviders(
	registry: ProviderRegistry,
	mcpHub: McpHubLike,
	capabilitiesFor: (serverName: string) => ToolCapabilityId[] = (serverName) => [`mcp.${serverName}`],
): void {
	for (const server of mcpHub.getServers()) {
		const satisfies = capabilitiesFor(server.name)
		if (satisfies.length === 0) {
			continue
		}

		const serverName = server.name
		registry.register({
			providerClass: "mcp",
			providerId: serverName,
			satisfies,
			toolsFor(capability: ToolCapabilityId): ResolvedTool[] {
				if (!satisfies.includes(capability)) {
					return []
				}
				// Read tool metadata from the hub lazily so the hub remains the
				// single source of truth; the schemaRef is an opaque handle, not
				// a copied schema.
				const current = mcpHub.getServers().find((candidate) => candidate.name === serverName)
				const tools = current?.tools ?? []
				return tools
					.filter((tool) => tool.enabledForPrompt !== false)
					.map((tool) => ({
						providerClass: "mcp" as const,
						providerId: serverName,
						toolName: tool.name,
						// Opaque handle sourced from the hub; the broker/composer
						// dereferences it against McpHub, which owns the schema.
						schemaRef: { serverName, toolName: tool.name } as const,
					}))
			},
		})
	}
}
