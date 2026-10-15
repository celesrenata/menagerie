import { z } from "zod"

/**
 * Fleet_Inventory Zod vocabulary (OmniRoute Fleet Topology, design §1).
 *
 * Shared from `@roo-code/types` so the Menagerie_Client and the `packages/fleet`
 * toolkit parse, validate, compile, and read the same inventory. The schemas
 * encode the structural shape and the numeric bounds from Requirement 1; the
 * cross-field, referential, uniqueness, role, and secret rules of Requirement 2
 * and Requirement 3 live in the Inventory_Validator, not here.
 */

// Requirement 1.6 — Spend_Class of a Cloud_Target / lane spill tier.
export const spendClass = z.enum(["free", "low-budget", "paid"])

export type SpendClass = z.infer<typeof spendClass>

// Requirement 1.1 — a Device with its slot ceiling and host-preemption flag.
export const deviceSchema = z.object({
	id: z.string(),
	slotCeiling: z.number().int().min(1).max(64),
	hostPreemption: z.boolean(),
})

export type Device = z.infer<typeof deviceSchema>

// Requirement 1.3 — a serving Endpoint: provider, the Devices it serves, the
// per-instance network address, and either a credential reference or an
// explicit no-credential statement (Requirement 1.8).
export const endpointAddressSchema = z.object({
	instanceId: z.string(),
	url: z.string(),
})

export const endpointSchema = z.object({
	id: z.string(),
	provider: z.string(),
	deviceIds: z.array(z.string()).min(1),
	addresses: z.array(endpointAddressSchema).min(1),
	secretRef: z.string().optional(),
	noCredential: z.boolean().default(false),
})

export type Endpoint = z.infer<typeof endpointSchema>

// Requirement 1.5 — a Residency_Group with its measured swap latency.
export const residencyGroupSchema = z.object({
	id: z.string(),
	swapLatencyMs: z.number().int().min(0),
})

export type ResidencyGroup = z.infer<typeof residencyGroupSchema>

// Requirement 1.2 — a Model_Offering: one advertised model on one Device via one
// Endpoint, with its context window, slot count, residency group, capability
// tags, and one Performance_Rank per slot (ranks.length === slots, Req 2.11).
export const modelOfferingSchema = z.object({
	id: z.string(),
	endpointId: z.string(),
	deviceId: z.string(),
	modelId: z.string(), // advertised id, char-for-char
	context: z.number().int().min(1).max(16_777_216),
	slots: z.number().int().min(1).max(64),
	residencyGroup: z.string(),
	tags: z.array(z.string().min(1).max(64)).min(1).max(32),
	ranks: z.array(z.number().int().min(1).max(1000)), // length === slots (Req 2.11)
})

export type ModelOffering = z.infer<typeof modelOfferingSchema>

// Requirement 1.6 — a Cloud_Target: a cloud model with its Spend_Class.
export const cloudTargetSchema = z.object({
	id: z.string(),
	provider: z.string(),
	modelId: z.string(),
	spend: spendClass,
	context: z.number().int().min(1).max(16_777_216),
	tags: z.array(z.string().min(1).max(64)).min(1).max(32),
})

export type CloudTarget = z.infer<typeof cloudTargetSchema>

// The four Capability_Lanes a lane may map (Requirement 3.4).
export const capabilityLane = z.enum(["reader.fast", "reader.deep", "coder.primary", "reasoning.escalation"])

export type CapabilityLane = z.infer<typeof capabilityLane>

// Requirement 1.7 — a Lane_Definition: the Public_Route name(s), required
// capabilities, context floor, ordering policy, spend ceiling, spill tiers, and
// the Capability_Lanes it serves.
export const laneSchema = z.object({
	id: z.string(),
	names: z.array(z.string()).min(1), // names[0] is the Public_Route
	capabilities: z.array(z.string()).min(1).max(32),
	minContext: z.number().int().min(1).max(16_777_216),
	order: z.enum(["fill-first"]), // only policy in v1
	maxSpend: spendClass,
	spillTiers: z.array(spendClass).max(8), // each is one Spend_Class (Req 3.1)
	failClosed: z.boolean(),
	maxQueueMs: z.number().int().min(0).max(120_000).default(30_000),
	capabilityLanes: z.array(capabilityLane).max(4),
})

export type Lane = z.infer<typeof laneSchema>

// Requirement 1.13/1.14/1.15 — an OmniRoute_Instance: its role, the address the
// Reconciler reaches it at, an optional credential reference, and the
// Route_Backup retention count.
export const instanceSchema = z.object({
	id: z.string(),
	role: z.enum(["primary", "secondary", "retired"]),
	address: z.string(),
	secretRef: z.string().optional(),
	backupRetention: z.number().int().min(1).max(1000).default(20),
})

export type Instance = z.infer<typeof instanceSchema>

// Requirement 12.7 — a Diagnostic_Route pinned to a declared Device.
export const diagnosticSchema = z.object({
	id: z.string(),
	deviceId: z.string(),
})

export type Diagnostic = z.infer<typeof diagnosticSchema>

// The Alert_Destination the Reconciler and Fleet_Observer write summaries to.
export const alertDestinationSchema = z.object({
	url: z.string(),
	secretRef: z.string().optional(),
})

export type AlertDestination = z.infer<typeof alertDestinationSchema>

// Requirement 20.6 — the nine improvement-objective identifiers an evaluation
// reports and ranks against. An improvement is a decrease for every objective
// except `embeddings-success`, for which it is an increase.
export const improvementObjectiveId = z.enum([
	"planner-cloud-share",
	"planner-multi-attempt",
	"code-p50",
	"reader-cloud-share",
	"reader-multi-attempt",
	"cloud-input-tokens",
	"capacity-rejections",
	"embeddings-success",
	"model-switches",
])

export type ImprovementObjectiveId = z.infer<typeof improvementObjectiveId>

// Requirement 1.16 — the declared order the Arrangement_Evaluator ranks by,
// listing each objective identifier exactly once. Uniqueness/completeness is
// enforced by the Inventory_Validator (Requirement 20.8).
export const improvementObjectiveOrder = z.array(improvementObjectiveId)

export type ImprovementObjectiveOrder = z.infer<typeof improvementObjectiveOrder>

// The top-level Fleet_Inventory (Requirement 1). Structural shape only; the
// referential, uniqueness, allocation, role, and secret rules are the
// Inventory_Validator's responsibility (Requirement 2).
export const fleetInventorySchema = z.object({
	devices: z.array(deviceSchema),
	endpoints: z.array(endpointSchema),
	residencyGroups: z.array(residencyGroupSchema),
	offerings: z.array(modelOfferingSchema),
	clouds: z.array(cloudTargetSchema),
	lanes: z.array(laneSchema),
	instances: z.array(instanceSchema),
	diagnostics: z.array(diagnosticSchema),
	alertDestination: alertDestinationSchema.optional(),
	improvementObjectiveOrder,
})

export type FleetInventory = z.infer<typeof fleetInventorySchema>
