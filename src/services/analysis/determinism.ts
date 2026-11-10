/**
 * Numeric-noise probe for the serving stack (MEN-GRANITE-SDD-001 R3.4).
 *
 * The service decodes greedily (temperature is ignored), so identical requests should give
 * identical text. When they do not, near-tie tokens are flipping: KV quantization, the
 * speculative verify path, or batching across slots. That noise is what becomes a stray
 * bracket or a different judgement. This measures it directly, in minutes, without labels,
 * so a serving config (KV format, EAGLE on/off, slot count) can be compared before spending
 * a full golden run on it.
 */
export type Complete = (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) => Promise<string>

export interface DeterminismResult {
	caseId: string
	sequentialDistinct: number
	concurrentDistinct: number
	runs: number
}

export interface DeterminismReport {
	cases: number
	runsPerMode: number
	/** Mean of (distinct outputs - 1) / (runs - 1): 0 = fully deterministic, 1 = every run differs. */
	sequentialNoise: number
	concurrentNoise: number
	perCase: DeterminismResult[]
}

const noise = (distinct: number, runs: number) => (runs <= 1 ? 0 : (distinct - 1) / (runs - 1))

export async function measureDeterminism(
	complete: Complete,
	cases: ReadonlyArray<{ id: string; messages: Parameters<Complete>[0] }>,
	runs: number,
	/** Characters compared; the tail of a ramble is irrelevant noise. */
	compareChars = 400,
): Promise<DeterminismReport> {
	const perCase: DeterminismResult[] = []
	for (const c of cases) {
		const sequential: string[] = []
		for (let i = 0; i < runs; i++) sequential.push((await complete(c.messages)).slice(0, compareChars))
		const concurrent = (await Promise.all(Array.from({ length: runs }, () => complete(c.messages)))).map((t) => t.slice(0, compareChars))
		perCase.push({ caseId: c.id, sequentialDistinct: new Set(sequential).size, concurrentDistinct: new Set(concurrent).size, runs })
	}
	const mean = (f: (r: DeterminismResult) => number) => (perCase.length ? perCase.reduce((n, r) => n + f(r), 0) / perCase.length : 0)
	return {
		cases: cases.length,
		runsPerMode: runs,
		sequentialNoise: mean((r) => noise(r.sequentialDistinct, r.runs)),
		concurrentNoise: mean((r) => noise(r.concurrentDistinct, r.runs)),
		perCase,
	}
}
