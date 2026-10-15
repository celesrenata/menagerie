// Inventory_Printer (OmniRoute Fleet Topology, Requirements 2.3, 2.4).
//
// Formats a typed `FleetInventory` back into a Fleet_Inventory KDL document.
// Two properties govern this module:
//
//   - Requirement 2.3 (printer stability): equal models print byte-identically.
//     Every node emits its fields in a fixed order, every list is space-joined
//     in model order, and no value is drawn from an unordered structure, so the
//     output is a pure, deterministic function of the model.
//   - Requirement 2.4 (round-trip): `parse(print(m))` equals `m` for every model
//     the Inventory_Validator accepts, including the element order of every
//     ordered field. The emitted shape is the canonical KDL layout of design §1,
//     with one node per entry and a 1:1 mapping from node name + property to the
//     typed field, so the Inventory_Parser recovers every field and value.
//
// The output is produced deterministically as text (not via a KDL library
// pretty-printer) so field order, quoting, indentation, and line endings are
// fully controlled and stable. The grammar emitted here is a subset of KDL that
// the `kdljs`-based Inventory_Parser accepts.

import type { FleetInventory } from "@roo-code/types"

const NEWLINE = "\n"
const INDENT = "  "

/**
 * The Inventory_Printer: a typed `FleetInventory` model to a KDL document.
 */
export interface InventoryPrinter {
	print(model: FleetInventory): string
}

/**
 * Escape a string for a KDL double-quoted string literal. Only the characters
 * that KDL requires escaping inside a quoted string are escaped, each to a
 * single stable form, so printing is deterministic and the parser recovers the
 * exact original value.
 */
function quote(value: string): string {
	let out = '"'
	for (const char of value) {
		switch (char) {
			case "\\":
				out += "\\\\"
				break
			case '"':
				out += '\\"'
				break
			case "\n":
				out += "\\n"
				break
			case "\r":
				out += "\\r"
				break
			case "\t":
				out += "\\t"
				break
			case "\b":
				out += "\\b"
				break
			case "\f":
				out += "\\f"
				break
			default:
				out += char
		}
	}
	return out + '"'
}

/**
 * Render a space-joined list as a single quoted KDL string, matching the
 * `tags="chat code"` form of design §1. The list is emitted in model order so
 * ordered fields (names, capability lanes, device bindings) round-trip exactly.
 *
 * The space separator is the canonical list encoding of design §1 and is the
 * shared contract with the Inventory_Parser, which splits these properties on
 * whitespace. Individual list elements (identifiers, capability tags, route
 * names) are whitespace-free in every inventory the Inventory_Validator accepts,
 * so the join is unambiguous; a validated model round-trips exactly.
 */
function quoteList(values: readonly string[]): string {
	return quote(values.join(" "))
}

/** Render a KDL integer argument (no decimal point, no exponent). */
function int(value: number): string {
	return String(Math.trunc(value))
}

/**
 * Render a KDL (v2) boolean keyword. KDL v2 spells booleans `#true`/`#false`;
 * a bare `true`/`false` is an identifier string, not a boolean, so the keyword
 * form is required for the value to round-trip back to a boolean.
 */
function bool(value: boolean): string {
	return value ? "#true" : "#false"
}

/**
 * Build one line of a KDL node: a name, zero or more positional (quoted)
 * arguments, and zero or more `key=value` properties in the given order.
 */
function node(name: string, args: readonly string[], props: readonly string[], depth: number): string {
	const parts = [name, ...args, ...props]
	return INDENT.repeat(depth) + parts.join(" ")
}

/**
 * The default Inventory_Printer. Each entry kind is emitted as one top-level
 * node whose property order is fixed by this module, so the document is a stable
 * function of the model.
 */
export const inventoryPrinter: InventoryPrinter = {
	print(model: FleetInventory): string {
		const lines: string[] = []

		// Alert_Destination (optional): url first, then the secret reference.
		if (model.alertDestination) {
			const props = [`url=${quote(model.alertDestination.url)}`]
			if (model.alertDestination.secretRef !== undefined) {
				props.push(`secret=${quote(model.alertDestination.secretRef)}`)
			}
			lines.push(node("alert-destination", [], props, 0))
		}

		// OmniRoute_Instances. `backup-retention` is a child node (design §1).
		for (const instance of model.instances) {
			const props = [`role=${quote(instance.role)}`, `address=${quote(instance.address)}`]
			if (instance.secretRef !== undefined) {
				props.push(`secret=${quote(instance.secretRef)}`)
			} else {
				props.push(`no-credential=${bool(true)}`)
			}
			lines.push(node("instance", [quote(instance.id)], props, 0) + " {")
			lines.push(node("backup-retention", [int(instance.backupRetention)], [], 1))
			lines.push("}")
		}

		// Devices.
		for (const device of model.devices) {
			const props = [
				`slot-ceiling=${int(device.slotCeiling)}`,
				`host-preemption=${bool(device.hostPreemption)}`,
			]
			lines.push(node("device", [quote(device.id)], props, 0))
		}

		// Serving_Endpoints. Addresses and the credential statement are children.
		for (const endpoint of model.endpoints) {
			const props = [`provider=${quote(endpoint.provider)}`, `devices=${quoteList(endpoint.deviceIds)}`]
			lines.push(node("endpoint", [quote(endpoint.id)], props, 0) + " {")
			for (const address of endpoint.addresses) {
				lines.push(
					node("address", [], [`instance=${quote(address.instanceId)}`, `url=${quote(address.url)}`], 1),
				)
			}
			if (endpoint.secretRef !== undefined) {
				lines.push(node("secret", [quote(endpoint.secretRef)], [], 1))
			} else {
				lines.push(node("no-credential", [bool(true)], [], 1))
			}
			lines.push("}")
		}

		// Residency_Groups.
		for (const residency of model.residencyGroups) {
			lines.push(node("residency", [quote(residency.id)], [`swap-latency-ms=${int(residency.swapLatencyMs)}`], 0))
		}

		// Model_Offerings. One `rank` child per slot, in slot order (Req 2.4).
		for (const offering of model.offerings) {
			const props = [
				`endpoint=${quote(offering.endpointId)}`,
				`device=${quote(offering.deviceId)}`,
				`id=${quote(offering.modelId)}`,
				`context=${int(offering.context)}`,
				`slots=${int(offering.slots)}`,
				`residency=${quote(offering.residencyGroup)}`,
				`tags=${quoteList(offering.tags)}`,
			]
			lines.push(node("model", [quote(offering.id)], props, 0) + " {")
			for (const rank of offering.ranks) {
				lines.push(node("rank", [int(rank)], [], 1))
			}
			lines.push("}")
		}

		// Cloud_Targets.
		for (const cloud of model.clouds) {
			const props = [
				`provider=${quote(cloud.provider)}`,
				`id=${quote(cloud.modelId)}`,
				`spend=${quote(cloud.spend)}`,
				`context=${int(cloud.context)}`,
				`tags=${quoteList(cloud.tags)}`,
			]
			lines.push(node("cloud", [quote(cloud.id)], props, 0))
		}

		// Lane_Definitions. Spill tiers are children, in declared order (Req 2.4).
		for (const lane of model.lanes) {
			const props = [
				`names=${quoteList(lane.names)}`,
				`capabilities=${quoteList(lane.capabilities)}`,
				`min-context=${int(lane.minContext)}`,
				`order=${quote(lane.order)}`,
				`max-spend=${quote(lane.maxSpend)}`,
				`fail-closed=${bool(lane.failClosed)}`,
				`max-queue-ms=${int(lane.maxQueueMs)}`,
				`capability-lanes=${quoteList(lane.capabilityLanes)}`,
			]
			lines.push(node("lane", [quote(lane.id)], props, 0) + " {")
			for (const tier of lane.spillTiers) {
				lines.push(node("spill", [quote(tier)], [], 1))
			}
			lines.push("}")
		}

		// Diagnostic_Routes.
		for (const diagnostic of model.diagnostics) {
			lines.push(node("diagnostic", [quote(diagnostic.id)], [`device=${quote(diagnostic.deviceId)}`], 0))
		}

		// Improvement-objective order (Requirement 1.16): a single ordered list.
		lines.push(node("improvement-objective-order", [quoteList(model.improvementObjectiveOrder)], [], 0))

		return lines.join(NEWLINE) + NEWLINE
	},
}
