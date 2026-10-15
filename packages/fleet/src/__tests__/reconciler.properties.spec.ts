// Reconciler property + integration capstone (OmniRoute Fleet Topology, task
// 7.3; Requirements 9.9, 9.10, 11.2, 12.1, 22.4; Properties 8, 9, 10).
//
// The property suite composes the WHOLE Reconciler against the in-memory fake:
// compile → plan → apply → rollback (and detectDrift / decommission for the
// credential-safety sweep). Three properties:
//
//   Property 8 (reconciler idempotence, Requirement 9.9): compile a valid
//   inventory, plan from a clean live state, apply it via the fake, then plan
//   AGAIN with no live change — the second plan carries zero combo ops.
//
//   Property 9 (apply/rollback round-trip, Requirement 9.10): apply a generated
//   plan over a generated live state, then roll back to the apply's backup —
//   every object returns to its pre-apply value and everything the apply created
//   is deleted.
//
//   Property 10 (secret / body absence, Requirement 22.4): with generated secret
//   values and tokenized URL path segments injected, no plan, backup, report,
//   audit entry, or alert produced anywhere in the suite contains any generated
//   secret value or tokenized segment.
//
// The integration tests drive the full inventory → compile → detectDrift → plan
// → apply → rollback cycle example-by-example, covering the mid-apply write
// failure restore path, the drifted-live abort (9.4), the onboarding
// inventory-only no-drift check (11.2), and a decommission plan that removes the
// dead OpenRouter-free and 5090-reader targets (12.1).
//
// The valid-inventory fast-check arbitrary is adapted from
// `inventory.properties.spec.ts` / `compiler.properties.spec.ts`: the
// referential skeleton is fixed-and-valid and the within-bounds values vary. For
// Property 10 the skeleton's secret refs and endpoint addresses are overlaid
// with generated secret values and generated tokenized URL path segments.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { FleetInventory } from "@roo-code/types"

import { compile, type Combo, type DesiredRouteState, type Revision } from "../index.js"
import type { Connection, OmniRouteClient } from "../omniroute/client.js"
import { FakeOmniRouteClient } from "../omniroute/fake.js"
import { detectDrift } from "../reconcile/drift.js"
import {
	apply,
	InMemoryAuditLog,
	InMemoryBackupStore,
	type ApplyDeps,
	type InstanceLocks,
	type OperatorConfirmation,
} from "../reconcile/apply.js"
import { plan, type ChangeOp, type ChangePlan } from "../reconcile/plan.js"
import {
	rollback,
	type InstanceRole,
	type InstanceRoleLookup,
	type RollbackDeps,
} from "../reconcile/rollback.js"
import { decommission } from "../reconcile/decommission.js"

const RUNS = 100

const REV: Revision = { commit: "abc123def456", uncommitted: false }
const INSTANCE = "cluster"

// A fixed, monotonically increasing UTC clock so startedAt/endedAt are
// deterministic and distinct across an apply/rollback. Each call advances 1 s.
function clockSeq(from = "2026-10-15T00:00:01.000Z"): () => string {
	let t = Date.parse(from)
	return () => {
		const iso = new Date(t).toISOString()
		t += 1000
		return iso
	}
}

// ---------------------------------------------------------------------------
// The nine improvement objectives and the live connections for the arbitrary.
// ---------------------------------------------------------------------------

const ALL_OBJECTIVES: FleetInventory["improvementObjectiveOrder"] = [
	"planner-cloud-share",
	"planner-multi-attempt",
	"code-p50",
	"reader-cloud-share",
	"reader-multi-attempt",
	"cloud-input-tokens",
	"capacity-rejections",
	"embeddings-success",
	"model-switches",
]

// The two local endpoints the arbitrary declares, and the live connections that
// resolve them (provider + host:port, matching the inventory addresses below).
// `plan()` fills `connectionId` on local-slot refs from these.
const VLLM_CONN_ID = "conn-vllm"
const OVMS_CONN_ID = "conn-ovms"

function liveConnections(): Connection[] {
	return [
		{ id: VLLM_CONN_ID, provider: "vllm", address: "http://host:2701", isActive: true },
		{ id: OVMS_CONN_ID, provider: "ovms", address: "http://ovms:8000", isActive: true },
	]
}

/**
 * The advertised-models map for the fake, keyed by connection id, built from the
 * inventory's local offerings so a `detectDrift` model-catalog check finds every
 * declared model id advertised (no `missing`/`undeclared` model-id finding). The
 * advertised entries carry NO `contextLength`, so the exposed-context check is
 * skipped (the arbitrary varies offering contexts; an absent advertised context
 * never mismatches — see onboard.spec.ts).
 */
function advertisedModelsFor(inv: FleetInventory): Record<string, { id: string }[]> {
	const byConnection: Record<string, { id: string }[]> = {}
	const connIdForEndpoint = (endpointId: string): string | undefined =>
		endpointId === "vllm" ? VLLM_CONN_ID : endpointId === "ovms" ? OVMS_CONN_ID : undefined
	for (const offering of inv.offerings) {
		const connId = connIdForEndpoint(offering.endpointId)
		if (!connId) {
			continue
		}
		;(byConnection[connId] ??= []).push({ id: offering.modelId })
	}
	return byConnection
}

/** The live connection id that resolves a local-slot ref's endpoint (by endpoint id). */
function connectionIdForSlot(ref: { id: string }): string | undefined {
	// Slot id: t:<device>:<endpoint>:<model>:<index>
	const endpointId = ref.id.startsWith("t:") ? ref.id.split(":")[2] : undefined
	if (endpointId === "vllm") return VLLM_CONN_ID
	if (endpointId === "ovms") return OVMS_CONN_ID
	return undefined
}

// ---------------------------------------------------------------------------
// Arbitrary: a valid, compilable FleetInventory.
// ---------------------------------------------------------------------------
//
// Adapted from compiler.properties.spec.ts. The skeleton is fixed-and-valid; the
// `overlay` callback (used by the secret-bearing variant) may rewrite secret
// refs and endpoint addresses with generated values. The lane minimum stays at
// or below the context floor (1024) so every local Slot clears it and compile()
// succeeds by design.

const spend = fc.constantFrom("free" as const, "low-budget" as const, "paid" as const)
const context = fc.integer({ min: 1024, max: 1_000_000 })
const maxQueueMs = fc.integer({ min: 0, max: 120_000 })
const backupRetention = fc.integer({ min: 1, max: 1000 })
const extraTag = fc.constantFrom("tools", "vision", "long", "json")
const chatTags = fc.uniqueArray(extraTag, { minLength: 0, maxLength: 3 }).map((xs) => ["chat", ...xs])
const slotCeiling = fc.integer({ min: 2, max: 64 })

const ranksOfLength = (slots: number): fc.Arbitrary<number[]> =>
	fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: slots, maxLength: slots })

/** The overlay applied to the skeleton: inject secret refs / tokenized addresses. */
interface InventoryOverlay {
	readonly vllmSecretRef?: string
	readonly mgmtSecretRef?: string
	readonly alertSecretRef?: string
	readonly vllmAddressUrl?: string
	readonly instanceAddress?: string
	readonly alertUrl?: string
}

function makeInventoryArb(overlayArb: fc.Arbitrary<InventoryOverlay>): fc.Arbitrary<FleetInventory> {
	return fc
		.record({
			gpuCeiling: slotCeiling,
			arcCeiling: slotCeiling,
			gpuSwap: fc.integer({ min: 0, max: 600_000 }),
			arcSwap: fc.integer({ min: 0, max: 600_000 }),
			coderContext: context,
			embedContext: context,
			rerankContext: context,
			cloudContext: context,
			coderSlots: fc.integer({ min: 1, max: 2 }),
			embedSlots: fc.integer({ min: 1, max: 2 }),
			rerankSlots: fc.integer({ min: 1, max: 2 }),
			gpuPreempt: fc.boolean(),
			arcPreempt: fc.boolean(),
			coderTags: chatTags,
			cloudTags: chatTags,
			laneMinContext: fc.integer({ min: 1, max: 1024 }),
			laneFailClosed: fc.boolean(),
			laneSpend: spend,
			laneQueue: maxQueueMs,
			retention: backupRetention,
			objectiveOrder: fc
				.shuffledSubarray(ALL_OBJECTIVES, {
					minLength: ALL_OBJECTIVES.length,
					maxLength: ALL_OBJECTIVES.length,
				})
				.map((xs) => [...xs] as FleetInventory["improvementObjectiveOrder"]),
			overlay: overlayArb,
		})
		.chain((seed) =>
			fc
				.tuple(ranksOfLength(seed.coderSlots), ranksOfLength(seed.embedSlots), ranksOfLength(seed.rerankSlots))
				.map(([coderRanks, embedRanks, rerankRanks]): FleetInventory => {
					const o = seed.overlay
					const spillFor = (max: "free" | "low-budget" | "paid"): ("free" | "low-budget" | "paid")[] =>
						max === "free" ? ["free"] : ["free", max]

					const lane = (
						id: string,
						name: string,
						capabilities: string[],
						capabilityLanes: FleetInventory["lanes"][number]["capabilityLanes"],
					): FleetInventory["lanes"][number] => ({
						id,
						names: [name],
						capabilities,
						minContext: seed.laneMinContext,
						order: "fill-first",
						maxSpend: seed.laneSpend,
						spillTiers: spillFor(seed.laneSpend),
						failClosed: seed.laneFailClosed,
						maxQueueMs: seed.laneQueue,
						capabilityLanes,
					})

					return {
						devices: [
							{ id: "gpu0", slotCeiling: seed.gpuCeiling, hostPreemption: seed.gpuPreempt },
							{ id: "arc0", slotCeiling: seed.arcCeiling, hostPreemption: seed.arcPreempt },
						],
						endpoints: [
							{
								id: "vllm",
								provider: "vllm",
								deviceIds: ["gpu0"],
								addresses: [
									{ instanceId: INSTANCE, url: o.vllmAddressUrl ?? "http://host:2701" },
								],
								secretRef: o.vllmSecretRef ?? "vllm_key",
								noCredential: false,
							},
							{
								id: "ovms",
								provider: "ovms",
								deviceIds: ["arc0"],
								addresses: [{ instanceId: INSTANCE, url: "http://ovms:8000" }],
								noCredential: true,
							},
						],
						residencyGroups: [
							{ id: "r0", swapLatencyMs: seed.gpuSwap },
							{ id: "r1", swapLatencyMs: seed.arcSwap },
						],
						offerings: [
							{
								id: "coder",
								endpointId: "vllm",
								deviceId: "gpu0",
								modelId: "qwen-coder",
								context: seed.coderContext,
								slots: seed.coderSlots,
								residencyGroup: "r0",
								tags: ["code", "read", ...seed.coderTags.filter((t) => t !== "chat")].concat(["chat"]),
								ranks: coderRanks,
							},
							{
								id: "embed",
								endpointId: "ovms",
								deviceId: "arc0",
								modelId: "qwen-embed",
								context: seed.embedContext,
								slots: seed.embedSlots,
								residencyGroup: "r1",
								tags: ["embed"],
								ranks: embedRanks,
							},
							{
								id: "rerank",
								endpointId: "ovms",
								deviceId: "arc0",
								modelId: "qwen-rerank",
								context: seed.rerankContext,
								slots: seed.rerankSlots,
								residencyGroup: "r1",
								tags: ["rerank"],
								ranks: rerankRanks,
							},
						],
						clouds: [
							{
								id: "codestral",
								provider: "mistral",
								modelId: "codestral",
								spend: seed.laneSpend,
								context: seed.cloudContext,
								tags: seed.cloudTags,
							},
						],
						lanes: [
							lane("code", "hybrid/code", ["chat", "code"], ["coder.primary"]),
							lane("research", "hybrid/research", ["chat"], []),
							lane("fast", "hybrid/fast", ["chat"], []),
							lane("planner", "hybrid/planner", ["chat"], ["reasoning.escalation"]),
							lane("reader", "hybrid/reader", ["chat", "read"], ["reader.fast", "reader.deep"]),
							lane("reviewer", "hybrid/reviewer", ["chat"], []),
							lane("frontier", "hybrid/frontier", ["chat"], []),
							lane("tester", "hybrid/tester", ["chat"], []),
							lane("embed-lane", "memory/embed", ["embed"], []),
							lane("rerank-lane", "memory/rerank", ["rerank"], []),
						],
						instances: [
							{
								id: INSTANCE,
								role: "primary",
								address: o.instanceAddress ?? "https://omniroute",
								secretRef: o.mgmtSecretRef ?? "mgmt_key",
								backupRetention: seed.retention,
							},
						],
						diagnostics: [{ id: "diag/gpu0", deviceId: "gpu0" }],
						alertDestination: { url: o.alertUrl ?? "https://alerts", secretRef: o.alertSecretRef ?? "alert_key" },
						improvementObjectiveOrder: seed.objectiveOrder,
					}
				}),
		)
}

/** The plain valid inventory arbitrary (no injected secrets). */
const inventoryArb = makeInventoryArb(fc.constant({}))

// ---------------------------------------------------------------------------
// Live-state helpers.
// ---------------------------------------------------------------------------

function desiredState(inv: FleetInventory): DesiredRouteState {
	const result = compile(inv, REV)
	if (!result.ok) {
		throw new Error(`fixture failed to compile: ${JSON.stringify(result.failures)}`)
	}
	const state = result.states.get(INSTANCE)
	if (!state) {
		throw new Error("fixture produced no state for cluster")
	}
	return state
}

/**
 * The live combos of a clean, no-drift fleet: the compiled Desired_Route_State
 * with each local-slot ref's `connectionId` filled to the live connection
 * `plan()` would resolve (the compiler leaves it empty, the Reconciler fills it).
 * These carry the `fleetRevision` provenance key the compiler emits, so the plan
 * treats them as managed.
 */
function cleanCombos(inv: FleetInventory): Combo[] {
	return desiredState(inv).combos.map((c) => ({
		...structuredClone(c),
		models: c.models.map((m) => {
			if (!m.id.startsWith("t:")) {
				return structuredClone(m)
			}
			const connectionId = connectionIdForSlot(m)
			return connectionId ? { ...structuredClone(m), connectionId } : structuredClone(m)
		}),
	}))
}

/** A matching apply confirmation for a plan built at `createdAt`. */
function confirmFor(changePlan: ChangePlan, confirmDeletions = true): OperatorConfirmation {
	return {
		operator: "celes",
		instanceId: changePlan.instanceId,
		target: { kind: "plan", revision: changePlan.revision.commit, createdAt: changePlan.createdAt },
		confirmDeletions,
	}
}

/** The apply dependency bundle with in-memory stores and a deterministic clock. */
function applyDeps(client: FakeOmniRouteClient, overrides: Partial<ApplyDeps> = {}): ApplyDeps {
	let seq = 0
	return {
		client,
		backups: overrides.backups ?? new InMemoryBackupStore(),
		audit: overrides.audit ?? new InMemoryAuditLog(),
		locks: overrides.locks ?? new Set<string>(),
		clock: overrides.clock ?? clockSeq(),
		withWriteDeadline: overrides.withWriteDeadline,
		withBackupDeadline: overrides.withBackupDeadline,
		backupRetention: overrides.backupRetention,
		backupId: overrides.backupId ?? (() => `bkp-${++seq}`),
	}
}

/** An instance-role lookup: the fleet's single instance is primary. */
function roles(map: Record<string, InstanceRole> = { [INSTANCE]: "primary" }): InstanceRoleLookup {
	return { roleOf: (id) => map[id] }
}

/** The rollback dependency bundle sharing stores/locks with an apply. */
function rollbackDeps(
	client: FakeOmniRouteClient,
	backups: InMemoryBackupStore,
	overrides: Partial<RollbackDeps> = {},
): RollbackDeps {
	return {
		client,
		backups,
		audit: overrides.audit ?? new InMemoryAuditLog(),
		locks: overrides.locks ?? new Set<string>(),
		roles: overrides.roles ?? roles(),
		clock: overrides.clock ?? clockSeq("2026-10-15T01:00:00.000Z"),
		withWriteDeadline: overrides.withWriteDeadline,
		rolledBackApplyStartedAt: overrides.rolledBackApplyStartedAt,
	}
}

/** The combo ops of a plan (the create/update/delete the suite reasons about). */
function comboOps(changePlan: ChangePlan): readonly ChangeOp[] {
	return changePlan.ops.filter((op) => op.kind === "combo")
}

/** A combo value without its OmniRoute-assigned id, mirroring a plan `after`. */
function stripId(c: Combo): Omit<Combo, "id"> {
	const { id: _ignored, ...rest } = c
	void _ignored
	return rest
}

// ---------------------------------------------------------------------------
// Property 8: Reconciler idempotence (Requirement 9.9).
// ---------------------------------------------------------------------------

describe("Reconciler property suite — idempotence", () => {
	// Feature: omniroute-fleet-topology, Property 8: Reconciler idempotence —
	// plan → apply → plan (no live change) yields an empty plan.
	it("Property 8: apply then re-plan with no live change yields zero combo ops", async () => {
		await fc.assert(
			fc.asyncProperty(inventoryArb, async (model) => {
				// Plan from a CLEAN empty live state (only the connections exist),
				// so the first plan is all-creates.
				const fake = new FakeOmniRouteClient({ connections: liveConnections() })
				const first = await plan(model, REV, INSTANCE, fake, { clock: clockSeq() })
				expect(first.errors).toEqual([])
				expect(comboOps(first).length).toBeGreaterThan(0)

				// Apply the plan via the fake (the sole writer path).
				const result = await apply(first, confirmFor(first), applyDeps(fake))
				expect(result.outcome).toBe("succeeded")

				// Re-plan with NO live change: the live state now equals desired, so
				// the second plan carries zero combo ops (Requirement 9.9).
				const second = await plan(model, REV, INSTANCE, fake, { clock: clockSeq() })
				expect(second.errors).toEqual([])
				expect(comboOps(second)).toEqual([])
			}),
			{ numRuns: RUNS },
		)
	})
})

// ---------------------------------------------------------------------------
// Property 9: Apply / rollback round-trip (Requirement 9.10).
// ---------------------------------------------------------------------------

describe("Reconciler property suite — apply/rollback round-trip", () => {
	// Feature: omniroute-fleet-topology, Property 9: Apply/rollback round-trip —
	// apply then rollback restores every object and deletes every created object.
	it("Property 9: apply then rollback returns the live state to pre-apply", async () => {
		await fc.assert(
			fc.asyncProperty(inventoryArb, fc.boolean(), async (model, startFromClean) => {
				// Two live-state shapes to vary the ops the apply must perform and
				// then undo:
				//   startFromClean=false → empty live (all creates to undo by delete)
				//   startFromClean=true  → a drifted clean state (an update + an extra
				//     managed combo to delete, so rollback recreates the deleted one).
				let seedCombos: Combo[]
				if (startFromClean) {
					const clean = cleanCombos(model)
					// Mutate one combo so the plan emits an update, and append an
					// extra managed combo so the plan emits a delete the rollback
					// must then recreate.
					seedCombos = clean.map((c, i) =>
						i === 0 ? { ...c, context_length: (c.context_length ?? 0) + 123 } : c,
					)
					seedCombos.push({
						id: "cmb-extra",
						name: "hybrid/extra-managed",
						strategy: "priority",
						models: [{ id: "t:gpu0:vllm:qwen-coder:0", kind: "model", model: "qwen-coder", connectionId: VLLM_CONN_ID }],
						config: { fleetRevision: "old-commit" },
						context_length: 4242,
						isHidden: false,
					})
				} else {
					seedCombos = []
				}

				const fake = new FakeOmniRouteClient({ combos: seedCombos, connections: liveConnections() })

				// Capture the exact pre-apply live state for the final comparison.
				const preApply = (await fake.listCombos())
					.map((c) => ({ ...c }))
					.sort((a, b) => a.name.localeCompare(b.name))

				const built = await plan(model, REV, INSTANCE, fake, { clock: clockSeq() })
				expect(built.errors).toEqual([])

				const backups = new InMemoryBackupStore()
				const locks: InstanceLocks = new Set<string>()
				const applied = await apply(built, confirmFor(built), applyDeps(fake, { backups, locks }))
				expect(applied.outcome).toBe("succeeded")

				// If the plan had nothing to do (live already equalled desired) there
				// is nothing to round-trip; the property holds vacuously.
				if (comboOps(built).length === 0) {
					return
				}

				const savedBackup = (await backups.load(applied.backupId!))!
				const result = await rollback(
					applied.backupId!,
					{ operator: "celes", instanceId: INSTANCE, target: { kind: "backup", capturedAt: savedBackup.capturedAt }, confirmDeletions: false },
					rollbackDeps(fake, backups, { locks, rolledBackApplyStartedAt: applied.startedAt }),
				)
				expect(result.outcome === "succeeded" || result.outcome === "no-changes").toBe(true)

				// Every pre-apply object is back to its pre-apply value (ignoring the
				// OmniRoute-assigned id — a recreated combo gets a fresh id), and
				// nothing the apply created survives.
				const after = (await fake.listCombos())
					.map((c) => ({ ...c }))
					.sort((a, b) => a.name.localeCompare(b.name))

				expect(after.map((c) => c.name)).toEqual(preApply.map((c) => c.name))
				for (const pre of preApply) {
					const post = after.find((c) => c.name === pre.name)!
					expect(stripId(post)).toEqual(stripId(pre))
				}
			}),
			{ numRuns: RUNS },
		)
	})
})

// ---------------------------------------------------------------------------
// Property 10: Secret and body absence (Requirement 22.4).
// ---------------------------------------------------------------------------

describe("Reconciler property suite — secret / body absence", () => {
	// A generated secret value (never a secret REF): a credential value that must
	// never leak. Kept free of characters that would make it a valid secret-ref.
	const secretValueArb = fc
		.string({ minLength: 8, maxLength: 24, unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-".split("")) })
		.map((s) => `sk-LEAK-${s}`)

	// A generated tokenized URL path segment, placed after /api/v1/vscode/ so the
	// redactor recognises it. The token itself must never appear in any artifact.
	const tokenArb = fc
		.string({ minLength: 6, maxLength: 20, unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")) })
		.map((s) => `TOK${s}`)

	// Build the overlay from a raw (secret, token) pair: the secret value is
	// injected into every secret-ref slot (so a leak of the "ref" would leak the
	// value) and the token into the vllm endpoint address, the instance address,
	// and the alert URL as a tokenized /api/v1/vscode/<token>/ segment.
	const overlayFor = (secret: string, token: string): InventoryOverlay => ({
		vllmSecretRef: secret,
		mgmtSecretRef: secret,
		alertSecretRef: secret,
		vllmAddressUrl: `http://host:2701/api/v1/vscode/${token}/models`,
		instanceAddress: `https://omniroute/api/v1/vscode/${token}/mgmt`,
		alertUrl: `https://alerts/api/v1/vscode/${token}/hook`,
	})

	// Carry the raw secret/token alongside the generated model so the assertion
	// can look for the exact injected values (shrinking preserves all three).
	const secretBearingArb = fc
		.record({ secret: secretValueArb, token: tokenArb })
		.chain(({ secret, token }) =>
			makeInventoryArb(fc.constant(overlayFor(secret, token))).map((model) => ({ model, secret, token })),
		)

	// Feature: omniroute-fleet-topology, Property 10: Secret and body absence —
	// no plan/backup/report/audit/alert produced across plan/apply/rollback/
	// detectDrift/decommission contains any generated secret value or tokenized
	// URL path segment.
	it("Property 10: no artifact contains a generated secret value or tokenized segment", async () => {
		await fc.assert(
			fc.asyncProperty(secretBearingArb, async ({ model, secret, token }) => {
				// A tokenized segment carried inside a LIVE combo config, so the
				// plan/backup/drift artifacts would leak it unless redacted.
				const live = cleanCombos(model).map((c, i) =>
					i === 0
						? {
								...c,
								context_length: (c.context_length ?? 0) + 7,
								config: {
									...c.config,
									probeUrl: `https://host/api/v1/vscode/${token}/combos`,
								},
							}
						: c,
				)
				const fake = new FakeOmniRouteClient({ combos: live, connections: liveConnections() })

				const artifacts: unknown[] = []

				// --- plan ---------------------------------------------------------
				const built = await plan(model, REV, INSTANCE, fake, { clock: clockSeq() })
				artifacts.push(built)

				// --- apply --------------------------------------------------------
				const backups = new InMemoryBackupStore()
				const audit = new InMemoryAuditLog()
				const locks: InstanceLocks = new Set<string>()
				const applied = await apply(built, confirmFor(built), applyDeps(fake, { backups, audit, locks }))
				artifacts.push(applied)
				artifacts.push(audit.entries)
				if (applied.backupId) {
					artifacts.push(await backups.load(applied.backupId))
				}

				// --- rollback -----------------------------------------------------
				if (applied.outcome === "succeeded" && applied.backupId && comboOps(built).length > 0) {
					const savedBackup = (await backups.load(applied.backupId))!
					const rollbackAudit = new InMemoryAuditLog()
					const rolled = await rollback(
						applied.backupId,
						{ operator: "celes", instanceId: INSTANCE, target: { kind: "backup", capturedAt: savedBackup.capturedAt }, confirmDeletions: false },
						rollbackDeps(fake, backups, { audit: rollbackAudit, locks, rolledBackApplyStartedAt: applied.startedAt }),
					)
					artifacts.push(rolled)
					artifacts.push(rollbackAudit.entries)
				}

				// --- detectDrift (over a fresh live state carrying the token) -----
				const driftFake = new FakeOmniRouteClient({ combos: live, connections: liveConnections() })
				const clients = new Map<string, OmniRouteClient>([[INSTANCE, driftFake]])
				const drift = await detectDrift(model, REV, clients, {
					readAttempts: 1,
					readTimeoutMs: 0,
					sleep: async () => {},
				})
				artifacts.push(drift)

				// --- decommission (NEW inventory identical: no-op diff) -----------
				const decommFake = new FakeOmniRouteClient({ combos: live, connections: liveConnections() })
				const decomm = await decommission(model, model, REV, INSTANCE, decommFake, { clock: clockSeq() })
				artifacts.push(decomm)

				// No artifact serialized anywhere contains the generated secret
				// value or the tokenized segment.
				const serialized = JSON.stringify(artifacts)
				expect(serialized.includes(secret)).toBe(false)
				expect(serialized.includes(token)).toBe(false)
			}),
			{ numRuns: RUNS },
		)
	})
})

// ---------------------------------------------------------------------------
// Integration tests — the full cycle on the fake.
// ---------------------------------------------------------------------------

describe("Reconciler integration — full inventory → compile → drift → plan → apply → rollback", () => {
	it("drives the whole cycle on the fake and returns the live state to pre-apply", async () => {
		const model = fc.sample(inventoryArb, { numRuns: 1, seed: 7 })[0]!

		// Pre-apply live: empty combos (only connections + their advertised models,
		// so the model-catalog check is clean and the only drift is the missing
		// combos). detectDrift reports every desired combo missing; plan is all-
		// creates.
		const fake = new FakeOmniRouteClient({
			connections: liveConnections(),
			advertisedModels: advertisedModelsFor(model),
		})

		const clients = new Map<string, OmniRouteClient>([[INSTANCE, fake]])
		const driftBefore = await detectDrift(model, REV, clients, { readAttempts: 1, readTimeoutMs: 0, sleep: async () => {} })
		const clusterBefore = driftBefore.instances.find((i) => i.instanceId === INSTANCE)!
		expect(clusterBefore.differences.some((d) => d.object === "combo" && d.kind === "missing")).toBe(true)

		// Plan → apply.
		const built = await plan(model, REV, INSTANCE, fake, { clock: clockSeq() })
		expect(built.errors).toEqual([])
		const backups = new InMemoryBackupStore()
		const locks: InstanceLocks = new Set<string>()
		const applied = await apply(built, confirmFor(built), applyDeps(fake, { backups, locks }))
		expect(applied.outcome).toBe("succeeded")

		// A drift run after apply reports no missing/extra/changed combos.
		const driftAfter = await detectDrift(model, REV, new Map([[INSTANCE, fake]]), {
			readAttempts: 1,
			readTimeoutMs: 0,
			sleep: async () => {},
		})
		const clusterAfter = driftAfter.instances.find((i) => i.instanceId === INSTANCE)!
		expect(clusterAfter.counts.missing).toBe(0)
		expect(clusterAfter.counts.extra).toBe(0)
		expect(clusterAfter.counts.changed).toBe(0)

		// Rollback returns the live state to the pre-apply (empty) snapshot.
		const savedBackup = (await backups.load(applied.backupId!))!
		const rolled = await rollback(
			applied.backupId!,
			{ operator: "celes", instanceId: INSTANCE, target: { kind: "backup", capturedAt: savedBackup.capturedAt }, confirmDeletions: false },
			rollbackDeps(fake, backups, { locks, rolledBackApplyStartedAt: applied.startedAt }),
		)
		expect(rolled.outcome).toBe("succeeded")
		expect(await fake.listCombos()).toEqual([])
	})

	it("restores every written object on a mid-apply write failure (9.6)", async () => {
		const model = fc.sample(inventoryArb, { numRuns: 1, seed: 11 })[0]!

		// A clean live state so the plan has updates to perform; mutate one combo
		// so there is at least one update, and script the create of a NEW combo to
		// fail so the restore sweep must undo the earlier writes.
		const clean = cleanCombos(model)
		const mutated = clean.map((c, i) => (i === 0 ? { ...c, context_length: (c.context_length ?? 0) + 99 } : c))
		// Drop one combo from the live state so the plan creates it; that create is
		// the write we fail.
		const dropped = mutated[mutated.length - 1]!
		const liveMinusOne = mutated.slice(0, mutated.length - 1)
		const fake = new FakeOmniRouteClient({ combos: liveMinusOne, connections: liveConnections() })

		// Capture pre-apply live for the restore comparison.
		const preApply = (await fake.listCombos()).map((c) => ({ ...c })).sort((a, b) => a.name.localeCompare(b.name))

		// Fail every createCombo write (the plan creates the dropped combo).
		fake.scriptFailure({ operation: "createCombo", kind: "writeError", status: 500 })

		const built = await plan(model, REV, INSTANCE, fake, { clock: clockSeq() })
		expect(built.errors).toEqual([])
		// Sanity: the plan creates the dropped combo.
		expect(comboOps(built).some((op) => op.op === "create" && op.id === dropped.name)).toBe(true)

		const result = await apply(built, confirmFor(built), applyDeps(fake))
		expect(result.outcome).toBe("failed-and-restored")
		expect(result.restores!.every((r) => r.restored)).toBe(true)

		// Live is back to the pre-apply snapshot (ignoring OmniRoute-assigned ids).
		const after = (await fake.listCombos()).map((c) => ({ ...c })).sort((a, b) => a.name.localeCompare(b.name))
		expect(after.map((c) => c.name)).toEqual(preApply.map((c) => c.name))
		for (const pre of preApply) {
			const post = after.find((c) => c.name === pre.name)!
			expect(stripId(post)).toEqual(stripId(pre))
		}
	})

	it("aborts when the live state drifts between plan and apply (9.4)", async () => {
		const model = fc.sample(inventoryArb, { numRuns: 1, seed: 13 })[0]!

		// A clean live state. Plan it (no ops yet since it's clean), so force an
		// update by seeding a drifted combo the plan will target, then mutate the
		// live state AGAIN after the plan so the apply's snapshot differs from the
		// plan.before value → the 9.4 abort.
		const clean = cleanCombos(model)
		const target = clean[0]!
		const drifted = clean.map((c, i) => (i === 0 ? { ...c, context_length: (c.context_length ?? 0) + 50 } : c))
		const fake = new FakeOmniRouteClient({ combos: drifted, connections: liveConnections() })

		const built = await plan(model, REV, INSTANCE, fake, { clock: clockSeq() })
		const update = comboOps(built).find((op) => op.op === "update" && op.id === target.name)
		expect(update).toBeDefined()

		// Mutate the live combo AGAIN so it no longer matches the plan.before value.
		const liveNow = (await fake.listCombos()).find((c) => c.name === target.name)!
		const freshFake = new FakeOmniRouteClient({
			combos: (await fake.listCombos()).map((c) =>
				c.name === target.name ? { ...c, context_length: (liveNow.context_length ?? 0) + 777 } : c,
			),
			connections: liveConnections(),
		})

		const result = await apply(built, confirmFor(built), applyDeps(freshFake))
		expect(result.outcome).toBe("aborted")
		expect(result.drifted!.length).toBeGreaterThan(0)
		expect(result.drifted!.some((d) => d.id === target.name)).toBe(true)
		// No write issued (aborted before the first write).
		expect(freshFake.calls().filter((c) => c.operation === "updateCombo")).toHaveLength(0)
	})
})

describe("Reconciler integration — onboarding inventory-only no-drift (11.2)", () => {
	it("edits the inventory, plans + applies, and finds no drift for the new entries", async () => {
		// BASE: a fleet with the standard offerings. ONBOARDED: adds a new offering
		// on a new device/endpoint (an inventory-only edit). We seed the live state
		// with the BASE combos (clean) plus a live connection for the new endpoint,
		// then plan+apply the onboarded inventory and confirm detectDrift sees no
		// drift for the new entries (Requirement 11.2).
		const base = fc.sample(inventoryArb, { numRuns: 1, seed: 21 })[0]!

		// The onboarded inventory adds a third device/endpoint/offering serving the
		// code lane (same tags as coder), driven by a brand-new connection.
		const onboarded: FleetInventory = {
			...base,
			devices: [...base.devices, { id: "gpu1", slotCeiling: 8, hostPreemption: false }],
			endpoints: [
				...base.endpoints,
				{
					id: "vllm2",
					provider: "vllm",
					deviceIds: ["gpu1"],
					addresses: [{ instanceId: INSTANCE, url: "http://host2:2701" }],
					secretRef: "vllm2_key",
					noCredential: false,
				},
			],
			residencyGroups: [...base.residencyGroups, { id: "r2", swapLatencyMs: 0 }],
			offerings: [
				...base.offerings,
				{
					id: "reader2",
					endpointId: "vllm2",
					deviceId: "gpu1",
					modelId: "qwen-reader2",
					context: 128_000,
					slots: 1,
					residencyGroup: "r2",
					tags: ["chat", "code", "read"],
					ranks: [9],
				},
			],
		}

		// Live state: the BASE combos (clean) plus both connections (vllm +
		// vllm2 pre-created live so the plan resolves them).
		const baseLive = cleanCombos(base)
		const connections: Connection[] = [
			...liveConnections(),
			{ id: "conn-vllm2", provider: "vllm", address: "http://host2:2701", isActive: true },
		]
		// Advertised models for every connection, including the new reader2 model
		// on conn-vllm2, so the post-apply model-catalog check is clean and only
		// the combos (if any) could register as drift.
		const advertisedModels: Record<string, { id: string }[]> = {
			...advertisedModelsFor(base),
			"conn-vllm2": [{ id: "qwen-reader2" }],
		}
		const fake = new FakeOmniRouteClient({ combos: baseLive, connections, advertisedModels })

		// Plan + apply the onboarded (edited) inventory.
		const built = await plan(onboarded, REV, INSTANCE, fake, { clock: clockSeq() })
		expect(built.errors).toEqual([])
		const applied = await apply(built, confirmFor(built), applyDeps(fake))
		expect(applied.outcome).toBe("succeeded")

		// A drift run after apply reports no drift for the fleet, including the new
		// reader2 entries (Requirement 11.2 — the onboarding was inventory-only).
		const drift = await detectDrift(onboarded, REV, new Map([[INSTANCE, fake]]), {
			readAttempts: 1,
			readTimeoutMs: 0,
			sleep: async () => {},
		})
		const cluster = drift.instances.find((i) => i.instanceId === INSTANCE)!
		expect(cluster.counts.missing).toBe(0)
		expect(cluster.counts.extra).toBe(0)
		expect(cluster.counts.changed).toBe(0)

		// Specifically: the NEW reader2 entries show no drift difference.
		const newEntryDiffs = cluster.differences.filter((d) => JSON.stringify(d).includes("qwen-reader2"))
		expect(newEntryDiffs).toEqual([])
	})
})

describe("Reconciler integration — decommission removes dead targets (12.1)", () => {
	it("plans deletion of the dead OpenRouter-free and 5090-reader targets dropped from the new inventory", async () => {
		// OLD: the standard fleet plus two dead targets live today — a 5090-reader
		// offering and an OpenRouter-free cloud. NEW: both dropped. The decommission
		// plan must remove every live reference to the dead targets (Requirement
		// 12.1); no desired combo it emits references either.
		const base = fc.sample(inventoryArb, { numRuns: 1, seed: 31 })[0]!

		const dead5090 = {
			id: "reader-5090",
			endpointId: "vllm",
			deviceId: "gpu0",
			modelId: "reader-5090-model",
			context: 160_000,
			slots: 1,
			residencyGroup: "r0",
			tags: ["chat", "code", "read"],
			ranks: [7],
		}
		const openRouterFree = {
			id: "or-free-27b",
			provider: "openrouter",
			modelId: "free-27b",
			spend: "free" as const,
			context: 256_000,
			tags: ["chat", "code"],
		}

		const old: FleetInventory = {
			...base,
			offerings: [...base.offerings, dead5090],
			clouds: [...base.clouds, openRouterFree],
		}
		const next = base // both dead targets dropped.

		// Live state: the OLD compiled combos (which reference the dead 5090 slot).
		const liveCombos = cleanCombos(old)
		const serializedLive = JSON.stringify(liveCombos)
		expect(serializedLive).toContain("reader-5090-model")

		const fake = new FakeOmniRouteClient({ combos: liveCombos, connections: liveConnections() })
		const result = await decommission(old, next, REV, INSTANCE, fake, { clock: clockSeq() })

		// No desired combo the plan emits references either dead target.
		const serializedAfter = JSON.stringify(result.ops.filter((o) => o.kind === "combo").map((o) => o.after))
		expect(serializedAfter).not.toContain("reader-5090-model")
		expect(serializedAfter).not.toContain("free-27b")

		// The live combos carrying the dead 5090 slot are updated/deleted so the
		// dead target is removed from every route (Requirement 12.1).
		const deadReferencedAfterApply = result.ops.filter(
			(o) => o.kind === "combo" && o.after && JSON.stringify(o.after).includes("reader-5090-model"),
		)
		expect(deadReferencedAfterApply).toEqual([])
	})
})
