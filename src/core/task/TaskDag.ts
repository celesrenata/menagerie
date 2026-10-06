import type { ExecutionPlan } from "./elasticTypes"
import { ParallelTasksArgumentError } from "../tools/parallelTasksErrors"

/**
 * The event-driven dependency graph the mastermind represents over an
 * {@link ExecutionPlan} (design §"Event-driven DAG", PAR-004).
 *
 * Nodes are task names; edges point from a dependency to its dependent, so a
 * dependent node becomes runnable the instant all of its dependencies complete
 * and never waits on unrelated siblings (PAR-004.3, PAR-004.4, PAR-004.5).
 * Independent nodes (no dependency path between them) are concurrently runnable
 * (PAR-004.2).
 *
 * Completion is tracked internally: {@link TaskDag.unlockedBy} marks a node
 * completed and returns the dependents whose *last* dependency just satisfied,
 * which the scheduler uses to transition those dependents to `runnable`.
 *
 * The constructor rejects two malformed plans as recoverable argument errors so
 * the mastermind can fix and retry (design §Error Handling, "Invalid
 * ExecutionPlan is recoverable"):
 *  - a dependency cycle (the plan must be acyclic), and
 *  - non-unique task names.
 * Both throw {@link ParallelTasksArgumentError}, consumable by the recoverable
 * `formatParallelTasksArgumentError` path in `ParallelTasksTool`.
 */
export class TaskDag {
	/** All node ids, in plan task order. */
	private readonly nodes: readonly string[]
	/** nodeId → its dependency ids (nodes that must complete before it runs). */
	private readonly dependencies: ReadonlyMap<string, readonly string[]>
	/** nodeId → its dependent ids (nodes that wait on it). */
	private readonly dependents: ReadonlyMap<string, readonly string[]>
	/** Nodes marked completed so far. */
	private readonly completed = new Set<string>()

	constructor(plan: ExecutionPlan) {
		const taskNames = plan.tasks.map((task) => task.name)

		// Reject non-unique task names: node identity must be unambiguous.
		const seen = new Set<string>()
		const duplicates = new Set<string>()
		for (const name of taskNames) {
			if (seen.has(name)) duplicates.add(name)
			seen.add(name)
		}
		if (duplicates.size > 0) {
			throw new ParallelTasksArgumentError(
				`Task names must be unique; duplicated: ${[...duplicates].sort().join(", ")}`,
			)
		}

		this.nodes = taskNames
		const nodeSet = seen

		// Compile dependency edges. A dependency naming an unknown task is a
		// malformed plan the mastermind can fix and retry.
		const deps = new Map<string, string[]>()
		const dependents = new Map<string, string[]>()
		for (const name of taskNames) {
			deps.set(name, [])
			dependents.set(name, [])
		}

		for (const edge of plan.dependencies ?? []) {
			if (!nodeSet.has(edge.dependent)) {
				throw new ParallelTasksArgumentError(
					`Dependency references unknown dependent task: ${edge.dependent}`,
				)
			}
			const dependentDeps = deps.get(edge.dependent)!
			for (const dependency of edge.dependsOn) {
				if (!nodeSet.has(dependency)) {
					throw new ParallelTasksArgumentError(
						`Task ${edge.dependent} depends on unknown task: ${dependency}`,
					)
				}
				if (dependency === edge.dependent) {
					throw new ParallelTasksArgumentError(`Task ${edge.dependent} cannot depend on itself`)
				}
				// A task may be listed by more than one edge; de-duplicate so a
				// repeated dependency does not distort runnability or the graph.
				if (!dependentDeps.includes(dependency)) {
					dependentDeps.push(dependency)
					dependents.get(dependency)!.push(edge.dependent)
				}
			}
		}

		this.dependencies = deps
		this.dependents = dependents

		this.rejectCycles()
	}

	/**
	 * True iff every dependency of `nodeId` has completed. A node with no
	 * dependencies is runnable immediately. An unknown node is never runnable.
	 */
	isRunnable(nodeId: string): boolean {
		const deps = this.dependencies.get(nodeId)
		if (deps === undefined) return false
		return deps.every((dependency) => this.completed.has(dependency))
	}

	/**
	 * Mark `nodeId` completed and return the dependents whose *last* remaining
	 * dependency just satisfied — i.e. nodes that are now runnable solely
	 * because `nodeId` completed. Dependents still blocked by another
	 * incomplete dependency are not returned.
	 *
	 * Idempotent: completing an already-completed node unlocks nothing further.
	 */
	unlockedBy(nodeId: string): readonly string[] {
		if (!this.dependencies.has(nodeId)) return []
		if (this.completed.has(nodeId)) return []
		this.completed.add(nodeId)
		return (this.dependents.get(nodeId) ?? []).filter((dependent) => this.isRunnable(dependent))
	}

	/**
	 * The longest dependency chain through the graph, returned in dependency →
	 * dependent order. Critical-path nodes receive scheduling preference
	 * (PAR-010.3). Ties are broken by plan task order so the result is
	 * deterministic. Returns an empty array for an empty plan.
	 */
	criticalPath(): readonly string[] {
		// Longest path in a DAG via memoized DFS. `best[node]` is the longest
		// chain that ends at `node` (inclusive), expressed as node ids.
		const best = new Map<string, readonly string[]>()
		const index = new Map(this.nodes.map((node, i) => [node, i]))

		const longestEndingAt = (node: string): readonly string[] => {
			const memo = best.get(node)
			if (memo !== undefined) return memo
			let longest: readonly string[] = []
			for (const dependency of this.dependencies.get(node) ?? []) {
				const candidate = longestEndingAt(dependency)
				if (
					candidate.length > longest.length ||
					(candidate.length === longest.length &&
						candidate.length > 0 &&
						(index.get(candidate[0]) ?? 0) < (index.get(longest[0]) ?? 0))
				) {
					longest = candidate
				}
			}
			const chain = [...longest, node]
			best.set(node, chain)
			return chain
		}

		let overall: readonly string[] = []
		for (const node of this.nodes) {
			const chain = longestEndingAt(node)
			if (
				chain.length > overall.length ||
				(chain.length === overall.length &&
					chain.length > 0 &&
					(index.get(chain[0]) ?? 0) < (index.get(overall[0]) ?? 0))
			) {
				overall = chain
			}
		}
		return overall
	}

	/**
	 * Reject a dependency cycle via iterative DFS, reporting the first cycle
	 * found. A cyclic plan can never satisfy its dependents, so it is a
	 * recoverable argument error.
	 */
	private rejectCycles(): void {
		const WHITE = 0
		const GRAY = 1
		const BLACK = 2
		const color = new Map<string, number>(this.nodes.map((node) => [node, WHITE]))

		for (const start of this.nodes) {
			if (color.get(start) !== WHITE) continue
			// Explicit stack of (node, nextDependencyIndex) frames.
			const stack: Array<{ node: string; cursor: number }> = [{ node: start, cursor: 0 }]
			color.set(start, GRAY)
			while (stack.length > 0) {
				const frame = stack[stack.length - 1]
				const deps = this.dependencies.get(frame.node) ?? []
				if (frame.cursor < deps.length) {
					const next = deps[frame.cursor]
					frame.cursor++
					const nextColor = color.get(next)
					if (nextColor === GRAY) {
						// `next` is on the current DFS path: cycle. Reconstruct it.
						const path = stack.map((f) => f.node)
						const cycleStart = path.indexOf(next)
						const cycle = [...path.slice(cycleStart), next]
						throw new ParallelTasksArgumentError(
							`Task dependencies must be acyclic; cycle detected: ${cycle.join(" → ")}`,
						)
					}
					if (nextColor === WHITE) {
						color.set(next, GRAY)
						stack.push({ node: next, cursor: 0 })
					}
				} else {
					color.set(frame.node, BLACK)
					stack.pop()
				}
			}
		}
	}
}
