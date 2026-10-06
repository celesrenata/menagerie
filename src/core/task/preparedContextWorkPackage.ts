// Feature: capability-lanes-routing
//
// The `PreparedContextWorkPackage` builder: the compact, concise-only package
// delivered to the `coder.primary` lane before implementation. It merges the
// reader output contract (Req 4), `Worker_Bootstrap_Retrieval` evidence
// (semantic-first-retrieval `EvidencePacket`), and `AutonomousTaskState`
// (mastermind-execution-metadata) into exactly the nine defined fields.
//
// The builder is pure (no I/O) and copies ONLY concise findings and evidence
// references — never full file contents or function bodies, even when an input
// origin (such as an `EvidenceItem.snippet`) carries raw source material
// (Req 6.3, 6.5, 13.5, 13.6).

// `EvidenceReference` and `AutonomousTaskState` are consumed read-only from the
// mastermind-execution-metadata types (sibling modules autonomousTaskState.ts /
// normalizeWorkerResult.ts import these from `@roo-code/types`).
import type { AutonomousTaskState, EvidenceReference } from "@roo-code/types"

// `EvidencePacket` is consumed read-only from the semantic-first-retrieval
// types. `Worker_Bootstrap_Retrieval` produces this bounded (~5-8 item) packet;
// its `EvidenceItem`s carry a `file` and a `[startLine, endLine]` range plus an
// optional `snippet` of raw source — the builder reads only the location and
// reason, never the snippet (Req 6.5).
import type { EvidencePacket } from "../exploration/types"

/**
 * One concise reader finding — the Req 4 reader output contract shape. A finding
 * is a claim with an optional `file:line` location *reference* (never a code
 * block), an explanation of why it matters, an uncertainty note, a confidence
 * score, and a list of {@link EvidenceReference}s. It never embeds raw source
 * (Req 6.5).
 */
export interface ReaderFinding {
	claim: string
	/** A `file:line` reference string, not a code block (Req 6.5). */
	location?: string
	whyItMatters?: string
	uncertainty?: string
	confidence?: number
	/** Reused from the mastermind-execution-metadata evidence contract. */
	evidence: EvidenceReference[]
}

/**
 * The compact context package handed to the `coder.primary` lane before
 * implementation (Req 6.1, 6.2). It contains exactly nine fields; the builder
 * populates only those for which input is available and omits the rest. It holds
 * concise findings and evidence references only — never raw source (Req 6.3,
 * 6.5).
 */
export interface PreparedContextWorkPackage {
	objective: string
	relevantFiles: string[]
	relevantSymbols: string[]
	readerFindings: ReaderFinding[]
	architecturalConstraints: string[]
	knownAssumptions: string[]
	existingTestFailures: string[]
	expectedBehavior: string
	implementationBoundaries: string[]
}

/**
 * Inputs to {@link PreparedContextWorkPackageBuilder.build}. `readerFindings`
 * come from the reader output contract (Req 4); `bootstrap` is the optional
 * `Worker_Bootstrap_Retrieval` evidence packet (semantic-first-retrieval); and
 * `taskState` is the optional authoritative {@link AutonomousTaskState}
 * (mastermind-execution-metadata).
 */
export interface PreparedContextInputs {
	objective: string
	readerFindings: ReaderFinding[]
	bootstrap?: EvidencePacket
	taskState?: AutonomousTaskState
}

/**
 * Builds a {@link PreparedContextWorkPackage} from reader findings plus optional
 * bootstrap evidence and task state. Populates only the defined fields; omits
 * fields with no available input. Never embeds raw source.
 */
export interface PreparedContextWorkPackageBuilder {
	build(inputs: PreparedContextInputs): PreparedContextWorkPackage
}

/**
 * Appends `value` to `target` only when it is a non-empty, not-yet-present
 * string, keeping the derived lists concise and free of duplicates.
 */
function pushUnique(target: string[], value: string | undefined): void {
	if (value === undefined) {
		return
	}

	const trimmed = value.trim()

	if (trimmed.length === 0 || target.includes(trimmed)) {
		return
	}

	target.push(trimmed)
}

/**
 * Derives a concise `file:line` reference (never a code block) from a bootstrap
 * {@link EvidencePacket} item, using its file path and line range. The item's
 * optional `snippet` of raw source is deliberately ignored (Req 6.5).
 */
function fileLineReference(file: string, startLine: number): string {
	return `${file}:${startLine}`
}

/**
 * Merges reader findings (Req 4), `Worker_Bootstrap_Retrieval` evidence
 * (`EvidencePacket`), and `AutonomousTaskState` into the nine defined package
 * fields. Pure and synchronous: it reads only the passed-in inputs and copies
 * concise findings and location references, never raw source (Req 6.3, 6.5).
 */
function buildPreparedContextWorkPackage(inputs: PreparedContextInputs): PreparedContextWorkPackage {
	const { readerFindings, bootstrap, taskState } = inputs

	const relevantFiles: string[] = []
	const relevantSymbols: string[] = []
	const architecturalConstraints: string[] = []
	const knownAssumptions: string[] = []
	const existingTestFailures: string[] = []
	const implementationBoundaries: string[] = []

	// Reader findings contribute their locations as relevant files. The finding
	// objects themselves are already concise (claim/location/evidence) and are
	// carried through verbatim — they never contain raw source (Req 6.5).
	for (const finding of readerFindings) {
		if (finding.location !== undefined) {
			const file = finding.location.split(":")[0]
			pushUnique(relevantFiles, file)
		}

		for (const reference of finding.evidence) {
			if (reference.type === "file") {
				pushUnique(relevantFiles, reference.reference)
			}
		}
	}

	// Bootstrap evidence contributes concise file:line references only. The raw
	// `snippet` on each item is intentionally never read into the package.
	if (bootstrap !== undefined) {
		for (const item of bootstrap.items) {
			pushUnique(relevantFiles, item.file)
			pushUnique(relevantSymbols, fileLineReference(item.file, item.startLine))
		}
	}

	// Objective prefers the explicit input, falling back to the task-state
	// objective when the explicit value is empty.
	const objective = inputs.objective.trim().length > 0 ? inputs.objective : (taskState?.objective ?? "")

	let expectedBehavior = ""

	// Task state contributes constraints, assumptions, test-failure blockers,
	// touched files, and next-action boundaries — all already concise strings.
	if (taskState !== undefined) {
		for (const constraint of taskState.constraints) {
			pushUnique(architecturalConstraints, constraint)
		}

		for (const assumption of taskState.assumptions) {
			pushUnique(knownAssumptions, assumption)
		}

		for (const blocker of taskState.blockers) {
			pushUnique(existingTestFailures, blocker)
		}

		for (const file of taskState.filesTouched) {
			pushUnique(relevantFiles, file)
		}

		for (const nextAction of taskState.nextActions) {
			pushUnique(implementationBoundaries, nextAction)
		}

		// The first open question, when present, seeds the expected-behavior
		// summary; it is a concise prompt string, not raw source.
		expectedBehavior = taskState.openQuestions[0]?.trim() ?? ""
	}

	const workPackage: PreparedContextWorkPackage = {
		objective,
		relevantFiles,
		relevantSymbols,
		readerFindings,
		architecturalConstraints,
		knownAssumptions,
		existingTestFailures,
		expectedBehavior,
		implementationBoundaries,
	}

	return workPackage
}

/**
 * Factory returning a {@link PreparedContextWorkPackageBuilder}. The returned
 * object exposes the pure `build` function so callers can inject or fake the
 * builder in the reader→coder handoff wiring.
 */
export function createPreparedContextWorkPackageBuilder(): PreparedContextWorkPackageBuilder {
	return {
		build: buildPreparedContextWorkPackage,
	}
}
