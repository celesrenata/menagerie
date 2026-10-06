/**
 * Tool Capability taxonomy for the Dynamic Capability Broker (FEAT-013).
 *
 * This module defines the extensible, namespaced vocabulary a worker reasons in
 * when requesting tool/MCP access, together with the small set of kinds the
 * catalog and policy engine share. It is pure data + types: no I/O, no runtime
 * dependencies on McpHub, auto-approval, or the broker itself.
 */

/**
 * Namespaced tool-capability id, e.g. "repo.read", "cluster.deploy".
 *
 * Extensible by design: the string-literal members document the seed vocabulary
 * for editor completion and reference, while the `(string & {})` member keeps
 * the type open so a runtime registry may introduce additional namespaced
 * capabilities without a code change to the broker core. This is NOT a closed
 * enum.
 */
export type ToolCapabilityId =
	| "semantic.retrieve"
	| "repo.read"
	| "repo.write"
	| "git.read"
	| "git.write"
	| "terminal.read"
	| "terminal.execute"
	| "cluster.read"
	| "cluster.deploy"
	| "browser.inspect"
	| "browser.interact"
	| "cloud.read"
	| "cloud.mutate"
	| "observability.read"
	| "issue.read"
	| "issue.write"
	| "artifact.read"
	| "artifact.write"
	// Extension point: a registry may add further namespaced capabilities.
	| (string & {})

/** The kind of access a capability represents. */
export type CapabilityAccessKind = "read" | "write" | "execute"

/**
 * Risk classes map onto the existing `AutoApprovalState` keys in the policy
 * engine (low → read-only, high → write/execute/mcp). `elevated` sits between.
 */
export type CapabilityRiskClass = "low" | "elevated" | "high"

/** Where a capability's tools come from. */
export type ProviderClass = "native" | "mcp"

/**
 * Risk class pinned to each seed capability, per the design's risk table.
 *
 * This is the single source of truth shared by the Capability Catalog and the
 * Capability Policy Engine so a capability's risk can never diverge between the
 * two. Low-risk reads auto-grant when relevant; `terminal.read` is elevated;
 * the write/execute/deploy/mutate/interact set is high and must route through
 * `checkAutoApproval`.
 */
export const SEED_RISK_BY_CAPABILITY: Readonly<Record<string, CapabilityRiskClass>> = {
	// Low-risk reads.
	"semantic.retrieve": "low",
	"repo.read": "low",
	"git.read": "low",
	"cluster.read": "low",
	"browser.inspect": "low",
	"cloud.read": "low",
	"observability.read": "low",
	"issue.read": "low",
	"artifact.read": "low",
	// Elevated.
	"terminal.read": "elevated",
	// High-risk writes / executes / mutations.
	"repo.write": "high",
	"git.write": "high",
	"terminal.execute": "high",
	"cluster.deploy": "high",
	"browser.interact": "high",
	"cloud.mutate": "high",
	"issue.write": "high",
	"artifact.write": "high",
}
