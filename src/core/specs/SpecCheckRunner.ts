import { execFile } from "child_process"
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import type { SpecApproval, SpecEvidenceRecord, SpecRevision } from "@roo-code/types"

import { isSafeWorkspacePath } from "./SpecCompiler"
import { runnerEvidence } from "./SpecGateJoin"
import { verifyRevisionId } from "./specRevision"

/**
 * Host-side executor for a spec's executable checks (MEN-GRANITE-SDD-001 R8.1).
 *
 * Why host-side and not a worker: a worker reports results in prose, and a model-reported exit
 * code is exactly the kind of assertion this feature refuses to accept as evidence. Here the
 * process exit status is observed directly by the extension host.
 *
 * Authorization: commands run ONLY for a revision the user approved (`SpecApproval`), because
 * that approval is the user's consent to those exact argv arrays. Execution is `execFile` (no
 * shell), shells are refused outright, there is a timeout and an output cap, the working
 * directory is the workspace, and secret-looking environment variables are removed.
 */
export class SpecCheckError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SpecCheckError"
	}
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "csh", "tcsh", "ksh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"])
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000

export interface ExecResult {
	/** Process exit code; non-zero for failure, timeout or spawn error. */
	exitCode: number
	output: string
}
export type ExecFn = (argv: readonly string[], options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv }) => Promise<ExecResult>

export const defaultExec: ExecFn = (argv, { cwd, timeoutMs, maxOutputBytes, env }) =>
	new Promise((resolve) => {
		execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes, env, shell: false, windowsHide: true }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr}`
			if (!error) return resolve({ exitCode: 0, output })
			const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
			// A non-numeric code (ENOENT, timeout kill, maxBuffer) is still a failure, never a pass.
			resolve({ exitCode: typeof code === "number" && code !== 0 ? code : 1, output: output || error.message })
		})
	})

export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)))
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")

/** Digest of each declared input file. A missing file is recorded as "absent" so its later creation reads as a change. */
export async function digestInputs(workspaceRoot: string, inputs: readonly string[]): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	for (const rel of inputs) {
		if (!isSafeWorkspacePath(rel)) throw new SpecCheckError(`unsafe input path ${rel}`)
		try {
			out[rel] = sha256(await fs.readFile(path.resolve(workspaceRoot, rel)))
		} catch {
			out[rel] = "absent"
		}
	}
	return out
}

export interface RunCheckArgs {
	revision: SpecRevision
	acceptanceId: string
	workspaceRoot: string
	approval: SpecApproval | undefined
	/** Workspace revision this run is against (e.g. git HEAD). */
	sourceRevision: string
	timeoutMs?: number
	maxOutputBytes?: number
	exec?: ExecFn
	now?: () => number
	env?: NodeJS.ProcessEnv
}

export async function runSpecCheck(args: RunCheckArgs): Promise<SpecEvidenceRecord> {
	const { revision: rev } = args
	if (!verifyRevisionId(rev)) throw new SpecCheckError("revision id does not match its content")
	if (!args.approval || args.approval.revisionId !== rev.revisionId || args.approval.approvedBy !== "user") {
		throw new SpecCheckError("refusing to run checks for a revision the user has not approved")
	}
	const acceptance = rev.acceptance.find((a) => a.id === args.acceptanceId)
	const check = acceptance && rev.checks.find((c) => c.id === acceptance.checkRef)
	if (!acceptance || !check) throw new SpecCheckError(`unknown acceptance or check for ${args.acceptanceId}`)
	if (check.kind === "inspection" || !check.command) throw new SpecCheckError(`check ${check.id} is not executable`)
	const [bin] = check.command
	if (SHELLS.has(path.basename(bin).toLowerCase())) throw new SpecCheckError(`check ${check.id} must not invoke a shell (${bin})`)
	if (check.command.some((a) => a.includes("\0"))) throw new SpecCheckError(`check ${check.id} has an invalid argument`)

	const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
	const inputDigests = await digestInputs(args.workspaceRoot, check.inputs ?? [])
	const result = await (args.exec ?? defaultExec)(check.command, {
		cwd: args.workspaceRoot,
		timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxOutputBytes,
		env: scrubbedEnv(args.env ?? process.env),
	})
	const now = args.now ?? Date.now
	return runnerEvidence(rev, args.acceptanceId, {
		checkRunId: `${rev.revisionId.slice(7, 19)}-${args.acceptanceId}-${now()}`,
		sourceRevision: args.sourceRevision,
		exitCode: result.exitCode,
		artifactDigest: sha256(result.output.slice(0, maxOutputBytes)),
		inputDigests,
		recordedAt: now(),
	})
}
