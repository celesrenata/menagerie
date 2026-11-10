import type { SpecRevision } from "@roo-code/types"

import type { ParentOutcome } from "../task/verificationGate"
import { digestInputs, runSpecCheck, type ExecFn } from "./SpecCheckRunner"
import { evaluateSpecGate, type GateResult } from "./SpecGate"
import { verifierGatePassed } from "./SpecGateJoin"
import type { SpecRevisionStore } from "./SpecRevisionStore"

/**
 * Runs every executable check of an approved revision, records the evidence append-only, and
 * returns the deterministic gate result (R8.3). Inspection checks are never run here; they stay
 * missing until a human records evidence, so they block `strict` rather than pass.
 */
export interface VerifySpecArgs {
	store: SpecRevisionStore
	revision: SpecRevision
	workspaceRoot: string
	sourceRevision: string
	/** Per-task outcomes from the existing `gateParentOutcome`; empty means nothing was verified. */
	verifierOutcomes: readonly ParentOutcome[]
	exec?: ExecFn
	now?: () => number
	timeoutMs?: number
}

export async function verifySpecRevision(args: VerifySpecArgs): Promise<GateResult> {
	const { store, revision: rev } = args
	const approval = await store.findApproval(rev.specId, rev.revisionId)
	for (const acceptance of rev.acceptance) {
		const check = rev.checks.find((c) => c.id === acceptance.checkRef)
		if (!check || check.kind === "inspection" || !check.command) continue
		const record = await runSpecCheck({
			revision: rev,
			acceptanceId: acceptance.id,
			workspaceRoot: args.workspaceRoot,
			approval,
			sourceRevision: args.sourceRevision,
			exec: args.exec,
			now: args.now,
			timeoutMs: args.timeoutMs,
		})
		await store.appendEvidence(record)
	}
	const { records } = await store.readEvidence(rev.specId)
	const allInputs = [...new Set(rev.checks.flatMap((c) => c.inputs ?? []))]
	return evaluateSpecGate({
		revision: rev,
		approval,
		evidence: records,
		currentSourceRevision: args.sourceRevision,
		currentInputDigests: await digestInputs(args.workspaceRoot, allInputs),
		verifierGatePassed: verifierGatePassed(args.verifierOutcomes),
	})
}
