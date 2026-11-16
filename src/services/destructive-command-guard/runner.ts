import { spawn } from "child_process"

import { type DcgGuardLevel } from "@roo-code/types"

import { DCG_MAX_OUTPUT_BYTES, DCG_RUN_TIMEOUT_MS } from "./constants"

/**
 * Severity of a DCG verdict, derived from the decision string DCG emits
 * (`allow` / `log` / `warn` / `deny`). Callers map this onto a guard level:
 * `relaxed` blocks on `deny`, `standard` also on `warn`, `strict` on anything
 * that is not a positive `allow`.
 */
export type DcgSeverity = "allow" | "log" | "warn" | "deny"

export type DcgDecision = { decision: "allow" | "deny"; reason?: string; ruleId?: string } & {
	/** Raw severity reported by DCG (allow/log/warn/deny). */
	severity: DcgSeverity
}

type DcgJsonOutput = {
	schema_version?: number | string
	decision?: string
	reason?: string
	rule_id?: string
	pattern_name?: string
	pack_id?: string
}

/**
 * Maps a DCG severity onto a guard level: whether the verdict blocks the
 * command. `off` never blocks (guard disabled); `relaxed` blocks on `deny`
 * only (today's behavior); `standard` also blocks on `warn`; `strict` blocks on
 * anything DCG does not positively `allow` (`deny`, `warn`, `log`).
 */
export function isDcgDecisionBlocked(severity: DcgSeverity, level: DcgGuardLevel): boolean {
	switch (level) {
		case "off":
			return false
		case "relaxed":
			return severity === "deny"
		case "standard":
			return severity === "deny" || severity === "warn"
		case "strict":
			return severity !== "allow"
	}
}

const DCG_ENV_KEYS = ["HOME", "PATH", "TEMP", "TMPDIR", "TMP", "USERPROFILE", "SystemRoot", "WINDIR"] as const
const POWERSHELL_COMMENT_FALSE_POSITIVE = "PowerShell substitution contains comment syntax"
const NIX_FLAKE_REF = /^\.#(?:[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*$/
const PLAIN_NIX_ARG = /^[A-Za-z0-9_./:+\-=]+$/

/** Quote only a plain, local Nix flake reference for DCG's parser. Never rewrite shell input. */
export function normalizeNixFlakeRefsForDcg(command: string): string | undefined {
	if (process.platform === "win32") return undefined
	const words = command.trim().split(/\s+/)
	if (words[0] !== "nix" || words.length < 3) return undefined
	const subcommand = words[1]
	const argsStart = subcommand === "flake" && ["show", "check", "metadata"].includes(words[2]) ? 3 : 2
	if (!["build", "eval", "run", "develop", "shell"].includes(subcommand) && argsStart !== 3) return undefined
	if (words.length <= argsStart) return undefined

	let foundRef = false
	const normalized = words.map((word, index) => {
		if (index >= argsStart && NIX_FLAKE_REF.test(word)) {
			foundRef = true
			return `'${word}'`
		}
		return word
	})
	if (!foundRef || words.some((word, index) => index >= argsStart && !NIX_FLAKE_REF.test(word) && !PLAIN_NIX_ARG.test(word))) {
		return undefined
	}
	return normalized.join(" ")
}

function getDcgEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { NO_COLOR: "1" }
	for (const key of DCG_ENV_KEYS) {
		if (process.env[key] !== undefined) env[key] = process.env[key]
	}
	return env
}

export async function runDcg(binaryPath: string, command: string, cwd: string): Promise<DcgDecision> {
	let result = await runDcgOnce(binaryPath, command, cwd)
	if (result.decision === "deny" && result.reason?.startsWith(POWERSHELL_COMMENT_FALSE_POSITIVE)) {
		const normalized = normalizeNixFlakeRefsForDcg(command)
		if (normalized) result = await runDcgOnce(binaryPath, normalized, cwd)
	}
	if (result.decision === "deny") console.warn("[DCG] Command denied", result.reason ?? "No reason provided")
	return result
}

function runDcgOnce(binaryPath: string, command: string, cwd: string): Promise<DcgDecision> {
	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, ["test", "--format", "json", "--no-color", command], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: getDcgEnvironment(),
		})
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
		let settled = false
		const fail = (error: Error, killChild = true) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (killChild) child.kill("SIGKILL")
			console.warn("[DCG]", error.message)
			reject(error)
		}
		const appendOutputOrFail = (
			current: Buffer<ArrayBufferLike>,
			chunk: Buffer<ArrayBufferLike>,
		): Buffer<ArrayBufferLike> => {
			if (current.length + chunk.length > DCG_MAX_OUTPUT_BYTES) {
				fail(new Error("DCG produced too much output"))
				return current
			}
			return Buffer.concat([current, chunk])
		}
		const timer = setTimeout(() => fail(new Error("DCG evaluation timed out")), DCG_RUN_TIMEOUT_MS)
		child.stdout?.on("data", (chunk: Buffer) => (stdout = appendOutputOrFail(stdout, chunk)))
		child.stderr?.on("data", (chunk: Buffer) => (stderr = appendOutputOrFail(stderr, chunk)))
		child.on("error", (error) => fail(new Error(`Unable to start DCG: ${error.message}`)))
		child.on("close", (code, signal) => {
			if (settled) return
			if (signal || (code !== 0 && code !== 1)) {
				fail(new Error(`DCG evaluation failed${stderr.length ? `: ${stderr.toString().trim()}` : ""}`), false)
				return
			}

			let payload: DcgJsonOutput
			try {
				payload = JSON.parse(stdout.toString("utf8")) as DcgJsonOutput
			} catch {
				fail(new Error("DCG returned invalid JSON"), false)
				return
			}

			const schemaVersion = Number(payload.schema_version)
			if (![1, 2].includes(schemaVersion)) {
				fail(new Error("DCG returned an unsupported response schema"), false)
				return
			}
			if ((payload.decision === "allow" || payload.decision === "warn" || payload.decision === "log") && code === 0) {
				settled = true
				clearTimeout(timer)
				resolve({ decision: "allow", severity: (payload.decision ?? "allow") as DcgSeverity })
			} else if (payload.decision === "deny" && code === 1) {
				settled = true
				clearTimeout(timer)
				resolve({
					decision: "deny",
					severity: "deny",
					reason: payload.reason,
					ruleId:
						payload.rule_id ??
						(payload.pack_id && payload.pattern_name
							? `${payload.pack_id}:${payload.pattern_name}`
							: undefined),
				})
			} else {
				fail(new Error("DCG decision did not match its exit status"), false)
			}
		})
	})
}
