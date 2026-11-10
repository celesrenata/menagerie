import type { SpecEvidenceRecord, SpecRevision } from "@roo-code/types"

import { sealRevision } from "../specRevision"

type Content = Parameters<typeof sealRevision>[0]

/** Three requirements, three tasks (t2 depends on t1), each with one required runner check. */
export function baseContent(over: Partial<Content> = {}): Content {
	return {
		specId: "demo",
		policy: "strict",
		sourceRevision: "git:aaa",
		requirements: [
			{ id: "R1", text: "Sessions expire after 30 minutes.", acceptanceIds: ["A1"] },
			{ id: "R2", text: "Passwords are at least 12 characters.", acceptanceIds: ["A2"] },
			{ id: "R3", text: "Failed logins are rate limited.", acceptanceIds: ["A3"] },
		],
		decisions: [{ id: "D1", rationale: "Use a server-side session store.", requirementIds: ["R1"] }],
		tasks: [
			{ id: "t1", summary: "Session expiry", dependsOn: [], requirementIds: ["R1"], decisionIds: ["D1"], acceptanceIds: ["A1"], filesWrite: ["src/session.ts"] },
			{ id: "t2", summary: "Password policy", dependsOn: ["t1"], requirementIds: ["R2"], acceptanceIds: ["A2"], filesWrite: ["src/password.ts"] },
			{ id: "t3", summary: "Rate limit", dependsOn: [], requirementIds: ["R3"], acceptanceIds: ["A3"], filesWrite: ["src/ratelimit.ts"] },
		],
		acceptance: [
			{ id: "A1", text: "Session expiry test passes", required: true, evidenceKind: "test", checkRef: "C1" },
			{ id: "A2", text: "Password test passes", required: true, evidenceKind: "test", checkRef: "C2" },
			{ id: "A3", text: "Rate limit test passes", required: true, evidenceKind: "test", checkRef: "C3" },
		],
		checks: [
			{ id: "C1", kind: "test", command: ["pnpm", "test", "session"], inputs: ["src/session.ts"] },
			{ id: "C2", kind: "test", command: ["pnpm", "test", "password"], inputs: ["src/password.ts"] },
			{ id: "C3", kind: "test", command: ["pnpm", "test", "ratelimit"], inputs: ["src/ratelimit.ts"] },
		],
		...over,
	} as Content
}

export const baseRevision = (over: Partial<Content> = {}): SpecRevision => sealRevision(baseContent(over))

export function evidence(rev: SpecRevision, acceptanceId: string, over: Partial<SpecEvidenceRecord> = {}): SpecEvidenceRecord {
	const a = rev.acceptance.find((x) => x.id === acceptanceId)!
	const check = rev.checks.find((c) => c.id === a.checkRef)!
	return {
		revisionId: rev.revisionId,
		acceptanceId,
		checkId: check.id,
		sourceRevision: "git:aaa",
		inputDigests: Object.fromEntries((check.inputs ?? []).map((p) => [p, `digest-of-${p}`])),
		checkRunId: `run-${acceptanceId}`,
		status: "pass",
		exitCode: 0,
		artifactDigest: "a".repeat(64),
		source: "runner",
		recordedAt: 1_000,
		...over,
	}
}

export const currentDigests = (rev: SpecRevision): Record<string, string> =>
	Object.fromEntries(rev.checks.flatMap((c) => c.inputs ?? []).map((p) => [p, `digest-of-${p}`]))
