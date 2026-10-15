// Parsed-document adapter (OmniRoute Fleet Topology, design §1).
//
// Tasks 2.1 (Inventory_Parser) and 2.3 (Inventory_Validator) were built against
// two different parsed-document shapes:
//
//   - The parser (`parsed-document.ts`) produces a loose, kind-agnostic tree:
//     a flat `entries` list and a `byKind` index, where every node keeps its
//     verbatim KDL property names (`slot-ceiling`, `host-preemption`, …), its
//     positional `values`, and its nested `children`.
//   - The validator (`types.ts`) reads a grouped document: one array per kind
//     (`devices`, `endpoints`, …), each entry a `{ id, index, fields }` record
//     whose `fields` use the camelCase names of the typed `FleetInventory`
//     (`slotCeiling`, `hostPreemption`, …), with list properties resolved to
//     arrays, child nodes folded into structured sub-records, and
//     `credentialFields` naming the credential-bearing fields.
//
// This module is the single bridge between them: it converts the parser's
// `ParsedDocument` into the validator's `ParsedDocument` without validating,
// coercing numbers, or dropping unknown fields (those stay so the validator can
// still report them). It preserves declaration order and assigns each entry its
// 0-based `index` within its kind. The KDL property names it reads are exactly
// the ones the Inventory_Printer emits, so a printed-then-parsed-then-adapted
// model round-trips through the validator.

import type { ParsedDocument as LooseDocument, ParsedEntry as LooseEntry, ParsedValue as LooseValue } from "./parsed-document.js"
import type { ParsedDocument, ParsedEntry, ParsedScalar, ParsedValue } from "./types.js"

/** The node name the printer emits for each top-level kind. */
const KIND = {
	device: "device",
	endpoint: "endpoint",
	model: "model",
	cloud: "cloud",
	residency: "residency",
	lane: "lane",
	instance: "instance",
	diagnostic: "diagnostic",
	alertDestination: "alert-destination",
	improvementObjectiveOrder: "improvement-objective-order",
} as const

// KDL property names that carry a space-joined list the printer wrote with
// `quoteList`. The validator expects these as arrays; splitting on whitespace
// matches the printer's encoding and the validator's `asList` expectation.
const LIST_SPLIT = /\s+/

/**
 * Split a space-joined list property into a string array, matching the
 * printer's `quoteList` join. A non-string value is kept as a single-element
 * list so a malformed document still reaches the validator (which reports it);
 * an empty/whitespace-only string becomes an empty list.
 */
function splitList(value: LooseValue | undefined): string[] {
	if (typeof value !== "string") {
		return value === undefined ? [] : [String(value)]
	}
	const trimmed = value.trim()
	return trimmed.length === 0 ? [] : trimmed.split(LIST_SPLIT)
}

/** Read a child node's leading positional argument. */
function firstValue(entry: LooseEntry): LooseValue | undefined {
	return entry.values[0]
}

/** Collect every child of the given kind, in document order. */
function childrenOfKind(entry: LooseEntry, kind: string): LooseEntry[] {
	return entry.children.filter((c) => c.kind === kind)
}

/**
 * Convert the parser's loose `ParsedDocument` into the validator's grouped
 * `ParsedDocument`. Every top-level entry is routed to its kind's array;
 * entries of an unrecognized kind are ignored (they are not part of the typed
 * model and the parser already proves the document is syntactically valid).
 */
export function adapt(loose: LooseDocument): ParsedDocument {
	const byKind = loose.byKind

	const devices = (byKind[KIND.device] ?? []).map(adaptDevice)
	const endpoints = (byKind[KIND.endpoint] ?? []).map(adaptEndpoint)
	const residencyGroups = (byKind[KIND.residency] ?? []).map(adaptResidency)
	const offerings = (byKind[KIND.model] ?? []).map(adaptOffering)
	const clouds = (byKind[KIND.cloud] ?? []).map(adaptCloud)
	const lanes = (byKind[KIND.lane] ?? []).map(adaptLane)
	const instances = (byKind[KIND.instance] ?? []).map(adaptInstance)
	const diagnostics = (byKind[KIND.diagnostic] ?? []).map(adaptDiagnostic)

	const alertNode = (byKind[KIND.alertDestination] ?? [])[0]
	const alertDestination = alertNode ? adaptAlertDestination(alertNode, 0) : undefined

	const orderNode = (byKind[KIND.improvementObjectiveOrder] ?? [])[0]
	const improvementObjectiveOrder = orderNode ? splitList(firstValue(orderNode)) : undefined

	return {
		devices,
		endpoints,
		residencyGroups,
		offerings,
		clouds,
		lanes,
		instances,
		diagnostics,
		alertDestination,
		improvementObjectiveOrder,
	}
}

// ---- per-kind adapters ------------------------------------------------------

function adaptDevice(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	rename(fields, node, "slot-ceiling", "slotCeiling")
	rename(fields, node, "host-preemption", "hostPreemption")
	passUnknownProps(fields, node, DEVICE_KDL_PROPS)
	return { id: idOf(node), index, fields }
}

function adaptResidency(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	rename(fields, node, "swap-latency-ms", "swapLatencyMs")
	passUnknownProps(fields, node, RESIDENCY_KDL_PROPS)
	return { id: idOf(node), index, fields }
}

function adaptEndpoint(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	rename(fields, node, "provider", "provider")
	fields["deviceIds"] = splitList(node.properties["devices"])

	// Address children → addresses: [{ instanceId, url }].
	const addresses = childrenOfKind(node, "address").map((a) => ({
		instanceId: a.properties["instance"] ?? null,
		url: a.properties["url"] ?? null,
	}))
	// The validator reads `addresses` as a structured array; the loose
	// `ParsedValue` type does not model records, so this structured value is
	// carried through the shared `fields` map. A validator-side cast reads it
	// back; see validator `checkEndpointAddresses`.
	setStructured(fields, "addresses", addresses)

	// Credential statement: a `secret "<ref>"` child or a `no-credential #true`.
	const credentialFields = applyCredentialChildren(fields, node)

	passUnknownProps(fields, node, ENDPOINT_KDL_PROPS)
	return { id: idOf(node), index, fields, credentialFields }
}

function adaptOffering(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	rename(fields, node, "endpoint", "endpointId")
	rename(fields, node, "device", "deviceId")
	rename(fields, node, "id", "modelId")
	rename(fields, node, "context", "context")
	rename(fields, node, "slots", "slots")
	rename(fields, node, "residency", "residencyGroup")
	fields["tags"] = splitList(node.properties["tags"])

	// Rank children → ranks: number[] (kept verbatim; non-numbers pass through).
	const ranks = childrenOfKind(node, "rank").map((r) => scalarOf(firstValue(r)))
	fields["ranks"] = ranks

	passUnknownProps(fields, node, OFFERING_KDL_PROPS)
	return { id: idOf(node), index, fields }
}

function adaptCloud(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	rename(fields, node, "provider", "provider")
	rename(fields, node, "id", "modelId")
	rename(fields, node, "spend", "spend")
	rename(fields, node, "context", "context")
	fields["tags"] = splitList(node.properties["tags"])
	passUnknownProps(fields, node, CLOUD_KDL_PROPS)
	return { id: idOf(node), index, fields }
}

function adaptLane(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	fields["names"] = splitList(node.properties["names"])
	fields["capabilities"] = splitList(node.properties["capabilities"])
	rename(fields, node, "min-context", "minContext")
	rename(fields, node, "order", "order")
	rename(fields, node, "max-spend", "maxSpend")
	rename(fields, node, "fail-closed", "failClosed")
	rename(fields, node, "max-queue-ms", "maxQueueMs")
	fields["capabilityLanes"] = splitList(node.properties["capability-lanes"])

	// Spill children → spillTiers: string[].
	fields["spillTiers"] = childrenOfKind(node, "spill").map((s) => scalarOf(firstValue(s)))

	passUnknownProps(fields, node, LANE_KDL_PROPS)
	return { id: idOf(node), index, fields }
}

function adaptInstance(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	rename(fields, node, "role", "role")
	rename(fields, node, "address", "address")

	const credentialFields = applyCredentialProps(fields, node)

	// backup-retention child → backupRetention.
	const retentionChild = childrenOfKind(node, "backup-retention")[0]
	if (retentionChild) {
		fields["backupRetention"] = scalarOf(firstValue(retentionChild))
	}

	passUnknownProps(fields, node, INSTANCE_KDL_PROPS)
	return { id: idOf(node), index, fields, credentialFields }
}

function adaptDiagnostic(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	setId(fields, node)
	rename(fields, node, "device", "deviceId")
	passUnknownProps(fields, node, DIAGNOSTIC_KDL_PROPS)
	return { id: idOf(node), index, fields }
}

function adaptAlertDestination(node: LooseEntry, index: number): ParsedEntry {
	const fields: Record<string, ParsedValue> = {}
	rename(fields, node, "url", "url")
	let credentialFields: string[] | undefined
	if (typeof node.properties["secret"] === "string") {
		fields["secretRef"] = node.properties["secret"]
		credentialFields = ["secretRef"]
	}
	passUnknownProps(fields, node, ALERT_KDL_PROPS)
	return { index, fields, credentialFields }
}

// ---- field helpers ----------------------------------------------------------

function idOf(node: LooseEntry): string | undefined {
	return node.id
}

/**
 * Record the entry's declared identifier under the `id` field so the validator
 * can require and report it, mirroring the loose doc's `fields.id` convention.
 */
function setId(fields: Record<string, ParsedValue>, node: LooseEntry): void {
	if (typeof node.id === "string") {
		fields["id"] = node.id
	}
}

/**
 * Copy a KDL property to the validator's field name, verbatim. A missing
 * property is left absent so the validator reports it as missing rather than
 * seeing a defaulted value.
 */
function rename(fields: Record<string, ParsedValue>, node: LooseEntry, kdlName: string, fieldName: string): void {
	if (Object.prototype.hasOwnProperty.call(node.properties, kdlName)) {
		fields[fieldName] = node.properties[kdlName] ?? null
	}
}

/**
 * Carry any KDL property this adapter did not explicitly map into `fields`
 * under its original name, so the validator's unknown-field check still fires
 * on fields the format does not define (Requirement 2.11). The listed names are
 * the properties this kind's adapter already consumed.
 */
function passUnknownProps(fields: Record<string, ParsedValue>, node: LooseEntry, consumed: ReadonlySet<string>): void {
	for (const [name, value] of Object.entries(node.properties)) {
		if (!consumed.has(name)) {
			fields[name] = value ?? null
		}
	}
}

/** Narrow a loose value to a `ParsedScalar`, mapping `undefined` to `null`. */
function scalarOf(value: LooseValue | undefined): ParsedScalar {
	return value === undefined ? null : value
}

/**
 * Store a structured sub-record array (addresses) in `fields`. The validator's
 * `ParsedValue` type models scalars and scalar lists only; structured children
 * are the one exception the validator reads via an internal cast. This helper
 * localizes that single structural widening behind one commented boundary.
 */
function setStructured(fields: Record<string, ParsedValue>, name: string, value: ReadonlyArray<Record<string, ParsedScalar>>): void {
	// The addresses array is a structured value the validator reads back with a
	// matching internal cast (`checkEndpointAddresses`). It is not expressible
	// in the scalar-or-scalar-list `ParsedValue`, so we widen through `unknown`
	// at this single boundary rather than leak a loose `any` across the module.
	fields[name] = value as unknown as ParsedValue
}

/**
 * Apply a credential CHILD node (endpoints: `secret "<ref>"` or
 * `no-credential #true`). Returns `["secretRef"]` when a secret is declared so
 * the validator enforces the secret-reference rule on it.
 */
function applyCredentialChildren(fields: Record<string, ParsedValue>, node: LooseEntry): string[] | undefined {
	const secretChild = childrenOfKind(node, "secret")[0]
	if (secretChild) {
		fields["secretRef"] = scalarOf(firstValue(secretChild))
		return ["secretRef"]
	}
	const noCred = childrenOfKind(node, "no-credential")[0]
	if (noCred) {
		fields["noCredential"] = firstValue(noCred) === true
	}
	return undefined
}

/**
 * Apply a credential PROPERTY statement (instances: `secret="<ref>"` or
 * `no-credential=#true`). Returns `["secretRef"]` when a secret is declared.
 */
function applyCredentialProps(fields: Record<string, ParsedValue>, node: LooseEntry): string[] | undefined {
	if (Object.prototype.hasOwnProperty.call(node.properties, "secret")) {
		fields["secretRef"] = node.properties["secret"] ?? null
		return ["secretRef"]
	}
	if (Object.prototype.hasOwnProperty.call(node.properties, "no-credential")) {
		fields["noCredential"] = node.properties["no-credential"] === true
	}
	return undefined
}

// ---- consumed-property sets (for unknown-field pass-through) ----------------

const DEVICE_KDL_PROPS = new Set(["slot-ceiling", "host-preemption"])
const RESIDENCY_KDL_PROPS = new Set(["swap-latency-ms"])
const ENDPOINT_KDL_PROPS = new Set(["provider", "devices"])
const OFFERING_KDL_PROPS = new Set(["endpoint", "device", "id", "context", "slots", "residency", "tags"])
const CLOUD_KDL_PROPS = new Set(["provider", "id", "spend", "context", "tags"])
const LANE_KDL_PROPS = new Set([
	"names",
	"capabilities",
	"min-context",
	"order",
	"max-spend",
	"fail-closed",
	"max-queue-ms",
	"capability-lanes",
])
const INSTANCE_KDL_PROPS = new Set(["role", "address", "secret", "no-credential"])
const DIAGNOSTIC_KDL_PROPS = new Set(["device"])
const ALERT_KDL_PROPS = new Set(["url", "secret"])
