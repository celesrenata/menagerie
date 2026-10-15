// fleetctl — shared CLI plumbing (task 10.1).
//
// Every command DEFAULTS to read-only (Requirement 22.1); only `apply` and
// `rollback` write (Requirement 22.2), and each write command demands an
// INTERACTIVE per-invocation operator confirmation (Requirement 22.7). The CLI
// NEVER prints a management key or any other secret: credentials are resolved
// only through the injected `SecretResolver` inside `HttpOmniRouteClient`, and
// nothing here ever echoes a resolved value.
//
// The command handlers take their side effects through this `CliDeps` bag so
// task 10.2's smoke tests can drive them against a fake client, a scripted
// confirmation provider, and a captured output sink instead of the real
// process.stdout/stdin and a live HttpOmniRouteClient. Every dependency has a
// real default, so the production `index.ts` wires nothing by hand.

import { createInterface } from "node:readline"

import type { FleetInventory, Instance } from "@roo-code/types"

import { adapt } from "../inventory/adapt.js"
import { parse } from "../inventory/parser.js"
import { createInventoryValidator, type Violation } from "../inventory/validator.js"
import {
	HttpOmniRouteClient,
	type OmniRouteClient,
	type SecretResolver,
} from "../omniroute/client.js"
import { FileAndEnvSecretResolver, nodeSecretSource } from "../omniroute/secrets.js"
import type { OperatorConfirmation } from "../reconcile/apply.js"
import type { Revision } from "../compile/compiler.js"

// ---------------------------------------------------------------------------
// Output sink
// ---------------------------------------------------------------------------

/**
 * A line-oriented output sink. The production default writes to the process
 * streams; a test passes a sink that records lines so it can assert on output
 * without touching the real stdout.
 */
export interface OutputSink {
	out(line: string): void
	err(line: string): void
}

/** The default sink: stdout for `out`, stderr for `err`. */
export const processOutputSink: OutputSink = {
	out: (line: string): void => {
		process.stdout.write(`${line}\n`)
	},
	err: (line: string): void => {
		process.stderr.write(`${line}\n`)
	},
}

// ---------------------------------------------------------------------------
// Confirmation provider (Requirement 22.7)
// ---------------------------------------------------------------------------

/** What a write command needs confirmed before its first write (Requirement 22.7). */
export interface ConfirmationRequest {
	readonly action: "apply" | "rollback"
	readonly instanceId: string
	/** For an apply: the Change_Plan's revision commit and creation time. */
	readonly plan?: { readonly revision: string; readonly createdAt: string }
	/** For a rollback: the Route_Backup capture time. */
	readonly backup?: { readonly capturedAt: string }
	/** For an apply with deletions: whether the operator passed `--confirm-deletions`. */
	readonly deletionsRequested: boolean
}

/**
 * How a write command obtains the per-invocation operator confirmation. It is
 * supplied to THIS invocation before the first write (Requirement 22.7): the
 * production provider prompts the operator on stdin; a test injects a scripted
 * provider. A provider returns `undefined` when the operator declines, which the
 * command treats as a refusal and performs no write.
 */
export interface ConfirmationProvider {
	confirm(request: ConfirmationRequest): Promise<OperatorConfirmation | undefined>
}

/**
 * The interactive stdin confirmation provider (Requirement 22.7). It prints what
 * the operator is confirming — the Managed_Instance, and the Change_Plan's
 * revision + creation time (for an apply) or the Route_Backup capture time (for
 * a rollback) — then reads the operator's identity and an explicit `yes`. It
 * NEVER prints a management key or any secret; it reads only the operator's own
 * typed input. A declined or empty response yields `undefined` (no write).
 */
export function stdinConfirmationProvider(sink: OutputSink): ConfirmationProvider {
	return {
		async confirm(request: ConfirmationRequest): Promise<OperatorConfirmation | undefined> {
			const rl = createInterface({ input: process.stdin, output: process.stdout })
			const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve))
			try {
				sink.out("")
				sink.out(`CONFIRM ${request.action.toUpperCase()} on instance '${request.instanceId}'`)
				if (request.plan) {
					sink.out(`  plan revision:  ${request.plan.revision}`)
					sink.out(`  plan createdAt: ${request.plan.createdAt}`)
				}
				if (request.backup) {
					sink.out(`  backup capturedAt: ${request.backup.capturedAt}`)
				}
				if (request.deletionsRequested) {
					sink.out("  this plan contains DELETIONS (confirmed by --confirm-deletions)")
				}

				const proceed = (await ask("Proceed? type 'yes' to confirm: ")).trim()
				if (proceed.toLowerCase() !== "yes") {
					return undefined
				}
				const operator = (await ask("Confirming operator identity: ")).trim()
				if (operator.length === 0) {
					return undefined
				}

				return buildConfirmation(request, operator)
			} finally {
				rl.close()
			}
		},
	}
}

/**
 * Build the `OperatorConfirmation` the Reconciler accepts (Requirement 22.7)
 * from a confirmed request and the operator's identity. For an apply it names
 * the plan by revision + creation time; for a rollback it names the backup by
 * capture time. `confirmDeletions` reflects the explicit `--confirm-deletions`
 * flag the operator passed.
 */
export function buildConfirmation(request: ConfirmationRequest, operator: string): OperatorConfirmation {
	if (request.action === "apply") {
		if (!request.plan) {
			throw new Error("apply confirmation requires a plan revision and createdAt")
		}
		return {
			operator,
			instanceId: request.instanceId,
			target: { kind: "plan", revision: request.plan.revision, createdAt: request.plan.createdAt },
			confirmDeletions: request.deletionsRequested,
		}
	}
	if (!request.backup) {
		throw new Error("rollback confirmation requires a backup capturedAt")
	}
	return {
		operator,
		instanceId: request.instanceId,
		target: { kind: "backup", capturedAt: request.backup.capturedAt },
		confirmDeletions: request.deletionsRequested,
	}
}

// ---------------------------------------------------------------------------
// Live OmniRoute client factory
// ---------------------------------------------------------------------------

/**
 * Builds a read/write client for one Managed_Instance. The production factory
 * constructs an `HttpOmniRouteClient` that resolves the instance's management
 * secret reference through the injected `SecretResolver` at call time — the key
 * value never passes through the CLI. A test injects a fake factory that returns
 * an in-memory client and never touches the network.
 */
export type ClientFactory = (instance: Instance, resolver: SecretResolver) => OmniRouteClient

/** The default factory: an `HttpOmniRouteClient` reaching the instance's address. */
export const defaultClientFactory: ClientFactory = (instance, resolver) =>
	new HttpOmniRouteClient({
		baseUrl: instance.address,
		managementSecretRef: instance.secretRef ?? "",
		managementSecretFieldPath: `instances[id=${instance.id}].secretRef`,
		secretResolver: resolver,
	})

// ---------------------------------------------------------------------------
// Dependency bag
// ---------------------------------------------------------------------------

/**
 * The injectable dependencies every command handler takes. Each field has a real
 * production default (see `defaultCliDeps`); task 10.2 overrides `sink`,
 * `clientFactory`, `confirmation`, and `clock` to drive the handlers against a
 * fake with no network, no stdin, and no wall clock.
 */
export interface CliDeps {
	readonly sink: OutputSink
	readonly secretResolver: SecretResolver
	readonly clientFactory: ClientFactory
	readonly confirmation: ConfirmationProvider
	/** UTC ISO clock; defaults to the wall clock. Injected for deterministic tests. */
	readonly clock: () => string
	/** Reads a file's text. Injected so a test need not touch the filesystem. */
	readonly readFile: (path: string) => Promise<string>
}

/** The production defaults: real stdout/stdin, a file+env resolver, an HTTP client. */
export function defaultCliDeps(): CliDeps {
	const secretResolver = new FileAndEnvSecretResolver(nodeSecretSource())
	return {
		sink: processOutputSink,
		secretResolver,
		clientFactory: defaultClientFactory,
		confirmation: stdinConfirmationProvider(processOutputSink),
		clock: () => new Date().toISOString(),
		readFile: async (path: string): Promise<string> => {
			const { readFile } = await import("node:fs/promises")
			return readFile(path, "utf8")
		},
	}
}

// ---------------------------------------------------------------------------
// Inventory loading (parse → adapt → validate)
// ---------------------------------------------------------------------------

/** A loaded + validated inventory, or the violations that rejected it. */
export type LoadResult =
	| { readonly ok: true; readonly model: FleetInventory }
	| { readonly ok: false; readonly violations: readonly Violation[] }
	| { readonly ok: false; readonly parseError: string }

const validator = createInventoryValidator()

/**
 * Read a KDL inventory file and run parse → adapt → validate. A syntax fault is
 * reported as `parseError`; a semantic rejection carries the `violations` with
 * their field paths (never a secret value, per the validator's contract).
 * Read-only: it touches only the file and the pure pipeline.
 */
export async function loadInventory(path: string, deps: CliDeps): Promise<LoadResult> {
	const text = await deps.readFile(path)
	const parsed = parse(text)
	if (!parsed.ok) {
		return {
			ok: false,
			parseError: `parse error at ${parsed.error.line}:${parsed.error.column} — ${parsed.error.message}`,
		}
	}
	const result = validator.validate(adapt(parsed.value))
	if (!result.ok) {
		return { ok: false, violations: result.violations }
	}
	return { ok: true, model: result.model }
}

/** Print each violation as `path: message` (never a secret value). */
export function printViolations(sink: OutputSink, violations: readonly Violation[]): void {
	sink.err(`inventory rejected (${violations.length} violation${violations.length === 1 ? "" : "s"}):`)
	for (const v of violations) {
		sink.err(`  ${v.fieldPath}: ${v.message} [${v.code}]`)
	}
}

/**
 * The Fleet_Inventory_Revision to compile against. The commit is supplied by the
 * operator (a `--revision` flag) or marked uncommitted when absent; the compiler
 * never discovers it itself. A test passes a fixed value.
 */
export function revisionOf(commit: string | undefined): Revision {
	if (commit && commit.length > 0) {
		return { commit, uncommitted: false }
	}
	return { commit: "uncommitted", uncommitted: true }
}

/** Resolve a declared instance by id, or `undefined` when the inventory omits it. */
export function findInstance(model: FleetInventory, instanceId: string): Instance | undefined {
	return model.instances.find((inst) => inst.id === instanceId)
}

/** The primary Managed_Instance (the compiler measures capacities against it). */
export function primaryInstance(model: FleetInventory): Instance | undefined {
	return model.instances.find((inst) => inst.role === "primary")
}
