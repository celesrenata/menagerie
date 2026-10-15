import type {
	CloudTarget,
	Device,
	Endpoint,
	FleetInventory,
	Instance,
	Lane,
	ModelOffering,
	ResidencyGroup,
} from "@roo-code/types"
import { describe, expect, it } from "vitest"

import {
	Attributor,
	UNATTRIBUTED,
	attemptStartMs,
	liveRevisionAt,
	type AttributionInput,
	type ReconcilerAuditEntry,
	type RevisionResolver,
} from "../attribution.js"

// ---------------------------------------------------------------------------
// Fixtures — a validated typed FleetInventory with one device offering, one
// cloud target, and one lane (Public_Route + alias).
// ---------------------------------------------------------------------------

function device(overrides: Partial<Device> = {}): Device {
	return { id: "gpu0", slotCeiling: 4, hostPreemption: false, ...overrides }
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
	return {
		id: "vllm",
		provider: "vllm",
		deviceIds: ["gpu0"],
		addresses: [{ instanceId: "cluster", url: "http://gpu0:2701" }],
		noCredential: true,
		...overrides,
	}
}

function offering(overrides: Partial<ModelOffering> = {}): ModelOffering {
	return {
		id: "coder",
		endpointId: "vllm",
		deviceId: "gpu0",
		modelId: "qwen-coder",
		context: 160_000,
		slots: 2,
		residencyGroup: "r0",
		tags: ["chat", "code"],
		ranks: [1, 3],
		...overrides,
	}
}

function cloud(overrides: Partial<CloudTarget> = {}): CloudTarget {
	return {
		id: "or-sonnet",
		provider: "openrouter",
		modelId: "anthropic/claude-sonnet",
		spend: "paid",
		context: 200_000,
		tags: ["chat", "code"],
		...overrides,
	}
}

function residency(overrides: Partial<ResidencyGroup> = {}): ResidencyGroup {
	return { id: "r0", swapLatencyMs: 0, ...overrides }
}

function lane(overrides: Partial<Lane> = {}): Lane {
	return {
		id: "code",
		names: ["hybrid/code", "code"],
		capabilities: ["code"],
		minContext: 128_000,
		order: "fill-first",
		maxSpend: "paid",
		spillTiers: ["paid"],
		failClosed: false,
		maxQueueMs: 30_000,
		capabilityLanes: ["coder.primary"],
		...overrides,
	}
}

function instance(overrides: Partial<Instance> = {}): Instance {
	return { id: "cluster", role: "primary", address: "http://cluster:8080", backupRetention: 20, ...overrides }
}

function inventory(overrides: Partial<FleetInventory> = {}): FleetInventory {
	return {
		devices: [device()],
		endpoints: [endpoint()],
		residencyGroups: [residency()],
		offerings: [offering()],
		clouds: [cloud()],
		lanes: [lane()],
		instances: [instance()],
		diagnostics: [],
		improvementObjectiveOrder: [],
		...overrides,
	}
}

/** A resolver that serves one inventory per commit id. */
function resolverFor(byCommit: Record<string, FleetInventory>): RevisionResolver {
	return { resolve: (commit) => byCommit[commit] }
}

/** A single successful apply making `commit` live from `endedAt`. */
function applyEntry(commit: string, endedAt: string, startedAt = endedAt): ReconcilerAuditEntry {
	return {
		kind: "apply",
		instanceId: "cluster",
		outcome: "succeeded",
		revision: { commit, uncommitted: false },
		startedAt,
		endedAt,
	}
}

/** Target_Identifier of the first slot of the default offering. */
const SLOT0_ID = "t:gpu0:vllm:qwen-coder:0"
/** Target_Identifier of the default cloud target. */
const CLOUD_ID = "c:openrouter:anthropic/claude-sonnet"

// ---------------------------------------------------------------------------
// attemptStartMs / liveRevisionAt
// ---------------------------------------------------------------------------

describe("attemptStartMs", () => {
	it("is completion time minus end-to-end latency", () => {
		const start = attemptStartMs({
			instanceId: "cluster",
			completedAt: "2026-10-10T00:00:10.000Z",
			endToEndMs: 10_000,
		})
		expect(start).toBe(Date.parse("2026-10-10T00:00:00.000Z"))
	})
})

describe("liveRevisionAt", () => {
	const audit: ReconcilerAuditEntry[] = [
		applyEntry("rev-a", "2026-10-01T00:00:00.000Z"),
		applyEntry("rev-b", "2026-10-05T00:00:00.000Z"),
	]

	it("selects the revision whose apply ended most recently at or before the start", () => {
		expect(liveRevisionAt(audit, "cluster", Date.parse("2026-10-03T00:00:00.000Z"))).toBe("rev-a")
		expect(liveRevisionAt(audit, "cluster", Date.parse("2026-10-06T00:00:00.000Z"))).toBe("rev-b")
	})

	it("returns undefined before any revision was live", () => {
		expect(liveRevisionAt(audit, "cluster", Date.parse("2026-09-30T00:00:00.000Z"))).toBeUndefined()
	})

	it("ignores failed/aborted applies when choosing the live revision", () => {
		const withFailure: ReconcilerAuditEntry[] = [
			applyEntry("rev-a", "2026-10-01T00:00:00.000Z"),
			{ ...applyEntry("rev-x", "2026-10-04T00:00:00.000Z"), outcome: "failed" },
		]
		expect(liveRevisionAt(withFailure, "cluster", Date.parse("2026-10-05T00:00:00.000Z"))).toBe("rev-a")
	})

	it("restores the pre-apply revision after a successful rollback", () => {
		const withRollback: ReconcilerAuditEntry[] = [
			applyEntry("rev-a", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
			applyEntry("rev-b", "2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z"),
			{
				kind: "rollback",
				instanceId: "cluster",
				outcome: "succeeded",
				revision: { commit: "rev-b", uncommitted: false },
				startedAt: "2026-10-06T00:00:00.000Z",
				endedAt: "2026-10-06T00:00:00.000Z",
				rolledBackApplyStartedAt: "2026-10-05T00:00:00.000Z",
			},
		]
		// After the rollback, the revision live when rev-b's apply started (rev-a).
		expect(liveRevisionAt(withRollback, "cluster", Date.parse("2026-10-07T00:00:00.000Z"))).toBe("rev-a")
	})

	it("scopes the live revision to the recording instance", () => {
		const multi: ReconcilerAuditEntry[] = [
			applyEntry("rev-a", "2026-10-01T00:00:00.000Z"),
			{ ...applyEntry("rev-other", "2026-10-02T00:00:00.000Z"), instanceId: "secondary" },
		]
		expect(liveRevisionAt(multi, "cluster", Date.parse("2026-10-03T00:00:00.000Z"))).toBe("rev-a")
	})
})

// ---------------------------------------------------------------------------
// Attributor — attribution by Target_Identifier (Req 17.1)
// ---------------------------------------------------------------------------

describe("Attributor", () => {
	const audit = [applyEntry("rev-a", "2026-10-01T00:00:00.000Z")]
	const base: Omit<AttributionInput, "targetId"> = {
		instanceId: "cluster",
		completedAt: "2026-10-10T00:00:05.000Z",
		endToEndMs: 5_000,
		requestedModelId: "hybrid/code",
		capabilityLaneName: "coder.primary",
	}

	it("attributes a slot Target_Identifier to its Device and Model_Offering", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: SLOT0_ID })
		expect(a.activeRevision).toBe("rev-a")
		expect(a.deviceId).toBe("gpu0")
		expect(a.modelOfferingId).toBe("coder")
		expect(a.cloudTargetId).toBeNull()
		expect(a.isUnattributed).toBe(false)
	})

	it("attributes a cloud Target_Identifier to its Cloud_Target with no Device", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: CLOUD_ID })
		expect(a.cloudTargetId).toBe("or-sonnet")
		expect(a.deviceId).toBeNull()
		expect(a.modelOfferingId).toBeNull()
		expect(a.isUnattributed).toBe(false)
	})

	it("attributes the Public_Route, Lane_Definition, and Capability_Lane", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: SLOT0_ID })
		expect(a.publicRoute).toBe("hybrid/code")
		expect(a.laneId).toBe("code")
		expect(a.capabilityLane).toBe("coder.primary")
	})

	it("resolves the Public_Route from a Route_Alias as the lane's own name", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: SLOT0_ID, requestedModelId: "code" })
		expect(a.publicRoute).toBe("hybrid/code")
		expect(a.laneId).toBe("code")
	})

	it("gives no Public_Route to a requested model id that is not a route name", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: SLOT0_ID, requestedModelId: "vllm/qwen-coder" })
		expect(a.publicRoute).toBeNull()
		expect(a.laneId).toBeNull()
	})

	it("falls back to connection + upstream model id when no Target_Identifier is recorded", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({
			...base,
			connectionId: "vllm",
			upstreamModelId: "qwen-coder",
		})
		expect(a.deviceId).toBe("gpu0")
		expect(a.modelOfferingId).toBe("coder")
		expect(a.servingEndpointId).toBe("vllm")
	})

	it("attributes a Health_Probe only to its Serving_Endpoint", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({
			...base,
			isHealthProbe: true,
			connectionId: "vllm",
			upstreamModelId: "qwen-coder",
			requestedModelId: undefined,
			capabilityLaneName: undefined,
		})
		expect(a.servingEndpointId).toBe("vllm")
		expect(a.deviceId).toBeNull()
		expect(a.modelOfferingId).toBeNull()
		expect(a.cloudTargetId).toBeNull()
	})

	// --- revision-at-attempt-start selection (Req 17.5) ----------------------

	it("attributes using the revision live at the attempt's start, not a later one", () => {
		// rev-a serves offering "coder"; rev-b replaces it with a different model id,
		// so the SAME connection+model only maps under rev-a.
		const invB = inventory({ offerings: [offering({ modelId: "qwen-coder-v2" })] })
		const twoRev: ReconcilerAuditEntry[] = [
			applyEntry("rev-a", "2026-10-01T00:00:00.000Z"),
			applyEntry("rev-b", "2026-10-20T00:00:00.000Z"),
		]
		const attributor = new Attributor(twoRev, resolverFor({ "rev-a": inventory(), "rev-b": invB }))
		// Attempt starts 2026-10-10 (while rev-a was live).
		const a = attributor.attribute({ ...base, connectionId: "vllm", upstreamModelId: "qwen-coder" })
		expect(a.activeRevision).toBe("rev-a")
		expect(a.modelOfferingId).toBe("coder")
	})

	// --- stability across regeneration (Req 17.6) ----------------------------

	it("gives the same attribution for the same Target_Identifier across a regeneration", () => {
		// A regenerated revision reorders ranks/tags but keeps the Slot identity,
		// so the Target_Identifier is unchanged and resolves identically.
		const regen = inventory({ offerings: [offering({ ranks: [2, 1], tags: ["code", "chat", "read"] })] })
		const twoRev: ReconcilerAuditEntry[] = [
			applyEntry("rev-a", "2026-10-01T00:00:00.000Z"),
			applyEntry("rev-regen", "2026-10-20T00:00:00.000Z"),
		]
		const attributor = new Attributor(twoRev, resolverFor({ "rev-a": inventory(), "rev-regen": regen }))
		const before = attributor.attribute({ ...base, targetId: SLOT0_ID })
		const after = attributor.attribute({
			...base,
			targetId: SLOT0_ID,
			completedAt: "2026-10-25T00:00:05.000Z",
		})
		expect(after.activeRevision).toBe("rev-regen")
		expect(after.deviceId).toBe(before.deviceId)
		expect(after.modelOfferingId).toBe(before.modelOfferingId)
	})

	// --- unattributed bucket (Req 17.5) --------------------------------------

	it("marks an unmappable Target_Identifier as unattributed, keeping other attributes", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: "t:ghost:none:none:0" })
		expect(a.deviceId).toBe(UNATTRIBUTED)
		expect(a.modelOfferingId).toBe(UNATTRIBUTED)
		expect(a.cloudTargetId).toBe(UNATTRIBUTED)
		expect(a.isUnattributed).toBe(true)
		expect(a.reasons).toContain("unmapped-target")
		// Other attributes are kept.
		expect(a.publicRoute).toBe("hybrid/code")
		expect(a.capabilityLane).toBe("coder.primary")
	})

	it("marks every identity unattributed when no revision was live at the start", () => {
		const lateAudit = [applyEntry("rev-a", "2026-10-20T00:00:00.000Z")]
		const attributor = new Attributor(lateAudit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: SLOT0_ID })
		expect(a.activeRevision).toBe(UNATTRIBUTED)
		expect(a.deviceId).toBe(UNATTRIBUTED)
		expect(a.reasons).toContain("no-active-revision")
	})

	it("marks the identity unattributed when the revision cannot be read from version control", () => {
		const attributor = new Attributor(audit, resolverFor({})) // rev-a not readable
		const a = attributor.attribute({ ...base, targetId: SLOT0_ID })
		expect(a.activeRevision).toBe(UNATTRIBUTED)
		expect(a.reasons).toContain("revision-unreadable")
	})

	it("marks the Capability_Lane unattributed when the recorded name is unknown", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({ ...base, targetId: SLOT0_ID, capabilityLaneName: "bogus.lane" })
		expect(a.capabilityLane).toBe(UNATTRIBUTED)
		expect(a.reasons).toContain("unknown-capability-lane")
		// The rest still resolves.
		expect(a.deviceId).toBe("gpu0")
	})

	it("yields the Serving_Endpoint but no Device for an ambiguous connection+model", () => {
		// Same connection (endpoint) + model id serving two devices → ambiguous.
		const ambiguous = inventory({
			devices: [device(), device({ id: "gpu1" })],
			endpoints: [endpoint({ deviceIds: ["gpu0", "gpu1"] })],
			offerings: [offering({ id: "o0", deviceId: "gpu0" }), offering({ id: "o1", deviceId: "gpu1" })],
		})
		const attributor = new Attributor(audit, resolverFor({ "rev-a": ambiguous }))
		const a = attributor.attribute({ ...base, connectionId: "vllm", upstreamModelId: "qwen-coder" })
		expect(a.servingEndpointId).toBe("vllm")
		expect(a.deviceId).toBe(UNATTRIBUTED)
		expect(a.reasons).toContain("ambiguous-device")
	})

	it("has no Device/Model_Offering/Cloud_Target for a not-dispatched attempt with no target or connection", () => {
		const attributor = new Attributor(audit, resolverFor({ "rev-a": inventory() }))
		const a = attributor.attribute({
			...base,
			requestedModelId: undefined,
			capabilityLaneName: undefined,
		})
		expect(a.deviceId).toBeNull()
		expect(a.modelOfferingId).toBeNull()
		expect(a.cloudTargetId).toBeNull()
		expect(a.isUnattributed).toBe(false)
	})
})
