import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import path from "node:path"
import http from "node:http"
import os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import * as vscode from "vscode"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { waitUntilCompleted } from "./utils"

/**
 * Live extension-host demo of detached parallel_tasks (background + steering + next-turn
 * delivery) and the worker audit loop (verify, send back, bounded rounds, escalation).
 * The model is a scripted OpenAI-compatible server; everything else is the real extension.
 * Each test writes a timeline of what every agent saw to E2E_TIMELINE_DIR (default tmpdir).
 */

const exec = promisify(execFile)

type Message = { role: string; content?: unknown; tool_call_id?: string }
type Body = { model: string; messages: Message[] }
type Call = { name: string; args: object; id: string }

const timelineDir = process.env.E2E_TIMELINE_DIR || os.tmpdir()

function text(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part?.text === "string" ? part.text : JSON.stringify(part))).join("\n")
	}
	return JSON.stringify(content ?? "")
}

function firstUser(body: Body): string {
	return text(body.messages.find((message) => message.role === "user")?.content)
}

function lastUser(body: Body): string {
	return text([...body.messages].reverse().find((message) => message.role === "user")?.content)
}

function toolResult(body: Body, id: string): string | undefined {
	const found = body.messages.find((message) => message.role === "tool" && message.tool_call_id === id)
	return found ? text(found.content) : undefined
}

function assistantTurns(body: Body): number {
	return body.messages.filter((message) => message.role === "assistant").length
}

function reply(response: http.ServerResponse, model: string, calls: Call[]) {
	response.writeHead(200, { "content-type": "text/event-stream" })
	response.write(
		`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: null }] })}\n\n`,
	)
	response.end(
		`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
	)
}

function workerResult(status: "completed" | "failed", summary: string, extra: object = {}) {
	return JSON.stringify({
		status,
		summary,
		findings: [],
		evidence: [],
		changes: [],
		tests: [],
		blockers: [],
		artifacts: [],
		...extra,
	})
}

const complete = (result: string, id: string): Call => ({ name: "attempt_completion", args: { result }, id })

async function startServer(handler: (body: Body, response: http.ServerResponse) => void) {
	let serverError: unknown
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
				handler(JSON.parse(Buffer.concat(chunks).toString()) as Body, response)
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
	return {
		port: address.port,
		error: () => serverError,
		close: async () => {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}

function profile(port: number, model: string): ProviderSettings {
	return {
		apiProvider: providerIdentifiers.openai,
		openAiBaseUrl: `http://127.0.0.1:${port}/v1`,
		openAiApiKey: "fixture",
		openAiModelId: model,
		openAiCustomModelInfo: { contextWindow: 32768, maxTokens: 4096, supportsImages: false, supportsPromptCache: false },
		rateLimitSeconds: 0,
	}
}

async function initRepo(cwd: string) {
	const git = (...args: string[]) => exec("git", args, { cwd })
	await git("init", "-q")
	await git("config", "user.name", "Zoo E2E")
	await git("config", "user.email", "e2e@localhost")
	await fs.writeFile(path.join(cwd, "input.txt"), "committed\n")
	await fs.writeFile(path.join(cwd, "other.txt"), "second read\n")
	await git("add", ".")
	await git("commit", "-qm", "fixture")
}

const taskConfiguration = {
	mode: "orchestrator",
	experiments: { parallelTasks: true, parallelToolExecution: true },
	autoApprovalEnabled: true,
	alwaysAllowSubtasks: true,
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: true,
	alwaysAllowWrite: true,
	alwaysAllowWriteOutsideWorkspace: true,
	enableCheckpoints: false,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite("Background subtasks and worker audit (live extension host)", function () {
	this.timeout(240_000)

	test("A: detached batch, parent keeps working, steering routed to a named worker, results next turn", async () => {
		const api = globalThis.api
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(cwd)
		await initRepo(cwd)

		const t0 = Date.now()
		const timeline: Array<Record<string, unknown>> = []
		const log = (event: string, data: Record<string, unknown> = {}) => {
			timeline.push({ ms: Date.now() - t0, event, ...data })
			console.log(`[bg-demo +${Date.now() - t0}ms] ${event} ${JSON.stringify(data).slice(0, 400)}`)
		}

		const STEER_REQUEST = "USER_STEER: tell slow to use the v2 endpoint"
		const STEER_TOKEN = "STEER_TOKEN_V2"
		let slowHeld: (() => void) | undefined
		let slowFirstRequestAt: number | undefined
		let slowSawSteering = false
		let slowDone = false
		let detachedAt: number | undefined
		let steeringSent = false
		let guardError: string | undefined
		const deliveries: string[] = []

		const server = await startServer((body, response) => {
			const first = firstUser(body)
			// Workers inherit the parent's model id by design, so identify agents by their task text.
			if (!first.includes("WORKER_") && first.includes("Run the background fixture batch.")) {
				const turn = assistantTurns(body)
				const last = lastUser(body)
				if (last.includes("# Background Tasks")) {
					const section = last.slice(last.indexOf("# Background Tasks"), last.indexOf("# Background Tasks") + 1500)
					deliveries.push(section)
					log("parent sees # Background Tasks", { turn, section: section.slice(0, 600) })
				}
				const detached = toolResult(body, "bg_start")
				if (!detached) {
					log("parent turn: dispatch parallel_tasks background:true")
					reply(response, body.model, [
						{
							name: "parallel_tasks",
							id: "bg_start",
							args: {
								background: true,
								tasks: [
									{ name: "slow", mode: "ask", message: "WORKER_SLOW: analyse input.txt and report.", todos: null, route: null, verification: null },
									{ name: "quick", mode: "ask", message: "WORKER_QUICK: report the file count.", todos: null, route: null, verification: null },
								],
							},
						},
					])
					return
				}
				if (detachedAt === undefined) {
					detachedAt = Date.now()
					log("parent got parallel_tasks result (detached)", {
						result: detached.slice(0, 300),
						slowStillHeld: slowHeld !== undefined,
						slowWorkerStarted: slowFirstRequestAt !== undefined,
					})
				}
				const guard = toolResult(body, "parent_try_complete")
				if (toolResult(body, "parent_final_read")) {
					const lastTool = [...body.messages].reverse().find((message) => message.role === "tool")
					log("parent final turn: attempt_completion", {
						previousToolResult: text(lastTool?.content).slice(0, 300),
						lastUser: last.split("<environment_details>")[0].slice(0, 300),
					})
					reply(response, body.model, [complete("Background batch handled", "parent_done")])
					return
				}
				if (guard !== undefined) {
					guardError ??= guard
					log("parent got attempt_completion guard result", { guard: guard.slice(0, 300) })
					// Release the slow worker now; hold the parent's next step until it settles.
					slowHeld?.()
					slowHeld = undefined
					const waitForSlow = async () => {
						while (!slowDone) await sleep(100)
						await sleep(2_500)
						log("parent continues (read other.txt) after slow settled")
						reply(response, body.model, [{ name: "read_file", args: { path: "other.txt" }, id: "parent_final_read" }])
					}
					void waitForSlow()
					return
				}
				if (toolResult(body, "parent_steer")) {
					log("parent got steer result", { result: toolResult(body, "parent_steer")!.slice(0, 300) })
					log("parent tries attempt_completion while slow is running")
					reply(response, body.model, [complete("Trying to finish early", "parent_try_complete")])
					return
				}
				const sawUser = JSON.stringify(body.messages).includes(STEER_REQUEST)
				if (sawUser) {
					log("parent read queued user steering; routes it with background_tasks steer → slow")
					reply(response, body.model, [
						{
							name: "background_tasks",
							id: "parent_steer",
							args: { action: "steer", target: "slow", message: `${STEER_TOKEN}: use the v2 endpoint`, timeoutMs: null },
						},
					])
					return
				}
				// Parent keeps working while the batch runs. The user types while the parent is busy.
				if (!steeringSent) {
					steeringSent = true
					log("user sends a message while the parent is busy (goes to the top-level queue)")
					void api.sendMessage(STEER_REQUEST)
					setTimeout(() => {
						log("parent continues own work: read_file input.txt")
						reply(response, body.model, [{ name: "read_file", args: { path: "input.txt" }, id: `parent_read_${turn}` }])
					}, 1_500)
					return
				}
				log("parent continues own work: read_file other.txt", { turn })
				reply(response, body.model, [{ name: "read_file", args: { path: "other.txt" }, id: `parent_read_${turn}` }])
				return
			}
			if (first.includes("WORKER_QUICK:")) {
				log("quick worker request → completes")
				reply(response, body.model, [complete("quick: 2 files", "quick_done")])
				return
			}
			if (first.includes("WORKER_SLOW:")) {
				const turn = assistantTurns(body)
				if (turn === 0) {
					slowFirstRequestAt ??= Date.now()
					log("slow worker first request arrived; holding it (worker is busy)")
					slowHeld = () => {
						log("slow worker released → read_file input.txt")
						reply(response, body.model, [{ name: "read_file", args: { path: "input.txt" }, id: "slow_read" }])
					}
					return
				}
				const all = JSON.stringify(body.messages)
				slowSawSteering = all.includes("# Steering from parent") && all.includes(STEER_TOKEN)
				log("slow worker next request", { sawSteeringSection: slowSawSteering })
				slowDone = true
				reply(response, body.model, [complete(`slow: analysed with ${slowSawSteering ? STEER_TOKEN : "no steering"}`, "slow_done")])
				return
			}
			log("unexpected request", { model: body.model, first: first.slice(0, 200) })
			reply(response, body.model, [complete("noop", "noop")])
		})

		const prior = api.getConfiguration()
		const priorProfile = api.getActiveProfile()
		try {
			const parentId = await api.upsertProfile("bg-parent", profile(server.port, "bg-parent"), true)
			const workerId = await api.upsertProfile("bg-worker", profile(server.port, "bg-worker"), false)
			await api.setConfiguration({ modeApiConfigs: { orchestrator: parentId!, ask: workerId!, code: workerId! } })
			await waitUntilCompleted({
				api,
				timeout: 180_000,
				start: () => api.startNewTask({ configuration: taskConfiguration, text: "Run the background fixture batch." }),
			})
			if (server.error()) throw server.error()
			log("parent task completed")
			await fs.writeFile(path.join(timelineDir, "bg-demo-A.json"), JSON.stringify({ timeline, deliveries, guardError }, null, 2))

			assert.ok(detachedAt !== undefined, "parent received the detach result")
			assert.ok(slowFirstRequestAt !== undefined && slowFirstRequestAt <= detachedAt + 5_000)
			assert.ok(guardError && /background/i.test(guardError), `completion guard refused: ${guardError}`)
			assert.ok(slowSawSteering, "slow worker received the steering section")
			assert.ok(deliveries.some((section) => section.includes("slow")), "slow result delivered on a later parent turn")
		} finally {
			await api.cancelCurrentTask()
			if (priorProfile) await api.setActiveProfile(priorProfile)
			for (const name of ["bg-parent", "bg-worker"]) await api.deleteProfile(name)
			await api.setConfiguration(prior)
			await server.close()
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")
		}
	})

	test("B: failing worker output is audited, sent back with bounded rounds, then escalated", async () => {
		const api = globalThis.api
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(cwd)
		await fs.rm(path.join(cwd, ".git"), { recursive: true, force: true })
		await initRepo(cwd)

		const t0 = Date.now()
		const timeline: Array<Record<string, unknown>> = []
		const log = (event: string, data: Record<string, unknown> = {}) => {
			timeline.push({ ms: Date.now() - t0, event, ...data })
			console.log(`[audit-demo +${Date.now() - t0}ms] ${event} ${JSON.stringify(data).slice(0, 400)}`)
		}
		let batch: string | undefined

		const server = await startServer((body, response) => {
			const first = firstUser(body)
			const turn = assistantTurns(body)
			const isParent =
				first.includes("Run the audit fixture batch.") &&
				!first.includes("WORKER_") &&
				!first.includes("You are an independent verifier") &&
				!first.includes("Verification feedback:")
			if (isParent) {
				const returned = toolResult(body, "audit_start")
				if (returned) {
					batch = returned
					log("parent received batch result", { result: returned.slice(0, 1500) })
					reply(response, body.model, [complete("Audit batch reviewed", "audit_parent_done")])
					return
				}
				log("parent dispatches blocking parallel_tasks with required verification")
				const verification = (file: string) => ({ required: true, criteria: [`${file} contains the word CORRECT`] })
				reply(response, body.model, [
					{
						name: "parallel_tasks",
						id: "audit_start",
						args: {
							background: null,
							tasks: [
								{ name: "fixable", mode: "code", message: "WORKER_FIXABLE: write output-fixable.txt containing CORRECT.", todos: null, route: null, verification: verification("output-fixable.txt") },
								{ name: "stubborn", mode: "code", message: "WORKER_STUBBORN: write output-stubborn.txt containing CORRECT.", todos: null, route: null, verification: verification("output-stubborn.txt") },
							],
						},
					},
				])
				return
			}
			const worker = first.includes("WORKER_FIXABLE") ? "fixable" : first.includes("WORKER_STUBBORN") ? "stubborn" : undefined
			const file = `output-${worker}.txt`
			if (first.includes("You are an independent verifier") && worker) {
				if (turn === 0) {
					log(`verifier for ${worker}: read_file ${file}`)
					reply(response, body.model, [{ name: "read_file", args: { path: file }, id: `${worker}_verify_read` }])
					return
				}
				const seen = toolResult(body, `${worker}_verify_read`) ?? ""
				const pass = seen.includes("CORRECT")
				log(`verifier for ${worker}: file content checked → ${pass ? "PASS" : "FAIL"}`, { seen: seen.slice(0, 160) })
				reply(response, body.model, [
					complete(
						workerResult(pass ? "completed" : "failed", pass ? `${file} contains CORRECT` : `${file} does not contain CORRECT`, {
							evidence: [{ type: "test", reference: `${file} contains the word CORRECT`, result: pass ? "pass" : "fail" }],
							findings: pass ? [] : [{ claim: `${file} contains WRONG instead of CORRECT` }],
						}),
						`${worker}_verify_done`,
					),
				])
				return
			}
			if (first.includes("Verification feedback:")) {
				log("deeper-lane escalation follow-up ran", { first: first.slice(0, 200) })
				reply(response, body.model, [complete(workerResult("completed", "Escalation advice: the implementer keeps writing WRONG; fix the generator."), "escalation_done")])
				return
			}
			if (worker) {
				const round = Number(/# Audit feedback \(round (\d+)\)/.exec(first)?.[1] ?? 0)
				if (turn === 0) {
					const content = worker === "fixable" && round >= 1 ? "CORRECT\n" : "WRONG\n"
					log(`implementer ${worker} round ${round}: write ${file} = ${content.trim()}`, {
						hasFeedback: first.includes("Independent verification failed"),
					})
					reply(response, body.model, [{ name: "write_to_file", args: { path: file, content }, id: `${worker}_write_${round}` }])
					return
				}
				reply(response, body.model, [complete(workerResult("completed", `${worker} wrote ${file} (round ${round})`), `${worker}_done_${round}`)])
				return
			}
			log("unexpected request", { model: body.model, first: first.slice(0, 300) })
			reply(response, body.model, [complete(workerResult("completed", "noop"), `noop_${turn}`)])
		})

		const prior = api.getConfiguration()
		const priorProfile = api.getActiveProfile()
		try {
			const parentId = await api.upsertProfile("audit-parent", profile(server.port, "audit-parent"), true)
			const codeId = await api.upsertProfile("audit-code", profile(server.port, "audit-code"), false)
			const readerId = await api.upsertProfile("audit-reader", profile(server.port, "audit-reader"), false)
			// The verifier always runs in `project-reader` mode. Register it the way a user does
			// (workspace .roomodes) unless E2E_NO_PROJECT_READER asks to show the missing-mode case.
			if (!process.env.E2E_NO_PROJECT_READER) {
				await fs.writeFile(
					path.join(cwd, ".roomodes"),
					"customModes:\n  - slug: project-reader\n    name: Project Reader\n    roleDefinition: You read project files and report findings. You never edit.\n    groups:\n      - read\n",
				)
				await sleep(2_000)
			}
			await api.setConfiguration({
				modeApiConfigs: { orchestrator: parentId!, code: codeId!, "project-reader": readerId! },
			})
			await waitUntilCompleted({
				api,
				timeout: 200_000,
				start: () => api.startNewTask({ configuration: taskConfiguration, text: "Run the audit fixture batch." }),
			})
			if (server.error()) throw server.error()
			log("parent task completed")
			await fs.writeFile(path.join(timelineDir, "bg-demo-B.json"), JSON.stringify({ timeline, batch }, null, 2))
			assert.ok(batch, "parent got the batch result")
			assert.match(batch, /fixable/)
			assert.match(batch, /stubborn/)
		} finally {
			await api.cancelCurrentTask()
			if (priorProfile) await api.setActiveProfile(priorProfile)
			for (const name of ["audit-parent", "audit-code", "audit-reader"]) await api.deleteProfile(name)
			await api.setConfiguration(prior)
			await server.close()
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")
		}
	})
})
