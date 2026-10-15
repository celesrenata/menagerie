// Fleet_Observer — attempt attribution (design §4 "Attribution and recording",
// Requirements 17.1, 17.2, 17.5, 17.6).
//
// This is a PURE module. Given one recorded attempt, the Reconciler's audit
// history, and a way to read the Fleet_Inventory_Revision that version-control
// holds for a commit, it attributes the attempt to a stable
// Device/Model_Offering or Cloud_Target, a Public_Route, a Lane_Definition, and
// a Capability_Lane. It performs no I/O, holds no clock, and reads no live
// OmniRoute state: the inputs are the attempt, the audit entries, and an
// injected revision reader. That keeps attribution deterministic and
// reproducible (Requirement 17.6, the attribution-stability property).
//
// Attribution anchors on the Fleet_Inventory_Revision LIVE at the attempt's
// START time (completion time minus end-to-end latency), resolved from the
// Reconciler's audit history (Requirement 17.5, 17.1). Because the compiler
// derives Target_Identifiers from identity alone (compile/targets.ts), the same
// Target_Identifier always maps to the same Device/Model_Offering or
// Cloud_Target across route regenerations (Requirement 17.6). Any attribute the
// observer cannot determine is marked `unattributed` and surfaced, never
// silently dropped (Requirement 17.5).

import type { CloudTarget, FleetInventory, Lane, ModelOffering } from "@roo-code/types"

import { compile, type DesiredRouteState, type Revision } from "../compile/compiler.js"
import { cloudTargetId, offeringSlots, slotTargetId } from "../compile/targets.js"

// ---------------------------------------------------------------------------
// Reconciler audit history (consumed input; produced by task 6.2)
// ---------------------------------------------------------------------------

/** The outcome recorded for one apply/rollback (Requirement 9, 17.1). */
export type AuditOutcome = "succeeded" | "no-changes" | "failed" | "aborted"

/**
 * One Reconciler audit entry for an apply or rollback on one OmniRoute_Instance
 * (Requirement 9). The Fleet_Observer reads these to decide which
 * Fleet_Inventory_Revision was live at an attempt's start (Requirement 17.1,
 * 17.5). This interface is defined here and consumed read-only; the real audit
 * log is written by the Reconciler apply/rollback path (task 6.2).
 *
 *   - `apply`:    makes `revision` live from `endedAt` when the outcome is
 *                 `succeeded` or `no-changes`; no other outcome changes it.
 *   - `rollback`: makes the revision that was live when the rolled-back apply
 *                 STARTED live again from `endedAt`, when the outcome is
 *                 `succeeded` or `no-changes`. `rolledBackApplyStartedAt`
 *                 identifies that apply's start time.
 */
export interface ReconcilerAuditEntry {
	readonly kind: "apply" | "rollback"
	readonly instanceId: string
	readonly outcome: AuditOutcome
	/** The Fleet_Inventory_Revision this apply published (ignored for a rollback). */
	readonly revision: Revision
	/** ISO-8601 UTC time the operation started. */
	readonly startedAt: string
	/** ISO-8601 UTC time the operation ended (when it became live). */
	readonly endedAt: string
	/**
	 * For a `rollback`: the start time of the apply being rolled back. The
	 * revision live when that apply started becomes live again. Ignored for an
	 * `apply`.
	 */
	readonly rolledBackApplyStartedAt?: string
}

/**
 * Reads the Fleet_Inventory_Revision that version-control holds for a commit id
 * and compiles it for one OmniRoute_Instance (Requirement 17.5, 17.6). Injected
 * so attribution stays pure and testable: a test supplies a stub, production
 * supplies a reader backed by `git show`/the Route_Compiler. Returns
 * `undefined` when the revision cannot be read from version control
 * (Requirement 17.5 "a revision the attribution needs cannot be read").
 */
export interface RevisionResolver {
	resolve(commit: string): FleetInventory | undefined
}

// ---------------------------------------------------------------------------
// Attribution input / output
// ---------------------------------------------------------------------------

/**
 * The body-free view of one recorded attempt that attribution needs. These are
 * exactly the fields the observer copies and reads (Requirement 16.12); no body
 * or credential is present.
 */
export interface AttributionInput {
	/** The recording OmniRoute_Instance id. */
	readonly instanceId: string
	/** Completion time, ISO-8601 UTC. */
	readonly completedAt: string
	/** End-to-end latency in whole milliseconds (admission wait + upstream). */
	readonly endToEndMs: number
	/** The recorded Target_Identifier of the combo target, when the attempt had one. */
	readonly targetId?: string
	/** The OmniRoute connection the attempt dispatched to or waited for. */
	readonly connectionId?: string
	/** The upstream (provider) model id the attempt dispatched to or waited for. */
	readonly upstreamModelId?: string
	/** The requested model id the client named (a Public_Route, alias, or other). */
	readonly requestedModelId?: string
	/** The Capability_Lane name recorded with the attempt (`session_tag`), if any. */
	readonly capabilityLaneName?: string
	/** True for a Health_Probe (attributed only to a Serving_Endpoint). */
	readonly isHealthProbe?: boolean
}

/** The visible marker for an attribute the observer could not determine. */
export const UNATTRIBUTED = "unattributed" as const
export type Unattributed = typeof UNATTRIBUTED

/** Why one or more attributes were left unattributed (Requirement 17.5). */
export type UnattributedReason =
	| "no-active-revision"
	| "revision-unreadable"
	| "unmapped-target"
	| "ambiguous-device"
	| "unknown-capability-lane"

/**
 * The attribution of one attempt. Each identity field is either a resolved
 * value or `UNATTRIBUTED` (Requirement 17.5 — undetermined attributes are marked
 * and surfaced, never dropped). `reasons` records every reason an attribute was
 * left unattributed, for the per-reason report (Requirement 17.5 last bullet).
 */
export interface Attribution {
	readonly instanceId: string
	/** The Fleet_Inventory_Revision live at the attempt's start, or UNATTRIBUTED. */
	readonly activeRevision: string | Unattributed
	/** Device id, UNATTRIBUTED, or null (a Cloud_Target / not-dispatched attempt). */
	readonly deviceId: string | Unattributed | null
	/** Model_Offering id, UNATTRIBUTED, or null. */
	readonly modelOfferingId: string | Unattributed | null
	/** Serving_Endpoint id (set for a Health_Probe or ambiguous device), or null. */
	readonly servingEndpointId: string | null
	/** Cloud_Target id, UNATTRIBUTED, or null (a local / not-dispatched attempt). */
	readonly cloudTargetId: string | Unattributed | null
	/** Public_Route name, or null when the requested model id names no Public_Route. */
	readonly publicRoute: string | null
	/** Lane_Definition id, or null when there is no Public_Route. */
	readonly laneId: string | null
	/** Capability_Lane name, UNATTRIBUTED (unknown name), or null (none recorded). */
	readonly capabilityLane: string | Unattributed | null
	/** Whether any attribute was left unattributed. */
	readonly isUnattributed: boolean
	/** The distinct reasons attributes were left unattributed. */
	readonly reasons: readonly UnattributedReason[]
}

// ---------------------------------------------------------------------------
// Active-revision resolution from the audit history (Requirement 17.1, 17.5)
// ---------------------------------------------------------------------------

/** The attempt's start time in epoch ms: completion time minus end-to-end latency. */
export function attemptStartMs(input: AttributionInput): number {
	return Date.parse(input.completedAt) - input.endToEndMs
}

/**
 * The Fleet_Inventory_Revision commit live on `instanceId` at `startMs`,
 * resolved from the Reconciler audit history (Requirement 17.1):
 *
 *   - a successful (or no-changes) APPLY makes its revision live from its end;
 *   - a successful (or no-changes) ROLLBACK makes the revision that was live
 *     when the rolled-back apply started live again from its end;
 *   - no other outcome changes the live revision.
 *
 * The live revision at `startMs` is the one established by the most recent such
 * entry whose end time is at or before `startMs`. Returns `undefined` when no
 * revision was live yet (Requirement 17.5 "no Fleet_Inventory_Revision was live
 * ... at the attempt's start time").
 */
export function liveRevisionAt(
	audit: readonly ReconcilerAuditEntry[],
	instanceId: string,
	startMs: number,
): string | undefined {
	// Entries for this instance that had taken effect at or before startMs,
	// ordered by effect (end) time, then processed to track the live revision.
	const effective = audit
		.filter((e) => e.instanceId === instanceId && isLiveChanging(e) && Date.parse(e.endedAt) <= startMs)
		.slice()
		.sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))

	let live: string | undefined
	for (const entry of effective) {
		if (entry.kind === "apply") {
			live = entry.revision.commit
			continue
		}
		// A rollback restores the revision live when the rolled-back apply
		// started — i.e. the revision an earlier effective apply established
		// before `rolledBackApplyStartedAt`.
		live = revisionLiveBefore(effective, entry)
	}
	return live
}

/** An entry changes the live revision only on a `succeeded`/`no-changes` outcome. */
function isLiveChanging(entry: ReconcilerAuditEntry): boolean {
	return entry.outcome === "succeeded" || entry.outcome === "no-changes"
}

/**
 * The revision that was live when the apply identified by `rollback`'s
 * `rolledBackApplyStartedAt` STARTED: the last applied revision whose own apply
 * took effect strictly before that start time. `undefined` when nothing was
 * live then (the rollback restores "no revision").
 */
function revisionLiveBefore(
	effective: readonly ReconcilerAuditEntry[],
	rollback: ReconcilerAuditEntry,
): string | undefined {
	const applyStart = rollback.rolledBackApplyStartedAt
	if (applyStart === undefined) {
		return undefined
	}
	const applyStartMs = Date.parse(applyStart)
	let live: string | undefined
	for (const entry of effective) {
		if (entry.kind !== "apply") {
			continue
		}
		if (Date.parse(entry.endedAt) < applyStartMs) {
			live = entry.revision.commit
		}
	}
	return live
}

// ---------------------------------------------------------------------------
// Target index built from a compiled Desired_Route_State (Requirement 17.6)
// ---------------------------------------------------------------------------

/**
 * A resolved local target: the Device and Model_Offering a Slot's
 * Target_Identifier represents. Carries the Serving_Endpoint for Health_Probe
 * and ambiguous-device attribution (Requirement 17.1).
 */
interface LocalTargetIdentity {
	readonly deviceId: string
	readonly modelOfferingId: string
	readonly endpointId: string
}

/**
 * The identity lookups attribution needs for one active revision + instance.
 * Built once per revision; cached by the attributor so a window of attempts
 * sharing a revision reuses it (Requirement 16 performance, 17.6 stability).
 */
interface RevisionIndex {
	readonly inventory: FleetInventory
	/** Target_Identifier → local Device/Model_Offering (Slot targets). */
	readonly localByTargetId: ReadonlyMap<string, LocalTargetIdentity>
	/** Target_Identifier → Cloud_Target id (cloud targets). */
	readonly cloudByTargetId: ReadonlyMap<string, string>
	/** `connectionId|upstreamModelId` → the local offerings it could be (fallback). */
	readonly offeringsByConnModel: ReadonlyMap<string, readonly LocalTargetIdentity[]>
	/** `provider|modelId` → Cloud_Target id (fallback for a cloud attempt). */
	readonly cloudByProviderModel: ReadonlyMap<string, string>
	/** Requested model id → the Lane it names as a Public_Route or alias. */
	readonly laneByRouteName: ReadonlyMap<string, Lane>
	/** The Public_Route (own) name of each lane. */
	readonly publicNameByLaneId: ReadonlyMap<string, string>
}

/**
 * Build the identity lookups from the inventory of one revision. The local
 * Target_Identifier index comes from enumerating every offering's slots with the
 * SAME scheme the compiler uses (`slotTargetId`/`cloudTargetId`), so a recorded
 * Target_Identifier resolves identically to how it was compiled (Requirement
 * 17.6). The route-name index comes from the lanes (name[0] is the Public_Route,
 * the rest are Route_Aliases, Requirement 17.1 "matched exactly including case").
 */
function buildRevisionIndex(inventory: FleetInventory): RevisionIndex {
	const localByTargetId = new Map<string, LocalTargetIdentity>()
	const offeringsByConnModel = new Map<string, LocalTargetIdentity[]>()

	// `connectionId` is a live OmniRoute UUID the inventory does not know; the
	// stable fallback key is the Serving_Endpoint id + upstream model id, which
	// is what a recorded connection resolves to. The copy stores the endpoint-
	// derived connection, so the fallback index is keyed by endpointId|modelId
	// AND by provider|modelId to tolerate either recording.
	for (const offering of inventory.offerings) {
		const identity: LocalTargetIdentity = {
			deviceId: offering.deviceId,
			modelOfferingId: offering.id,
			endpointId: offering.endpointId,
		}
		for (const slot of offeringSlots(offering)) {
			localByTargetId.set(slotTargetId(slot), identity)
		}
		addToList(offeringsByConnModel, connModelKey(offering.endpointId, offering.modelId), identity)
		const provider = providerOfEndpoint(inventory, offering.endpointId)
		if (provider !== undefined) {
			addToList(offeringsByConnModel, connModelKey(provider, offering.modelId), identity)
		}
	}

	const cloudByTargetId = new Map<string, string>()
	const cloudByProviderModel = new Map<string, string>()
	for (const cloud of inventory.clouds) {
		cloudByTargetId.set(cloudTargetId(cloud), cloud.id)
		cloudByProviderModel.set(connModelKey(cloud.provider, cloud.modelId), cloud.id)
	}

	const laneByRouteName = new Map<string, Lane>()
	const publicNameByLaneId = new Map<string, string>()
	for (const lane of inventory.lanes) {
		publicNameByLaneId.set(lane.id, lane.names[0]!)
		for (const name of lane.names) {
			laneByRouteName.set(name, lane)
		}
	}

	return {
		inventory,
		localByTargetId,
		cloudByTargetId,
		offeringsByConnModel,
		cloudByProviderModel,
		laneByRouteName,
		publicNameByLaneId,
	}
}

function providerOfEndpoint(inventory: FleetInventory, endpointId: string): string | undefined {
	return inventory.endpoints.find((e) => e.id === endpointId)?.provider
}

function connModelKey(connOrProvider: string, modelId: string): string {
	return `${connOrProvider}|${modelId}`
}

function addToList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key)
	if (list) {
		list.push(value)
	} else {
		map.set(key, [value])
	}
}

// ---------------------------------------------------------------------------
// Attributor
// ---------------------------------------------------------------------------

/** The four Capability_Lane names the inventory may record (Requirement 17.4, 17.5). */
const KNOWN_CAPABILITY_LANES = new Set<string>([
	"reader.fast",
	"reader.deep",
	"coder.primary",
	"reasoning.escalation",
])

/**
 * Attributes recorded attempts to stable identities using the revision live at
 * each attempt's start (Requirement 17.1, 17.5, 17.6). Construct once with the
 * audit history and a `RevisionResolver`; it caches a `RevisionIndex` per
 * commit so a window of attempts sharing one revision pays the compile/index
 * cost once. Compiling the revision is used as a well-formedness check — the
 * identity lookups are built straight from the inventory so they match the
 * compiler's Target_Identifier scheme (Requirement 17.6).
 */
export class Attributor {
	private readonly audit: readonly ReconcilerAuditEntry[]
	private readonly resolver: RevisionResolver
	private readonly indexCache = new Map<string, RevisionIndex | null>()

	constructor(audit: readonly ReconcilerAuditEntry[], resolver: RevisionResolver) {
		this.audit = audit
		this.resolver = resolver
	}

	/** Attribute one recorded attempt (Requirement 17.1, 17.2, 17.5). */
	attribute(input: AttributionInput): Attribution {
		const reasons = new Set<UnattributedReason>()
		const startMs = attemptStartMs(input)
		const commit = liveRevisionAt(this.audit, input.instanceId, startMs)

		if (commit === undefined) {
			reasons.add("no-active-revision")
			return unattributedAttribution(input, UNATTRIBUTED, reasons)
		}

		const index = this.indexFor(commit)
		if (index === null) {
			reasons.add("revision-unreadable")
			return unattributedAttribution(input, UNATTRIBUTED, reasons)
		}

		// Route / lane / capability-lane depend only on recorded names + the
		// revision, independent of the target identity (Requirement 17.1).
		const lane = resolveLane(input, index)
		const publicRoute = lane ? index.publicNameByLaneId.get(lane.id)! : null
		const laneId = lane ? lane.id : null
		const capabilityLane = resolveCapabilityLane(input, reasons)

		// A Health_Probe is attributed only to a Serving_Endpoint (Requirement 17.1).
		if (input.isHealthProbe) {
			const endpointId = resolveProbeEndpoint(input, index)
			if (endpointId === undefined) {
				reasons.add("unmapped-target")
			}
			return {
				instanceId: input.instanceId,
				activeRevision: commit,
				deviceId: null,
				modelOfferingId: null,
				servingEndpointId: endpointId ?? null,
				cloudTargetId: null,
				publicRoute,
				laneId,
				capabilityLane,
				isUnattributed: reasons.size > 0,
				reasons: [...reasons],
			}
		}

		const identity = resolveTargetIdentity(input, index, reasons)
		return {
			instanceId: input.instanceId,
			activeRevision: commit,
			deviceId: identity.deviceId,
			modelOfferingId: identity.modelOfferingId,
			servingEndpointId: identity.servingEndpointId,
			cloudTargetId: identity.cloudTargetId,
			publicRoute,
			laneId,
			capabilityLane,
			isUnattributed: reasons.size > 0,
			reasons: [...reasons],
		}
	}

	private indexFor(commit: string): RevisionIndex | null {
		const cached = this.indexCache.get(commit)
		if (cached !== undefined) {
			return cached
		}
		const inventory = this.resolver.resolve(commit)
		if (inventory === undefined) {
			this.indexCache.set(commit, null)
			return null
		}
		// Compile as a well-formedness gate (Requirement 5): a revision that
		// fails to compile cannot have produced the routes an attempt references.
		// The identity lookups still come from the inventory directly.
		const compiled = compile(inventory, inventoryRevision(commit))
		if (!compiled.ok) {
			this.indexCache.set(commit, null)
			return null
		}
		const index = buildRevisionIndex(inventory)
		this.indexCache.set(commit, index)
		return index
	}
}

/** A `Revision` for a bare commit id (committed, never dirty — read from VCS). */
function inventoryRevision(commit: string): Revision {
	return { commit, uncommitted: false }
}

// ---------------------------------------------------------------------------
// Per-attribute resolution
// ---------------------------------------------------------------------------

interface TargetIdentityResult {
	readonly deviceId: string | Unattributed | null
	readonly modelOfferingId: string | Unattributed | null
	readonly servingEndpointId: string | null
	readonly cloudTargetId: string | Unattributed | null
}

/**
 * Device/Model_Offering or Cloud_Target of the attempt (Requirement 17.1, 17.2,
 * 17.5):
 *   - a recorded Target_Identifier resolves directly in the compiled revision;
 *   - without one, the OmniRoute connection + upstream model id map to a local
 *     offering or a Cloud_Target;
 *   - a connection+model that maps to offerings on more than one Device yields
 *     the Serving_Endpoint but no Device (Requirement 17.1, ambiguous-device);
 *   - a not-dispatched attempt with neither a Target_Identifier nor a connection
 *     has no Device, Model_Offering, or Cloud_Target (all null);
 *   - anything that cannot be mapped is marked UNATTRIBUTED (Requirement 17.5).
 */
function resolveTargetIdentity(
	input: AttributionInput,
	index: RevisionIndex,
	reasons: Set<UnattributedReason>,
): TargetIdentityResult {
	if (input.targetId !== undefined) {
		const local = index.localByTargetId.get(input.targetId)
		if (local) {
			return {
				deviceId: local.deviceId,
				modelOfferingId: local.modelOfferingId,
				servingEndpointId: null,
				cloudTargetId: null,
			}
		}
		const cloud = index.cloudByTargetId.get(input.targetId)
		if (cloud !== undefined) {
			return { deviceId: null, modelOfferingId: null, servingEndpointId: null, cloudTargetId: cloud }
		}
		reasons.add("unmapped-target")
		return {
			deviceId: UNATTRIBUTED,
			modelOfferingId: UNATTRIBUTED,
			servingEndpointId: null,
			cloudTargetId: UNATTRIBUTED,
		}
	}

	// No Target_Identifier: fall back to connection + upstream model id.
	if (input.connectionId === undefined && input.upstreamModelId === undefined) {
		// Not dispatched, nothing to map: no Device/Model_Offering/Cloud_Target.
		return { deviceId: null, modelOfferingId: null, servingEndpointId: null, cloudTargetId: null }
	}

	const key = connModelKey(input.connectionId ?? "", input.upstreamModelId ?? "")
	const locals = index.offeringsByConnModel.get(key)
	if (locals && locals.length > 0) {
		const devices = new Set(locals.map((l) => l.deviceId))
		if (devices.size > 1) {
			// Ambiguous device: Serving_Endpoint only (Requirement 17.1, 17.5).
			reasons.add("ambiguous-device")
			return {
				deviceId: UNATTRIBUTED,
				modelOfferingId: UNATTRIBUTED,
				servingEndpointId: locals[0]!.endpointId,
				cloudTargetId: null,
			}
		}
		const only = locals[0]!
		return {
			deviceId: only.deviceId,
			modelOfferingId: only.modelOfferingId,
			servingEndpointId: only.endpointId,
			cloudTargetId: null,
		}
	}

	const cloud = index.cloudByProviderModel.get(key)
	if (cloud !== undefined) {
		return { deviceId: null, modelOfferingId: null, servingEndpointId: null, cloudTargetId: cloud }
	}

	reasons.add("unmapped-target")
	return {
		deviceId: UNATTRIBUTED,
		modelOfferingId: UNATTRIBUTED,
		servingEndpointId: null,
		cloudTargetId: UNATTRIBUTED,
	}
}

/** The Lane a requested model id names as a Public_Route or Route_Alias, else null. */
function resolveLane(input: AttributionInput, index: RevisionIndex): Lane | null {
	if (input.requestedModelId === undefined) {
		return null
	}
	return index.laneByRouteName.get(input.requestedModelId) ?? null
}

/** The Serving_Endpoint of a Health_Probe's connection + model, else undefined. */
function resolveProbeEndpoint(input: AttributionInput, index: RevisionIndex): string | undefined {
	const key = connModelKey(input.connectionId ?? "", input.upstreamModelId ?? "")
	const locals = index.offeringsByConnModel.get(key)
	if (locals && locals.length > 0) {
		return locals[0]!.endpointId
	}
	return undefined
}

/** The Capability_Lane name, UNATTRIBUTED when unknown, null when none recorded. */
function resolveCapabilityLane(
	input: AttributionInput,
	reasons: Set<UnattributedReason>,
): string | Unattributed | null {
	const name = input.capabilityLaneName
	if (name === undefined) {
		return null
	}
	if (KNOWN_CAPABILITY_LANES.has(name)) {
		return name
	}
	reasons.add("unknown-capability-lane")
	return UNATTRIBUTED
}

/**
 * The attribution for an attempt with no usable active revision: every identity
 * attribute is marked UNATTRIBUTED (so it is visible, Requirement 17.5), while
 * route/lane/capability-lane are left null because no revision maps them.
 */
function unattributedAttribution(
	input: AttributionInput,
	activeRevision: Unattributed,
	reasons: Set<UnattributedReason>,
): Attribution {
	return {
		instanceId: input.instanceId,
		activeRevision,
		deviceId: UNATTRIBUTED,
		modelOfferingId: UNATTRIBUTED,
		servingEndpointId: null,
		cloudTargetId: UNATTRIBUTED,
		publicRoute: null,
		laneId: null,
		capabilityLane: input.capabilityLaneName === undefined ? null : UNATTRIBUTED,
		isUnattributed: true,
		reasons: [...reasons],
	}
}

// Re-exported so callers that already import this module can reach the compiled
// state type without a second import when they pair attribution with a plan.
export type { DesiredRouteState, ModelOffering, CloudTarget }
