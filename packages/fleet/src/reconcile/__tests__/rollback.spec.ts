import { createHash } from "node:crypto"

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
	type PostApplyRecord,
	type RouteBackup,
} from "../apply.js"
import type { ChangeOp, ChangePlan } from "../plan.js"
import {
	rollback,
	type InstanceRole,
	type InstanceRoleLookup,
	type RollbackDeps,
} from "../rollback.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REV: Revision = { commit: "abc123", uncommitted: false }
const CREATED_AT = "2026-10-15T00:00:00.000Z"
const CAPTURED_AT = "2026-10-15T00:00:01.000Z"
const INSTANCE = "cluster"

/** A fixed, monotonically increasing UTC clock so start/end times are distinct. */
function clockSeq(from = "2026-10-15T01:00:00.000Z"): () => string {
	let t = Date.parse(from)
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

/** A combo value without its OmniRoute-assigned id, mirroring a plan `after`. */
function stripId(c: Combo): Omit<Combo, "id"> {
	const { id: _ignored, ...rest } = c
	void _ignored
	return rest
}

/** The SHA-256 checksum apply computes over a redacted snapshot, re-derived here. */
function checksumOf(combos: readonly Combo[]): string {
	// Mirror apply's stableStringify over { combos }. These fixtures carry no
	// tokenized segments, so redaction is a no-op and we can checksum directly.
	return createHash("sha256").update(stableStringify({ combos })).digest("hex")
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null"
	}
	if (Array.isArray(value)) {
		return `[${value.map((e) => stableStringify(e)).join(",")}]`
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

/** A confirmation that names a backup captured at CAPTURED_AT on INSTANCE. */
function confirm(overrides: Partial<OperatorConfirmation> = {}): OperatorConfirmation {
	return {
		operator: "celes",
		instanceId: INSTANCE,
		target: { kind: "backup", capturedAt: CAPTURED_AT },
		confirmDeletions: false,
		...overrides,
	}
}

/** An instance-role lookup backed by a map; undeclared instances return undefined. */
function roles(map: Record<string, InstanceRole> = { [INSTANCE]: "primary" }): InstanceRoleLookup {
	return { roleOf: (id) => map[id] }
}

/**
 * Build a Route_Backup whose snapshot is `backupCombos` (the pre-apply live
 * state) and whose postApply records model what the apply wrote. The checksum is
 * computed over the snapshot so it verifies.
 */
function routeBackup(
	backupCombos: readonly Combo[],
	postApply: readonly PostApplyRecord[],
	overrides: Partial<RouteBackup> = {},
): RouteBackup {
	const snapshot = { combos: backupCombos }
	return {
		id: "bkp-1",
		instanceId: INSTANCE,
		capturedAt: CAPTURED_AT,
		revision: REV,
		location: `backups/${INSTANCE}/bkp-1.json`,
		snapshot,
		checksum: checksumOf(backupCombos),
		postApply,
		...overrides,
	}
}

/** The rollback dependency bundle with in-memory stores and zero deadlines. */
function deps(client: FakeOmniRouteClient, overrides: Partial<RollbackDeps> = {}): RollbackDeps {
	return {
		client,
		backups: overrides.backups ?? new InMemoryBackupStore(),
		audit: overrides.audit ?? new InMemoryAuditLog(),
		locks: overrides.locks ?? new Set<string>(),
		roles: overrides.roles ?? roles(),
		clock: overrides.clock ?? clockSeq(),
		withWriteDeadline: overrides.withWriteDeadline,
		rolledBackApplyStartedAt: overrides.rolledBackApplyStartedAt,
	}
}

// ---------------------------------------------------------------------------
// Clean rollback (Requirement 9.7, 9.10, 9.16)
// ---------------------------------------------------------------------------

describe("rollback — clean restore", () => {
	it("restores updates/deletes and deletes created objects, in reverse write order", async () => {
		// Pre-apply (backup) snapshot: an `upd` combo at 100 and a `del` combo.
		const updBackup = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const delBackup = combo({ id: "cmb-del", name: "hybrid/del", context_length: 100 })

		// Post-apply live: `new` created, `upd` changed to 300, `del` deleted.
		const createdNew = combo({ id: "cmb-new", name: "hybrid/new", context_length: 200 })
		const updAfter = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })
		const fake = new FakeOmniRouteClient({ combos: [createdNew, updAfter] })

		// postApply is in the apply's WRITE order: create, update, delete.
		const backup = routeBackup(
			[updBackup, delBackup],
			[
				{ kind: "combo", id: "hybrid/new", op: "create", omniRouteId: "cmb-new", postApplyValue: stripId(createdNew) },
				{ kind: "combo", id: "hybrid/upd", op: "update", omniRouteId: "cmb-upd", postApplyValue: stripId(updAfter) },
				{ kind: "combo", id: "hybrid/del", op: "delete", omniRouteId: "cmb-del", postApplyValue: undefined },
			],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)
		const audit = new InMemoryAuditLog()

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups, audit }))

		expect(result.outcome).toBe("succeeded")

		// Live state returns to the backup: new gone, upd at 100, del recreated.
		const live = await fake.listCombos()
		const byName = new Map(live.map((c) => [c.name, c]))
		expect(byName.has("hybrid/new")).toBe(false)
		expect(byName.get("hybrid/upd")!.context_length).toBe(100)
		expect(byName.has("hybrid/del")).toBe(true)

		// Restores are reported in reverse-write order: del, upd, new.
		expect(result.restores!.map((r) => r.id)).toEqual(["hybrid/del", "hybrid/upd", "hybrid/new"])
		expect(result.restores!.every((r) => r.restored)).toBe(true)

		// Audit: one rollback entry carrying the backup's revision (8.1 shape).
		expect(audit.entries).toHaveLength(1)
		expect(audit.entries[0]).toMatchObject({ kind: "rollback", instanceId: INSTANCE, outcome: "succeeded" })
		expect(audit.entries[0]!.revision).toEqual(REV)
	})

	it("records rolledBackApplyStartedAt when the caller supplies it (8.1 attribution)", async () => {
		const fake = new FakeOmniRouteClient({ combos: [combo()] })
		const backup = routeBackup(
			[combo()],
			[{ kind: "combo", id: "hybrid/code", op: "update", omniRouteId: "cmb-code", postApplyValue: stripId(combo()) }],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)
		const audit = new InMemoryAuditLog()

		await rollback(
			"bkp-1",
			confirm(),
			deps(fake, { backups, audit, rolledBackApplyStartedAt: CREATED_AT }),
		)

		expect(audit.entries[0]!.rolledBackApplyStartedAt).toBe(CREATED_AT)
	})
})

// ---------------------------------------------------------------------------
// Guards (Requirement 22.7, 9.15, 10.5)
// ---------------------------------------------------------------------------

describe("rollback — guards", () => {
	it("refuses a confirmation whose capturedAt does not match the backup (22.7)", async () => {
		const fake = new FakeOmniRouteClient({ combos: [combo()] })
		const backup = routeBackup([combo()], [])
		const backups = new InMemoryBackupStore()
		await backups.save(backup)

		const result = await rollback(
			"bkp-1",
			confirm({ target: { kind: "backup", capturedAt: "2000-01-01T00:00:00.000Z" } }),
			deps(fake, { backups }),
		)

		expect(result.outcome).toBe("aborted")
		expect(result.refuseReason).toContain("capture time")
		// No write issued.
		expect(fake.calls().filter((c) => c.operation === "updateCombo")).toHaveLength(0)
	})

	it("refuses when the operator is absent (22.7)", async () => {
		const fake = new FakeOmniRouteClient({})
		const result = await rollback("bkp-1", confirm({ operator: "  " }), deps(fake))
		expect(result.outcome).toBe("aborted")
		expect(result.refuseReason).toContain("operator")
	})

	it("refuses a target that is a plan, not a backup (22.7)", async () => {
		const fake = new FakeOmniRouteClient({})
		const result = await rollback(
			"bkp-1",
			confirm({ target: { kind: "plan", revision: REV.commit, createdAt: CREATED_AT } }),
			deps(fake),
		)
		expect(result.outcome).toBe("aborted")
		expect(result.refuseReason).toContain("Route_Backup")
	})

	it("refuses a rollback for a retired instance before any write (10.5)", async () => {
		const fake = new FakeOmniRouteClient({ combos: [combo()] })
		const backups = new InMemoryBackupStore()
		await backups.save(routeBackup([combo()], []))

		const result = await rollback(
			"bkp-1",
			confirm(),
			deps(fake, { backups, roles: roles({ [INSTANCE]: "retired" }) }),
		)

		expect(result.outcome).toBe("aborted")
		expect(result.refuseReason).toContain("retired")
		// The backup store was never even read (refused before load).
		expect(fake.calls()).toHaveLength(0)
	})

	it("refuses a rollback for an undeclared instance before any write (10.5)", async () => {
		const fake = new FakeOmniRouteClient({ combos: [combo()] })
		const result = await rollback("bkp-1", confirm(), deps(fake, { roles: roles({}) }))

		expect(result.outcome).toBe("aborted")
		expect(result.refuseReason).toContain("does not declare")
		expect(fake.calls()).toHaveLength(0)
	})

	it("refuses a concurrent apply/rollback on the same instance (9.15)", async () => {
		const fake = new FakeOmniRouteClient({ combos: [combo()] })
		const backups = new InMemoryBackupStore()
		await backups.save(routeBackup([combo()], []))
		const locks: InstanceLocks = new Set<string>([INSTANCE])

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups, locks }))

		expect(result.outcome).toBe("aborted")
		expect(result.refuseReason).toContain("in progress")
	})
})

// ---------------------------------------------------------------------------
// Backup verification (Requirement 9.7, 9.8)
// ---------------------------------------------------------------------------

describe("rollback — backup verification", () => {
	it("refuses when the Route_Backup is missing (9.8)", async () => {
		const fake = new FakeOmniRouteClient({})
		const result = await rollback("does-not-exist", confirm(), deps(fake))
		expect(result.outcome).toBe("refused")
		expect(result.refuseReason).toContain("missing")
	})

	it("refuses when the Route_Backup fails checksum verification (9.7)", async () => {
		const fake = new FakeOmniRouteClient({ combos: [combo()] })
		const backups = new InMemoryBackupStore()
		// A backup whose checksum does not match its snapshot.
		await backups.save(routeBackup([combo()], [], { checksum: "deadbeef" }))

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups }))

		expect(result.outcome).toBe("refused")
		expect(result.refuseReason).toContain("checksum")
		// No write issued.
		expect(fake.calls().filter((c) => c.operation !== "listCombos")).toHaveLength(0)
	})

	it("refuses and reports an object that drifted away from both recorded values (9.8)", async () => {
		// The backup had `upd` at 100; the apply wrote 300 (post-apply value). The
		// live value is now 999 — neither the post-apply value nor the backup.
		const updBackup = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const updAfter = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })
		const liveNow = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 999 })
		const fake = new FakeOmniRouteClient({ combos: [liveNow] })

		const backup = routeBackup(
			[updBackup],
			[{ kind: "combo", id: "hybrid/upd", op: "update", omniRouteId: "cmb-upd", postApplyValue: stripId(updAfter) }],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups }))

		expect(result.outcome).toBe("refused")
		expect(result.drifted).toHaveLength(1)
		expect(result.drifted![0]).toMatchObject({ id: "hybrid/upd" })
		expect((result.drifted![0]!.current as Combo).context_length).toBe(999)
		// No write issued (refused before the first write).
		expect(fake.calls().filter((c) => c.operation === "updateCombo")).toHaveLength(0)
	})

	it("proceeds when an object still equals its recorded post-apply value (9.7)", async () => {
		// Live equals the post-apply value (300); the rollback restores to 100.
		const updBackup = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const updAfter = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })
		const fake = new FakeOmniRouteClient({ combos: [updAfter] })

		const backup = routeBackup(
			[updBackup],
			[{ kind: "combo", id: "hybrid/upd", op: "update", omniRouteId: "cmb-upd", postApplyValue: stripId(updAfter) }],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups }))

		expect(result.outcome).toBe("succeeded")
		expect((await fake.listCombos()).find((c) => c.id === "cmb-upd")!.context_length).toBe(100)
	})

	it("is a no-op when every object already equals its backup value (9.10 round-trip)", async () => {
		// Live already equals the backup; nothing to restore.
		const updBackup = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const fake = new FakeOmniRouteClient({ combos: [updBackup] })
		const backup = routeBackup(
			[updBackup],
			[{ kind: "combo", id: "hybrid/upd", op: "update", omniRouteId: "cmb-upd", postApplyValue: stripId(updBackup) }],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups }))

		expect(result.outcome).toBe("no-changes")
		expect(result.alreadyAtBackup).toBe(1)
		expect(fake.calls().filter((c) => c.operation === "updateCombo")).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// Restore-write failure (Requirement 9.16)
// ---------------------------------------------------------------------------

describe("rollback — restore write failure", () => {
	it("stops and reports each object not yet restored on a restore write error (9.16)", async () => {
		// Two objects to restore in reverse order: first restore (the LAST written,
		// `cmb-b`) fails, so `cmb-a` is left unrestored and no further write issues.
		const aBackup = combo({ id: "cmb-a", name: "hybrid/a", context_length: 100 })
		const bBackup = combo({ id: "cmb-b", name: "hybrid/b", context_length: 100 })
		const aAfter = combo({ id: "cmb-a", name: "hybrid/a", context_length: 300 })
		const bAfter = combo({ id: "cmb-b", name: "hybrid/b", context_length: 300 })
		const fake = new FakeOmniRouteClient({ combos: [aAfter, bAfter] })
		// The update of cmb-b (the first restore, reverse order) errors.
		fake.scriptFailure({ operation: "updateCombo", kind: "writeError", objectId: "cmb-b", status: 500 })

		const backup = routeBackup(
			[aBackup, bBackup],
			[
				{ kind: "combo", id: "hybrid/a", op: "update", omniRouteId: "cmb-a", postApplyValue: stripId(aAfter) },
				{ kind: "combo", id: "hybrid/b", op: "update", omniRouteId: "cmb-b", postApplyValue: stripId(bAfter) },
			],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)
		const audit = new InMemoryAuditLog()

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups, audit }))

		expect(result.outcome).toBe("failed-unrestored")
		// Reverse order: cmb-b attempted first (fails), cmb-a never attempted.
		const b = result.restores!.find((r) => r.id === "hybrid/b")!
		const a = result.restores!.find((r) => r.id === "hybrid/a")!
		expect(b.restored).toBe(false)
		expect(b.reason).toBeDefined()
		expect(a.restored).toBe(false)
		expect(a.backupValue).toBeDefined()
		// cmb-a was never written (halted after the first failure).
		expect(fake.calls().filter((c) => c.operation === "updateCombo" && c.objectId === "cmb-a")).toHaveLength(0)
		expect(audit.entries[0]).toMatchObject({ kind: "rollback", outcome: "failed" })
	})

	it("treats a restore write exceeding the ≤30 s deadline as a failure (9.16)", async () => {
		const updBackup = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const updAfter = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })
		const fake = new FakeOmniRouteClient({ combos: [updAfter] })
		fake.scriptFailure({ operation: "updateCombo", kind: "timeout", objectId: "cmb-upd", onCall: 1 })

		const withWriteDeadline = <T>(work: Promise<T>): Promise<T> =>
			Promise.race([
				work,
				new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("deadline exceeded")), 10)),
			])

		const backup = routeBackup(
			[updBackup],
			[{ kind: "combo", id: "hybrid/upd", op: "update", omniRouteId: "cmb-upd", postApplyValue: stripId(updAfter) }],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups, withWriteDeadline }))

		expect(result.outcome).toBe("failed-unrestored")
		expect(result.restores!.find((r) => r.id === "hybrid/upd")!.restored).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Credential safety (Requirement 22.4-22.6)
// ---------------------------------------------------------------------------

describe("rollback — no secret leak", () => {
	it("writes no tokenized URL path segment into the drift report or audit", async () => {
		const tokenized = "http://host/api/v1/vscode/SECRET-TOKEN/combos"
		// Backup had the combo without the token; live drifted to carry the token
		// in a value that matches neither recorded value, forcing a 9.8 report.
		const updBackup = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const updAfter = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })
		const liveNow = combo({
			id: "cmb-upd",
			name: "hybrid/upd",
			context_length: 999,
			config: { fleetRevision: "abc123", endpoint: tokenized },
		})
		const fake = new FakeOmniRouteClient({ combos: [liveNow] })

		const backup = routeBackup(
			[updBackup],
			[{ kind: "combo", id: "hybrid/upd", op: "update", omniRouteId: "cmb-upd", postApplyValue: stripId(updAfter) }],
		)
		const backups = new InMemoryBackupStore()
		await backups.save(backup)
		const audit = new InMemoryAuditLog()

		const result = await rollback("bkp-1", confirm(), deps(fake, { backups, audit }))

		expect(result.outcome).toBe("refused")
		const serialized = JSON.stringify(result.drifted) + JSON.stringify(audit.entries)
		expect(serialized).not.toContain("SECRET-TOKEN")
		expect(serialized).toContain("<redacted>")
	})
})

// ---------------------------------------------------------------------------
// Apply → rollback round-trip (Property 9 / Requirement 9.10)
// ---------------------------------------------------------------------------

describe("rollback — apply/rollback round-trip", () => {
	it("drives a real apply then rollback and returns the live state to pre-apply", async () => {
		// Pre-apply live: an existing `old` to delete and an `upd` to update.
		const oldPre = combo({ id: "cmb-old", name: "hybrid/old", context_length: 100 })
		const updPre = combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 100 })
		const fake = new FakeOmniRouteClient({ combos: [oldPre, updPre] })

		// Capture the exact pre-apply live state for the final comparison.
		const preApply = (await fake.listCombos()).map((c) => ({ ...c })).sort((a, b) => a.name.localeCompare(b.name))

		const backups = new InMemoryBackupStore()
		const audit = new InMemoryAuditLog()
		const locks: InstanceLocks = new Set<string>()

		// Apply: create `new`, update `upd` to 300, delete `old`.
		const plan: ChangePlan = {
			instanceId: INSTANCE,
			revision: REV,
			createdAt: CREATED_AT,
			ops: [
				{ kind: "combo", op: "create", id: "hybrid/new", after: stripId(combo({ name: "hybrid/new", context_length: 200 })) },
				{ kind: "combo", op: "update", id: "hybrid/upd", before: updPre, after: stripId(combo({ id: "cmb-upd", name: "hybrid/upd", context_length: 300 })) },
				{ kind: "combo", op: "delete", id: "hybrid/old", before: oldPre },
			] satisfies ChangeOp[],
			errors: [],
		}

		const applyDeps: ApplyDeps = {
			client: fake,
			backups,
			audit,
			locks,
			clock: clockSeq("2026-10-15T00:00:01.000Z"),
			backupId: () => "bkp-1",
		}
		const applied = await apply(
			plan,
			{ operator: "celes", instanceId: INSTANCE, target: { kind: "plan", revision: REV.commit, createdAt: CREATED_AT }, confirmDeletions: true },
			applyDeps,
		)
		expect(applied.outcome).toBe("succeeded")

		// Rollback to the apply's backup, confirming by its capturedAt.
		const savedBackup = (await backups.load(applied.backupId!))!
		const result = await rollback(
			applied.backupId!,
			confirm({ target: { kind: "backup", capturedAt: savedBackup.capturedAt } }),
			deps(fake, { backups, audit, locks, rolledBackApplyStartedAt: applied.startedAt }),
		)

		expect(result.outcome).toBe("succeeded")

		// Live state equals the pre-apply snapshot, ignoring OmniRoute-assigned ids
		// (the recreated `old` gets a fresh id).
		const after = (await fake.listCombos()).map((c) => ({ ...c })).sort((a, b) => a.name.localeCompare(b.name))
		expect(after.map((c) => c.name)).toEqual(preApply.map((c) => c.name))
		for (const name of preApply.map((c) => c.name)) {
			const pre = preApply.find((c) => c.name === name)!
			const post = after.find((c) => c.name === name)!
			expect(post.context_length).toBe(pre.context_length)
			expect(post.config).toEqual(pre.config)
			expect(post.models).toEqual(pre.models)
		}
		// Everything the apply created is absent.
		expect(after.find((c) => c.name === "hybrid/new")).toBeUndefined()
	})
})
