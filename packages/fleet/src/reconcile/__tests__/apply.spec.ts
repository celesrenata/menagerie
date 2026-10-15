import { describe, expect, it } from "vitest"

import type { Revision } from "../../compile/compiler.js"
import type { Combo } from "../../omniroute/client.js"
import { FakeOmniRouteClient } from "../../omniroute/fake.js"
import {
	apply,
	InMemoryAuditLog,
	InMemoryBackupStore,
	type ApplyDeps,
	type InstanceLocks,
	type OperatorConfirmation,
	type RouteBackup,
} from "../apply.js"
import type { ChangeOp, ChangePlan } from "../plan.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REV: Revision = { commit: "abc123", uncommitted: false }
const CREATED_AT = "2026-10-15T00:00:00.000Z"
const INSTANCE = "cluster"

// A fixed, monotonically increasing UTC clock so startedAt/endedAt are
// deterministic and distinct across an apply.
function clockSeq(): () => string {
	let t = Date.parse("2026-10-15T00:00:01.000Z")
	return () => {
		const iso = new Date(t).toISOString()
		t += 1000
		return iso
	}
}

function combo(overrides: Partial<Combo> = {}): Combo {
	return {
		id: "cmb-code",
		name: "hybrid/code",
		strategy: "priority",
		models: [{ id: "t:gpu0:vllm:qwen:0", kind: "model", model: "qwen", connectionId: "conn-vllm" }],
		config: { fleetRevision: "abc123" },
		context_length: 160_000,
		isHidden: false,
		...overrides,
	}
}

/** A confirmation that matches a plan for INSTANCE at REV/CREATED_AT. */
function confirm(overrides: Partial<OperatorConfirmation> = {}): OperatorConfirmation {
	return {
		operator: "celes",
		instanceId: INSTANCE,
		target: { kind: "plan", revision: REV.commit, createdAt: CREATED_AT },
		confirmDeletions: false,
		...overrides,
	}
}

function changePlan(ops: ChangeOp[], overrides: Partial<ChangePlan> = {}): ChangePlan {
	return {
		instanceId: INSTANCE,
		revision: REV,
		createdAt: CREATED_AT,
		ops,
		errors: [],
		...overrides,
	}
}

/** The dependency bundle with in-memory stores and zero deadlines for tests. */
function deps(client: FakeOmniRouteClient, overrides: Partial<ApplyDeps> = {}): ApplyDeps {
	const locks: InstanceLocks = overrides.locks ?? new Set<string>()
	let seq = 0
	return {
		client,
		backups: overrides.backups ?? new InMemoryBackupStore(),
		audit: overrides.audit ?? new InMemoryAuditLog(),
		locks,
		clock: overrides.clock ?? clockSeq(),
		// Zero deadlines so the real timer is bypassed; the fake drives timeouts
		// via a never-settling promise, wrapped by withWriteDeadline below.
		withWriteDeadline: overrides.withWriteDeadline,
		withBackupDeadline: overrides.withBackupDeadline,
		backupRetention: overrides.backupRetention,
		backupId: overrides.backupId ?? (() => `bkp-${++seq}`),
	}
}

// ---------------------------------------------------------------------------
// Clean apply
// ---------------------------------------------------------------------------

describe("apply — clean apply", () => {
	it("applies ops in order, records readbacks, audits succeeded, prunes the backup", async () => {
		// Live has an existing combo to update and one to delete; the plan also
		// creates one. Ordered: create, update, delete.
		const existing = combo({ id: "cmb-old", name: "hybrid/old", context_length: 100 })
		const toUpdate = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const fake = new FakeOmniRouteClient({ combos: [existing, toUpdate] })

		const createAfter = combo({ name: "hybrid/new", context_length: 200 })
		const updateAfter = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })
		const deleteBefore = existing

		const plan = changePlan(
			[
				{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(createAfter) },
				{ kind: "combo", op: "update", id: "hybrid/upd", before: toUpdate, after: stripId(updateAfter) },
				{ kind: "combo", op: "delete", id: "hybrid/old", before: deleteBefore },
			],
			{},
		)

		const backups = new InMemoryBackupStore()
		const audit = new InMemoryAuditLog()
		const d = deps(fake, { backups, audit })

		const result = await apply(plan, confirm({ confirmDeletions: true }), d)

		expect(result.outcome).toBe("succeeded")
		expect(result.counts).toEqual({ createsPlanned: 1, updatesPlanned: 1, deletesPlanned: 1, completed: 3 })
		expect(result.backupId).toBeDefined()
		expect(result.backupLocation).toContain(INSTANCE)

		// Live state reflects the plan: new created, upd updated, old deleted.
		const liveCombos = await fake.listCombos()
		const names = liveCombos.map((c) => c.name).sort()
		expect(names).toEqual(["hybrid/new", "hybrid/upd"])
		expect(liveCombos.find((c) => c.name === "hybrid/upd")!.context_length).toBe(300)

		// The backup recorded a post-apply value per written op (Requirement 9.5).
		const backup = (await backups.load(result.backupId!))!
		expect(backup.postApply.map((p) => p.id).sort()).toEqual(["hybrid/new", "hybrid/old", "hybrid/upd"])

		// Audit: one succeeded apply entry (Requirement 9.12).
		expect(audit.entries).toHaveLength(1)
		expect(audit.entries[0]).toMatchObject({ kind: "apply", instanceId: INSTANCE, outcome: "succeeded" })
		expect(audit.entries[0]!.revision).toEqual(REV)

		// Prune kept this backup (retention default 20 ⇒ nothing to delete).
		expect(backups.all()).toHaveLength(1)
	})

	it("audits no-changes for an empty plan without capturing a backup", async () => {
		const fake = new FakeOmniRouteClient({})
		const backups = new InMemoryBackupStore()
		const audit = new InMemoryAuditLog()
		const result = await apply(changePlan([]), confirm(), deps(fake, { backups, audit }))

		expect(result.outcome).toBe("no-changes")
		expect(result.backupId).toBeUndefined()
		expect(backups.all()).toHaveLength(0)
		expect(audit.entries[0]).toMatchObject({ outcome: "no-changes" })
		// No write issued.
		expect(fake.calls().filter((c) => c.operation === "createCombo")).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("apply — guards", () => {
	it("refuses a confirmation that does not match this plan (22.7)", async () => {
		const fake = new FakeOmniRouteClient({})
		const audit = new InMemoryAuditLog()
		const plan = changePlan([{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(combo()) }])

		// Wrong revision in the confirmation.
		const result = await apply(
			plan,
			confirm({ target: { kind: "plan", revision: "wrong", createdAt: CREATED_AT } }),
			deps(fake, { audit }),
		)

		expect(result.outcome).toBe("aborted")
		expect(result.abortReason).toContain("revision")
		expect(audit.entries[0]).toMatchObject({ outcome: "aborted" })
		// No backup, no write.
		expect(result.backupId).toBeUndefined()
		expect(fake.calls().filter((c) => c.operation === "createCombo")).toHaveLength(0)
	})

	it("refuses when the operator is absent (22.2/22.7)", async () => {
		const fake = new FakeOmniRouteClient({})
		const plan = changePlan([{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(combo()) }])
		const result = await apply(plan, confirm({ operator: "  " }), deps(fake))
		expect(result.outcome).toBe("aborted")
		expect(result.abortReason).toContain("operator")
	})

	it("refuses an apply of an uncommitted revision (9.17)", async () => {
		const fake = new FakeOmniRouteClient({})
		const dirtyRev: Revision = { commit: "abc123", uncommitted: true }
		const plan = changePlan([{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(combo()) }], {
			revision: dirtyRev,
		})
		const result = await apply(plan, confirm(), deps(fake))
		expect(result.outcome).toBe("aborted")
		expect(result.abortReason).toContain("uncommitted")
		expect(result.backupId).toBeUndefined()
	})

	it("refuses deletions without confirmDeletions (9.11)", async () => {
		const existing = combo({ id: "cmb-old", name: "hybrid/old" })
		const fake = new FakeOmniRouteClient({ combos: [existing] })
		const plan = changePlan([{ kind: "combo", op: "delete", id: "hybrid/old", before: existing }])

		const result = await apply(plan, confirm({ confirmDeletions: false }), deps(fake))

		expect(result.outcome).toBe("aborted")
		expect(result.abortReason).toContain("deletion")
		// The combo was NOT deleted.
		expect((await fake.listCombos()).map((c) => c.name)).toContain("hybrid/old")
	})

	it("aborts when the live state changed since plan creation (9.4)", async () => {
		// The plan expects to update a combo whose live context_length has since
		// changed from the plan.before value.
		const planBefore = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const liveNow = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 777 })
		const fake = new FakeOmniRouteClient({ combos: [liveNow] })
		const audit = new InMemoryAuditLog()

		const plan = changePlan([
			{ kind: "combo", op: "update", id: "hybrid/upd", before: planBefore, after: stripId(combo({ context_length: 200 })) },
		])

		const result = await apply(plan, confirm(), deps(fake, { audit }))

		expect(result.outcome).toBe("aborted")
		expect(result.drifted).toHaveLength(1)
		expect(result.drifted![0]).toMatchObject({ id: "hybrid/upd" })
		// No write issued (aborted before the first write).
		expect(fake.calls().filter((c) => c.operation === "updateCombo")).toHaveLength(0)
		expect(audit.entries[0]).toMatchObject({ outcome: "aborted" })
	})

	it("refuses a concurrent apply on the same instance (9.15)", async () => {
		const fake = new FakeOmniRouteClient({})
		const locks: InstanceLocks = new Set<string>([INSTANCE])
		const plan = changePlan([{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(combo()) }])

		const result = await apply(plan, confirm(), deps(fake, { locks }))

		expect(result.outcome).toBe("aborted")
		expect(result.abortReason).toContain("in progress")
	})
})

// ---------------------------------------------------------------------------
// Restore-on-failure (Requirement 9.6, 9.16, 9.5)
// ---------------------------------------------------------------------------

describe("apply — restore on failure", () => {
	it("restores every written object in reverse order on a mid-apply write error (9.6, 9.16)", async () => {
		// Live has a combo to update; the plan creates one, then updates one, then
		// a third write (delete) errors. The create + update must be restored in
		// reverse: the update rolled back to its backup value, the create deleted.
		const updBefore = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const delBefore = combo({ id: "cmb-del", name: "hybrid/del", context_length: 100 })
		const fake = new FakeOmniRouteClient({ combos: [updBefore, delBefore] })
		fake.scriptFailure({ operation: "deleteCombo", kind: "writeError", objectId: "cmb-del", status: 500 })

		const audit = new InMemoryAuditLog()
		const backups = new InMemoryBackupStore()
		const plan = changePlan([
			{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(combo({ name: "hybrid/new" })) },
			{ kind: "combo", op: "update", id: "hybrid/upd", before: updBefore, after: stripId(combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })) },
			{ kind: "combo", op: "delete", id: "hybrid/del", before: delBefore },
		])

		const result = await apply(plan, confirm({ confirmDeletions: true }), deps(fake, { audit, backups }))

		expect(result.outcome).toBe("failed-and-restored")
		expect(result.failedOp).toEqual({ kind: "combo", id: "hybrid/del" })
		expect(result.failureCause).toBeDefined()

		// Every written object restored (the delete never landed, so just the
		// create + update are rolled back).
		const restoredIds = result.restores!.filter((r) => r.restored).map((r) => r.id).sort()
		expect(restoredIds).toContain("hybrid/new")
		expect(restoredIds).toContain("hybrid/upd")

		// Live state is back to the pre-apply snapshot: hybrid/new gone, hybrid/upd
		// at 100, hybrid/del still present.
		const live = await fake.listCombos()
		const byName = new Map(live.map((c) => [c.name, c]))
		expect(byName.has("hybrid/new")).toBe(false)
		expect(byName.get("hybrid/upd")!.context_length).toBe(100)
		expect(byName.has("hybrid/del")).toBe(true)

		expect(audit.entries[0]).toMatchObject({ kind: "apply", outcome: "failed" })
	})

	it("restores on a readback mismatch (9.5 → 9.6)", async () => {
		const updBefore = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const fake = new FakeOmniRouteClient({ combos: [updBefore] })
		// The update lands in the store, but listCombos returns a mismatched value
		// on the readback for cmb-upd.
		fake.scriptFailure({
			operation: "listCombos",
			kind: "readbackMismatch",
			onCall: 2, // call 1 is the pre-apply snapshot; call 2 is the readback.
			mutate: (real) => {
				const combos = (real as Combo[]).map((c) =>
					c.id === "cmb-upd" ? { ...c, context_length: 999 } : c,
				)
				return combos
			},
		})

		const plan = changePlan([
			{ kind: "combo", op: "update", id: "hybrid/upd", before: updBefore, after: stripId(combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })) },
		])

		const result = await apply(plan, confirm(), deps(fake))

		expect(result.outcome).toBe("failed-and-restored")
		expect(result.failedOp).toEqual({ kind: "combo", id: "hybrid/upd" })
		expect(result.restores!.find((r) => r.id === "hybrid/upd")!.restored).toBe(true)
	})

	it("treats a write that exceeds the ≤30 s deadline as a failure and restores (9.5, 9.6)", async () => {
		const updBefore = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const fake = new FakeOmniRouteClient({ combos: [updBefore] })
		// The first update write never settles, so the injected write deadline
		// rejects; the restore sweep's later writes are allowed to proceed.
		fake.scriptFailure({ operation: "updateCombo", kind: "timeout", objectId: "cmb-upd", onCall: 1 })

		// A deadline that rejects quickly stands in for the real ≤30 s wrapper.
		const withWriteDeadline = <T>(work: Promise<T>): Promise<T> =>
			Promise.race([
				work,
				new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("deadline exceeded")), 10)),
			])

		const plan = changePlan([
			{ kind: "combo", op: "update", id: "hybrid/upd", before: updBefore, after: stripId(combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })) },
		])

		const result = await apply(plan, confirm(), deps(fake, { withWriteDeadline }))

		expect(result.outcome).toBe("failed-and-restored")
		expect(result.failedOp).toEqual({ kind: "combo", id: "hybrid/upd" })
		// The timed-out update never mutated the store (writeError-style), so the
		// restore sweep finds the live value already equal to the backup.
		expect((await fake.listCombos()).find((c) => c.id === "cmb-upd")!.context_length).toBe(100)
	})
})

// ---------------------------------------------------------------------------
// Backup pruning (Requirement 9.13)
// ---------------------------------------------------------------------------

describe("apply — backup pruning", () => {
	it("keeps only the most recent `backupRetention` backups of the instance (9.13)", async () => {
		const backups = new InMemoryBackupStore()
		// Pre-seed 3 older backups for the instance.
		const older: RouteBackup[] = [1, 2, 3].map((n) => ({
			id: `old-${n}`,
			instanceId: INSTANCE,
			capturedAt: new Date(Date.parse("2026-10-14T00:00:00.000Z") + n * 1000).toISOString(),
			revision: REV,
			location: `backups/${INSTANCE}/old-${n}.json`,
			snapshot: { combos: [] },
			checksum: "x",
			postApply: [],
		}))
		for (const b of older) await backups.save(b)

		const fake = new FakeOmniRouteClient({})
		const plan = changePlan([{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(combo({ name: "hybrid/new" })) }])

		// Retention 2 ⇒ after a write-bearing apply, keep the 2 most recent.
		const result = await apply(plan, confirm(), deps(fake, { backups, backupRetention: 2 }))

		expect(result.outcome).toBe("succeeded")
		const remaining = backups.all().map((b) => b.id)
		expect(remaining).toHaveLength(2)
		// The newest kept is the one captured by this apply.
		expect(remaining).toContain(result.backupId)
	})
})

// ---------------------------------------------------------------------------
// Credential safety (Requirement 22.4-22.6)
// ---------------------------------------------------------------------------

describe("apply — no secret leak", () => {
	it("writes no tokenized URL path segment into the backup or audit", async () => {
		// A combo config that smuggles a tokenized URL path segment.
		const tokenized = "http://host/api/v1/vscode/SECRET-TOKEN/combos"
		const live = combo({
			id: "cmb-upd",
			name: "hybrid/upd",
			context_length: 100,
			config: { fleetRevision: "abc123", endpoint: tokenized },
		})
		const fake = new FakeOmniRouteClient({ combos: [live] })
		const backups = new InMemoryBackupStore()
		const audit = new InMemoryAuditLog()

		const plan = changePlan([
			{
				kind: "combo",
				op: "update",
				id: "hybrid/upd",
				before: live,
				after: stripId(combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300, config: { fleetRevision: "abc123", endpoint: tokenized } })),
			},
		])

		const result = await apply(plan, confirm(), deps(fake, { backups, audit }))

		expect(result.outcome).toBe("succeeded")
		const serializedBackup = JSON.stringify(await backups.load(result.backupId!))
		const serializedAudit = JSON.stringify(audit.entries)
		expect(serializedBackup).not.toContain("SECRET-TOKEN")
		expect(serializedBackup).toContain("<redacted>")
		expect(serializedAudit).not.toContain("SECRET-TOKEN")
	})
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A combo value without its OmniRoute-assigned id, mirroring a plan `after`. */
function stripId(c: Combo): Omit<Combo, "id"> {
	const { id: _ignored, ...rest } = c
	void _ignored
	return rest
}


describe("apply — readback tolerates OmniRoute server-side normalization", () => {
	// OmniRoute normalizes a combo on write: it fills model-step `weight`, defaults
	// `providerId`/`connectionId` to null, adds config defaults, and the list read
	// adds `computed_context_length`. The readback comparison must treat these as a
	// MATCH (compare only client-owned identity fields), or every live apply would
	// false-fail on the first write (the production symptom).
	const normalizeLikeOmniRoute = (real: unknown): unknown =>
		(real as Combo[]).map((c) => ({
			...c,
			computed_context_length: c.context_length,
			config: { ...c.config, serverDefault: true },
			models: c.models.map((m) => ({ ...m, weight: 1, providerId: null, connectionId: null })),
		}))

	it("counts a create as completed when the readback differs ONLY by normalized fields", async () => {
		const fake = new FakeOmniRouteClient({})
		fake.scriptFailure({ operation: "listCombos", kind: "readbackMismatch", mutate: normalizeLikeOmniRoute })

		const plan = changePlan([
			{ kind: "combo", op: "create", id: "pool/x", after: combo({ name: "pool/x", context_length: 163_840 }) },
		])
		const result = await apply(plan, confirm(), deps(fake))

		expect(result.outcome).toBe("succeeded")
		expect(result.counts.completed).toBe(1)
	})

	it("still fails-and-restores when the readback changes a CLIENT-OWNED field", async () => {
		const corrupt = (real: unknown): unknown =>
			(real as Combo[]).map((c) => ({ ...c, context_length: (c.context_length ?? 0) + 7 }))
		const existing = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100_000 })
		const fake = new FakeOmniRouteClient({ combos: [existing] })
		fake.scriptFailure({ operation: "listCombos", kind: "readbackMismatch", mutate: corrupt })

		const plan = changePlan([
			{
				kind: "combo",
				op: "update",
				id: "hybrid/upd",
				before: existing,
				after: combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 120_000 }),
			},
		])
		const result = await apply(plan, confirm(), deps(fake))
		expect(result.outcome).not.toBe("succeeded")
	})
})
