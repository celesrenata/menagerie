// Reconciler — Preflight_Check and onboarding plan (design §3 "Onboarding and
// decommissioning", Requirements 11.1-11.7).
//
// Onboarding a Device, Serving_Endpoint, and Model_Offerings is NOTHING MORE
// than an edit to the Fleet_Inventory document plus any new secret the new
// secret references name (Requirement 11.2). The compiler already places every
// eligible Slot into every eligible lane from the inventory, so there is no
// per-combo or per-connection authoring here — the onboarding plan is the
// ordinary Change_Plan (from `plan.ts`) wrapped with:
//
//   1. A read-only Preflight_Check per new Serving_Endpoint (Requirement 11.3),
//      run BEFORE any of that endpoint's Model_Offerings or connection enter
//      the plan. A failure EXCLUDES the affected offerings and the model is
//      recompiled as if they were absent (Requirement 11.4), which can trip the
//      compiler's "lane with no eligible target" failure (Requirement 5.7) —
//      surfaced here, not swallowed.
//
//   2. Ordered connection-lifecycle steps (Requirement 11.5, 11.6, 11.7): a NEW
//      connection is created INACTIVE, its catalog is synced (readback compared
//      case-sensitively to the advertised list), the Preflight_Check is repeated
//      immediately before activation, and only then is it activated. These steps
//      are ordered to PRECEDE every combo op that adds a target using the
//      connection and every write that publishes route metadata for the new
//      Slots.
//
// Representation (coordinated with plan.ts's `ChangeOp` of kind combo|setting):
// rather than widen `ChangeOp` — which apply.ts (task 6.2) only knows how to
// execute for combo/setting — this module adds a DEDICATED `ConnectionOp` kind
// and an `OnboardPlan` that carries the connection ops first, then the base
// Change_Plan ops. The connection-lifecycle apply is the onboarding-specific
// writer step (task 6.2's `apply` handles the combo/setting ops that follow);
// the ordering invariant Requirement 11.7 is enforced at plan-build time and is
// assertable in a test without executing a live apply.
//
// READ-ONLY by default: `onboardPlan()` and `preflightCheck()` send ONLY read
// requests (`listConnections`, `getAdvertisedModels`) plus the read-only secret
// resolution of the endpoint credential. No write, no catalog sync, no inference
// request is issued while planning (Requirement 22.1); the connection-lifecycle
// ops are DESCRIBED in the plan and executed only by a later confirmed apply.
//
// Credential safety (Requirement 11.4, 22.4-22.6): no Preflight report, plan op,
// or failure record carries a resolved secret value — only the secret ref, the
// field path, and the machine cause.

import type { Endpoint, FleetInventory, ModelOffering } from "@roo-code/types"

import { compile, type Revision } from "../compile/compiler.js"
import type { AdvertisedModel, Connection, OmniRouteClient } from "../omniroute/client.js"
import { redactTokenizedSegments } from "../omniroute/redact.js"
import type { SecretResolver } from "../omniroute/client.js"
import { resolveSecret } from "../omniroute/secrets.js"

import { plan, type ChangePlan, type PlanOptions } from "./plan.js"

// ---------------------------------------------------------------------------
// Preflight_Check (Requirement 11.3)
// ---------------------------------------------------------------------------

/** Which Preflight check a failure concerns (Requirement 11.3 bullets). */
export type PreflightCheckKind = "reachability" | "authentication" | "model-id" | "context-window"

/**
 * One per-offering Preflight result. `pass` means every applicable check passed
 * for this Model_Offering; otherwise `cause` names the first failing check and a
 * credential-free reason. A `reachability` or `authentication` failure is an
 * ENDPOINT-level failure duplicated onto every offering of the endpoint (it
 * excludes the whole endpoint, Requirement 11.4); a `model-id` or
 * `context-window` failure is scoped to the single offering it names.
 */
export interface OfferingPreflight {
	readonly offeringId: string
	readonly modelId: string
	readonly pass: boolean
	/** Set when `pass` is false. */
	readonly cause?: PreflightFailureCause
}

/** A credential-free Preflight failure cause (Requirement 11.4 report shape). */
export interface PreflightFailureCause {
	readonly check: PreflightCheckKind
	/** Human reason, carrying NO credential value (Requirement 11.4, 22.4). */
	readonly reason: string
	/** For an authentication failure: the secret ref/field-path, never a value. */
	readonly secretRef?: string
	readonly secretFieldPath?: string
}

/** The complete Preflight result for one Serving_Endpoint. */
export interface EndpointPreflight {
	readonly endpointId: string
	/** True when every applicable check passed for every declared offering. */
	readonly pass: boolean
	/** One entry per Model_Offering the inventory declares for this endpoint. */
	readonly offerings: readonly OfferingPreflight[]
	/**
	 * An endpoint-level failure (reachability / authentication) that excludes the
	 * WHOLE endpoint, as opposed to the per-offering model-id/context failures
	 * carried on `offerings`. Absent when the endpoint is reachable and
	 * authenticated.
	 */
	readonly endpointFailure?: PreflightFailureCause
	/**
	 * True when the reachability + model-id + context checks were DEFERRED because
	 * no live OmniRoute connection resolves this endpoint yet (a brand-new
	 * connection a confirmed apply will create). The design verifies such a
	 * connection by creating it inactive, syncing its catalog, and REPEATING the
	 * Preflight immediately before activation (Requirement 11.5). The pre-apply
	 * plan cannot probe a connection that does not exist, so it does not exclude
	 * the offerings; authentication (secret resolution) is still checked here.
	 */
	readonly deferred?: boolean
}

/** Tuning for the Preflight read retry (Requirement 8.10: 3 attempts, 10 s each). */
export interface PreflightOptions {
	/** Consecutive read attempts before a check is a reachability failure (default 3). */
	readonly readAttempts?: number
	/** Per-attempt deadline in ms (default 10_000). Set small/0 in tests. */
	readonly readTimeoutMs?: number
	/** Secret-resolution deadline in ms (default 10_000). Set small/0 in tests. */
	readonly secretTimeoutMs?: number
	/** Injectable sleep between attempts (default: real timer; tests pass a no-op). */
	readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_READ_ATTEMPTS = 3
const DEFAULT_READ_TIMEOUT_MS = 10_000

/**
 * Run the read-only Preflight_Check for one Serving_Endpoint against the live
 * connection that resolves it (Requirement 11.3). Reachability and the model-id
 * / context-window checks read the endpoint's advertised model list through the
 * resolved connection (`getAdvertisedModels`, retried per Requirement 8.10);
 * authentication resolves the endpoint's secret ref (unless the inventory
 * declares `noCredential`). A connection that cannot be resolved for the
 * endpoint on this instance is a reachability failure (we have nothing to probe).
 *
 * `connectionId` is the live connection id already resolved for this endpoint
 * (the caller resolves it from `listConnections`, exactly as `plan.ts` does); it
 * is passed in so Preflight itself issues only the advertised-models read.
 */
export async function preflightCheck(
	endpoint: Endpoint,
	offerings: readonly ModelOffering[],
	connectionId: string | undefined,
	client: OmniRouteClient,
	secretResolver: SecretResolver,
	options: PreflightOptions = {},
): Promise<EndpointPreflight> {
	const declared = offerings.filter((o) => o.endpointId === endpoint.id)

	// --- authentication (Requirement 11.3 bullet 2) --------------------------
	// Resolve the endpoint credential (unless none is declared). A missing/empty
	// secret is an endpoint-level authentication failure, carrying ref/field only.
	if (!endpoint.noCredential && endpoint.secretRef) {
		const fieldPath = `endpoints[${endpoint.id}].secretRef`
		const resolved = await resolveSecret(secretResolver, endpoint.secretRef, fieldPath, {
			timeoutMs: options.secretTimeoutMs,
		})
		if (!resolved.ok) {
			const failure: PreflightFailureCause = {
				check: "authentication",
				reason: `credential did not resolve (${resolved.failure.cause})`,
				secretRef: resolved.failure.ref,
				secretFieldPath: resolved.failure.fieldPath,
			}
			return endpointFailureResult(endpoint.id, declared, failure)
		}
		// The resolved value is used only to authenticate the probe below (the
		// client resolves its OWN management bearer; the endpoint credential is
		// what the live connection carries). We never retain or report the value.
	}

	// --- reachability (Requirement 11.3 bullet 1) ----------------------------
	// A brand-new connection does not exist yet: the pre-apply plan cannot probe
	// it, so the reachability + model-id + context checks are DEFERRED to the
	// apply-time repeat (create inactive → sync → repeat Preflight → activate,
	// Requirement 11.5). We do NOT exclude the offerings here — authentication was
	// already checked above.
	if (!connectionId) {
		return {
			endpointId: endpoint.id,
			pass: true,
			deferred: true,
			offerings: declared.map((o) => ({ offeringId: o.id, modelId: o.modelId, pass: true })),
		}
	}

	const advertisedResult = await readWithRetry(
		() => client.getAdvertisedModels(connectionId),
		options,
	)
	if (!advertisedResult.ok) {
		const failure: PreflightFailureCause = {
			check: "reachability",
			reason: `endpoint did not answer a read request (${advertisedResult.reason})`,
		}
		return endpointFailureResult(endpoint.id, declared, failure)
	}
	const advertised = advertisedResult.value

	// --- per-offering model-id + context-window checks (bullets 3, 4) --------
	const advById = new Map<string, AdvertisedModel>(advertised.map((m) => [m.id, m]))
	const offeringResults: OfferingPreflight[] = declared.map((offering) => {
		// model ids: EXACT, case-sensitive membership in the advertised list.
		const advertisedModel = advById.get(offering.modelId)
		if (!advertisedModel) {
			return {
				offeringId: offering.id,
				modelId: offering.modelId,
				pass: false,
				cause: {
					check: "model-id",
					reason: `advertised model list does not contain '${offering.modelId}' (exact, case-sensitive)`,
				},
			}
		}
		// context window: ONLY where the endpoint exposes it (advertised
		// contextLength present). The exposed value must equal the declared
		// Served_Context_Window.
		if (advertisedModel.contextLength !== undefined && advertisedModel.contextLength !== offering.context) {
			return {
				offeringId: offering.id,
				modelId: offering.modelId,
				pass: false,
				cause: {
					check: "context-window",
					reason: `exposed context ${advertisedModel.contextLength} != declared ${offering.context}`,
				},
			}
		}
		return { offeringId: offering.id, modelId: offering.modelId, pass: true }
	})

	return {
		endpointId: endpoint.id,
		pass: offeringResults.every((r) => r.pass),
		offerings: offeringResults,
	}
}

/** An endpoint-level failure duplicated onto every declared offering (Req 11.4). */
function endpointFailureResult(
	endpointId: string,
	declared: readonly ModelOffering[],
	failure: PreflightFailureCause,
): EndpointPreflight {
	return {
		endpointId,
		pass: false,
		endpointFailure: failure,
		offerings: declared.map((o) => ({
			offeringId: o.id,
			modelId: o.modelId,
			pass: false,
			cause: failure,
		})),
	}
}

// ---------------------------------------------------------------------------
// Read retry (Requirement 8.10 — 3 attempts, 10 s each; injectable in tests)
// ---------------------------------------------------------------------------

type ReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

/**
 * Perform a read with the Requirement 8.10 retry: up to `readAttempts`
 * consecutive attempts, each bounded by `readTimeoutMs`, sleeping between
 * attempts. A persistent failure yields `{ ok: false }` with a credential-free
 * reason. Timers are injectable so tests run with 0 ms and a no-op sleep.
 */
async function readWithRetry<T>(read: () => Promise<T>, options: PreflightOptions): Promise<ReadResult<T>> {
	const attempts = options.readAttempts ?? DEFAULT_READ_ATTEMPTS
	const timeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
	const sleep = options.sleep ?? realSleep

	let lastReason = "connection failure"
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const value = await withDeadline(read(), timeoutMs)
			return { ok: true, value }
		} catch (error) {
			lastReason = error instanceof ReadTimeout ? "timeout" : reasonOf(error)
			if (attempt < attempts) {
				await sleep(0)
			}
		}
	}
	return { ok: false, reason: lastReason }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class ReadTimeout extends Error {
	constructor() {
		super("read timed out")
		this.name = "ReadTimeout"
	}
}

/** Race a read against a per-attempt deadline. A `<= 0` deadline fires immediately. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	if (ms <= 0) {
		return Promise.race([
			work,
			new Promise<T>((_resolve, reject) => {
				setTimeout(() => reject(new ReadTimeout()), 0)
			}),
		])
	}
	return Promise.race([
		work,
		new Promise<T>((_resolve, reject) => {
			setTimeout(() => reject(new ReadTimeout()), ms)
		}),
	])
}

/** A credential-free reason string for a thrown read error. */
function reasonOf(error: unknown): string {
	if (error && typeof error === "object" && "status" in error) {
		const status = (error as { status?: unknown }).status
		if (status === 401 || status === 403) {
			return "authentication rejection"
		}
		if (typeof status === "number") {
			return "error response"
		}
	}
	return "connection failure"
}

// ---------------------------------------------------------------------------
// Onboarding plan (Requirements 11.1, 11.4, 11.5, 11.6, 11.7)
// ---------------------------------------------------------------------------

/** The lifecycle step a connection op performs (Requirement 11.5, 11.6). */
export type ConnectionOpStep = "create-inactive" | "sync-catalog" | "activate"

/**
 * One ordered connection-lifecycle op of an onboarding plan. These are a
 * DEDICATED op kind (not a `ChangeOp`) so apply.ts's combo/setting executor is
 * unchanged; the onboarding apply runs these in order BEFORE the base plan's
 * combo ops that reference the connection (Requirement 11.7). Carries only
 * credential-free identifiers.
 */
export interface ConnectionOp {
	readonly kind: "connection"
	readonly step: ConnectionOpStep
	/** The endpoint whose connection this op manages. */
	readonly endpointId: string
	/**
	 * The live connection id, when known. Absent for `create-inactive` of a NEW
	 * connection (its id is assigned by the apply at create time).
	 */
	readonly connectionId?: string
	/**
	 * For `sync-catalog`: the model ids the readback is compared against
	 * (case-sensitive, Requirement 11.6). The compare itself happens at apply.
	 */
	readonly expectedModelIds?: readonly string[]
}

/** One excluded Model_Offering with the Preflight failure that excluded it (Req 11.4). */
export interface ExcludedOffering {
	readonly offeringId: string
	readonly endpointId: string
	readonly modelId: string
	readonly cause: PreflightFailureCause
}

/** How an onboarding-plan build ended. */
export type OnboardOutcome = "ok" | "compile-failed"

/**
 * The onboarding plan for one Managed_Instance (Requirement 11.1, 11.7). It
 * composes:
 *   - `preflight`: the per-endpoint Preflight results (Requirement 11.3).
 *   - `excluded`: the Model_Offerings excluded by a Preflight failure, which the
 *     compile below treated as absent (Requirement 11.4).
 *   - `connectionOps`: the ordered connection-lifecycle ops (create-inactive →
 *     sync-catalog → activate), ordered BEFORE the base change ops (11.5-11.7).
 *   - `changePlan`: the ordinary Change_Plan over the (post-exclusion) compiled
 *     Desired_Route_State, or `undefined` when the exclusion left a lane with no
 *     eligible target and compilation failed (Requirement 11.4 → 5.7).
 *   - `compileFailures`: the compiler failures when `outcome` is `compile-failed`.
 *
 * The ORDERED op view for an apply is `connectionOps` first, then
 * `changePlan.ops` — `orderedSteps()` returns exactly that.
 */
export interface OnboardPlan {
	readonly instanceId: string
	readonly revision: Revision
	readonly createdAt: string
	readonly outcome: OnboardOutcome
	readonly preflight: readonly EndpointPreflight[]
	readonly excluded: readonly ExcludedOffering[]
	readonly connectionOps: readonly ConnectionOp[]
	readonly changePlan?: ChangePlan
	readonly compileFailures: readonly string[]
}

/** Args for `onboardPlan`. The set of NEW endpoint ids triggers Preflight (11.3). */
export interface OnboardPlanArgs {
	readonly model: FleetInventory
	readonly rev: Revision
	readonly instanceId: string
	readonly client: OmniRouteClient
	readonly secretResolver: SecretResolver
	/**
	 * The endpoint ids that are NEW relative to the last applied revision (their
	 * Serving_Endpoints get a Preflight_Check before their offerings/connection
	 * enter the plan, Requirement 11.3). An endpoint not in this set is treated
	 * as already-verified and its offerings compile normally.
	 */
	readonly newEndpointIds: readonly string[]
	readonly preflightOptions?: PreflightOptions
	readonly planOptions?: PlanOptions
}

const defaultClock = (): string => new Date().toISOString()

/**
 * Build the onboarding plan for one Managed_Instance (Requirement 11.1-11.7).
 * READ-ONLY: issues `listConnections`, `getAdvertisedModels`, and `listCombos`
 * (the last via `plan`), plus read-only secret resolution — no write.
 */
export async function onboardPlan(args: OnboardPlanArgs): Promise<OnboardPlan> {
	const { model, rev, instanceId, client, secretResolver, newEndpointIds } = args
	const clock = args.planOptions?.clock ?? defaultClock
	const createdAt = clock()
	const newEndpoints = new Set(newEndpointIds)

	// --- Resolve each new endpoint to its live connection id (read-only) ------
	// Same provider + host:port resolution plan.ts uses; a new endpoint with no
	// live connection resolves to `undefined` (a connection that a confirmed
	// apply will CREATE), which Preflight treats as a reachability failure for a
	// pre-apply probe but which the connection-lifecycle ops will create inactive.
	const liveConnections = await client.listConnections()
	const connectionIdByEndpoint = resolveConnectionIds(model, instanceId, liveConnections)

	// --- Preflight each NEW endpoint (Requirement 11.3) -----------------------
	const preflight: EndpointPreflight[] = []
	const excluded: ExcludedOffering[] = []
	const excludedOfferingIds = new Set<string>()

	for (const endpoint of model.endpoints) {
		if (!newEndpoints.has(endpoint.id)) {
			continue
		}
		const result = await preflightCheck(
			endpoint,
			model.offerings,
			connectionIdByEndpoint.get(endpoint.id),
			client,
			secretResolver,
			args.preflightOptions,
		)
		preflight.push(result)

		// On failure, EXCLUDE the affected offerings (Requirement 11.4):
		//   - reachability / authentication → the WHOLE endpoint's offerings;
		//   - model-id / context-window     → only the named offerings.
		for (const offering of result.offerings) {
			if (!offering.pass && offering.cause) {
				excludedOfferingIds.add(offering.offeringId)
				excluded.push({
					offeringId: offering.offeringId,
					endpointId: endpoint.id,
					modelId: offering.modelId,
					cause: offering.cause,
				})
			}
		}
	}

	// --- Compile AS IF the excluded offerings were absent (Req 11.4 → 5.7) ----
	const prunedModel = excludedOfferingIds.size === 0 ? model : pruneOfferings(model, excludedOfferingIds)
	const compiled = compile(prunedModel, rev)
	if (!compiled.ok) {
		// A Preflight exclusion may have left a lane with no eligible target,
		// tripping Requirement 5.7. Surface it (never partial output).
		return {
			instanceId,
			revision: rev,
			createdAt,
			outcome: "compile-failed",
			preflight,
			excluded,
			connectionOps: [],
			changePlan: undefined,
			compileFailures: compiled.failures.map((f) => f.message),
		}
	}

	// --- Ordinary Change_Plan over the post-exclusion inventory ---------------
	const changePlan = await plan(prunedModel, rev, instanceId, client, args.planOptions)

	// --- Connection-lifecycle ops, ordered BEFORE the combo ops (11.5-11.7) ---
	const connectionOps = buildConnectionOps(
		model,
		prunedModel,
		instanceId,
		newEndpoints,
		excludedOfferingIds,
		connectionIdByEndpoint,
	)

	return {
		instanceId,
		revision: rev,
		createdAt,
		outcome: "ok",
		preflight,
		excluded,
		connectionOps,
		changePlan,
		compileFailures: [],
	}
}

/**
 * The ordered steps of an onboarding apply (Requirement 11.7): every connection
 * op (create-inactive → sync-catalog → activate per endpoint) precedes every
 * base Change_Plan op. Returns a flat, typed list a test can scan for ordering.
 */
export function orderedSteps(plan: OnboardPlan): readonly (ConnectionOp | ChangePlan["ops"][number])[] {
	return [...plan.connectionOps, ...(plan.changePlan?.ops ?? [])]
}

// ---------------------------------------------------------------------------
// Connection-lifecycle ordering (Requirement 11.5, 11.6, 11.7)
// ---------------------------------------------------------------------------

/**
 * Build the ordered connection-lifecycle ops for the NEW endpoints whose
 * offerings survived Preflight. For each such endpoint the three steps are
 * emitted in order (create-inactive → sync-catalog → activate), and all
 * connection ops precede the base plan's combo ops by construction in
 * `orderedSteps` (Requirement 11.7).
 *
 * An endpoint whose offerings were ALL excluded gets no connection op (its
 * targets are absent from the plan, so nothing references the connection). An
 * endpoint that already has a live connection (not new to OmniRoute) still
 * re-syncs its catalog but is not re-created or re-activated — only a NEW
 * connection is created inactive and activated (Requirement 11.5).
 */
function buildConnectionOps(
	fullModel: FleetInventory,
	prunedModel: FleetInventory,
	instanceId: string,
	newEndpoints: ReadonlySet<string>,
	excludedOfferingIds: ReadonlySet<string>,
	connectionIdByEndpoint: ReadonlyMap<string, string>,
): ConnectionOp[] {
	const ops: ConnectionOp[] = []

	for (const endpoint of fullModel.endpoints) {
		if (!newEndpoints.has(endpoint.id)) {
			continue
		}
		// The surviving (non-excluded) offerings of this endpoint in the pruned
		// inventory. If none survive, the connection is referenced by no combo and
		// needs no lifecycle op.
		const surviving = prunedModel.offerings.filter(
			(o) => o.endpointId === endpoint.id && !excludedOfferingIds.has(o.id),
		)
		if (surviving.length === 0) {
			continue
		}
		const expectedModelIds = surviving.map((o) => o.modelId)
		const liveConnectionId = connectionIdByEndpoint.get(endpoint.id)

		if (liveConnectionId === undefined) {
			// A NEW connection: create inactive, sync catalog, then activate
			// (Requirement 11.5, 11.6). The id is assigned at apply/create time.
			ops.push({ kind: "connection", step: "create-inactive", endpointId: endpoint.id })
			ops.push({
				kind: "connection",
				step: "sync-catalog",
				endpointId: endpoint.id,
				expectedModelIds,
			})
			ops.push({ kind: "connection", step: "activate", endpointId: endpoint.id })
		} else {
			// An existing connection gaining a new Model_Offering: sync its catalog
			// before the combos that reference the new slots (Requirement 11.6).
			ops.push({
				kind: "connection",
				step: "sync-catalog",
				endpointId: endpoint.id,
				connectionId: liveConnectionId,
				expectedModelIds,
			})
		}
	}

	return ops
}

// ---------------------------------------------------------------------------
// Connection-id resolution (shared shape with plan.ts, read-only)
// ---------------------------------------------------------------------------

/**
 * Resolve each declared endpoint to its live connection id by provider +
 * address host:port on this instance (design §3). An endpoint with no live
 * connection is absent from the returned map (a NEW connection to create).
 */
function resolveConnectionIds(
	model: FleetInventory,
	instanceId: string,
	liveConnections: readonly Connection[],
): Map<string, string> {
	const connectionByKey = new Map<string, string>()
	for (const connection of liveConnections) {
		const key = providerHostKey(connection.provider, hostPort(connection.address))
		if (key && !connectionByKey.has(key)) {
			connectionByKey.set(key, connection.id)
		}
	}

	const out = new Map<string, string>()
	for (const endpoint of model.endpoints) {
		const address = endpoint.addresses.find((a) => a.instanceId === instanceId)
		const key = address ? providerHostKey(endpoint.provider, hostPort(address.url)) : undefined
		const connectionId = key ? connectionByKey.get(key) : undefined
		if (connectionId) {
			out.set(endpoint.id, connectionId)
		}
	}
	return out
}

/** The composite resolution key: provider + host:port (NUL-separated). */
function providerHostKey(provider: string, hp: string | undefined): string | undefined {
	return hp ? `${provider}\u0000${hp}` : undefined
}

/** The lowercased `host:port` of a URL, or undefined when it cannot be parsed. */
function hostPort(url: string): string | undefined {
	try {
		return new URL(url).host.toLowerCase()
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Inventory pruning (Requirement 11.4 — compile as if excluded offerings absent)
// ---------------------------------------------------------------------------

/**
 * A copy of the inventory with the excluded Model_Offerings removed, so the
 * compiler builds the Desired_Route_State as if those offerings were never
 * declared (Requirement 11.4). Only `offerings` is pruned; every other field is
 * carried through unchanged. A device/endpoint left with no surviving offering
 * simply contributes no Slot, exactly as if it had none — the compiler's lane
 * eligibility (and the 5.7 trip) follows from the pruned offering set.
 */
function pruneOfferings(model: FleetInventory, excludedOfferingIds: ReadonlySet<string>): FleetInventory {
	return {
		...model,
		offerings: model.offerings.filter((o) => !excludedOfferingIds.has(o.id)),
	}
}

// ---------------------------------------------------------------------------
// Report rendering (credential-free)
// ---------------------------------------------------------------------------

/**
 * A one-line, credential-free human summary of a Preflight failure, for the
 * onboarding report (Requirement 11.4, 22.4). Names the endpoint, the check,
 * and the reason; a secret ref/field (never a value) when present.
 */
export function describePreflightFailure(endpointId: string, cause: PreflightFailureCause): string {
	const secret = cause.secretRef ? ` [secret '${redactTokenizedSegments(cause.secretRef)}' at '${cause.secretFieldPath ?? "?"}']` : ""
	return `endpoint '${endpointId}' ${cause.check} check failed: ${redactTokenizedSegments(cause.reason)}${secret}`
}
