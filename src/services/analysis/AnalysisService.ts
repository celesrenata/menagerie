import * as fs from "fs/promises"
import * as path from "path"

import type { AnalysisOutcome, AnalysisRequest, WorkerResult } from "@roo-code/types"

import { selectAnalysisExecutor, type AnalysisRouteStatus } from "../../core/task/analysisWorkRouting"
import { AnalysisCache } from "./AnalysisCache"
import { AnalysisExecutor } from "./AnalysisExecutor"
import { AnalysisQueue } from "./AnalysisQueue"
import { evidencePacketToAnalysisEvidence, workerResultToEvidencePacket } from "./evidenceAdapter"
import { GraniteAnalysisClient } from "./GraniteAnalysisClient"
import { summarizeOutcomeForParent } from "./summarizeForParent"
import { createWorkspaceEvidenceVerifier } from "./workspaceEvidenceVerifier"

/**
 * Runtime facade that connects scout/reader results to the tool-less analysis executor
 * (MEN-GRANITE-SDD-001 R5.1, R7.2, R7.3). It never throws for expected conditions, reads no
 * files except through the digest-pinning adapter, and returns ONLY bounded summaries.
 *
 * Route configuration is injected from the environment, never from source constants (R2.6):
 *   MENAGERIE_ANALYSIS_BASE_URL   required, http(s) URL including /v1
 *   MENAGERIE_ANALYSIS_MODEL      required, served model id
 *   MENAGERIE_ANALYSIS_API_KEY    optional
 *   MENAGERIE_ANALYSIS_MAX_ACTIVE optional, 1-2 (default 2)
 * Missing base URL or model means "not published": optional analysis is skipped with a visible
 * cause, required analysis escalates. It never fails open.
 */
export interface AnalysisRouteConfig {
	baseUrl: string
	model: string
	apiKey?: string
	maxActive: number
	maxQueued: number
	timeoutMs: number
}

export function resolveAnalysisRouteConfig(env: Readonly<Record<string, string | undefined>>): AnalysisRouteConfig | undefined {
	const baseUrl = env.MENAGERIE_ANALYSIS_BASE_URL?.trim()
	const model = env.MENAGERIE_ANALYSIS_MODEL?.trim()
	if (!baseUrl || !model || !/^https?:\/\//.test(baseUrl)) return undefined
	const requested = Number.parseInt(env.MENAGERIE_ANALYSIS_MAX_ACTIVE ?? "", 10)
	// The service allows at most two active generations; never ask for more.
	const maxActive = Number.isFinite(requested) ? Math.min(2, Math.max(1, requested)) : 2
	return { baseUrl, model, apiKey: env.MENAGERIE_ANALYSIS_API_KEY?.trim() || undefined, maxActive, maxQueued: 16, timeoutMs: 60_000 }
}

export interface AnalysisRunner {
	execute(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisOutcome>
}

interface Runtime {
	runner: (namespace: string, workspaceRoot: string) => AnalysisRunner
	/** Last time the service looked down (unavailable / timeout). */
	lastUnavailableAt: number
}

const UNHEALTHY_WINDOW_MS = 30_000
// One queue per (baseUrl, model): the 2-slot service capacity is process-wide, not per task.
const runtimes = new Map<string, Runtime>()

function runtimeFor(config: AnalysisRouteConfig): Runtime {
	const key = `${config.baseUrl}|${config.model}`
	let rt = runtimes.get(key)
	if (!rt) {
		const client = new GraniteAnalysisClient({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs: config.timeoutMs })
		const queue = new AnalysisQueue({ maxActive: config.maxActive, maxQueued: config.maxQueued })
		const cache = new AnalysisCache()
		const created: Runtime = {
			lastUnavailableAt: 0,
			runner: (namespace, workspaceRoot) =>
				new AnalysisExecutor({
					client,
					queue,
					cache,
					namespace,
					verifyEvidence: createWorkspaceEvidenceVerifier(workspaceRoot),
					onEvent: (e) => {
						if (e.type === "completed" && (e.kind === "unavailable" || e.kind === "timeout")) created.lastUnavailableAt = Date.now()
					},
				}),
		}
		rt = created
		runtimes.set(key, rt)
	}
	return rt
}

export interface ReaderResultInput {
	name: string
	/** Raw worker result already normalized to the structured shape. */
	result: WorkerResult
}

export interface AnalysisAugmentationItem {
	task: string
	status: AnalysisOutcome["kind"] | "no-file-evidence"
	/** Bounded summary text (parent-safe). */
	summary: string
}

export type AnalysisAugmentation =
	| { status: "analyzed"; items: AnalysisAugmentationItem[] }
	| { status: "skipped"; reason: string }
	| { status: "escalate"; lane: string; reason: string; items: AnalysisAugmentationItem[] }

export interface AnalyzeArgs {
	batchId: string
	workspaceRoot: string
	readers: readonly ReaderResultInput[]
	/** Strict policy: unavailable analysis must escalate rather than be skipped. */
	required: boolean
	env?: Readonly<Record<string, string | undefined>>
	/** Test seam: replaces the HTTP-backed runner. */
	runner?: AnalysisRunner
	routeOverride?: AnalysisRouteStatus
	maxTasks?: number
}

const MAX_TASKS = 8

/** Absolute paths under the workspace become relative; anything else is left for the adapter to reject. */
function relativizeEvidence(result: WorkerResult, root: string): WorkerResult {
	const prefix = root.endsWith(path.sep) ? root : root + path.sep
	return {
		...result,
		evidence: result.evidence.map((e) =>
			e.type === "file" && e.reference.startsWith(prefix) ? { ...e, reference: e.reference.slice(prefix.length).split(path.sep).join("/") } : e,
		),
	}
}

async function readInsideRoot(root: string, relative: string): Promise<string | undefined> {
	try {
		const realRoot = await fs.realpath(root)
		const resolved = await fs.realpath(path.resolve(realRoot, relative))
		if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) return undefined
		return await fs.readFile(resolved, "utf8")
	} catch {
		return undefined
	}
}

export async function analyzeReaderResults(args: AnalyzeArgs): Promise<AnalysisAugmentation> {
	const env = args.env ?? process.env
	const config = args.runner ? undefined : resolveAnalysisRouteConfig(env)
	const runtime = config ? runtimeFor(config) : undefined
	const route: AnalysisRouteStatus =
		args.routeOverride ?? {
			published: args.runner !== undefined || config !== undefined,
			healthy: runtime ? Date.now() - runtime.lastUnavailableAt > UNHEALTHY_WINDOW_MS : true,
		}

	const decision = selectAnalysisExecutor({ enabled: true, requiresTools: false, required: args.required, route })
	if (decision.executor === "skipped") return { status: "skipped", reason: decision.reason }
	if (decision.executor === "escalate") return { status: "escalate", lane: decision.lane, reason: decision.reason, items: [] }
	if (decision.executor !== "analysis") return { status: "skipped", reason: decision.reason }

	const runner = args.runner ?? runtime!.runner(args.workspaceRoot, args.workspaceRoot)
	const workspaceUri = `file://${args.workspaceRoot}`
	const candidates = args.readers.slice(0, args.maxTasks ?? MAX_TASKS)

	const items = await Promise.all(
		candidates.map(async (reader): Promise<AnalysisAugmentationItem> => {
			const packet = workerResultToEvidencePacket(relativizeEvidence(reader.result, args.workspaceRoot), reader.name)
			const adapted = await evidencePacketToAnalysisEvidence(packet, {
				workspaceUri,
				readFileText: (p) => readInsideRoot(args.workspaceRoot, p),
			})
			if (adapted.evidence.length === 0) {
				return { task: reader.name, status: "no-file-evidence", summary: "no usable file citations to analyze" }
			}
			const request: AnalysisRequest = {
				requestId: `${args.batchId}:${reader.name}`.slice(0, 128),
				operation: "summarize-evidence",
				evidence: adapted.evidence,
				instructionsVersion: "scout-summary-1",
				schemaVersion: 1,
				maxOutputTokens: 512,
			}
			let outcome: AnalysisOutcome
			try {
				outcome = await runner.execute(request)
			} catch (error) {
				return { task: reader.name, status: "unavailable", summary: `[analysis unavailable] ${error instanceof Error ? error.message : "unexpected error"}`.slice(0, 300) }
			}
			return { task: reader.name, status: outcome.kind, summary: summarizeOutcomeForParent(outcome) }
		}),
	)

	// A required analysis that produced nothing usable must not read as success.
	if (args.required && items.length > 0 && items.every((i) => i.status !== "valid")) {
		return { status: "escalate", lane: "reader.deep", reason: "required analysis produced no valid result", items }
	}
	return { status: "analyzed", items }
}
