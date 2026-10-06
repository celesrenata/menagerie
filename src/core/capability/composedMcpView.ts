/**
 * SYSTEM_PROMPT enforcement wiring for the Dynamic Capability Broker (FEAT-013).
 *
 * The {@link ComposedToolSurface} produced by the Schema Composer is applied to
 * the prompt layer here, WITHOUT forking `SYSTEM_PROMPT`/`generatePrompt`
 * (`src/core/prompts/system.ts`) and WITHOUT restarting or disconnecting any
 * MCP process. Enforcement is achieved by:
 *
 *   1. presenting a *filtered* `McpHub` view whose `getServers()` returns only
 *      the servers/tools named by `surface.leasedMcp` (the leased subset), and
 *   2. threading `surface.disabledTools` into the existing `SYSTEM_PROMPT`
 *      `disabledTools` argument to suppress every unleased native/MCP tool.
 *
 * The real hub stays the single source of concrete tool schemas: the filtered
 * view is a read-only wrapper that defers every unrelated member to the live
 * hub (so the existing serialization path works unchanged) and overrides only
 * `getServers()` to narrow the visible servers/tools. Nothing on the real hub
 * is mutated; no connection is restarted or disconnected to remove a schema —
 * an unleased schema is simply never surfaced to the prompt (MCP-002, MCP-018).
 */

import type { McpServer, McpTool } from "@roo-code/types"

import type { McpHub } from "../../services/mcp/McpHub"
import type { ComposedToolSurface } from "./schemaComposer"

/**
 * The narrow slice of `McpHub` the prompt serialization path consumes
 * (`generatePrompt` → `getMcpServerTools` / effective-tool-policy both read
 * `getServers()`). The filtered view satisfies the full `McpHub` type at the
 * call site by wrapping a real hub, but only this slice is reshaped.
 */
export interface FilteredMcpHubView {
	/** Only the leased servers/tools are visible to the prompt layer. */
	getServers(): McpServer[]
}

/**
 * Result of applying a composed surface to the prompt layer. `mcpHub` is the
 * filtered view to pass as the `mcpHub` argument of
 * `SYSTEM_PROMPT(... mcpHub, ... disabledTools ...)`; `disabledTools` is the
 * computed suppression filter to pass as the `disabledTools` argument.
 */
export interface AppliedComposedSurface {
	/** Filtered `McpHub` view exposing only leased servers/tools. */
	mcpHub: McpHub
	/** disabledTools filter suppressing every unleased native/MCP tool. */
	disabledTools: string[]
	/** The surface that produced this view (for retention on failure). */
	surface: ComposedToolSurface
}

/**
 * Group the leased MCP tools of a composed surface by server name. The composer
 * resolves each MCP `ResolvedTool` with `providerId === <McpHub server name>`
 * and the concrete `toolName`, so the leased subset is exactly
 * `{ serverName → Set<toolName> }`.
 */
function leasedToolsByServer(surface: ComposedToolSurface): Map<string, Set<string>> {
	const byServer = new Map<string, Set<string>>()
	for (const tool of surface.leasedMcp) {
		if (tool.providerClass !== "mcp") {
			continue
		}
		const existing = byServer.get(tool.providerId)
		if (existing) {
			existing.add(tool.toolName)
		} else {
			byServer.set(tool.providerId, new Set([tool.toolName]))
		}
	}
	return byServer
}

/**
 * Project a single real `McpServer` down to only its leased tools. Returns
 * `undefined` when the server has no leased tool (so the server itself is
 * dropped from the filtered view). The returned server is a shallow clone with
 * a filtered `tools` array — the real server object is never mutated.
 */
function filterServerToLeased(server: McpServer, leasedToolNames: Set<string>): McpServer | undefined {
	const tools: McpTool[] = (server.tools ?? []).filter((tool) => leasedToolNames.has(tool.name))
	if (tools.length === 0) {
		return undefined
	}
	// Shallow clone so the live server (and the real hub) is left untouched.
	return { ...server, tools }
}

/**
 * Build the filtered server list for a composed surface from the real hub's
 * current servers. Only servers that have at least one leased tool survive, and
 * each surviving server exposes only its leased tools. Reads the live hub so the
 * hub remains the single source of concrete schemas; produces fresh clones so
 * nothing on the hub is mutated.
 */
function buildFilteredServers(mcpHub: McpHub, surface: ComposedToolSurface): McpServer[] {
	const byServer = leasedToolsByServer(surface)
	if (byServer.size === 0) {
		return []
	}
	const filtered: McpServer[] = []
	for (const server of mcpHub.getServers()) {
		const leasedToolNames = byServer.get(server.name)
		if (!leasedToolNames) {
			continue
		}
		const projected = filterServerToLeased(server, leasedToolNames)
		if (projected) {
			filtered.push(projected)
		}
	}
	return filtered
}

/**
 * Wrap a real `McpHub` in a read-only view that overrides only `getServers()`
 * to return the leased subset, deferring every other member to the live hub.
 *
 * A `Proxy` is used so the existing serialization path (which types its
 * argument as `McpHub`) keeps working unchanged for any member it happens to
 * touch, while the capability layer narrows exactly one method. The handler
 * only intercepts reads; it installs no setters, so the real hub cannot be
 * mutated through the view, and it never calls any restart/disconnect member.
 */
function createFilteredHubView(mcpHub: McpHub, filteredServers: McpServer[]): McpHub {
	const override: FilteredMcpHubView = {
		getServers: () => filteredServers,
	}
	return new Proxy(mcpHub, {
		get(target, property, receiver) {
			if (property === "getServers") {
				return override.getServers
			}
			const value = Reflect.get(target, property, receiver)
			// Bind methods back to the real hub so deferred calls keep their
			// `this`; non-function members pass through unchanged.
			return typeof value === "function" ? value.bind(target) : value
		},
	}) as McpHub
}

/**
 * Apply a composed tool surface to the prompt layer. Returns a filtered
 * `McpHub` view exposing only the leased servers/tools plus the computed
 * `disabledTools`, ready to pass into
 * `SYSTEM_PROMPT(... mcpHub, ... disabledTools ...)`.
 *
 * This reuses the existing serialization path: it does NOT fork `SYSTEM_PROMPT`
 * and does NOT restart or disconnect any MCP process to remove a schema — the
 * unleased schemas are simply absent from the filtered `getServers()` result.
 */
export function applyComposedSurface(mcpHub: McpHub, surface: ComposedToolSurface): AppliedComposedSurface {
	const filteredServers = buildFilteredServers(mcpHub, surface)
	const view = createFilteredHubView(mcpHub, filteredServers)
	// Defensive copy so a later mutation of the surface's array cannot alter the
	// filter already handed to the prompt.
	const disabledTools = surface.disabledTools.slice()
	return { mcpHub: view, disabledTools, surface }
}

/**
 * An explicit, non-throwing error indication naming a recomposition failure.
 * Surfaced (never swallowed) when a new surface cannot be composed; the prior
 * surface is retained instead.
 */
export interface RecompositionFailure {
	readonly ok: false
	/** The underlying failure, named rather than hidden. */
	readonly error: Error
	/** The retained (last successfully composed) applied surface, if any. */
	readonly retained?: AppliedComposedSurface
}

/** A successful recomposition carrying the freshly applied surface. */
export interface RecompositionSuccess {
	readonly ok: true
	readonly applied: AppliedComposedSurface
}

export type RecompositionResult = RecompositionSuccess | RecompositionFailure

/**
 * A stateful applier that threads a worker's successive composed surfaces into
 * the prompt layer and enforces the fail-closed retention rule: on a
 * recomposition failure the applier retains the LAST successfully composed
 * surface, restarts/disconnects NO MCP process, and returns an explicit error
 * indication naming the failure (MCP-002, MCP-018, FEAT-013 Req 10.4/10.6).
 */
export interface ComposedSurfaceApplier {
	/**
	 * Recompose from a fresh surface. On success the new surface becomes the
	 * retained surface and is returned. On any failure the previously retained
	 * surface (if any) is kept and an explicit `RecompositionFailure` naming the
	 * error is returned — no MCP process is touched.
	 */
	recompose(nextSurface: ComposedToolSurface): RecompositionResult
	/** The last successfully applied surface, or `undefined` before the first success. */
	current(): AppliedComposedSurface | undefined
}

/**
 * Create a {@link ComposedSurfaceApplier} bound to a real `McpHub`. The hub is
 * only ever read through `applyComposedSurface`; the applier never restarts or
 * disconnects a connection, so a failed recomposition leaves the live MCP
 * processes and the previously enforced surface untouched.
 */
export function createComposedSurfaceApplier(mcpHub: McpHub): ComposedSurfaceApplier {
	let retained: AppliedComposedSurface | undefined

	return {
		recompose(nextSurface: ComposedToolSurface): RecompositionResult {
			try {
				const applied = applyComposedSurface(mcpHub, nextSurface)
				retained = applied
				return { ok: true, applied }
			} catch (cause) {
				// Fail closed: keep the last good surface, name the failure, and
				// never restart/disconnect any MCP process to recover.
				const error =
					cause instanceof Error
						? new Error(`Capability recomposition failed: ${cause.message}`, { cause })
						: new Error(`Capability recomposition failed: ${String(cause)}`)
				return { ok: false, error, retained }
			}
		},
		current(): AppliedComposedSurface | undefined {
			return retained
		},
	}
}
