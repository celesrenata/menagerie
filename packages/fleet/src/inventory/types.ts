// Loose parsed-document contract shared by the Inventory_Parser (task 2.1) and
// the Inventory_Validator (task 2.3).
//
// The parser produces a `ParsedDocument` that retains EVERY declared field,
// including fields the validator will reject and field names the format does
// not define (Requirement 2.1). The validator is the only component that turns
// a `ParsedDocument` into a typed `FleetInventory` (design §1); it reports every
// violation of every rule in one pass (Requirement 2.10) and never emits a
// secret value (Requirements 2.9, 22.4, 22.5).
//
// A field path is "the sequence of field names and entry identifiers or list
// indices from the document root to the field" (Requirement 2.5). The parser
// supplies each entry's base path (e.g. `offerings[coder-5090]`) and the raw
// field map; the validator appends field names and indices as it descends.

/** A raw scalar as it appeared in the document, before any typing. */
export type ParsedScalar = string | number | boolean | null

/** A raw field value: a scalar or an ordered list of scalars. */
export type ParsedValue = ParsedScalar | ParsedScalar[]

/**
 * One declared entry of any kind. `fields` holds every declared field under
 * its declared name (including names the format does not define), each mapped
 * to its raw value exactly as parsed, so the validator can range-check, detect
 * unknown fields, and report missing ones without the parser having pre-judged
 * them. `id` is the entry's declared identifier when the kind has one (used in
 * the field path); `index` is its 0-based position among entries of its kind
 * (used in the field path when no identifier is declared). `credentialFields`
 * names the subset of `fields` the format designates as credential-bearing, so
 * the validator can enforce the secret-reference rule (Requirement 2.9) without
 * guessing which fields hold credentials.
 */
export interface ParsedEntry {
	readonly id?: string
	readonly index: number
	readonly fields: Readonly<Record<string, ParsedValue>>
	readonly credentialFields?: readonly string[]
}

/**
 * The loose document the parser produces. Each array preserves declaration
 * order. The validator reads these, applies every rule, and (on acceptance)
 * emits the typed `FleetInventory`.
 */
export interface ParsedDocument {
	readonly devices: readonly ParsedEntry[]
	readonly endpoints: readonly ParsedEntry[]
	readonly residencyGroups: readonly ParsedEntry[]
	readonly offerings: readonly ParsedEntry[]
	readonly clouds: readonly ParsedEntry[]
	readonly lanes: readonly ParsedEntry[]
	readonly instances: readonly ParsedEntry[]
	readonly diagnostics: readonly ParsedEntry[]
	readonly alertDestination?: ParsedEntry
	/** The declared improvement-objective order, raw (Requirements 1.16, 20.8). */
	readonly improvementObjectiveOrder?: readonly ParsedScalar[]
}
