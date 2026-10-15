// Loose parse representation of a Fleet_Inventory document (design §1,
// Requirements 2.1, 2.2).
//
// The Inventory_Parser does NOT produce the typed `FleetInventory`; that is the
// Inventory_Validator's job (task 2.3). Instead it produces a `ParsedDocument`
// that retains *every* declared entry and field exactly as written — including
// field names and values the validator will later reject — so the validator can
// report every violation in one pass (Requirement 2.1, 2.10). Nothing here is
// range-checked, reference-checked, or coerced into the schema shape.

/** A KDL scalar value as retained verbatim from the document. */
export type ParsedValue = string | number | boolean | null

/**
 * One declared entry in the document (a top-level node such as `device`,
 * `endpoint`, `model`, `lane`, `instance`, …, or a nested child node such as a
 * model's `rank` or a lane's `spill`). Every positional argument, every
 * `key=value` property, and every child is kept, unvalidated and in document
 * order.
 */
export interface ParsedEntry {
	/** The node name as written, e.g. `device`, `endpoint`, `model`, `rank`. */
	kind: string
	/**
	 * The entry's identity when it declares one: the first positional string
	 * argument (e.g. `device "rtx5090"` → `"rtx5090"`). `undefined` for entries
	 * that carry no leading id (e.g. a bare `rank 3`). Retained even when the
	 * value is not a string, in which case `id` is `undefined` and the raw value
	 * remains in `values`.
	 */
	id?: string
	/** Positional arguments in document order, verbatim. */
	values: ParsedValue[]
	/** `key=value` properties, keyed by property name, verbatim. */
	properties: Record<string, ParsedValue>
	/** Child entries from this node's children block, in document order. */
	children: ParsedEntry[]
}

/**
 * The whole parsed document: a flat list of top-level entries in document
 * order, plus an index of entries grouped by their declared kind for the
 * validator's convenience. Both views reference the same `ParsedEntry` objects.
 */
export interface ParsedDocument {
	/** Every top-level entry in document order. */
	entries: ParsedEntry[]
	/** Top-level entries grouped by `kind`, each list in document order. */
	byKind: Record<string, ParsedEntry[]>
}

/**
 * A syntax error from the Inventory_Parser (Requirement 2.2). It names the
 * 1-based line and column at which the document cannot be parsed and the kind of
 * syntax element that is unexpected or missing. It carries NO field value from
 * the document.
 */
export interface ParseError {
	/** 1-based line of the offending syntax element. */
	line: number
	/** 1-based column of the offending syntax element. */
	column: number
	/**
	 * The category of syntax fault, classifying what went wrong without quoting
	 * any field value from the document.
	 */
	elementKind: ParseErrorKind
	/**
	 * A human-readable description of the fault. Describes the kind of element
	 * that is unexpected or missing; never includes a field value from the
	 * document.
	 */
	message: string
}

/**
 * The classes of syntax fault the parser distinguishes. `unexpected` covers an
 * element that appears where the grammar does not allow it (including trailing
 * input and malformed tokens); `missing` covers an element the grammar requires
 * but that is absent.
 */
export type ParseErrorKind = "unexpected" | "missing"
