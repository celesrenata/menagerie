// Inventory_Parser (design §1, Requirements 2.1, 2.2).
//
// Parses a Fleet_Inventory KDL document into a loose `ParsedDocument` that
// retains every declared entry and field — including fields the
// Inventory_Validator will later reject — so the validator can report every
// violation in one pass. On a syntax error it returns a `ParseError` naming the
// 1-based line and column and whether a syntax element is unexpected or missing,
// carrying no field value from the document.
//
// The parser performs no referential, numeric, uniqueness, role, or secret
// checks and never coerces values toward the typed schema; that is the
// Inventory_Validator's responsibility (task 2.3).

import { parse as parseKdl } from "kdljs"
import type { Document, Node, Value } from "kdljs"

import { type Result, ok, err } from "../result.js"
import type { ParsedDocument, ParsedEntry, ParsedValue, ParseError, ParseErrorKind } from "./parsed-document.js"

/** The Inventory_Parser interface (design §1). */
export interface InventoryParser {
	parse(doc: string): Result<ParsedDocument, ParseError>
}

/**
 * Parse a Fleet_Inventory KDL document.
 *
 * On success the returned `ParsedDocument` keeps every top-level entry in
 * document order and an index of entries by kind; both views reference the same
 * entry objects (Requirement 2.1). On a syntax error the result is a
 * `ParseError` with a 1-based line/column and an `elementKind` of `unexpected`
 * or `missing`; it never includes a field value from the document
 * (Requirement 2.2).
 */
export function parse(doc: string): Result<ParsedDocument, ParseError> {
	const result = parseKdl(doc)

	if (result.errors.length > 0 || result.output === undefined) {
		return err(toParseError(result.errors[0], doc))
	}

	return ok(toParsedDocument(result.output))
}

/** The Inventory_Parser as an object implementing the design interface. */
export const inventoryParser: InventoryParser = { parse }

// --- Document transformation -------------------------------------------------

function toParsedDocument(document: Document): ParsedDocument {
	const entries = document.map(toParsedEntry)
	const byKind: Record<string, ParsedEntry[]> = {}

	for (const entry of entries) {
		;(byKind[entry.kind] ??= []).push(entry)
	}

	return { entries, byKind }
}

function toParsedEntry(node: Node): ParsedEntry {
	const values = node.values.map(toParsedValue)
	const id = typeof node.values[0] === "string" ? node.values[0] : undefined

	const properties: Record<string, ParsedValue> = {}
	for (const [key, value] of Object.entries(node.properties)) {
		properties[key] = toParsedValue(value)
	}

	return {
		kind: node.name,
		id,
		values,
		properties,
		children: node.children.map(toParsedEntry),
	}
}

function toParsedValue(value: Value): ParsedValue {
	// kdljs values are already string | number | boolean | null, which is the
	// `ParsedValue` set. Retained verbatim with no coercion.
	return value
}

// --- Syntax-error mapping ----------------------------------------------------

/**
 * The minimal shape the parser reads off a kdljs/Chevrotain recognition
 * exception. kdljs normalizes both lexer and parser faults into objects with a
 * `token` (which may carry a 1-based `startLine`/`startColumn`, or `null` at
 * end-of-input), a `name`, and a `message`. The raw `message` can quote the
 * offending text, so it is NEVER forwarded into a `ParseError`.
 */
interface RecognitionLike {
	name?: string
	token?: {
		startLine?: number | null
		startColumn?: number | null
		tokenType?: { name?: string }
	}
}

function toParseError(raw: RecognitionLike | undefined, doc: string): ParseError {
	const token = raw?.token
	const atEndOfInput = isEndOfInput(token)
	const position = atEndOfInput ? endOfDocument(doc) : resolvePosition(token, doc)

	// A fault at end-of-input means the grammar required an element the document
	// never supplied (an unclosed children block, a construct cut short) — that
	// is a MISSING element. A fault on a concrete token means an element appeared
	// where the grammar does not allow it — that is an UNEXPECTED element. This
	// classification reads only the token's type and position, never its value.
	const elementKind: ParseErrorKind = atEndOfInput ? "missing" : "unexpected"

	return {
		line: position.line,
		column: position.column,
		elementKind,
		message: describe(elementKind),
	}
}

/**
 * True when the fault's token is the end-of-input marker — either explicitly
 * typed `EOF` or reported with no position, as Chevrotain does when input ends
 * before a required token.
 */
function isEndOfInput(token: RecognitionLike["token"]): boolean {
	if (!token) {
		return true
	}
	if (token.tokenType?.name === "EOF") {
		return true
	}
	return typeof token.startLine !== "number" || typeof token.startColumn !== "number"
}

function describe(kind: ParseErrorKind): string {
	return kind === "missing"
		? "a required syntax element is missing"
		: "an unexpected syntax element was encountered"
}

/**
 * Resolve the 1-based line/column of a concrete offending token, falling back to
 * the end of the document if the position is somehow absent.
 */
function resolvePosition(
	token: RecognitionLike["token"],
	doc: string,
): { line: number; column: number } {
	if (token && typeof token.startLine === "number" && typeof token.startColumn === "number") {
		return { line: token.startLine, column: token.startColumn }
	}

	return endOfDocument(doc)
}

function endOfDocument(doc: string): { line: number; column: number } {
	if (doc.length === 0) {
		return { line: 1, column: 1 }
	}

	const lines = doc.split(/\r?\n/)
	const line = lines.length
	const lastLine = lines[line - 1] ?? ""
	const column = lastLine.length + 1

	return { line, column }
}
