/**
 * Capability Catalog for the Dynamic Capability Broker (FEAT-013).
 *
 * The catalog holds compact, mastermind-visible metadata describing every
 * available Tool Capability — far smaller than a serialized MCP tool schema and
 * sufficient to *choose* a capability without carrying any tool-schema
 * internals, server names, transports, or tool IDs. The compact
 * `mastermindView()` projection enforces that boundary at the type level.
 *
 * This module is pure data + types: no I/O, no McpHub, no auto-approval, no
 * broker. Seed risk classes are pulled from `SEED_RISK_BY_CAPABILITY` so a
 * capability's risk can never diverge between the catalog and the policy engine.
 */

import {
	type CapabilityAccessKind,
	type CapabilityRiskClass,
	type ProviderClass,
	type ToolCapabilityId,
	SEED_RISK_BY_CAPABILITY,
} from "./toolCapability"

/**
 * Compact catalog metadata for a single Tool Capability.
 *
 * Everything here is cheap to serialize and safe to show the mastermind: it
 * never includes a JSON Schema, a `schemaRef`, a server name, a transport, or a
 * concrete tool id. Those live in the Provider Registry / McpHub, not here.
 */
export interface CapabilityCatalogEntry {
	/** Namespaced capability id, e.g. "repo.read". */
	id: ToolCapabilityId
	/** Human-readable, mastermind-visible description. */
	description: string
	/** Risk class; for seed capabilities this matches SEED_RISK_BY_CAPABILITY. */
	risk: CapabilityRiskClass
	/** The kind of access the capability represents. */
	access: CapabilityAccessKind
	/** Whether the capability's tools are native or supplied by an MCP server. */
	providerClass: ProviderClass
	/** Light hints only — argument names/purpose, never a full JSON Schema. */
	requiredArgHints?: string[]
	/** Whether scoping (namespace, path, session, …) is meaningful here. */
	scopeable?: boolean
	/** True for the Always-Resident-Core surface; core is never leased. */
	core?: boolean
}

/**
 * The compact projection handed to the mastermind. It deliberately omits
 * `providerClass` and `core` and never carries any tool-schema internals,
 * server names, transports, or tool IDs — the `Pick` makes that a type-level
 * guarantee.
 */
export type CapabilityMastermindEntry = Pick<
	CapabilityCatalogEntry,
	"id" | "description" | "risk" | "access" | "requiredArgHints" | "scopeable"
>

export interface CapabilityCatalog {
	/** Look up a single entry by id. */
	get(id: ToolCapabilityId): CapabilityCatalogEntry | undefined
	/** All entries in insertion order. */
	list(): readonly CapabilityCatalogEntry[]
	/** The compact view handed to the mastermind — never includes tool schemas. */
	mastermindView(): readonly CapabilityMastermindEntry[]
}

/**
 * Build a `CapabilityCatalog` over the given entries. The last entry for a given
 * id wins, letting a provider override a seed entry without a code change here.
 * Insertion order is preserved for `list()` and `mastermindView()`.
 */
export function createCapabilityCatalog(entries: readonly CapabilityCatalogEntry[]): CapabilityCatalog {
	const byId = new Map<ToolCapabilityId, CapabilityCatalogEntry>()
	for (const entry of entries) {
		byId.set(entry.id, entry)
	}
	const ordered = Array.from(byId.values())

	return {
		get(id) {
			return byId.get(id)
		},
		list() {
			return ordered
		},
		mastermindView() {
			return ordered.map(({ id, description, risk, access, requiredArgHints, scopeable }) => ({
				id,
				description,
				risk,
				access,
				requiredArgHints,
				scopeable,
			}))
		},
	}
}

/**
 * The nine Always-Resident-Core members every worker is born with. These are
 * always ACTIVE, never leased, scoped, or revoked by the broker.
 * `capability.request`/`capability.release` are native core tools so a worker
 * can always ask for more without first needing an optional MCP capability
 * (no acquisition recursion).
 */
const CORE_CATALOG_ENTRIES: readonly CapabilityCatalogEntry[] = [
	{
		id: "task.read",
		description: "Read structured autonomous task state (status, findings, plan, todos).",
		risk: "low",
		access: "read",
		providerClass: "native",
		core: true,
	},
	{
		id: "task.update",
		description: "Update structured autonomous task state owned by this worker.",
		risk: "low",
		access: "write",
		providerClass: "native",
		core: true,
	},
	{
		id: "plan.update",
		description: "Update the task plan.",
		risk: "low",
		access: "write",
		providerClass: "native",
		core: true,
	},
	{
		id: "todo.update",
		description: "Update the task todo list.",
		risk: "low",
		access: "write",
		providerClass: "native",
		core: true,
	},
	{
		id: "semantic.retrieve",
		description: "Retrieve relevant knowledge via the semantic retrieval gateway.",
		risk: SEED_RISK_BY_CAPABILITY["semantic.retrieve"],
		access: "read",
		providerClass: "native",
		core: true,
	},
	{
		id: "evidence.read",
		description: "Read a bounded evidence packet referenced by retrieval.",
		risk: "low",
		access: "read",
		providerClass: "native",
		core: true,
	},
	{
		id: "capability.request",
		description: "Ask the broker to grant an additional Tool Capability, with a reason.",
		risk: "low",
		access: "execute",
		providerClass: "native",
		core: true,
	},
	{
		id: "capability.release",
		description: "Release a held Tool Capability so its schema leaves the context.",
		risk: "low",
		access: "execute",
		providerClass: "native",
		core: true,
	},
	{
		id: "completion.attempt",
		description: "Signal completion of the current task or phase (attempt_completion).",
		risk: "low",
		access: "execute",
		providerClass: "native",
		core: true,
	},
]

/**
 * Seed (non-core) capabilities. Risk is pulled from SEED_RISK_BY_CAPABILITY so
 * it can never diverge from the policy engine's source of truth. Metadata is
 * compact only — no schemas, server names, transports, or tool IDs.
 */
const SEED_PROVIDER_ENTRIES: readonly CapabilityCatalogEntry[] = [
	{
		id: "repo.read",
		description: "Read files and directory structure in the workspace repository.",
		risk: SEED_RISK_BY_CAPABILITY["repo.read"],
		access: "read",
		providerClass: "native",
		scopeable: true,
		requiredArgHints: ["path"],
	},
	{
		id: "repo.write",
		description: "Create or modify files in the workspace repository.",
		risk: SEED_RISK_BY_CAPABILITY["repo.write"],
		access: "write",
		providerClass: "native",
		scopeable: true,
		requiredArgHints: ["path", "content"],
	},
	{
		id: "git.read",
		description: "Inspect git status, history, diffs, and branches.",
		risk: SEED_RISK_BY_CAPABILITY["git.read"],
		access: "read",
		providerClass: "mcp",
	},
	{
		id: "git.write",
		description: "Stage, commit, branch, or push changes to git.",
		risk: SEED_RISK_BY_CAPABILITY["git.write"],
		access: "write",
		providerClass: "mcp",
		scopeable: true,
	},
	{
		id: "terminal.read",
		description: "Read terminal/process output without executing new commands.",
		risk: SEED_RISK_BY_CAPABILITY["terminal.read"],
		access: "read",
		providerClass: "native",
	},
	{
		id: "terminal.execute",
		description: "Execute shell commands in the workspace.",
		risk: SEED_RISK_BY_CAPABILITY["terminal.execute"],
		access: "execute",
		providerClass: "native",
		scopeable: true,
		requiredArgHints: ["command"],
	},
	{
		id: "cluster.read",
		description: "Read Kubernetes/cluster resource state.",
		risk: SEED_RISK_BY_CAPABILITY["cluster.read"],
		access: "read",
		providerClass: "mcp",
		scopeable: true,
		requiredArgHints: ["namespace"],
	},
	{
		id: "cluster.deploy",
		description: "Apply or deploy manifests to a cluster.",
		risk: SEED_RISK_BY_CAPABILITY["cluster.deploy"],
		access: "execute",
		providerClass: "mcp",
		scopeable: true,
		requiredArgHints: ["namespace", "manifest"],
	},
	{
		id: "browser.inspect",
		description: "Open and read pages in a headless browser (read-only).",
		risk: SEED_RISK_BY_CAPABILITY["browser.inspect"],
		access: "read",
		providerClass: "mcp",
		requiredArgHints: ["url"],
	},
	{
		id: "browser.interact",
		description: "Click, type, and navigate in a browser session.",
		risk: SEED_RISK_BY_CAPABILITY["browser.interact"],
		access: "write",
		providerClass: "mcp",
		scopeable: true,
		requiredArgHints: ["selector", "action"],
	},
	{
		id: "cloud.read",
		description: "Read cloud provider resource state.",
		risk: SEED_RISK_BY_CAPABILITY["cloud.read"],
		access: "read",
		providerClass: "mcp",
		scopeable: true,
	},
	{
		id: "cloud.mutate",
		description: "Create, modify, or delete cloud provider resources.",
		risk: SEED_RISK_BY_CAPABILITY["cloud.mutate"],
		access: "write",
		providerClass: "mcp",
		scopeable: true,
	},
	{
		id: "observability.read",
		description: "Query logs, metrics, and traces from observability backends.",
		risk: SEED_RISK_BY_CAPABILITY["observability.read"],
		access: "read",
		providerClass: "mcp",
		scopeable: true,
	},
	{
		id: "issue.read",
		description: "Read issues, tickets, or pull/merge requests.",
		risk: SEED_RISK_BY_CAPABILITY["issue.read"],
		access: "read",
		providerClass: "mcp",
	},
	{
		id: "issue.write",
		description: "Create or update issues, tickets, or pull/merge requests.",
		risk: SEED_RISK_BY_CAPABILITY["issue.write"],
		access: "write",
		providerClass: "mcp",
		scopeable: true,
	},
	{
		id: "artifact.read",
		description: "Read build artifacts, packages, or stored outputs.",
		risk: SEED_RISK_BY_CAPABILITY["artifact.read"],
		access: "read",
		providerClass: "mcp",
	},
	{
		id: "artifact.write",
		description: "Publish or modify build artifacts, packages, or stored outputs.",
		risk: SEED_RISK_BY_CAPABILITY["artifact.write"],
		access: "write",
		providerClass: "mcp",
		scopeable: true,
	},
]

/**
 * The seed catalog: the Always-Resident-Core members plus every taxonomy
 * capability, each with compact metadata only. Consumers that need extensions
 * build their own catalog via `createCapabilityCatalog([...SEED, ...custom])`.
 */
export const SEED_CAPABILITY_CATALOG: CapabilityCatalog = createCapabilityCatalog([
	...CORE_CATALOG_ENTRIES,
	...SEED_PROVIDER_ENTRIES,
])
