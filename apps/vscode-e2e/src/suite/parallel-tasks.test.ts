import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import path from "node:path"
import http from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"
import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"
import { waitUntilCompleted } from "./utils"

const exec = promisify(execFile)
type Request = { model: string; messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> }
type BatchResult = {
	tasks: Array<{
		name: string
		state: string
		workspace: string
		patch: string
		profile: string
		taskId: string
		error?: string
	}>
}

suite("Native parallel tasks", function () {
	this.timeout(120_000)

	test("overlaps three complete agents, preserves profiles and user edits, and returns isolated patches", async () => {
		const api = globalThis.api
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(cwd)
		const git = (...args: string[]) => exec("git", args, { cwd })
		await git("init", "-q")
		await git("config", "user.name", "Zoo E2E")
		await git("config", "user.email", "e2e@localhost")
		await fs.writeFile(path.join(cwd, "input.txt"), "committed\n")
		await fs.writeFile(path.join(cwd, "other.txt"), "second read\n")
		await git("add", ".")
		await git("commit", "-qm", "fixture")
		await fs.writeFile(path.join(cwd, "input.txt"), "user change\n")
		const indexBefore = await fs.readFile(path.join(cwd, ".git/index"))
		const seen = new Map<string, number>()
		const profiles = new Map<string, string>()
		const held: Array<() => void> = []
		let simultaneous = 0
		let result: BatchResult | undefined
		let board:
			| { tasks: Array<{ id: string; mode: string; parallelWorker: boolean; parentTaskId?: string }> }
			| undefined
		let serverError: unknown
		const reply = (
			response: http.ServerResponse,
			model: string,
			calls: Array<{ name: string; args: object; id: string }>,
		) => {
			response.writeHead(200, { "content-type": "text/event-stream" })
			response.write(
				`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: null }] })}\n\n`,
			)
			response.end(
				`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
			)
		}
		const server = http.createServer((request, response) => {
			if (request.method === "GET") {
				response.setHeader("content-type", "application/json")
				response.end('{"data":[]}')
				return
			}
			const chunks: Buffer[] = []
			request.on("data", (chunk: Buffer) => chunks.push(chunk))
			request.on("end", () => {
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString()) as Request
					if (body.model === "native-parent") {
						const returned = body.messages.find(
							(message) => message.role === "tool" && message.tool_call_id === "parallel_start",
						)
						if (returned) {
							result = JSON.parse(String(returned.content)) as BatchResult
							reply(response, body.model, [
								{
									name: "attempt_completion",
									args: { result: "Parallel batch verified" },
									id: "parent_done",
								},
							])
						} else {
							reply(response, body.model, [
								{
									name: "parallel_tasks",
									id: "parallel_start",
									args: {
										tasks: [
											{
												name: "A",
												mode: "code",
												message:
													"WORKER_A: Read the inputs and write your result to output-A.txt.",
												todos: null,
											},
											{
												name: "B",
												mode: "code",
												message:
													"WORKER_B: Read the inputs and write your result to output-B.txt.",
												todos: null,
											},
											{
												name: "C",
												mode: "ask",
												message: "WORKER_C: Read the inputs and return analysis.",
												todos: null,
											},
										],
									},
								},
							])
						}
						return
					}
					const text = JSON.stringify(body.messages)
					const worker = ["A", "B", "C"].find((name) => text.includes(`WORKER_${name}:`))
					assert.ok(worker, "Worker must receive its own explicit context")
					profiles.set(worker, body.model)
					const turn = seen.get(worker) ?? 0
					seen.set(worker, turn + 1)
					if (turn === 0) {
						held.push(() =>
							reply(response, body.model, [
								{ name: "read_file", args: { path: "input.txt" }, id: `${worker}_read` },
								{ name: "read_file", args: { path: "other.txt" }, id: `${worker}_read_other` },
							]),
						)
						// A structural barrier proves all three requests are in flight together.
						if (held.length === 3) {
							simultaneous = held.length
							void vscode.commands.executeCommand<typeof board>("zoo-code.getTaskBoard").then(
								(snapshot) => {
									board = snapshot
									held.splice(0).forEach((send) => send())
								},
								(error: unknown) => {
									serverError = error
									held.splice(0).forEach((send) => send())
								},
							)
						}
					} else if (turn === 1 && worker !== "C") {
						assert.ok(
							body.messages.some(
								(message) =>
									message.tool_call_id === `${worker}_read` &&
									String(message.content).includes("user change"),
							),
							"Each worker must read the uncommitted snapshot",
						)
						reply(response, body.model, [
							{
								name: "write_to_file",
								args: { path: `output-${worker}.txt`, content: `worker ${worker}\n` },
								id: `${worker}_write`,
							},
						])
					} else {
						reply(response, body.model, [
							{
								name: "attempt_completion",
								args: { result: `Worker ${worker} complete` },
								id: `${worker}_done`,
							},
						])
					}
				} catch (error) {
					serverError ??= error
					response.writeHead(500)
					response.end(String(error))
				}
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		assert.ok(address && typeof address !== "string")
		const prior = api.getConfiguration()
		const priorProfile = api.getActiveProfile()
		const profile = (model: string): ProviderSettings => ({
			apiProvider: providerIdentifiers.openai,
			openAiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
			openAiApiKey: "fixture",
			openAiModelId: model,
			openAiCustomModelInfo: {
				contextWindow: 32768,
				maxTokens: 4096,
				supportsImages: false,
				supportsPromptCache: false,
			},
			rateLimitSeconds: 0,
		})
		try {
			const parentId = await api.upsertProfile("parallel-parent", profile("native-parent"), true)
			const codeId = await api.upsertProfile("parallel-code", profile("native-code"), false)
			const longId = await api.upsertProfile("parallel-long", profile("native-long"), false)
			await api.setConfiguration({ modeApiConfigs: { orchestrator: parentId!, code: codeId!, ask: longId! } })
			await waitUntilCompleted({
				api,
				timeout: 90_000,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "orchestrator",
							experiments: { parallelTasks: true, parallelToolExecution: true },
							autoApprovalEnabled: true,
							alwaysAllowSubtasks: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
							alwaysAllowWrite: true,
							alwaysAllowWriteOutsideWorkspace: true,
							enableCheckpoints: false,
						},
						text: "Run the native parallel fixture batch.",
					}),
			})
			assert.equal(simultaneous, 3)
			if (serverError) throw serverError
			assert.ok(board)
			const boardTasks = board.tasks
			const workers = boardTasks.filter((task) => task.parallelWorker)
			assert.equal(workers.length, 3)
			assert.deepEqual(workers.map((task) => task.mode).sort(), ["ask", "code", "code"])
			assert.ok(workers.every((task) => boardTasks.some((parent) => parent.id === task.parentTaskId)))
			await vscode.commands.executeCommand("zoo-code.showTaskBoard")
			assert.deepEqual(Object.fromEntries(profiles), { A: "native-code", B: "native-code", C: "native-long" })
			assert.ok(result)
			assert.equal(result.tasks.length, 3)
			assert.ok(
				result.tasks.every((task) => task.state === "completed"),
				JSON.stringify(result),
			)
			assert.equal(new Set(result.tasks.map((task) => task.workspace)).size, 3)
			for (const task of result.tasks.filter((task) => task.name !== "C")) {
				assert.equal(
					await fs.readFile(path.join(task.workspace, `output-${task.name}.txt`), "utf8"),
					`worker ${task.name}\n`,
				)
				assert.match(await fs.readFile(task.patch, "utf8"), new RegExp(`output-${task.name}.txt`))
				await assert.rejects(fs.stat(path.join(cwd, `output-${task.name}.txt`)))
			}
			assert.equal(await fs.readFile(path.join(cwd, "input.txt"), "utf8"), "user change\n")
			assert.deepEqual(await fs.readFile(path.join(cwd, ".git/index")), indexBefore)
		} finally {
			await api.cancelCurrentTask()
			if (priorProfile) await api.setActiveProfile(priorProfile)
			for (const name of ["parallel-parent", "parallel-code", "parallel-long"]) await api.deleteProfile(name)
			await api.setConfiguration(prior)
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")
		}
	})
})
