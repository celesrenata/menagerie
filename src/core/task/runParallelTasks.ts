import path from "node:path"
import crypto from "node:crypto"
import * as fs from "node:fs/promises"
import { RooCodeEventName } from "@roo-code/types"
import type { Task } from "./Task"
import type { ClineProvider } from "../webview/ClineProvider"
import type { ParallelTaskSpec } from "../tools/ParallelTasksTool"
import { resolveWorkerModelId } from "./parallelWorkerRouting"
import { AUTO_READER_NAME } from "./ParallelTaskReader"
import { parallelTaskPool } from "./ParallelTaskPool"
import { snapshotWorkingTree, createParallelWorkspace, exportParallelPatch } from "./ParallelTaskWorkspace"

export interface ParallelTaskResult {
	name: string
	mode: string
	state: "completed" | "failed" | "cancelled"
	taskId?: string
	profile?: string
	workspace?: string
	patch?: string
	result?: string
	error?: string
}

/** Own results in the waiting tool call; children never mutate the parent's message buffers. */
export async function runParallelTasks(parent: Task, provider: ClineProvider, specs: ParallelTaskSpec[]) {
	const batchId = crypto.randomUUID()
	const directory = path.join(provider.context.globalStorageUri.fsPath, "parallel-tasks", batchId)
	const controller = new AbortController()
	const cancel = () => controller.abort(new Error("Parent task stopped"))
	parent.lifetimeSignal.addEventListener("abort", cancel, { once: true })
	if (parent.lifetimeSignal.aborted) cancel()
	// Long-running workers remain attached to the parent until they complete or
	// the parent stops. An absolute batch deadline discarded active work after
	// 30 minutes, forcing the parent to redo it serially.
	const signal = controller.signal
	try {
		signal.throwIfAborted()
		// Resolve every profile before starting any child. No global profile projection.
		// Per-worker model id is a pure pass-through: an explicit `route`, else the role
		// default, else the parent's model id (OmniRoute owns placement — design §5.2).
		const contexts = await Promise.all(
			specs.map(async (spec) => {
				const context = await provider.getTaskHandoffContext(parent, spec.mode, true)
				context.apiConfiguration.openAiModelId = resolveWorkerModelId(
					spec.route,
					spec.mode,
					context.apiConfiguration,
					parent.apiConfiguration.openAiModelId,
				)
				return context
			}),
		)
		const snapshot = await snapshotWorkingTree(parent.cwd, directory)
		// Git resolves symlinks in its root; VS Code may retain aliases such as
		// macOS /var -> /private/var. Compare canonical paths before joining.
		const relativeCwd = path.relative(await fs.realpath(snapshot.root), await fs.realpath(parent.cwd))
		if (relativeCwd === ".." || relativeCwd.startsWith(".." + path.sep) || path.isAbsolute(relativeCwd))
			throw new Error("Task workspace is outside its Git repository")
		const manifest = {
			batchId,
			parentTaskId: parent.taskId,
			snapshot: snapshot.commit,
			tasks: [] as ParallelTaskResult[],
		}
		await fs.writeFile(
			path.join(directory, "manifest.json"),
			JSON.stringify(
				{ ...manifest, tasks: specs.map(({ name, mode }) => ({ name, mode, state: "queued" })) },
				null,
				2,
			),
			{ mode: 0o600 },
		)
		const results = await Promise.all(
			specs.map(async (spec, index): Promise<ParallelTaskResult> => {
				const workspace = path.join(directory, `worker-${index + 1}`)
				const result: ParallelTaskResult = {
					name: spec.name,
					mode: spec.mode,
					state: "failed",
				}
				try {
					await parallelTaskPool.run(signal, async () => {
						signal.throwIfAborted()
						await createParallelWorkspace(snapshot.root, snapshot.commit, workspace)
						result.workspace = workspace
						signal.throwIfAborted()
						const runtime = await provider.createParallelTaskRuntime(
							parent,
							spec,
							path.join(workspace, relativeCwd),
							contexts[index]!,
						)
						const child = runtime.task
						try {
							result.taskId = child.taskId
							result.profile = await child.getTaskApiConfigName()
							await fs.writeFile(
								path.join(directory, `worker-${index + 1}.json`),
								JSON.stringify({ ...result, state: "running" }, null, 2),
								{ mode: 0o600 },
							)
							const workerSignal =
								spec.mode === "project-reader" && spec.name.startsWith(AUTO_READER_NAME)
									? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
									: signal
							result.result = await waitForParallelTask(child, runtime.provider, workerSignal)
							result.state = "completed"
						} finally {
							// Stop the agent loop after completion as well as on cancellation. Keep the
							// panel/history and worktree available for inspection and explicit resume.
							child.cancelCurrentRequest()
							try {
								await child.abortTask()
							} finally {
								await child.dispose()
							}
						}
					})
				} catch (error) {
					result.state = signal.aborted ? "cancelled" : "failed"
					result.error = error instanceof Error ? error.message : String(error)
				}
				if (result.workspace) {
					try {
						const patch = path.join(directory, `worker-${index + 1}.patch`)
						await exportParallelPatch(workspace, snapshot.commit, patch)
						result.patch = patch
					} catch (error) {
						result.error = `${result.error ?? ""} Patch export failed: ${String(error)}`.trim()
						if (result.state === "completed") result.state = "failed"
					}
				}
				try {
					await fs.writeFile(
						path.join(directory, `worker-${index + 1}.json`),
						JSON.stringify(result, null, 2),
						{
							mode: 0o600,
						},
					)
				} catch (error) {
					// Never let one failed record write abandon siblings still holding permits.
					result.error = `${result.error ?? ""} Result persistence failed: ${String(error)}`.trim()
					if (result.state === "completed") result.state = "failed"
				}
				return result
			}),
		)
		manifest.tasks = results
		await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 })
		return { ...manifest, manifestPath: path.join(directory, "manifest.json") }
	} finally {
		parent.lifetimeSignal.removeEventListener("abort", cancel)
	}
}

export function waitForParallelTask(
	child: Pick<Task, "taskId" | "clineMessages" | "lifetimeSignal" | "run" | "parallelWorkerFailure" | "on" | "off">,
	provider: Pick<ClineProvider, "on" | "off">,
	signal: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		// The first outcome wins; every path below goes through settle.
		let settled = false
		const settle = (fn: () => void) => {
			if (settled) return
			settled = true
			cleanup()
			fn()
		}
		// Set by the child's own TaskCompleted, which fires before the provider's async re-emit.
		let completedText: string | undefined
		const completionText = () =>
			[...child.clineMessages].reverse().find((message) => message.say === "completion_result")?.text ??
			"Task completed"
		const cleanup = () => {
			child.off(RooCodeEventName.TaskCompleted, onChildCompleted)
			provider.off(RooCodeEventName.TaskCompleted, complete)
			provider.off(RooCodeEventName.TaskInteractive, needsInput)
			provider.off(RooCodeEventName.TaskIdle, needsInput)
			signal.removeEventListener("abort", cancel)
			child.lifetimeSignal.removeEventListener("abort", stopped)
		}
		// A worker that completed is reported as completed even if it then stops or its loop ends.
		const resolveIfCompleted = () => {
			const text = completedText
			if (text === undefined) return false
			settle(() => resolve(text))
			return true
		}
		const onChildCompleted = () => {
			const text = completionText()
			completedText = text
			settle(() => resolve(text))
		}
		const complete = (taskId: string) => {
			if (taskId !== child.taskId) return
			const text = completionText()
			settle(() => resolve(text))
		}
		const cancel = () => {
			// A cancelled batch reports cancelled regardless of the worker's outcome.
			settle(() => reject(signal.reason ?? new Error("Batch cancelled")))
		}
		// Read at settle time: failParallelWorker records the reason before it aborts the child.
		const workerError = (fallback: string) =>
			new Error(child.parallelWorkerFailure ? `Worker failed: ${child.parallelWorkerFailure}` : fallback)
		const stopped = () => {
			if (resolveIfCompleted()) return
			settle(() => reject(workerError("Worker stopped before completing")))
		}
		const needsInput = (taskId: string) => {
			if (taskId !== child.taskId) return
			if (resolveIfCompleted()) return
			const ask = [...child.clineMessages]
				.reverse()
				.find((message) => message.type === "ask" && !message.isAnswered)
			if (ask?.ask === "completion_result") return
			settle(() =>
				reject(
					new Error(`Worker needs input${ask?.ask ? ` (${ask.ask})` : ""}; inspect its saved chat and patch`),
				),
			)
		}
		// Covers a loop that returns without attempt_completion (for example its outer catch).
		const onLoopEnded = () => {
			if (resolveIfCompleted()) return
			settle(() =>
				reject(
					workerError("Worker task loop ended without attempt_completion; inspect its saved chat and patch"),
				),
			)
		}
		const onLoopError = (error: unknown) => settle(() => reject(error))
		child.on(RooCodeEventName.TaskCompleted, onChildCompleted)
		provider.on(RooCodeEventName.TaskCompleted, complete)
		provider.on(RooCodeEventName.TaskInteractive, needsInput)
		provider.on(RooCodeEventName.TaskIdle, needsInput)
		signal.addEventListener("abort", cancel, { once: true })
		child.lifetimeSignal.addEventListener("abort", stopped, { once: true })
		if (signal.aborted) return cancel()
		if (child.lifetimeSignal.aborted) return stopped()
		// Register completion and cancellation before admitting the paused child.
		void child.run().then(onLoopEnded, onLoopError)
	})
}
