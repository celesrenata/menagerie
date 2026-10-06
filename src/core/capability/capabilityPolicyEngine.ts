/**
 * Capability Policy Engine for the Dynamic Capability Broker (FEAT-013).
 *
 * The policy engine decides, for a single capability request, whether it may be
 * auto-granted, must be surfaced to the mastermind, must be routed to the user
 * via `checkAutoApproval`, or must be denied outright. It is a **pure,
 * synchronous** function: `autoApprovalState` and `relevance` are passed in and
 * no I/O is performed, so the engine is unit- and property-testable. The actual
 * `checkAutoApproval` call for a `user-approval` decision is performed by the
 * broker (step 7), keeping this layer pure.
 *
 * Two invariants are load-bearing:
 *  - **Relevance ≠ authorization.** A high relevance score can make a capability
 *    *available to request*; it never, by itself, auto-grants a privileged
 *    capability. High-risk requests resolve to `user-approval` or `deny` only.
 *  - **Reader isolation is runtime, not prompt.** A `project-reader` / `reader.*`
 *    worker is denied the write/execute/mutate/interact set purely from its role
 *    identity and the requested capability — never from prompt text.
 *
 * `checkAutoApproval` / `AutoApprovalState` remain the sole authorization
 * authority; this engine only maps risk classes onto the existing autonomy
 * fields and never introduces a second permission store.
 */

import type { AutoApprovalState, AutoApprovalStateOptions } from "../auto-approval"

import type { CapabilityCatalogEntry } from "./capabilityCatalog"
import type { CapabilityAccessKind, ToolCapabilityId } from "./toolCapability"

/**
 * The default relevance threshold at or above which a low-risk capability may
 * auto-grant. Relevance is a 0..1 recommendation signal; it only ever gates
 * low-risk reads and never authorizes a privileged capability (see `decide`).
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.5

/**
 * The autonomy fields the policy engine reads, keyed by the existing
 * `AutoApprovalState` / `AutoApprovalStateOptions` names so this engine consults
 * no permission store other than the auto-approval fields. All fields are
 * optional and read-only; an absent flag reads as "not auto-approved".
 */
export type PolicyAutoApprovalState = Partial<Record<AutoApprovalState | AutoApprovalStateOptions, boolean>>

/**
 * Minimal request shape the policy engine needs. The full `CapabilityRequest` is
 * owned by the broker (task 7.1); this local type captures only what `decide`
 * reads: the requested capability, its access kind (defaults from the catalog
 * entry when absent), and the requesting worker's role/mode for reader
 * isolation.
 */
export interface PolicyCapabilityRequest {
	/** The capability being requested. */
	capability: ToolCapabilityId
	/** Access kind; defaults to the catalog entry's `access` when omitted. */
	access?: CapabilityAccessKind
	/** The worker's role/mode, e.g. "project-reader" or "coder.primary". */
	role?: string
}

/**
 * The decision for a request. `auto-allow` grants with no mastermind turn and no
 * user prompt; `mastermind-approval` surfaces an elevated capability to the
 * mastermind; `user-approval` routes a privileged capability through
 * `checkAutoApproval`; `deny` refuses it. Every decision carries human-readable
 * `reasons` for telemetry and the Observatory.
 */
export type PolicyDecision =
	| { kind: "auto-allow"; reasons: string[] }
	| { kind: "mastermind-approval"; reasons: string[] }
	| { kind: "user-approval"; reasons: string[] }
	| { kind: "deny"; reasons: string[] }

/** The capabilities a reader worker is categorically denied, by identity alone. */
const READER_FORBIDDEN_CAPABILITIES: ReadonlySet<ToolCapabilityId> = new Set<ToolCapabilityId>([
	"repo.write",
	"git.write",
	"cluster.deploy",
	"cloud.mutate",
	"browser.interact",
])

/** True when a role is a project reader (`project-reader` or any `reader.*`). */
function isReaderRole(role: string | undefined): boolean {
	if (role === undefined) {
		return false
	}
	return role === "project-reader" || role.startsWith("reader.")
}

/**
 * Whether a reader worker is forbidden from holding `capability`.
 *
 * Derived solely from role identity and the requested capability — never from
 * prompt text. For a `project-reader` / `reader.*` role this returns `true` for
 * the write/execute/mutate/interact set (`repo.write`, `git.write`,
 * `cluster.deploy`, `cloud.mutate`, `browser.interact`); it returns `false` for
 * any non-reader role.
 */
export function readerForbids(role: string | undefined, capability: ToolCapabilityId): boolean {
	return isReaderRole(role) && READER_FORBIDDEN_CAPABILITIES.has(capability)
}

/**
 * The `AutoApprovalState` key a capability's risk class and access kind map onto.
 *
 * Low risk maps to `alwaysAllowReadOnly`. High risk maps by access kind:
 * `write` → `alwaysAllowWrite`, `execute` → `alwaysAllowExecute`, and an
 * MCP-sourced high-risk capability → `alwaysAllowMcp`. `elevated` is handled by
 * `decide` directly (mastermind view) and has no single mapped key here.
 */
export function autoApprovalKeyFor(entry: CapabilityCatalogEntry, access: CapabilityAccessKind): AutoApprovalState {
	if (entry.risk === "low") {
		return "alwaysAllowReadOnly"
	}
	// High risk: route by provider/access onto exactly one existing autonomy key.
	if (entry.providerClass === "mcp") {
		return "alwaysAllowMcp"
	}
	return access === "execute" ? "alwaysAllowExecute" : "alwaysAllowWrite"
}

/**
 * Pure, synchronous policy decision for a single capability request.
 *
 * Ordering is deliberate:
 *  1. Reader isolation first: a forbidden reader request is `deny` regardless of
 *     relevance or autonomy state.
 *  2. Low risk: `auto-allow` only when relevance ≥ threshold (no mastermind turn,
 *     no user prompt); otherwise `mastermind-approval` so a less-relevant read is
 *     still obtainable without a user prompt.
 *  3. Elevated risk: `mastermind-approval`.
 *  4. High risk: never `auto-allow`. When the mapped autonomy key is enabled,
 *     `user-approval` (the broker's `checkAutoApproval` will resolve
 *     approve/ask/deny); otherwise `deny`.
 */
export function decide(input: {
	entry: CapabilityCatalogEntry
	request: PolicyCapabilityRequest
	relevance: number
	autoApprovalState: PolicyAutoApprovalState
	/** Threshold at/above which a low-risk capability auto-grants. */
	threshold?: number
}): PolicyDecision {
	const { entry, request, relevance, autoApprovalState } = input
	const threshold = input.threshold ?? DEFAULT_RELEVANCE_THRESHOLD
	const access = request.access ?? entry.access

	// 1. Reader isolation — runtime-enforced, independent of prompt text.
	if (readerForbids(request.role, request.capability)) {
		return {
			kind: "deny",
			reasons: [`reader role "${request.role}" is forbidden from "${request.capability}"`],
		}
	}

	// 2. Low risk — may auto-grant when sufficiently relevant.
	if (entry.risk === "low") {
		if (relevance >= threshold) {
			return {
				kind: "auto-allow",
				reasons: [`low-risk capability relevant at ${relevance.toFixed(2)} (>= ${threshold})`],
			}
		}
		return {
			kind: "mastermind-approval",
			reasons: [`low-risk capability below relevance threshold (${relevance.toFixed(2)} < ${threshold})`],
		}
	}

	// 3. Elevated risk — surface to the mastermind.
	if (entry.risk === "elevated") {
		return {
			kind: "mastermind-approval",
			reasons: [`elevated-risk capability "${request.capability}" requires mastermind approval`],
		}
	}

	// 4. High risk — never auto-allow; route through autonomy or deny.
	const key = autoApprovalKeyFor(entry, access)
	if (autoApprovalState[key] === true) {
		return {
			kind: "user-approval",
			reasons: [`high-risk capability "${request.capability}" routed through ${key}`],
		}
	}
	return {
		kind: "deny",
		reasons: [`high-risk capability "${request.capability}" not permitted by ${key}`],
	}
}
