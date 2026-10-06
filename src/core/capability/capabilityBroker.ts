/**
 * Capability Broker orchestration surface for the Dynamic Capability Broker
 * (FEAT-013).
 *
 * The broker ties the pure components together: it owns each worker's two-level
 * capability state (persisted structurally in `AutonomousTaskState`), runs the
 * {@link decide} policy, routes privileged grants through `checkAutoApproval`
 * (the sole authorization authority), resolves providers, and composes the
 * leased tool surface. Everything here is per-worker: a grant or release for one
 * worker never touches another worker's state, and there is no global lock.
 *
 * Task 7.1 established the orchestration surface; task 7.2 layers on fail-closed
 * broker degradation and parent/child least-privilege scoping. On an internal
 * failure (catalog/registry/composer) the broker enters
 * `Capability_Broker_Degradation`: the current ACTIVE set is frozen, every new
 * `high`-risk activation is refused with a `broker-degraded` outcome, no
 * capability outside the retained ACTIVE set is ever exposed (never the full
 * configured MCP set), `brokerDegraded` is persisted into task state, and
 * exactly one degraded Observatory event is emitted (within 1s of detection)
 * through the injected `onDegraded` sink. Scoping is per-worker and
 * least-privilege: a lease is scoped to exactly one `workerId`, a child without
 * an explicit inheritance declaration is born with only the core set, and a
 * granted scope is stored byte-for-byte and never widened.
 *
 * Authorization boundary: relevance flows IN (recommendation only); privileged
 * authorization flows OUT to `checkAutoApproval` and back. A high relevance
 * score never, by itself, activates a privileged capability.
 *
 * _Requirements: 1.4, 4.6, 7.1, 7.2, 7.5, 10.1, 11.1, 11.2, 11.3, 11.4, 12.3,
 * 16.1, 16.2, 16.3, 16.5, 17.1, 17.2, 17.3, 17.4_
 */

import type { AutonomousTaskState, CapabilityObservationEvent } from "@roo-code/types"

import { checkAutoApproval, type AutoApprovalState, type AutoApprovalStateOptions } from "../auto-approval"

import { SEED_CAPABILITY_CATALOG, type CapabilityCatalog } from "./capabilityCatalog"
import {
	activate,
	deny as denyTransition,
	release as releaseTransition,
	type CapabilityLease,
	type LeaseLifetime,
	type LeaseRequester,
	type LeaseState,
	type WorkerCapabilityState,
} from "./capabilityLease"
import { decide, type PolicyAutoApprovalState, type PolicyDecision } from "./capabilityPolicyEngine"
import {
	readWorkerCapabilityState,
	writeWorkerCapabilityState,
	type AutonomousTaskStateWithCapabilities,
} from "./capabilityStatePersistence"
import { createProviderRegistry, type ProviderRegistry } from "./providerRegistry"
import { createSchemaComposer, type ComposedToolSurface, type SchemaComposer } from "./schemaComposer"
import type { CapabilityAccessKind, ToolCapabilityId } from "./toolCapability"

/**
 * A lazy, in-execution (or provisioning-time) capability acquisition request.
 * Mirrors the design's `CapabilityRequest`. `access` defaults from the catalog
 * entry when omitted; `expiresWhen` defaults to `"phase-complete"`.
 */
export interface CapabilityRequest {
	capability: ToolCapabilityId
	taskId: string
	workerId: string
	requestedBy: LeaseRequester
	reason: string
	/** Access kind; defaults to the catalog entry's `access` when omitted. */
	access?: CapabilityAccessKind
	/** Best-effort scope tokens, e.g. ["namespace=nervecenter"]. */
	scope?: string[]
	/** Lease lifetime; defaults to "phase-complete". */
	expiresWhen?: LeaseLifetime
	/** The worker's role/mode, e.g. "project-reader"; drives reader isolation. */
	role?: string
	/** 0..1 relevance recommendation signal — NEVER authorization. */
	relevance?: number
}

/**
 * The autonomy state the broker threads into both the pure policy engine and
 * the real `checkAutoApproval`. It is the single `AutoApprovalState` /
 * `AutoApprovalStateOptions` surface, consumed read-only; no second permission
 * store is introduced.
 */
export type BrokerAutoApprovalState = Partial<
	Pick<import("@roo-code/types").ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
>

/**
 * The outcome of a capability request. `activated` moved the lease into ACTIVE
 * and recomposed; `pending-approval` recorded a `requested` lease awaiting a
 * user decision (no schema composed); `denied` recorded a `denied` lease;
 * `broker-degraded` is the fail-closed refusal (task 7.2 drives it — never
 * emitted here, but part of the union so callers handle it exhaustively).
 */
export type GrantOutcome =
	| { result: "activated"; lease: CapabilityLease }
	| { result: "pending-approval"; lease: CapabilityLease }
	| { result: "denied"; lease: CapabilityLease; reason: string }
	| { result: "broker-degraded"; reason: string }

/**
 * An explicit capability-level error raised when an ACTIVE lease's provider is
 * unavailable and no semantically compatible alternate could be remapped. It
 * always carries the capability, the originating provider id, and the lease
 * state at the time of failure, so the model never mistakes it for a silent
 * success (MCP-014).
 */
export interface CapabilityProviderError {
	readonly capability: ToolCapabilityId
	readonly providerId: string
	readonly state: LeaseState
}

/** A resolved-provider result for an active lease, or an explicit error. */
export type ProviderResolution =
	| { ok: true; providerId: string }
	| { ok: false; error: CapabilityProviderError }

/**
 * The Capability Broker orchestration surface. All methods are per-worker.
 * `coreCapabilities` is the always-resident core; `requestCapability` is the
 * lazy acquisition path; `releaseCapability` moves a lease out of ACTIVE; and
 * `snapshot` is a read-only view that mutates no lifecycle state.
 */
export interface CapabilityBroker {
	/** Core set every worker is born with; never leased, never recursive. */
	coreCapabilities(): readonly ToolCapabilityId[]

	/** Lazy, in-execution acquisition with a reason (MCP-003, MCP-017). */
	requestCapability(req: CapabilityRequest): Promise<GrantOutcome>

	/** Move a lease out of ACTIVE; schema disappears next generation (MCP-013). */
	releaseCapability(workerId: string, capability: ToolCapabilityId): void

	/** Read-only snapshot for state/Observatory; never mutates lifecycle. */
	snapshot(workerId: string): WorkerCapabilityState

	/**
	 * Resolve (and if needed remap) the provider backing an ACTIVE lease. On
	 * provider unavailability with no compatible alternate, returns an explicit
	 * capability-level error rather than a silent success (MCP-014). Exposed so
	 * the invocation path never reports success for an unremapped provider.
	 */
	resolveProvider(workerId: string, capability: ToolCapabilityId): ProviderResolution

	/**
	 * Enter `Capability_Broker_Degradation` (MCP-019): freeze the current ACTIVE
	 * set, refuse every new `high`-risk activation thereafter, persist
	 * `brokerDegraded` into task state, and emit EXACTLY ONE degraded Observatory
	 * event through the injected `onDegraded` sink. Idempotent: repeated calls
	 * neither re-persist nor re-emit, so the "exactly one event" guarantee holds
	 * however many internal failures are reported. Returns `true` on the
	 * transition into degradation, `false` if already degraded.
	 */
	markDegraded(cause: string): boolean

	/** True once the broker has entered degradation; never recovers in-process. */
	isDegraded(): boolean
}

/** Dependencies the broker is constructed with; all are injectable for tests. */
export interface CapabilityBrokerDeps {
	/** The capability catalog; defaults to the seed catalog. */
	catalog?: CapabilityCatalog
	/** The provider registry; defaults to an empty insertion-stable registry. */
	registry?: ProviderRegistry
	/** The schema composer; defaults to one over the catalog. */
	composer?: SchemaComposer
	/**
	 * Mutable holder for the authoritative `AutonomousTaskState`. The broker
	 * reads and writes per-worker capability state through the structured
	 * persistence helpers so lease state survives condensation. The holder is a
	 * getter/setter so the broker shares one source of truth with the runtime.
	 */
	taskState: {
		get(): AutonomousTaskState
		set(next: AutonomousTaskStateWithCapabilities): void
	}
	/** Read-only autonomy state threaded into the policy engine and checkAutoApproval. */
	autoApprovalState?: BrokerAutoApprovalState
	/** Workspace root for `checkAutoApproval` allowlist resolution. */
	cwd?: string
	/** Relevance threshold for low-risk auto-grant; defaults to the engine's. */
	relevanceThreshold?: number
	/** Composer sink; invoked with the freshly composed surface after a grant/release. */
	onCompose?: (workerId: string, surface: ComposedToolSurface) => void
	/**
	 * Fail-closed degradation seed (MCP-019). When `true`, the broker starts
	 * already degraded: privileged (`high`-risk) activation refuses with
	 * `broker-degraded` and the ACTIVE set is frozen. Degradation is also entered
	 * at runtime via {@link CapabilityBroker.markDegraded} when an internal
	 * structure (catalog/registry/composer) fails.
	 */
	degraded?: boolean
	/**
	 * Observatory sink for the single degraded event (MCP-019, Requirement 13.5).
	 * Invoked EXACTLY ONCE, at the moment the broker first enters degradation,
	 * with a minimal read-only {@link CapabilityObservationEvent} carrying the
	 * retained (frozen) ACTIVE set. Injected so the broker emits the degraded
	 * indication without importing the Observatory runtime. The broker never
	 * calls it more than once however many internal failures are reported.
	 */
	onDegraded?: (event: CapabilityObservationEvent) => void
	/**
	 * The task id stamped onto the degraded Observatory event. Optional; defaults
	 * to an empty string when the broker is constructed before a task id exists.
	 */
	taskId?: string
}

/**
 * Project the broker's autonomy state down to the boolean-flag shape the pure
 * policy engine reads. Only the auto-approval flags are consulted; no other
 * permission store is touched.
 */
function toPolicyAutoApprovalState(state: BrokerAutoApprovalState | undefined): PolicyAutoApprovalState {
	if (!state) {
		return {}
	}
	const result: PolicyAutoApprovalState = {}
	for (const [key, value] of Object.entries(state)) {
		if (typeof value === "boolean") {
			result[key as AutoApprovalState | AutoApprovalStateOptions] = value
		}
	}
	return result
}

/**
 * The `ClineAsk` channel a high-risk capability maps onto for `checkAutoApproval`.
 * MCP-sourced capabilities route through `use_mcp_server`; native privileged
 * capabilities route through `tool`/`command` approval. The broker passes the
 * capability as the ask `text` so the existing authorization logic applies.
 */
function askChannelFor(providerClass: "native" | "mcp", access: CapabilityAccessKind): "use_mcp_server" | "command" | "tool" {
	if (providerClass === "mcp") {
		return "use_mcp_server"
	}
	return access === "execute" ? "command" : "tool"
}

/**
 * Build the broker's initial per-worker state: the Always-Resident-Core members
 * are ALLOWED and ACTIVE from birth, each with a synthetic `active` core lease
 * so the state is self-describing. Core is never leased out, scoped, or revoked.
 */
function initialWorkerState(
	workerId: string,
	taskId: string,
	coreCapabilities: readonly ToolCapabilityId[],
	now: number,
): WorkerCapabilityState {
	const coreLeases: CapabilityLease[] = coreCapabilities.map((capability) => ({
		capability,
		taskId,
		workerId,
		requestedBy: "scheduler",
		reason: "always-resident core",
		access: "read",
		state: "active",
		expiresWhen: "task-complete",
		requestedAt: now,
		activatedAt: now,
	}))
	return {
		workerId,
		allowed: [...coreCapabilities],
		active: [...coreCapabilities],
		leases: coreLeases,
	}
}

/**
 * Create a {@link CapabilityBroker}.
 *
 * The broker enforces the no-acquisition-recursion invariant at construction:
 * `capability.request` / `capability.release` MUST be native core members, and
 * no core capability may be served only by an optional MCP provider. A catalog
 * that would make a core tool depend on an optional MCP capability is rejected
 * (MCP-016 / Property 16), so a worker can always ask for more with zero
 * optional MCP active.
 */
export function createCapabilityBroker(deps: CapabilityBrokerDeps): CapabilityBroker {
	const catalog = deps.catalog ?? SEED_CAPABILITY_CATALOG
	const registry = deps.registry ?? createProviderRegistry()
	const composer = deps.composer ?? createSchemaComposer(catalog)

	// Fail-closed degradation flag (MCP-019). Mutable: it starts from the
	// injected seed and latches `true` the first time an internal structure
	// fails (never recovering in-process). `degradedEmitted` guards the
	// "exactly one Observatory event" invariant independently of the flag so a
	// broker seeded `degraded: true` can still emit its one event on first touch.
	let degraded = deps.degraded ?? false
	let degradedEmitted = false

	// Core members, in catalog order, from entries flagged `core: true`.
	const coreCapabilities: ToolCapabilityId[] = catalog
		.list()
		.filter((entry) => entry.core === true)
		.map((entry) => entry.id)

	// No-acquisition-recursion guard. The two capability-management tools and
	// every other core tool must be native: a core tool backed only by an
	// optional MCP capability would require that MCP active before a worker could
	// ask for anything, which is forbidden.
	for (const id of coreCapabilities) {
		const entry = catalog.get(id)
		if (entry !== undefined && entry.providerClass === "mcp") {
			throw new Error(
				`Capability broker misconfigured: core capability "${id}" is MCP-provided; ` +
					`core tools must be native so capability acquisition can never recurse.`,
			)
		}
	}
	for (const required of ["capability.request", "capability.release"] as const) {
		const entry = catalog.get(required)
		if (entry === undefined || entry.core !== true || entry.providerClass !== "native") {
			throw new Error(
				`Capability broker misconfigured: "${required}" must be a native core tool ` +
					`(no acquisition recursion).`,
			)
		}
	}

	const coreSet = new Set<ToolCapabilityId>(coreCapabilities)

	/** Read the worker's structured state, seeding core-only state on first touch. */
	function loadWorkerState(workerId: string, taskId: string): WorkerCapabilityState {
		const read = readWorkerCapabilityState(deps.taskState.get(), workerId)
		if (read.ok) {
			return read.state
		}
		// No structured entry yet: a worker is born with exactly the core set.
		return initialWorkerState(workerId, taskId, coreCapabilities, Date.now())
	}

	/** Persist the worker's state back into the shared `AutonomousTaskState`. */
	function persistWorkerState(state: WorkerCapabilityState): void {
		deps.taskState.set(writeWorkerCapabilityState(deps.taskState.get(), state))
	}

	/**
	 * Collect every worker's current ACTIVE set (the retained, frozen surface
	 * under degradation). Reads structured state only; on an unreadable holder
	 * the retained set is simply empty, never the full configured MCP set.
	 */
	function retainedActiveSummary(): { active: string[]; firstWorkerId: string } {
		const summaries: { active: string[]; firstWorkerId: string } = { active: [], firstWorkerId: "" }
		const taskState = deps.taskState.get() as AutonomousTaskStateWithCapabilities
		const workers = taskState.capabilities?.workers ?? []
		for (const worker of workers) {
			if (summaries.firstWorkerId === "" && typeof worker?.workerId === "string") {
				summaries.firstWorkerId = worker.workerId
			}
			if (Array.isArray(worker?.active)) {
				for (const capability of worker.active) {
					if (typeof capability === "string") {
						summaries.active.push(capability)
					}
				}
			}
		}
		return summaries
	}

	/**
	 * Enter degradation (MCP-019). Latches the `degraded` flag, persists
	 * `brokerDegraded` into structured task state, and emits EXACTLY ONE minimal
	 * degraded Observatory event through the injected sink. Idempotent: once
	 * emitted it neither re-persists nor re-emits, so however many internal
	 * failures are reported only one event is ever produced. Returns `true` on
	 * the transition, `false` when already degraded.
	 */
	function markDegraded(_cause: string): boolean {
		if (degradedEmitted) {
			return false
		}
		const alreadyDegraded = degraded
		degraded = true
		degradedEmitted = true

		// Persist brokerDegraded into structured task state without disturbing
		// any worker entry (freeze the retained ACTIVE set).
		const current = deps.taskState.get() as AutonomousTaskStateWithCapabilities
		const next: AutonomousTaskStateWithCapabilities = {
			...current,
			capabilities: {
				...current.capabilities,
				workers: current.capabilities?.workers ?? [],
				brokerDegraded: true,
			},
		}
		deps.taskState.set(next)

		// Emit exactly one degraded Observatory event carrying the retained
		// (frozen) ACTIVE set — never the full configured MCP set.
		const retained = retainedActiveSummary()
		const event: CapabilityObservationEvent = {
			taskId: deps.taskId ?? "",
			workerId: retained.firstWorkerId,
			kind: "capability",
			active: retained.active.map((id) => ({ id, risk: riskOf(id), access: accessOf(id), state: "active" })),
			available: [],
			released: [],
			denied: [],
			committedAt: Date.now(),
		}
		deps.onDegraded?.(event)
		return !alreadyDegraded
	}

	/**
	 * Run a broker-internal structure call (catalog/registry/composer) fail-closed:
	 * if it throws, enter degradation and return `{ ok: false }` so the caller
	 * holds the retained ACTIVE set rather than proceeding on a corrupt structure.
	 */
	function guard<T>(cause: string, fn: () => T): { ok: true; value: T } | { ok: false } {
		try {
			return { ok: true, value: fn() }
		} catch {
			markDegraded(cause)
			return { ok: false }
		}
	}

	/** Catalog risk lookup used for the degraded event; defaults to `high` when unknown. */
	function riskOf(id: ToolCapabilityId): "low" | "elevated" | "high" {
		try {
			return catalog.get(id)?.risk ?? "high"
		} catch {
			return "high"
		}
	}

	/** Catalog access lookup used for the degraded event; defaults to `read` when unknown. */
	function accessOf(id: ToolCapabilityId): CapabilityAccessKind {
		try {
			return catalog.get(id)?.access ?? "read"
		} catch {
			return "read"
		}
	}

	/** Recompose the leased surface for a worker and notify the sink, if any. */
	function recompose(state: WorkerCapabilityState): void {
		// Composition is a broker-internal structure: a composer failure enters
		// degradation and retains the last successfully composed surface rather
		// than exposing anything beyond the retained ACTIVE set.
		const composed = guard("composer", () => composer.compose(state, registry))
		if (!composed.ok) {
			return
		}
		deps.onCompose?.(state.workerId, composed.value)
	}

	/**
	 * Resolve the provider backing a capability, attempting a transparent remap
	 * through `providersFor` when the preferred provider is unavailable. Returns
	 * an explicit capability-level error (never a silent success) when no
	 * compatible provider can serve the capability.
	 */
	function resolveProviderForLease(
		capability: ToolCapabilityId,
		leaseState: LeaseState,
		preferredProviderId?: string,
	): ProviderResolution {
		// The registry is a broker-internal structure: a lookup failure enters
		// degradation and surfaces an explicit capability-level error (never a
		// silent success and never the full configured set).
		const guarded = guard("registry", () => registry.providersFor(capability))
		if (!guarded.ok) {
			return { ok: false, error: { capability, providerId: preferredProviderId ?? "", state: leaseState } }
		}
		const candidates = guarded.value

		// Prefer the lease's recorded provider if it is still registered and
		// actually exposes tools for the capability.
		if (preferredProviderId !== undefined) {
			const preferred = candidates.find((provider) => provider.providerId === preferredProviderId)
			if (preferred !== undefined && preferred.toolsFor(capability).length > 0) {
				return { ok: true, providerId: preferred.providerId }
			}
		}

		// Transparent remap: the first registered alternate that still exposes
		// tools for the capability.
		for (const provider of candidates) {
			if (provider.toolsFor(capability).length > 0) {
				return { ok: true, providerId: provider.providerId }
			}
		}

		// No compatible provider: explicit capability-level error.
		return {
			ok: false,
			error: { capability, providerId: preferredProviderId ?? "", state: leaseState },
		}
	}

	/** Record a lease on the worker's history, replacing any prior lease for the capability. */
	function withLease(state: WorkerCapabilityState, lease: CapabilityLease): WorkerCapabilityState {
		return {
			...state,
			leases: [...state.leases.filter((existing) => existing.capability !== lease.capability), lease],
		}
	}

	/** Build a base lease record for a request. */
	function baseLease(req: CapabilityRequest, access: CapabilityAccessKind, state: LeaseState, now: number): CapabilityLease {
		return {
			capability: req.capability,
			taskId: req.taskId,
			workerId: req.workerId,
			requestedBy: req.requestedBy,
			reason: req.reason,
			access,
			// Store the requested scope byte-for-byte (MCP-017, Requirement 17.1):
			// a defensive copy of the exact tokens, never merged, expanded, or
			// shared with the request so no later path can widen it. The broker
			// never derives a broader scope than requested; a provider that
			// declares no scoping for the dimension is served at the requested
			// scope or denied, never widened (Requirement 17.3).
			scope: req.scope === undefined ? undefined : [...req.scope],
			state,
			expiresWhen: req.expiresWhen ?? "phase-complete",
			requestedAt: now,
		}
	}

	/**
	 * Activate an authorized capability: add it to ALLOWED, resolve its provider,
	 * move it into ACTIVE, persist the delta, and recompose. On provider
	 * unavailability with no compatible alternate the activation is refused with
	 * an explicit `denied` outcome carrying the capability-level error — never a
	 * silent success.
	 */
	function activateCapability(
		worker: WorkerCapabilityState,
		req: CapabilityRequest,
		access: CapabilityAccessKind,
		now: number,
	): GrantOutcome {
		// Fail-closed (MCP-019): while degraded, refuse every NEW `high`-risk
		// activation and leave the retained ACTIVE set untouched. Low/elevated
		// activations and already-active capabilities are unaffected. A capability
		// already in the worker's ACTIVE set is not a "new" activation.
		if (degraded && !worker.active.includes(req.capability)) {
			const risk = (() => {
				const guarded = guard("catalog", () => catalog.get(req.capability)?.risk)
				return guarded.ok ? guarded.value : "high"
			})()
			if (risk === "high") {
				return { result: "broker-degraded", reason: "broker degraded; new privileged lease refused" }
			}
		}

		// Resolve (and remap) the provider BEFORE touching ACTIVE, so an
		// unavailable provider never yields an active-but-unbacked lease.
		const resolution = resolveProviderForLease(req.capability, "active", undefined)
		if (!resolution.ok) {
			const lease = baseLease(req, access, "denied", now)
			const next = withLease({ ...worker }, lease)
			persistWorkerState(next)
			return {
				result: "denied",
				lease,
				reason: `provider unavailable for "${req.capability}" (${resolution.error.providerId || "none"})`,
			}
		}

		// Ensure the capability is ALLOWED (authorized) before activation.
		const allowed = worker.allowed.includes(req.capability)
			? worker.allowed
			: [...worker.allowed, req.capability]
		const activation = activate({ ...worker, allowed }, req.capability)

		const lease: CapabilityLease = {
			...baseLease(req, access, "active", now),
			providerId: resolution.providerId,
			activatedAt: now,
		}

		if (!activation.ok) {
			// Already active: refresh the lease record (with the resolved provider)
			// and recompose idempotently.
			const next = withLease({ ...activation.state }, lease)
			persistWorkerState(next)
			recompose(next)
			return { result: "activated", lease }
		}

		const next = withLease(activation.state, lease)
		persistWorkerState(next)
		recompose(next)
		return { result: "activated", lease }
	}

	/** Record a non-active lease (requested / denied) and persist it. */
	function recordInactiveLease(
		worker: WorkerCapabilityState,
		req: CapabilityRequest,
		access: CapabilityAccessKind,
		state: "requested" | "denied",
		now: number,
	): CapabilityLease {
		const lease = baseLease(req, access, state, now)
		persistWorkerState(withLease({ ...worker }, lease))
		return lease
	}

	return {
		coreCapabilities(): readonly ToolCapabilityId[] {
			return coreCapabilities
		},

		async requestCapability(req: CapabilityRequest): Promise<GrantOutcome> {
			const now = Date.now()
			const worker = loadWorkerState(req.workerId, req.taskId)
			// Catalog lookup is a broker-internal structure: a failure enters
			// degradation and refuses the request rather than exposing anything
			// outside the retained ACTIVE set.
			const entryLookup = guard("catalog", () => catalog.get(req.capability))
			if (!entryLookup.ok) {
				return { result: "broker-degraded", reason: "broker degraded; capability lookup unavailable" }
			}
			const entry = entryLookup.value
			const access = req.access ?? entry?.access ?? "read"

			// A core capability is always ACTIVE and needs no acquisition: a
			// request for it is a no-op success referencing the resident lease.
			if (coreSet.has(req.capability)) {
				const existing = worker.leases.find((lease) => lease.capability === req.capability)
				const lease: CapabilityLease =
					existing ??
					({ ...baseLease(req, access, "active", now), activatedAt: now } as CapabilityLease)
				return { result: "activated", lease }
			}

			// Unknown capability (no catalog entry): deny — the broker never
			// exposes a capability it cannot classify.
			if (entry === undefined) {
				const lease = recordInactiveLease(worker, req, access, "denied", now)
				return { result: "denied", lease, reason: `unknown capability "${req.capability}"` }
			}

			const decision: PolicyDecision = decide({
				entry,
				request: { capability: req.capability, access, role: req.role },
				relevance: req.relevance ?? 0,
				autoApprovalState: toPolicyAutoApprovalState(deps.autoApprovalState),
				threshold: deps.relevanceThreshold,
			})

			switch (decision.kind) {
				case "deny": {
					const lease = recordInactiveLease(worker, req, access, "denied", now)
					return { result: "denied", lease, reason: decision.reasons.join("; ") }
				}

				case "auto-allow":
				case "mastermind-approval": {
					// Low-risk relevant reads and elevated/mastermind-approved
					// capabilities activate directly (no user prompt).
					return activateCapability(worker, req, access, now)
				}

				case "user-approval": {
					// High risk: fail-closed under degradation (task 7.2 drives
					// `degraded`), otherwise route through the sole authorization
					// authority, `checkAutoApproval`.
					if (degraded) {
						return { result: "broker-degraded", reason: "broker degraded; new privileged lease refused" }
					}

					const providerClass = entry.providerClass
					let approval: Awaited<ReturnType<typeof checkAutoApproval>>
					try {
						approval = await checkAutoApproval({
							state: deps.autoApprovalState,
							cwd: deps.cwd,
							ask: askChannelFor(providerClass, access),
							text: req.capability,
						})
					} catch {
						// checkAutoApproval failed/unavailable: default to DENY,
						// never activate, and return an error indication.
						const lease = recordInactiveLease(worker, req, access, "denied", now)
						return {
							result: "denied",
							lease,
							reason: `authorization unavailable for "${req.capability}"; defaulted to deny`,
						}
					}

					if (approval.decision === "approve") {
						return activateCapability(worker, req, access, now)
					}
					if (approval.decision === "deny") {
						const lease = recordInactiveLease(worker, req, access, "denied", now)
						return { result: "denied", lease, reason: `denied by auto-approval for "${req.capability}"` }
					}
					// "ask" (and the "timeout" variant) are not auto-approvals: the
					// lease is `requested`, awaiting a user decision, with no schema
					// composed.
					const lease = recordInactiveLease(worker, req, access, "requested", now)
					return { result: "pending-approval", lease }
				}
			}
		},

		releaseCapability(workerId: string, capability: ToolCapabilityId): void {
			const read = readWorkerCapabilityState(deps.taskState.get(), workerId)
			if (!read.ok) {
				// No structured state to release from; nothing to do.
				return
			}
			const worker = read.state

			// If another ACTIVE lease still holds the capability, retain its
			// schema (MCP-018 crit. 5): the release is a no-op for composition.
			const activeHolders = worker.leases.filter(
				(lease) => lease.capability === capability && lease.state === "active",
			)
			if (activeHolders.length > 1) {
				return
			}

			const released = releaseTransition(worker, capability, coreCapabilities)
			if (!released.ok) {
				// Not active (or core): nothing to release.
				return
			}

			// Mark the lease `released` and persist the ACTIVE-set delta, then
			// recompose so the schema is gone on the next generation.
			const now = Date.now()
			const nextLeases = released.state.leases.map((lease) =>
				lease.capability === capability && lease.state === "active"
					? { ...lease, state: "released" as const, releasedAt: now }
					: lease,
			)
			const next: WorkerCapabilityState = { ...released.state, leases: nextLeases }
			persistWorkerState(next)
			recompose(next)
		},

		snapshot(workerId: string): WorkerCapabilityState {
			const read = readWorkerCapabilityState(deps.taskState.get(), workerId)
			if (read.ok) {
				// Return a defensive copy so callers cannot mutate persisted state.
				return {
					workerId: read.state.workerId,
					allowed: [...read.state.allowed],
					active: [...read.state.active],
					leases: read.state.leases.map((lease) => ({ ...lease })),
				}
			}
			// No structured entry: report the core-only birth state read-only,
			// without persisting (snapshot mutates no lifecycle state).
			return initialWorkerState(workerId, "", coreCapabilities, Date.now())
		},

		resolveProvider(workerId: string, capability: ToolCapabilityId): ProviderResolution {
			const read = readWorkerCapabilityState(deps.taskState.get(), workerId)
			const lease = read.ok
				? read.state.leases.find((candidate) => candidate.capability === capability && candidate.state === "active")
				: undefined
			if (lease === undefined) {
				return { ok: false, error: { capability, providerId: "", state: "released" } }
			}
			// Reflect any remap onto the stored lease for subsequent reads.
			const resolution = resolveProviderForLease(capability, lease.state, lease.providerId)
			if (resolution.ok && read.ok && resolution.providerId !== lease.providerId) {
				const next: WorkerCapabilityState = {
					...read.state,
					leases: read.state.leases.map((candidate) =>
						candidate.capability === capability && candidate.state === "active"
							? { ...candidate, providerId: resolution.providerId }
							: candidate,
					),
				}
				persistWorkerState(next)
			}
			if (!resolution.ok) {
				return { ok: false, error: { ...resolution.error, providerId: lease.providerId ?? "" } }
			}
			return resolution
		},

		markDegraded(cause: string): boolean {
			return markDegraded(cause)
		},

		isDegraded(): boolean {
			return degraded
		},
	}
}
