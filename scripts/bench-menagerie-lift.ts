#!/usr/bin/env tsx
/**
 * Menagerie lift — comparative benchmark on the pinned 8-task suite.
 *
 * Deterministic by construction: it computes the exact completion time for a
 * capacity-1 inference lane under two lease-holding models (no virtual clock
 * stepping, no timers), so the numbers reproduce identically on any machine and
 * are CI-stable. It is a COMPARATIVE benchmark of the lease boundary — the point
 * of lift C2 — not a wall-clock microbenchmark.
 *
 * Scenario (spec C2, "deterministic lease tests with capacity 1"): `WORKERS`
 * dispatched workers on a 1-slot lane. Each worker does one model generation
 * (`GENERATION_MS`) then waits on a tool (`TOOL_WAIT_MS` — the spec's "worker A
 * generates then waits on a 5-second tool"). The only difference between the two
 * strategies is when the single lane slot is released:
 *
 *  - **lifetime** (baseline, finding 7): the slot is held for the worker's whole
 *    lifetime — generation AND the tool wait — so the eight workers serialize
 *    over `G + T` each.
 *  - **per-generation** (P5, lift C2): the slot is held only during the
 *    generation; it is released before the tool wait. Generations still
 *    serialize on the single slot, but each worker's tool wait now runs
 *    off-lane and overlaps its peers' generations.
 *
 * Both strategies admit generations strictly in order on the single slot, so a
 * worker's generation `start` is fully determined by the slot's free time:
 *  - lifetime:        slot free after a completed worker = that worker's
 *                     `genStart + G + T`  (held through the tool wait)
 *  - per-generation:  slot free after a completed worker = `genStart + G`
 *                     (released at the end of the generation)
 * A worker settles when its own work finishes: `genStart + G` under
 * per-generation, `genStart + G + T` under lifetime (the tool wait still must
 * elapse before the task completes; only the lane is freed early).
 *
 * Run:  pnpm menagerie-lift:bench           (human table)
 *       pnpm menagerie-lift:bench --json    (machine-readable)
 */

/** The pinned 8-task suite. */
const WORKERS = 8
/** Virtual ms one model generation occupies the lane. */
const GENERATION_MS = 100
/** Virtual ms a worker waits on a tool after its generation. */
const TOOL_WAIT_MS = 5_000

interface WorkerReport {
	workerId: number
	/** Virtual ms the worker's generation started (after queueing on the slot). */
	genStart: number
	/** Virtual ms the worker fully settled (its own work finished). */
	settledAt: number
	/** Virtual ms the worker spent queued for the slot before its generation began. */
	queueWaitMs: number
	/** True when the worker had to wait for the slot (it was already busy). */
	starved: boolean
}

interface StrategyResult {
	name: "lifetime" | "per-generation"
	/** Virtual ms the last worker settled (the suite's completion). */
	completionMs: number
	/** Max simultaneously in-flight generations (capacity-1 lane ⇒ 1). */
	peakSimultaneousGenerations: number
	/** Number of workers that queued for a slot that was already busy. */
	leaseStarvationEvents: number
	workers: WorkerReport[]
}

/**
 * Compute the exact per-worker schedule on a capacity-1 lane under `strategy`.
 *
 * `slotHeldForTool` is true only for the lifetime model: it keeps the single
 * slot occupied through each worker's tool wait, so the next generation starts
 * later. The per-generation model releases the slot at the end of the
 * generation, so the next generation starts then.
 */
function simulate(strategy: "lifetime" | "per-generation"): StrategyResult {
	const slotHeldForTool = strategy === "lifetime"
	const workers: WorkerReport[] = []

	let slotFreeAt = 0 // the single lane slot's next free time
	const peakSimultaneousGenerations = 1 // capacity-1 lane: at most one generation

	for (let workerId = 0; workerId < WORKERS; workerId++) {
		// The generation starts the instant the slot is free. Under the lifetime
		// model the slot was held through the previous worker's tool wait, so
		// slotFreeAt already accounts for that; under per-generation it was freed
		// at the end of the previous generation.
		const genStart = slotFreeAt
		// The slot is released either at the end of the generation (per-generation)
		// or at the end of the worker's whole lifetime (lifetime, held through the
		// tool wait).
		slotFreeAt = genStart + GENERATION_MS + (slotHeldForTool ? TOOL_WAIT_MS : 0)

		// The worker's own work (gen + tool) always completes at genStart + G + T;
		// releasing the slot early only frees the LANE, not the worker.
		const ownSettledAt = genStart + GENERATION_MS + TOOL_WAIT_MS

		// Starved iff this worker had to wait for a slot that was already busy —
		// i.e. it enqueued while a generation was still in flight.
		const starved = workerId > 0

		workers.push({
			workerId,
			genStart,
			settledAt: ownSettledAt,
			queueWaitMs: genStart,
			starved,
		})
	}

	const completionMs = Math.max(...workers.map((w) => w.settledAt))
	const leaseStarvationEvents = workers.filter((w) => w.starved).length

	return {
		name: strategy,
		completionMs,
		peakSimultaneousGenerations,
		leaseStarvationEvents,
		workers,
	}
}

function main(): void {
	const asJson = process.argv.includes("--json")
	const lifetime = simulate("lifetime")
	const perGeneration = simulate("per-generation")

	const payload = {
		pinnedSuite: { workers: WORKERS, generationMs: GENERATION_MS, toolWaitMs: TOOL_WAIT_MS, lane: 1 },
		results: [lifetime, perGeneration],
	}
	if (asJson) {
		console.log(JSON.stringify(payload, null, 2))
		return
	}

	const speedup = perGeneration.completionMs === 0 ? 0 : lifetime.completionMs / perGeneration.completionMs
	console.log("Menagerie lift — comparative benchmark (pinned 8-task suite, capacity-1 lane)")
	console.log(`  suite: ${WORKERS} workers · generation=${GENERATION_MS}ms · tool-wait=${TOOL_WAIT_MS}ms · lane=1 slot`)
	console.log("")
	console.log("  strategy         completion   peak-gen   starvation   speedup")
	console.log("  ---------------   ---------   --------   ----------   -------")
	for (const [label, r] of [
		["lifetime (base)", lifetime],
		["per-generation", perGeneration],
	] as const) {
		const speed = label === "lifetime (base)" ? "1.00x" : `${speedup.toFixed(2)}x`
		console.log(
			`  ${label.padEnd(16)} ${String(r.completionMs + "ms").padStart(11)} ${String(r.peakSimultaneousGenerations).padStart(10)} ${String(r.leaseStarvationEvents).padStart(12)} ${speed}`,
		)
	}
	console.log("")
	console.log(
		`  per-generation leasing cuts lane completion from ${lifetime.completionMs}ms to ` +
			`${perGeneration.completionMs}ms (${speedup.toFixed(2)}x): the next worker generates while a peer waits on a tool, ` +
			`and the peak simultaneous generations stays at ${perGeneration.peakSimultaneousGenerations} on the 1-slot lane.`,
	)
}

main()
