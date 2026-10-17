/**
 * Named, bounded read-only "scout" readers (lift C3).
 *
 * The historical reader swarm appends one generic contract-audit reader per
 * useful shared document. This module generalizes that into separately NAMED,
 * bounded read-only jobs — `symbol locator`, `call-graph scout`, `API contract
 * reader`, `test failure analyst`, `dependency docs scout` — each carrying an
 * explicit scope, a byte budget, a short structured result schema, and a
 * concrete information-gain score. The coordinator ranks candidates by that
 * score and spawns only the top ones up to the elastic ceiling, so it never
 * manufactures filler work "just to occupy a GPU" (lift C3, PAR-005.5/005.6).
 *
 * Pure and deterministic: given the same workspace facts it returns the same
 * ranked, budgeted specs, which makes the selection logic unit-testable without
 * a VS Code host or a filesystem.
 */

import type { ParallelTaskSpec } from "../tools/ParallelTasksTool"

/** A single named scout-reader role. Each is strictly read-only. */
export type ScoutReaderKind =
	| "symbol-locator"
	| "call-graph-scout"
	| "api-contract-reader"
	| "test-failure-analyst"
	| "dependency-docs-scout"

/**
 * The bounded contract every scout reader is held to. A missing budget means
 * "use the reader default"; a missing scope means "the whole workspace root"
 * (still bounded by {@link ScoutReaderSpec.byteBudget}). The structured result
 * schema keeps the parent-visible return channel small — never a raw transcript.
 */
export interface ScoutReaderSpec {
	kind: ScoutReaderKind
	/** Stable, unique spec name so the DAG and results stay addressable. */
	name: string
	/** Human-readable, bounded work-intent description (OmniRoute places inference). */
	message: string
	/** Relative path scope, or `undefined` for the workspace root. */
	scope?: string
	/** Maximum bytes of source material this reader may read. */
	byteBudget: number
	/** Wall-clock timeout in ms; past it the reader is failed, not retried forever. */
	timeoutMs: number
	/** The short structured result schema the reader must return. */
	resultSchema: string
	/** 0..1 relative information gain; used to rank and cap fan-out. */
	informationGain: number
	/** Nominal scheduling priority; readers are `background` by default. */
	priority: "critical" | "high" | "normal" | "background" | "speculative"
}

/** Reader defaults shared with `ParallelTaskReader`'s historical bounds. */
export const SCOUT_READER_DEFAULTS = {
	byteBudget: 48 * 1024,
	excerptChars: 10_000,
	timeoutMs: 120_000,
} as const

/**
 * A workspace fact the scout set is planned against. The planner turns these
 * into concrete, bounded reader jobs; an absent fact means that reader has no
 * useful scope and is NOT spawned (no filler).
 */
export interface ScoutWorkspaceFacts {
	/** Candidate symbols the coordinator wants located (information-gain driven). */
	symbols?: string[]
	/** Entry points whose call graph the coordinator wants traced. */
	callGraphEntryPoints?: string[]
	/** API/contract documents worth a focused contract read. */
	contractDocs?: string[]
	/** Failing test ids the coordinator wants analyzed. */
	failingTests?: string[]
	/** Third-party dependency names worth a docs scout. */
	dependencies?: string[]
	/** Workspace-relative path prefix to scope all readers; defaults to root. */
	scope?: string
	/** The reader mode slug available to the coordinator (e.g. "project-reader"). */
	readerMode?: string
}

/**
 * Build the NAMED scout-reader set for the given workspace facts. Only readers
 * with at least one concrete scope are produced — an empty fact yields zero
 * readers, never a fabricated job. The result is sorted by descending
 * information gain so the caller can take the top-N within the elastic ceiling.
 */
export function planScoutReaders(facts: ScoutWorkspaceFacts): ScoutReaderSpec[] {
	const mode = facts.readerMode ?? "project-reader"
	const scope = facts.scope
	const readers: ScoutReaderSpec[] = []

	if (facts.symbols && facts.symbols.length > 0) {
		readers.push({
			kind: "symbol-locator",
			name: "scout-symbol-locator",
			message: `Locate definitions/usages of: ${facts.symbols.join(", ")}. Return symbol, file, and line only.`,
			scope,
			byteBudget: SCOUT_READER_DEFAULTS.byteBudget,
			timeoutMs: SCOUT_READER_DEFAULTS.timeoutMs,
			resultSchema: "symbols[]: {name, file, line}",
			informationGain: 0.9,
			priority: "background",
		})
	}

	if (facts.callGraphEntryPoints && facts.callGraphEntryPoints.length > 0) {
		readers.push({
			kind: "call-graph-scout",
			name: "scout-call-graph",
			message: `Trace the call graph from entry points: ${facts.callGraphEntryPoints.join(", ")}. Return call edges only.`,
			scope,
			byteBudget: SCOUT_READER_DEFAULTS.byteBudget,
			timeoutMs: SCOUT_READER_DEFAULTS.timeoutMs,
			resultSchema: "edges[]: {from, to, file, line}",
			informationGain: 0.75,
			priority: "background",
		})
	}

	if (facts.contractDocs && facts.contractDocs.length > 0) {
		readers.push({
			kind: "api-contract-reader",
			name: "scout-api-contract",
			message: `Read API/contract docs: ${facts.contractDocs.join(", ")}. Summarize request/response shapes only.`,
			scope,
			byteBudget: SCOUT_READER_DEFAULTS.byteBudget,
			timeoutMs: SCOUT_READER_DEFAULTS.timeoutMs,
			resultSchema: "contracts[]: {endpoint, request, response}",
			informationGain: 0.8,
			priority: "background",
		})
	}

	if (facts.failingTests && facts.failingTests.length > 0) {
		readers.push({
			kind: "test-failure-analyst",
			name: "scout-test-failure",
			message: `Analyze failing tests: ${facts.failingTests.join(", ")}. Return the asserted expectation and the actual, not full logs.`,
			scope,
			byteBudget: SCOUT_READER_DEFAULTS.byteBudget,
			timeoutMs: SCOUT_READER_DEFAULTS.timeoutMs,
			resultSchema: "failures[]: {test, expected, actual, file, line}",
			informationGain: 0.85,
			priority: "background",
		})
	}

	if (facts.dependencies && facts.dependencies.length > 0) {
		readers.push({
			kind: "dependency-docs-scout",
			name: "scout-dependency-docs",
			message: `Read docs for dependencies: ${facts.dependencies.join(", ")}. Return version-sensitive API notes only.`,
			scope,
			byteBudget: SCOUT_READER_DEFAULTS.byteBudget,
			timeoutMs: SCOUT_READER_DEFAULTS.timeoutMs,
			resultSchema: "deps[]: {name, version, notes}",
			informationGain: 0.6,
			priority: "background",
		})
	}

	void mode
	return [...readers].sort((a, b) => b.informationGain - a.informationGain)
}

/**
 * Take the top `ceiling` scout readers by information gain and project them onto
 * `ParallelTaskSpec`s for the reader mode. `ceiling <= 0` returns nothing — a
 * zero ceiling means "no scout fan-out", never a fabricated reader. The budget
 * and timeout ride on the spec so the scheduler holds each worker to the same
 * bounded contract that produced it.
 */
export function buildScoutReaderSpecs(
	facts: ScoutWorkspaceFacts,
	ceiling: number,
): ParallelTaskSpec[] {
	if (ceiling < 1) return []
	const readerMode = facts.readerMode ?? "project-reader"
	const ranked = planScoutReaders(facts).slice(0, ceiling)
	return ranked.map((reader) => ({
		name: reader.name,
		mode: readerMode,
		message: reader.message,
		// Bounded, structured — the parent-visible return channel is the result
		// schema above, never a raw transcript (lift C3).
		todos: null,
		filesRead: reader.scope ? [reader.scope] : undefined,
		expectedOutput: reader.resultSchema,
		deadlineMs: reader.timeoutMs,
		priority: reader.priority,
	}))
}
