import {
	fleetInventorySchema,
	improvementObjectiveId,
	type CapabilityLane,
	type FleetInventory,
} from "@roo-code/types"

import type { ParsedDocument, ParsedEntry, ParsedScalar, ParsedValue } from "./types.js"

/**
 * One rejection, located by its field path. A Violation NEVER carries a secret
 * value (Requirements 2.9, 22.4, 22.5): credential and tokenized-segment
 * violations report only the field path and a redaction marker.
 */
export interface Violation {
	readonly fieldPath: string
	readonly code: string
	readonly message: string
}

export type ValidationResult =
	| { readonly ok: true; readonly model: FleetInventory }
	| { readonly ok: false; readonly violations: readonly Violation[] }

export interface InventoryValidator {
	validate(doc: ParsedDocument): ValidationResult
}

// The eight baseline Public_Route names (Requirements 3.3, 4.2). Each must be
// declared in exactly one Lane_Definition (as its Public_Route or a Route_Alias).
const BASELINE_ROUTE_NAMES = [
	"hybrid/code",
	"hybrid/research",
	"hybrid/fast",
	"hybrid/planner",
	"hybrid/reader",
	"hybrid/reviewer",
	"hybrid/frontier",
	"hybrid/tester",
] as const

// The four Capability_Lanes (Requirements 3.4, 3.8). Each must map to exactly
// one Lane_Definition; any other name mapped is unknown.
const CAPABILITY_LANES: readonly CapabilityLane[] = [
	"reader.fast",
	"reader.deep",
	"coder.primary",
	"reasoning.escalation",
]

// A redaction marker that is the same for every credential value and every
// tokenized URL path segment (Requirements 22.4, 22.5).
const REDACTED = "<redacted>"

// Numeric ranges (Requirement 2.6 / design §1 bounds).
const SLOT_MIN = 1
const SLOT_MAX = 64
const ALLOC_MIN = 0
const ALLOC_MAX = 64
const CONTEXT_MIN = 1
const CONTEXT_MAX = 16_777_216
const RANK_MIN = 1
const RANK_MAX = 1000
const SWAP_MIN = 0
const SWAP_MAX = 600_000
const TAG_MAX_LEN = 64
const TAGS_MIN = 1
const TAGS_MAX = 32
const SPILL_MAX = 8
const MAXQUEUE_MIN = 0
const MAXQUEUE_MAX = 120_000
const RETENTION_MIN = 1
const RETENTION_MAX = 1000
const CAP_TAGS_MIN = 1
const CAP_TAGS_MAX = 32
const CAP_LANES_MAX = 4
const ROUTE_NAME_MIN_LEN = 1
const ROUTE_NAME_MAX_LEN = 64

const ROUTE_NAME_RE = /^[a-z0-9/\-_.]+$/
const SPEND_CLASSES = ["free", "low-budget", "paid"] as const
const INSTANCE_ROLES = ["primary", "secondary", "retired"] as const

// Credential-reference syntax: a secret name or secret file path. Any inline
// value that is not a bare reference is rejected without echoing it. We accept
// a `secret:`/`secretfile:` prefixed ref or a bare identifier/path token.
const SECRET_REF_RE = /^(secret|secretfile):\S+$|^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/

export class DefaultInventoryValidator implements InventoryValidator {
	validate(doc: ParsedDocument): ValidationResult {
		const violations: Violation[] = []
		const v = (fieldPath: string, code: string, message: string): void => {
			violations.push({ fieldPath, code, message })
		}

		// Every check runs in one pass; nothing short-circuits (Requirement 2.10).
		const ids = this.collectIds(doc)
		this.checkDuplicateIds(doc, v)
		this.checkDevices(doc, v)
		this.checkResidencyGroups(doc, v)
		this.checkEndpoints(doc, ids, v)
		this.checkOfferings(doc, ids, v)
		this.checkClouds(doc, v)
		this.checkAllocations(doc, v)
		this.checkInstances(doc, v)
		this.checkCredentials(doc, v)
		this.checkLanes(doc, ids, v)
		this.checkRouteNames(doc, v)
		this.checkCapabilityLanes(doc, v)
		this.checkEmbedAndRerankLanes(doc, v)
		this.checkDiagnostics(doc, ids, v)
		this.checkAlertDestination(doc, v)
		this.checkImprovementObjectiveOrder(doc, v)

		if (violations.length > 0) {
			return { ok: false, violations }
		}

		// Acceptance path: build the typed model and run it through the Zod
		// schema as a final structural net. A parse failure here is converted to
		// violations rather than thrown (Requirement 2.10 totality).
		const model = this.buildModel(doc)
		const parsed = fleetInventorySchema.safeParse(model)
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				v(issue.path.join("."), "schema", issue.message)
			}
			return { ok: false, violations }
		}
		return { ok: true, model: parsed.data }
	}

	// ---- identifier collection and uniqueness (Requirements 2.5, 2.8) -------

	private collectIds(doc: ParsedDocument): CollectedIds {
		const idSet = (entries: readonly ParsedEntry[]): Set<string> =>
			new Set(entries.map((e) => e.id).filter((id): id is string => typeof id === "string"))
		return {
			devices: idSet(doc.devices),
			endpoints: idSet(doc.endpoints),
			residencyGroups: idSet(doc.residencyGroups),
			offerings: idSet(doc.offerings),
			clouds: idSet(doc.clouds),
			lanes: idSet(doc.lanes),
			instances: idSet(doc.instances),
		}
	}

	private checkDuplicateIds(doc: ParsedDocument, v: Report): void {
		const kinds: Array<[string, readonly ParsedEntry[]]> = [
			["devices", doc.devices],
			["endpoints", doc.endpoints],
			["clouds", doc.clouds],
			["lanes", doc.lanes],
			["instances", doc.instances],
			["residencyGroups", doc.residencyGroups],
		]
		for (const [kind, entries] of kinds) {
			const seen = new Map<string, number[]>()
			entries.forEach((e, i) => {
				if (typeof e.id !== "string") return
				const list = seen.get(e.id) ?? []
				list.push(i)
				seen.set(e.id, list)
			})
			for (const [id, indices] of seen) {
				if (indices.length > 1) {
					for (const i of indices) {
						v(path(kind, id, i), "duplicate-id", `identifier "${id}" is declared ${indices.length} times`)
					}
				}
			}
		}
	}

	// ---- devices (Requirements 2.6, 2.11, 1.3) ------------------------------

	private checkDevices(doc: ParsedDocument, v: Report): void {
		doc.devices.forEach((d, i) => {
			const base = path("devices", d.id, i)
			requireField(d, "id", base, v)
			this.checkIntRange(d, "slotCeiling", base, SLOT_MIN, SLOT_MAX, v, true)
			requireField(d, "hostPreemption", base, v)
			if (has(d, "hostPreemption") && typeof field(d, "hostPreemption") !== "boolean") {
				v(`${base}.hostPreemption`, "range", "hostPreemption must be true or false")
			}
			this.checkUnknownFields(d, base, DEVICE_FIELDS, v)
		})
	}

	private checkResidencyGroups(doc: ParsedDocument, v: Report): void {
		doc.residencyGroups.forEach((r, i) => {
			const base = path("residencyGroups", r.id, i)
			requireField(r, "id", base, v)
			this.checkIntRange(r, "swapLatencyMs", base, SWAP_MIN, SWAP_MAX, v, true)
			this.checkUnknownFields(r, base, RESIDENCY_FIELDS, v)
		})
	}

	// ---- endpoints (Requirements 2.5, 2.11, 1.10) ---------------------------

	private checkEndpoints(doc: ParsedDocument, ids: CollectedIds, v: Report): void {
		doc.endpoints.forEach((e, i) => {
			const base = path("endpoints", e.id, i)
			requireField(e, "id", base, v)
			requireField(e, "provider", base, v)
			const devs = asList(field(e, "deviceIds"))
			if (devs.length === 0) {
				v(`${base}.deviceIds`, "missing-field", "endpoint must be bound to at least one device")
			}
			devs.forEach((dev, j) => {
				if (typeof dev === "string" && !ids.devices.has(dev)) {
					v(`${base}.deviceIds[${j}]`, "unresolved-ref", `device "${dev}" is not declared`)
				}
			})
			// Address list: each resolves to a declared instance (Requirement 1.10).
			const addrs = e.fields["addresses"]
			if (Array.isArray(addrs) || addrs === undefined) {
				// Addresses are parsed as structured children; a loose doc keeps
				// them under `addresses` as an array of {instanceId,url} records.
			}
			this.checkEndpointAddresses(e, ids, base, v)
			this.checkCredentialStatement(e, base, v)
			this.checkUnknownFields(e, base, ENDPOINT_FIELDS, v)
		})
	}

	private checkEndpointAddresses(e: ParsedEntry, ids: CollectedIds, base: string, v: Report): void {
		const addrs = (e.fields["addresses"] as unknown) as Array<Record<string, ParsedValue>> | undefined
		if (!Array.isArray(addrs) || addrs.length === 0) {
			v(`${base}.addresses`, "missing-field", "endpoint must declare at least one address")
			return
		}
		addrs.forEach((a, j) => {
			const inst = a?.["instanceId"]
			if (typeof inst !== "string") {
				v(`${base}.addresses[${j}].instanceId`, "missing-field", "address must name an instance")
			} else if (!ids.instances.has(inst)) {
				v(`${base}.addresses[${j}].instanceId`, "unresolved-ref", `instance "${inst}" is not declared`)
			}
			if (typeof a?.["url"] !== "string") {
				v(`${base}.addresses[${j}].url`, "missing-field", "address must declare a url")
			}
		})
	}

	// ---- model offerings (Requirements 2.5, 2.6, 2.7, 2.8, 2.11) -----------

	private checkOfferings(doc: ParsedDocument, ids: CollectedIds, v: Report): void {
		const endpointById = new Map(doc.endpoints.map((e) => [e.id, e] as const))
		// Duplicate model id per (endpoint, device) (Requirement 2.8).
		const byEndpointDeviceModel = new Map<string, number[]>()

		doc.offerings.forEach((o, i) => {
			const base = path("offerings", o.id, i)
			requireField(o, "id", base, v)
			const endpointId = field(o, "endpointId")
			const deviceId = field(o, "deviceId")
			const modelId = field(o, "modelId")

			if (typeof endpointId !== "string") {
				v(`${base}.endpointId`, "missing-field", "offering must name an endpoint")
			} else if (!ids.endpoints.has(endpointId)) {
				v(`${base}.endpointId`, "unresolved-ref", `endpoint "${endpointId}" is not declared`)
			}
			if (typeof deviceId !== "string") {
				v(`${base}.deviceId`, "missing-field", "offering must name a device")
			} else if (!ids.devices.has(deviceId)) {
				v(`${base}.deviceId`, "unresolved-ref", `device "${deviceId}" is not declared`)
			}
			// Model-device binding (Requirement 2.5): the device must be one of
			// the endpoint's bound devices.
			if (typeof endpointId === "string" && typeof deviceId === "string") {
				const ep = endpointById.get(endpointId)
				if (ep) {
					const bound = asList(field(ep, "deviceIds"))
					if (!bound.includes(deviceId)) {
						v(
							`${base}.deviceId`,
							"model-device-binding",
							`device "${deviceId}" is not bound to endpoint "${endpointId}"`,
						)
					}
				}
			}
			requireField(o, "modelId", base, v)
			this.checkIntRange(o, "context", base, CONTEXT_MIN, CONTEXT_MAX, v, true)
			this.checkIntRange(o, "slots", base, SLOT_MIN, SLOT_MAX, v, true)

			const residency = field(o, "residencyGroup")
			if (typeof residency !== "string") {
				v(`${base}.residencyGroup`, "missing-field", "offering must declare a residency group")
			} else if (!ids.residencyGroups.has(residency)) {
				v(`${base}.residencyGroup`, "unresolved-ref", `residency group "${residency}" is not declared`)
			}

			this.checkTags(o, base, v)
			this.checkRanks(o, base, v)
			this.checkUnknownFields(o, base, OFFERING_FIELDS, v)

			if (typeof endpointId === "string" && typeof deviceId === "string" && typeof modelId === "string") {
				const key = `${endpointId}\u0000${deviceId}\u0000${modelId}`
				const list = byEndpointDeviceModel.get(key) ?? []
				list.push(i)
				byEndpointDeviceModel.set(key, list)
			}
		})

		for (const [, indices] of byEndpointDeviceModel) {
			if (indices.length > 1) {
				for (const i of indices) {
					const o = doc.offerings[i]
					if (!o) continue
					v(
						path("offerings", o.id, i),
						"duplicate-model-id",
						"two or more offerings on one endpoint and device declare the same model id",
					)
				}
			}
		}
	}

	private checkRanks(o: ParsedEntry, base: string, v: Report): void {
		const ranks = asList(field(o, "ranks"))
		const slotsRaw = field(o, "slots")
		if (!has(o, "ranks")) {
			v(`${base}.ranks`, "missing-field", "offering must declare one performance rank per slot")
			return
		}
		ranks.forEach((r, j) => {
			if (typeof r !== "number" || !Number.isInteger(r) || r < RANK_MIN || r > RANK_MAX) {
				v(`${base}.ranks[${j}]`, "range", `performance rank must be an integer from ${RANK_MIN} to ${RANK_MAX}`)
			}
		})
		// ranks.length must equal slots (Requirement 2.11).
		if (typeof slotsRaw === "number" && ranks.length !== slotsRaw) {
			v(
				`${base}.ranks`,
				"rank-count",
				`offering declares ${ranks.length} performance ranks but ${slotsRaw} slots`,
			)
		}
	}

	// ---- cloud targets (Requirements 2.6, 2.8, 2.11) ------------------------

	private checkClouds(doc: ParsedDocument, v: Report): void {
		doc.clouds.forEach((c, i) => {
			const base = path("clouds", c.id, i)
			requireField(c, "id", base, v)
			requireField(c, "provider", base, v)
			requireField(c, "modelId", base, v)
			this.checkSpend(c, "spend", base, v)
			this.checkIntRange(c, "context", base, CONTEXT_MIN, CONTEXT_MAX, v, true)
			this.checkTags(c, base, v)
			this.checkUnknownFields(c, base, CLOUD_FIELDS, v)
		})
	}

	// ---- allocations (Requirements 2.6, 2.7, 10.2) --------------------------
	//
	// A device may carry an `allocations` map of instanceId -> slot count. When
	// absent, Requirement 1.11 defaults the device to allocating its ceiling to
	// the primary instance and 0 to every other. We validate declared values
	// here and enforce the per-device sum and the retired-instance-zero rule.

	private checkAllocations(doc: ParsedDocument, v: Report): void {
		const primaryId = this.primaryInstanceId(doc)
		const roleById = this.instanceRoles(doc)

		doc.devices.forEach((d, i) => {
			const base = path("devices", d.id, i)
			const ceiling = this.intValue(field(d, "slotCeiling"))
			const allocations = this.parseAllocations(d)
			if (!allocations) return

			let sum = 0
			for (const [instanceId, count] of allocations) {
				const apath = `${base}.allocations.${instanceId}`
				if (!Number.isInteger(count) || count < ALLOC_MIN || count > ALLOC_MAX) {
					v(apath, "range", `slot allocation must be an integer from ${ALLOC_MIN} to ${ALLOC_MAX}`)
					continue
				}
				// No slots may be allocated to a retired instance (Requirement 10.2).
				if (roleById.get(instanceId) === "retired" && count > 0) {
					v(apath, "retired-allocation", `instance "${instanceId}" is retired and cannot hold slots`)
				}
				sum += count
			}
			// Per-device allocation sum ≤ ceiling (Requirement 2.7).
			if (ceiling !== undefined && sum > ceiling) {
				v(
					`${base}.allocations`,
					"allocation-sum",
					`allocations sum to ${sum} but device ceiling is ${ceiling}`,
				)
			}
		})

		// Per-offering slot bound: slots ≤ device ceiling, and the sum over
		// instances of min(slots, Device_Allocation) ≤ slots (Requirement 2.7).
		const deviceById = new Map(doc.devices.map((d) => [d.id, d] as const))
		const instanceIds = doc.instances
			.map((inst) => inst.id)
			.filter((id): id is string => typeof id === "string")
		doc.offerings.forEach((o, i) => {
			const base = path("offerings", o.id, i)
			const slots = this.intValue(field(o, "slots"))
			const deviceId = field(o, "deviceId")
			if (slots === undefined || typeof deviceId !== "string") return
			const dev = deviceById.get(deviceId)
			if (!dev) return
			const ceiling = this.intValue(field(dev, "slotCeiling"))
			if (ceiling !== undefined && slots > ceiling) {
				v(
					`${base}.slots`,
					"slots-exceed-ceiling",
					`offering declares ${slots} slots but device "${deviceId}" ceiling is ${ceiling}`,
				)
			}
			const allocations = this.resolveAllocations(dev, ceiling, primaryId, instanceIds)
			let lesserSum = 0
			for (const alloc of allocations.values()) {
				lesserSum += Math.min(slots, alloc)
			}
			if (lesserSum > slots) {
				v(
					`${base}.slots`,
					"offering-concurrency",
					`sum of min(slots, allocation) is ${lesserSum} but offering has ${slots} slots`,
				)
			}
		})
	}

	// ---- instances / roles (Requirement 10.2) -------------------------------

	private checkInstances(doc: ParsedDocument, v: Report): void {
		let primaryCount = 0
		doc.instances.forEach((inst, i) => {
			const base = path("instances", inst.id, i)
			requireField(inst, "id", base, v)
			requireField(inst, "address", base, v)
			const role = field(inst, "role")
			if (role === undefined || role === null) {
				v(`${base}.role`, "missing-field", "instance must declare exactly one role")
			} else if (typeof role !== "string" || !INSTANCE_ROLES.includes(role as (typeof INSTANCE_ROLES)[number])) {
				v(`${base}.role`, "role", `role must be one of ${INSTANCE_ROLES.join(", ")}`)
			} else if (role === "primary") {
				primaryCount++
			}
			this.checkIntRange(inst, "backupRetention", base, RETENTION_MIN, RETENTION_MAX, v, false)
			this.checkCredentialStatement(inst, base, v)
			this.checkUnknownFields(inst, base, INSTANCE_FIELDS, v)
		})
		// Exactly one primary (Requirement 10.2).
		if (primaryCount !== 1) {
			v("instances", "primary-count", `exactly one instance must be primary; found ${primaryCount}`)
		}
	}

	// ---- credentials / tokenized segments (Requirements 2.9, 22.5) ---------

	private checkCredentials(doc: ParsedDocument, v: Report): void {
		const scan = (entry: ParsedEntry, base: string): void => {
			// Credential fields must hold only a secret reference, never a value.
			for (const credField of entry.credentialFields ?? []) {
				const raw = entry.fields[credField]
				if (raw === undefined) continue
				if (typeof raw !== "string" || !SECRET_REF_RE.test(raw)) {
					v(
						`${base}.${credField}`,
						"inline-credential",
						`credential field must reference a secret by name or path, not an inline value (${REDACTED})`,
					)
				}
			}
			// Any URL field with a tokenized segment or user-info password.
			for (const [name, value] of Object.entries(entry.fields)) {
				this.scanUrlValue(value, `${base}.${name}`, v)
			}
		}
		doc.devices.forEach((d, i) => scan(d, path("devices", d.id, i)))
		doc.endpoints.forEach((e, i) => {
			const base = path("endpoints", e.id, i)
			scan(e, base)
			const addrs = (e.fields["addresses"] as unknown) as Array<Record<string, ParsedValue>> | undefined
			if (Array.isArray(addrs)) {
				addrs.forEach((a, j) => this.scanUrlValue(a?.["url"], `${base}.addresses[${j}].url`, v))
			}
		})
		doc.instances.forEach((inst, i) => scan(inst, path("instances", inst.id, i)))
		if (doc.alertDestination) {
			scan(doc.alertDestination, "alertDestination")
		}
	}

	private scanUrlValue(value: ParsedValue | undefined, fieldPath: string, v: Report): void {
		const scanOne = (s: ParsedScalar, p: string): void => {
			if (typeof s !== "string") return
			if (!looksLikeUrl(s)) return
			if (hasUserInfoPassword(s)) {
				v(p, "credential-in-url", `url user-info part contains a credential (${REDACTED})`)
			}
			if (hasTokenizedSegment(s)) {
				v(p, "tokenized-segment", `url contains a tokenized path segment (${REDACTED})`)
			}
		}
		if (Array.isArray(value)) {
			value.forEach((s, j) => scanOne(s, `${fieldPath}[${j}]`))
		} else if (value !== undefined) {
			scanOne(value, fieldPath)
		}
	}

	private checkCredentialStatement(entry: ParsedEntry, base: string, v: Report): void {
		// Each endpoint/instance declares either a secret reference or an
		// explicit no-credential statement (Requirements 1.10, 1.14).
		const hasSecret = has(entry, "secretRef") && entry.fields["secretRef"] !== null
		const noCred = field(entry, "noCredential") === true
		if (!hasSecret && !noCred) {
			v(
				`${base}`,
				"missing-credential-statement",
				"must declare a secret reference or an explicit no-credential statement",
			)
		}
	}

	// ---- lanes (Requirements 3.1, 3.2, 3.7) ---------------------------------

	private checkLanes(doc: ParsedDocument, ids: CollectedIds, v: Report): void {
		const forbidden = this.capabilityForbiddenNames(doc)
		doc.lanes.forEach((lane, i) => {
			const base = path("lanes", lane.id, i)
			requireField(lane, "id", base, v)

			const names = asList(field(lane, "names"))
			if (names.length === 0) {
				v(`${base}.names`, "missing-field", "lane must declare at least one name")
			}

			this.checkLaneCapabilities(lane, forbidden, base, v)
			this.checkIntRange(lane, "minContext", base, CONTEXT_MIN, CONTEXT_MAX, v, true)
			this.checkLaneOrder(lane, base, v)
			this.checkSpend(lane, "maxSpend", base, v)
			this.checkSpillTiers(lane, forbidden, base, v)
			this.checkLaneFailClosed(lane, base, v)
			this.checkLaneMaxQueue(lane, base, v)
			this.checkLaneCapabilityLanes(lane, base, v)
			this.checkUnknownFields(lane, base, LANE_FIELDS, v)
		})
	}

	private checkLaneCapabilities(lane: ParsedEntry, forbidden: Set<string>, base: string, v: Report): void {
		const caps = asList(field(lane, "capabilities"))
		if (caps.length < CAP_TAGS_MIN || caps.length > CAP_TAGS_MAX) {
			v(
				`${base}.capabilities`,
				"range",
				`lane must declare ${CAP_TAGS_MIN} to ${CAP_TAGS_MAX} capability tags`,
			)
		}
		caps.forEach((tag, j) => {
			if (typeof tag !== "string" || tag.length < 1 || tag.length > TAG_MAX_LEN) {
				v(`${base}.capabilities[${j}]`, "range", `capability tag must be 1 to ${TAG_MAX_LEN} characters`)
				return
			}
			// No capability tag may name a device, endpoint, or model id,
			// case-insensitively (Requirements 3.2, 3.7).
			if (forbidden.has(tag.toLowerCase())) {
				v(
					`${base}.capabilities[${j}]`,
					"capability-names-identifier",
					`capability tag "${tag}" matches a declared device, endpoint, or model id`,
				)
			}
		})
	}

	private checkLaneOrder(lane: ParsedEntry, base: string, v: Report): void {
		if (!has(lane, "order")) {
			v(`${base}.order`, "missing-field", "lane must declare an ordering policy")
		} else if (field(lane, "order") !== "fill-first") {
			v(`${base}.order`, "range", 'lane ordering policy must be "fill-first"')
		}
	}

	private checkSpillTiers(lane: ParsedEntry, forbidden: Set<string>, base: string, v: Report): void {
		const tiers = asList(field(lane, "spillTiers"))
		if (tiers.length > SPILL_MAX) {
			v(`${base}.spillTiers`, "range", `lane may declare at most ${SPILL_MAX} spill tiers`)
		}
		const maxSpend = field(lane, "maxSpend")
		tiers.forEach((tier, j) => {
			const tpath = `${base}.spillTiers[${j}]`
			if (typeof tier !== "string" || !SPEND_CLASSES.includes(tier as (typeof SPEND_CLASSES)[number])) {
				v(tpath, "range", `spill tier must be one of ${SPEND_CLASSES.join(", ")}`)
				return
			}
			// A spill tier must not name an identifier (Requirements 3.2, 3.7).
			if (forbidden.has(tier.toLowerCase())) {
				v(tpath, "spill-names-identifier", `spill tier "${tier}" matches a declared identifier`)
			}
			// Each spill tier must be no higher than the lane's max spend.
			if (
				typeof maxSpend === "string" &&
				SPEND_CLASSES.includes(maxSpend as (typeof SPEND_CLASSES)[number]) &&
				spendRank(tier) > spendRank(maxSpend)
			) {
				v(tpath, "spill-above-max", `spill tier "${tier}" is higher than the lane max spend "${maxSpend}"`)
			}
		})
	}

	private checkLaneFailClosed(lane: ParsedEntry, base: string, v: Report): void {
		if (!has(lane, "failClosed")) {
			v(`${base}.failClosed`, "missing-field", "lane must declare whether it fails closed")
		} else if (typeof field(lane, "failClosed") !== "boolean") {
			v(`${base}.failClosed`, "range", "failClosed must be true or false")
		}
	}

	private checkLaneMaxQueue(lane: ParsedEntry, base: string, v: Report): void {
		if (!has(lane, "maxQueueMs")) return // optional; defaults to 30s
		const value = field(lane, "maxQueueMs")
		if (typeof value !== "number" || !Number.isInteger(value) || value < MAXQUEUE_MIN || value > MAXQUEUE_MAX) {
			v(
				`${base}.maxQueueMs`,
				"range",
				`max queue wait must be an integer from ${MAXQUEUE_MIN} to ${MAXQUEUE_MAX} ms`,
			)
		}
	}

	private checkLaneCapabilityLanes(lane: ParsedEntry, base: string, v: Report): void {
		const laneRefs = asList(field(lane, "capabilityLanes"))
		if (laneRefs.length > CAP_LANES_MAX) {
			v(`${base}.capabilityLanes`, "range", `lane may map at most ${CAP_LANES_MAX} capability lanes`)
		}
		laneRefs.forEach((ref, j) => {
			if (typeof ref !== "string" || !CAPABILITY_LANES.includes(ref as CapabilityLane)) {
				v(
					`${base}.capabilityLanes[${j}]`,
					"unknown-capability-lane",
					`"${String(ref)}" is not one of the four capability lanes`,
				)
			}
		})
	}

	// ---- route names (Requirements 3.3, 3.8, 4.8) ---------------------------

	private checkRouteNames(doc: ParsedDocument, v: Report): void {
		// Collect every declared name across lane names, retired names, and
		// diagnostic names, with its declaration location.
		type Decl = { name: string; where: string }
		const decls: Decl[] = []
		const laneFirstNames = new Map<string, string[]>() // first name -> lane locations

		doc.lanes.forEach((lane, i) => {
			const base = path("lanes", lane.id, i)
			const names = asList(field(lane, "names"))
			names.forEach((n, j) => {
				if (typeof n !== "string") return
				decls.push({ name: n, where: `${base}.names[${j}]` })
				if (j === 0) {
					const list = laneFirstNames.get(n) ?? []
					list.push(base)
					laneFirstNames.set(n, list)
				}
			})
			// Retired names: former names mapped to a successor.
			const retired = (lane.fields["retiredNames"] as unknown) as
				| Array<Record<string, ParsedValue>>
				| undefined
			if (Array.isArray(retired)) {
				retired.forEach((r, j) => {
					const nm = r?.["name"]
					if (typeof nm === "string") {
						decls.push({ name: nm, where: `${base}.retiredNames[${j}]` })
					}
				})
			}
		})
		doc.diagnostics.forEach((d, i) => {
			const base = path("diagnostics", d.id, i)
			if (typeof d.id === "string") {
				decls.push({ name: d.id, where: `${base}` })
			}
		})

		// Charset/length rule for every declared name.
		for (const { name, where } of decls) {
			if (name.length < ROUTE_NAME_MIN_LEN || name.length > ROUTE_NAME_MAX_LEN || !ROUTE_NAME_RE.test(name)) {
				v(
					where,
					"route-name-charset",
					`name "${name}" must be ${ROUTE_NAME_MIN_LEN}-${ROUTE_NAME_MAX_LEN} chars of lowercase letters, digits, / - _ .`,
				)
			}
		}

		// Global uniqueness across every declared name (Requirements 2.8, 4.8).
		const byName = new Map<string, string[]>()
		for (const { name, where } of decls) {
			const list = byName.get(name) ?? []
			list.push(where)
			byName.set(name, list)
		}
		for (const [name, wheres] of byName) {
			if (wheres.length > 1) {
				for (const where of wheres) {
					v(where, "duplicate-route-name", `name "${name}" is declared ${wheres.length} times`)
				}
			}
		}

		// Each baseline name declared in exactly one lane, as a name (first or
		// alias) (Requirements 3.3, 3.8). Also each baseline name must be the
		// first declared name of a lane (Requirement 4.8).
		for (const baseline of BASELINE_ROUTE_NAMES) {
			const lanesDeclaring = doc.lanes.filter((lane) => asList(field(lane, "names")).includes(baseline))
			if (lanesDeclaring.length === 0) {
				v("lanes", "baseline-name-missing", `baseline route name "${baseline}" is declared in no lane`)
			} else if (lanesDeclaring.length > 1) {
				lanesDeclaring.forEach((lane) => {
					const i = doc.lanes.indexOf(lane)
					v(
						path("lanes", lane.id, i),
						"baseline-name-duplicate",
						`baseline route name "${baseline}" is declared in ${lanesDeclaring.length} lanes`,
					)
				})
			}
			// Must be a first declared name (Requirement 4.8).
			const isFirstSomewhere = doc.lanes.some((lane) => asList(field(lane, "names"))[0] === baseline)
			const firstDeclaring = lanesDeclaring[0]
			if (firstDeclaring && !isFirstSomewhere) {
				const i = doc.lanes.indexOf(firstDeclaring)
				v(
					path("lanes", firstDeclaring.id, i),
					"baseline-name-not-public",
					`baseline route name "${baseline}" must be a lane's first declared name`,
				)
			}
		}

		// Retired-successor rule: a retired name's successor must be the first
		// declared name of a lane in this inventory (Requirement 4.8).
		const firstNames = new Set<string>()
		doc.lanes.forEach((lane) => {
			const first = asList(field(lane, "names"))[0]
			if (typeof first === "string") firstNames.add(first)
		})
		doc.lanes.forEach((lane, i) => {
			const base = path("lanes", lane.id, i)
			const retired = (lane.fields["retiredNames"] as unknown) as
				| Array<Record<string, ParsedValue>>
				| undefined
			if (!Array.isArray(retired)) return
			retired.forEach((r, j) => {
				const successor = r?.["successor"]
				if (typeof successor === "string" && !firstNames.has(successor)) {
					v(
						`${base}.retiredNames[${j}].successor`,
						"retired-successor",
						`retired name's successor "${successor}" is not any lane's first declared name`,
					)
				}
			})
		})
	}

	// ---- capability lanes mapped exactly once (Requirements 3.4, 3.8) -------

	private checkCapabilityLanes(doc: ParsedDocument, v: Report): void {
		const mappedBy = new Map<string, string[]>()
		doc.lanes.forEach((lane, i) => {
			const base = path("lanes", lane.id, i)
			asList(field(lane, "capabilityLanes")).forEach((ref) => {
				if (typeof ref !== "string") return
				const list = mappedBy.get(ref) ?? []
				list.push(base)
				mappedBy.set(ref, list)
			})
		})
		for (const cl of CAPABILITY_LANES) {
			const where = mappedBy.get(cl) ?? []
			if (where.length === 0) {
				v("lanes", "capability-lane-unmapped", `capability lane "${cl}" is mapped to no lane`)
			} else if (where.length > 1) {
				for (const w of where) {
					v(w, "capability-lane-overmapped", `capability lane "${cl}" is mapped to ${where.length} lanes`)
				}
			}
		}
		// Unknown capability lanes reported at their declaration (also flagged
		// per-lane in checkLaneCapabilityLanes); report mapped-but-unknown here.
		for (const [ref, where] of mappedBy) {
			if (!CAPABILITY_LANES.includes(ref as CapabilityLane)) {
				for (const w of where) {
					v(`${w}.capabilityLanes`, "unknown-capability-lane", `"${ref}" is not a known capability lane`)
				}
			}
		}
	}

	// ---- embeddings and rerank lanes present (Requirement 3.5) --------------

	private checkEmbedAndRerankLanes(doc: ParsedDocument, v: Report): void {
		const embedTags = this.exclusiveServingTags(doc, (tags) => tags.includes("embed"))
		const rerankTags = this.exclusiveServingTags(doc, (tags) => tags.includes("rerank"))
		const laneRequires = (tagSet: Set<string>): boolean =>
			doc.lanes.some((lane) => asList(field(lane, "capabilities")).some((c) => typeof c === "string" && tagSet.has(c)))
		// Require an embed/rerank lane ONLY when the inventory actually declares an
		// offering serving that capability. When memory (embeddings/rerank) is served
		// out-of-band by OmniRoute provider-nodes rather than toolkit-managed
		// offerings, the inventory declares no embed/rerank offering (the tag set is
		// empty) and no lane is required — the toolkit then manages only the compute
		// fleet. An inventory that DOES declare embed/rerank offerings still must
		// route them through a lane (the original Requirement 3.5 guard).
		if (embedTags.size > 0 && !laneRequires(embedTags)) {
			v("lanes", "no-embed-lane", "no lane requires a capability tag carried only by embedding offerings")
		}
		if (rerankTags.size > 0 && !laneRequires(rerankTags)) {
			v("lanes", "no-rerank-lane", "no lane requires a capability tag carried only by rerank offerings")
		}
	}

	// ---- diagnostics (Requirement 12.7) -------------------------------------

	private checkDiagnostics(doc: ParsedDocument, ids: CollectedIds, v: Report): void {
		doc.diagnostics.forEach((d, i) => {
			const base = path("diagnostics", d.id, i)
			requireField(d, "id", base, v)
			const deviceId = field(d, "deviceId")
			if (typeof deviceId !== "string") {
				v(`${base}.deviceId`, "missing-field", "diagnostic must name a device")
			} else if (!ids.devices.has(deviceId)) {
				v(`${base}.deviceId`, "unresolved-ref", `diagnostic is pinned to undeclared device "${deviceId}"`)
			}
			this.checkUnknownFields(d, base, DIAGNOSTIC_FIELDS, v)
		})
	}

	private checkAlertDestination(doc: ParsedDocument, v: Report): void {
		if (!doc.alertDestination) return
		const a = doc.alertDestination
		if (typeof field(a, "url") !== "string") {
			v("alertDestination.url", "missing-field", "alert destination must declare a url")
		}
		this.checkUnknownFields(a, "alertDestination", ALERT_FIELDS, v)
	}

	// ---- improvement-objective order (Requirement 20.8) --------------------

	private checkImprovementObjectiveOrder(doc: ParsedDocument, v: Report): void {
		const order = doc.improvementObjectiveOrder
		if (!order) {
			v("improvementObjectiveOrder", "missing-field", "improvement-objective order is required")
			return
		}
		const known = new Set(improvementObjectiveId.options)
		const seen = new Map<string, number>()
		order.forEach((idRaw, i) => {
			const id = typeof idRaw === "string" ? idRaw : String(idRaw)
			seen.set(id, (seen.get(id) ?? 0) + 1)
			if (!known.has(id as (typeof improvementObjectiveId.options)[number])) {
				v(`improvementObjectiveOrder[${i}]`, "unknown-objective", `"${id}" is not a known improvement objective`)
			}
		})
		for (const [id, count] of seen) {
			if (count > 1 && known.has(id as (typeof improvementObjectiveId.options)[number])) {
				v("improvementObjectiveOrder", "duplicate-objective", `objective "${id}" is listed ${count} times`)
			}
		}
		for (const id of known) {
			if (!seen.has(id)) {
				v("improvementObjectiveOrder", "missing-objective", `objective "${id}" is not listed`)
			}
		}
	}

	// ---- shared helpers -----------------------------------------------------

	private checkIntRange(
		entry: ParsedEntry,
		fieldName: string,
		base: string,
		min: number,
		max: number,
		v: Report,
		required: boolean,
	): void {
		if (!has(entry, fieldName)) {
			if (required) {
				v(`${base}.${fieldName}`, "missing-field", `${fieldName} is required`)
			}
			return
		}
		const value = entry.fields[fieldName]
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
			v(`${base}.${fieldName}`, "range", `${fieldName} must be an integer from ${min} to ${max}`)
		}
	}

	private checkSpend(entry: ParsedEntry, fieldName: string, base: string, v: Report): void {
		if (!has(entry, fieldName)) {
			v(`${base}.${fieldName}`, "missing-field", `${fieldName} is required`)
			return
		}
		const value = entry.fields[fieldName]
		if (typeof value !== "string" || !SPEND_CLASSES.includes(value as (typeof SPEND_CLASSES)[number])) {
			v(`${base}.${fieldName}`, "range", `${fieldName} must be one of ${SPEND_CLASSES.join(", ")}`)
		}
	}

	private checkTags(entry: ParsedEntry, base: string, v: Report): void {
		if (!has(entry, "tags")) {
			v(`${base}.tags`, "missing-field", "capability tags are required")
			return
		}
		const tags = asList(field(entry, "tags"))
		if (tags.length < TAGS_MIN || tags.length > TAGS_MAX) {
			v(`${base}.tags`, "range", `must declare ${TAGS_MIN} to ${TAGS_MAX} capability tags`)
		}
		tags.forEach((t, j) => {
			if (typeof t !== "string" || t.length < 1 || t.length > TAG_MAX_LEN) {
				v(`${base}.tags[${j}]`, "range", `capability tag must be 1 to ${TAG_MAX_LEN} characters`)
			}
		})
	}

	private checkUnknownFields(entry: ParsedEntry, base: string, known: ReadonlySet<string>, v: Report): void {
		for (const name of Object.keys(entry.fields)) {
			if (!known.has(name)) {
				v(`${base}.${name}`, "unknown-field", `field "${name}" is not defined by the inventory format`)
			}
		}
	}

	// Names forbidden as capability tags / spill tiers: every device, endpoint,
	// and model id, lower-cased (Requirements 3.2, 3.7).
	private capabilityForbiddenNames(doc: ParsedDocument): Set<string> {
		const names = new Set<string>()
		const add = (value: ParsedValue | undefined): void => {
			if (typeof value === "string") names.add(value.toLowerCase())
		}
		doc.devices.forEach((d) => add(d.id))
		doc.endpoints.forEach((e) => add(e.id))
		doc.offerings.forEach((o) => add(field(o, "modelId")))
		doc.clouds.forEach((c) => add(field(c, "modelId")))
		return names
	}

	// Tags carried ONLY by offerings matching the predicate (Requirement 3.5).
	private exclusiveServingTags(doc: ParsedDocument, serves: (tags: string[]) => boolean): Set<string> {
		const servingTags = new Set<string>()
		const otherTags = new Set<string>()
		doc.offerings.forEach((o) => {
			const tags = asList(field(o, "tags")).filter((t): t is string => typeof t === "string")
			if (serves(tags)) {
				tags.forEach((t) => servingTags.add(t))
			} else {
				tags.forEach((t) => otherTags.add(t))
			}
		})
		for (const t of otherTags) servingTags.delete(t)
		return servingTags
	}

	private primaryInstanceId(doc: ParsedDocument): string | undefined {
		const primaries = doc.instances.filter((inst) => field(inst, "role") === "primary")
		const only = primaries.length === 1 ? primaries[0] : undefined
		return only && typeof only.id === "string" ? only.id : undefined
	}

	private instanceRoles(doc: ParsedDocument): Map<string, string> {
		const map = new Map<string, string>()
		doc.instances.forEach((inst) => {
			if (typeof inst.id === "string" && typeof field(inst, "role") === "string") {
				map.set(inst.id, field(inst, "role") as string)
			}
		})
		return map
	}

	private parseAllocations(device: ParsedEntry): Map<string, number> | undefined {
		const raw = (device.fields["allocations"] as unknown) as Record<string, ParsedValue> | undefined
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
		const map = new Map<string, number>()
		for (const [instanceId, value] of Object.entries(raw)) {
			map.set(instanceId, typeof value === "number" ? value : Number.NaN)
		}
		return map
	}

	// Resolve the effective Device_Allocation per instance, applying the
	// Requirement 1.11 default when no allocation is declared.
	private resolveAllocations(
		device: ParsedEntry,
		ceiling: number | undefined,
		primaryId: string | undefined,
		instanceIds: readonly string[],
	): Map<string, number> {
		const declared = this.parseAllocations(device)
		if (declared) {
			const resolved = new Map<string, number>()
			for (const id of instanceIds) {
				resolved.set(id, declared.get(id) ?? 0)
			}
			return resolved
		}
		// Default: ceiling to primary, 0 to every other instance.
		const resolved = new Map<string, number>()
		for (const id of instanceIds) {
			resolved.set(id, id === primaryId ? (ceiling ?? 0) : 0)
		}
		return resolved
	}

	private intValue(value: ParsedValue | undefined): number | undefined {
		return typeof value === "number" && Number.isInteger(value) ? value : undefined
	}

	// Build the typed model from the loose document for the acceptance path.
	// Only reached when every validator rule passed, so the raw values are the
	// expected types; the final Zod parse is a structural safety net.
	private buildModel(doc: ParsedDocument): unknown {
		const str = (e: ParsedEntry, k: string): string => String(field(e, k))
		const num = (e: ParsedEntry, k: string): number => field(e, k) as number
		const bool = (e: ParsedEntry, k: string): boolean => field(e, k) === true
		const strList = (e: ParsedEntry, k: string): string[] =>
			asList(field(e, k)).map((x) => String(x))

		return {
			devices: doc.devices.map((d) => ({
				id: str(d, "id"),
				slotCeiling: num(d, "slotCeiling"),
				hostPreemption: bool(d, "hostPreemption"),
			})),
			endpoints: doc.endpoints.map((e) => ({
				id: str(e, "id"),
				provider: str(e, "provider"),
				deviceIds: strList(e, "deviceIds"),
				addresses: (((e.fields["addresses"] as unknown) as Array<Record<string, ParsedValue>>) ?? []).map(
					(a) => ({ instanceId: String(a["instanceId"]), url: String(a["url"]) }),
				),
				secretRef: typeof e.fields["secretRef"] === "string" ? (e.fields["secretRef"] as string) : undefined,
				noCredential: field(e, "noCredential") === true,
			})),
			residencyGroups: doc.residencyGroups.map((r) => ({
				id: str(r, "id"),
				swapLatencyMs: num(r, "swapLatencyMs"),
			})),
			offerings: doc.offerings.map((o) => ({
				id: str(o, "id"),
				endpointId: str(o, "endpointId"),
				deviceId: str(o, "deviceId"),
				modelId: str(o, "modelId"),
				context: num(o, "context"),
				slots: num(o, "slots"),
				residencyGroup: str(o, "residencyGroup"),
				tags: strList(o, "tags"),
				ranks: asList(field(o, "ranks")).map((x) => x as number),
			})),
			clouds: doc.clouds.map((c) => ({
				id: str(c, "id"),
				provider: str(c, "provider"),
				modelId: str(c, "modelId"),
				spend: str(c, "spend"),
				context: num(c, "context"),
				tags: strList(c, "tags"),
			})),
			lanes: doc.lanes.map((lane) => ({
				id: str(lane, "id"),
				names: strList(lane, "names"),
				capabilities: strList(lane, "capabilities"),
				minContext: num(lane, "minContext"),
				order: str(lane, "order"),
				maxSpend: str(lane, "maxSpend"),
				spillTiers: strList(lane, "spillTiers"),
				failClosed: bool(lane, "failClosed"),
				...(has(lane, "maxQueueMs") ? { maxQueueMs: num(lane, "maxQueueMs") } : {}),
				capabilityLanes: strList(lane, "capabilityLanes"),
			})),
			instances: doc.instances.map((inst) => ({
				id: str(inst, "id"),
				role: str(inst, "role"),
				address: str(inst, "address"),
				secretRef:
					typeof inst.fields["secretRef"] === "string" ? (inst.fields["secretRef"] as string) : undefined,
				...(has(inst, "backupRetention") ? { backupRetention: num(inst, "backupRetention") } : {}),
			})),
			diagnostics: doc.diagnostics.map((d) => ({
				id: str(d, "id"),
				deviceId: str(d, "deviceId"),
			})),
			alertDestination: doc.alertDestination
				? {
						url: str(doc.alertDestination, "url"),
						secretRef:
							typeof doc.alertDestination.fields["secretRef"] === "string"
								? (doc.alertDestination.fields["secretRef"] as string)
								: undefined,
					}
				: undefined,
			improvementObjectiveOrder: (doc.improvementObjectiveOrder ?? []).map((x) => String(x)),
		}
	}
}

/** Convenience factory. */
export const createInventoryValidator = (): InventoryValidator => new DefaultInventoryValidator()

// ======================= module-local helpers ============================

type Report = (fieldPath: string, code: string, message: string) => void

interface CollectedIds {
	devices: Set<string>
	endpoints: Set<string>
	residencyGroups: Set<string>
	offerings: Set<string>
	clouds: Set<string>
	lanes: Set<string>
	instances: Set<string>
}

// Known field names per kind (Requirement 2.11 unknown-field detection).
const DEVICE_FIELDS = new Set(["id", "slotCeiling", "hostPreemption", "allocations"])
const RESIDENCY_FIELDS = new Set(["id", "swapLatencyMs"])
const ENDPOINT_FIELDS = new Set(["id", "provider", "deviceIds", "addresses", "secretRef", "noCredential"])
const OFFERING_FIELDS = new Set([
	"id",
	"endpointId",
	"deviceId",
	"modelId",
	"context",
	"slots",
	"residencyGroup",
	"tags",
	"ranks",
])
const CLOUD_FIELDS = new Set(["id", "provider", "modelId", "spend", "context", "tags"])
const LANE_FIELDS = new Set([
	"id",
	"names",
	"retiredNames",
	"capabilities",
	"minContext",
	"order",
	"maxSpend",
	"spillTiers",
	"failClosed",
	"maxQueueMs",
	"capabilityLanes",
])
const INSTANCE_FIELDS = new Set(["id", "role", "address", "secretRef", "noCredential", "backupRetention"])
const DIAGNOSTIC_FIELDS = new Set(["id", "deviceId"])
const ALERT_FIELDS = new Set(["url", "secretRef"])

const field = (entry: ParsedEntry, name: string): ParsedValue | undefined => entry.fields[name]

const has = (entry: ParsedEntry, name: string): boolean =>
	Object.prototype.hasOwnProperty.call(entry.fields, name) && entry.fields[name] !== undefined

const asList = (value: ParsedValue | undefined): ParsedScalar[] => {
	if (value === undefined) return []
	return Array.isArray(value) ? value : [value]
}

const requireField = (entry: ParsedEntry, name: string, base: string, v: Report): void => {
	if (!has(entry, name)) {
		v(`${base}.${name}`, "missing-field", `${name} is required`)
	}
}

// A field path "the sequence of field names and entry identifiers or list
// indices from the document root to the field" (Requirement 2.5). Entries are
// addressed by identifier when declared, otherwise by 0-based index.
const path = (kind: string, id: string | undefined, index: number): string =>
	typeof id === "string" && id.length > 0 ? `${kind}[${id}]` : `${kind}[${index}]`

const spendRank = (spend: string): number => SPEND_CLASSES.indexOf(spend as (typeof SPEND_CLASSES)[number])

// A tokenized URL path segment is the segment immediately following the
// consecutive, case-insensitive segments api / v1 / vscode (Requirement 22.5).
const hasTokenizedSegment = (url: string): boolean => {
	const pathPart = stripUrlToPath(url)
	const segments = pathPart.split("/").filter((s) => s.length > 0)
	for (let i = 0; i + 3 < segments.length; i++) {
		if (
			segments[i]?.toLowerCase() === "api" &&
			segments[i + 1]?.toLowerCase() === "v1" &&
			segments[i + 2]?.toLowerCase() === "vscode"
		) {
			const token = segments[i + 3]
			if (token === undefined) continue
			// A secret reference in the Fleet_Inventory secret-reference syntax
			// is exempt; any other value (including a non-secret placeholder) is
			// a tokenized segment that must be redacted (Requirement 22.5).
			if (SECRET_REF_RE.test(token) && token.includes(":")) {
				continue
			}
			return true
		}
	}
	return false
}

const hasUserInfoPassword = (url: string): boolean => {
	// scheme://user:password@host/... — a ':' in the user-info part.
	const m = /^[a-z][a-z0-9+.-]*:\/\/([^/@]+)@/i.exec(url)
	if (!m || m[1] === undefined) return false
	return m[1].includes(":")
}

const looksLikeUrl = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(s)

const stripUrlToPath = (url: string): string => {
	const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
	const slash = withoutScheme.indexOf("/")
	if (slash < 0) return "/"
	const afterAuthority = withoutScheme.slice(slash)
	const noQuery = afterAuthority.split(/[?#]/)[0] ?? ""
	return noQuery.startsWith("/") ? noQuery : `/${noQuery}`
}
