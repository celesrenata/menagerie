#!/usr/bin/env node
// fleetctl — the OmniRoute fleet topology CLI (task 10.1).
//
// A `commander` program that wires the command handlers in `commands.ts`. Every
// command DEFAULTS to read-only (Requirement 22.1): `validate`, `compile`,
// `drift`, `plan`, `metrics`, `estimate`, and `evaluate` issue only reads.
// `apply` and `rollback` are the only writers (Requirement 22.2), and each
// demands the interactive per-invocation operator confirmation (Requirement
// 22.7) before any write. The CLI never prints a management key or any secret.
//
// The handlers take their side effects through an injectable `CliDeps` bag (see
// `shared.ts`) with real production defaults, so task 10.2's smoke tests drive
// the same handlers against a fake client, a scripted confirmation provider, and
// a captured output sink. `buildProgram` returns the configured program so a
// test can also exercise argument parsing without spawning a process.

import { Command } from "commander"

import {
	applyCommand,
	compileCommand,
	driftCommand,
	estimateCommand,
	evaluateCommand,
	metricsCommand,
	planCommand,
	rollbackCommand,
	validateCommand,
	type ApplyCommandOptions,
	type InventoryCommandOptions,
	type ObserverCommandOptions,
	type RollbackCommandOptions,
} from "./commands.js"
import { defaultCliDeps, type CliDeps } from "./shared.js"

/**
 * Build the `fleetctl` program. `deps` is injected by tests; production uses the
 * real defaults. Each action sets `process.exitCode` from the handler's numeric
 * result so a non-zero code propagates (e.g. a rejected inventory, an
 * unconfirmed write).
 */
export function buildProgram(deps: CliDeps = defaultCliDeps()): Command {
	const program = new Command()
	program
		.name("fleetctl")
		.description("OmniRoute fleet topology toolkit CLI (read-only by default; apply/rollback are the only writers)")
		.option("-r, --revision <commit>", "Fleet_Inventory_Revision commit (defaults to uncommitted)")

	const setExit = (code: number): void => {
		if (code !== 0) {
			process.exitCode = code
		}
	}

	program
		.command("validate")
		.description("parse + validate a Fleet_Inventory KDL file, printing violations (read-only)")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.action(async (file: string) => {
			setExit(await validateCommand(file, deps))
		})

	program
		.command("compile")
		.description("compile the Desired_Route_State per instance (read-only)")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.option("-i, --instance <id>", "target one Managed_Instance (defaults to all)")
		.action(async (file: string, opts: InventoryCommandOptions, cmd: Command) => {
			setExit(await compileCommand(file, mergeInventoryOpts(opts, cmd), deps))
		})

	program
		.command("drift")
		.description("compile + report drift against the live instance(s) (read-only)")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.option("-i, --instance <id>", "target one Managed_Instance (defaults to all)")
		.action(async (file: string, opts: InventoryCommandOptions, cmd: Command) => {
			setExit(await driftCommand(file, mergeInventoryOpts(opts, cmd), deps))
		})

	program
		.command("plan")
		.description("build the dry-run Change_Plan for one Managed_Instance (read-only)")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.option("-i, --instance <id>", "target one Managed_Instance (defaults to the primary)")
		.action(async (file: string, opts: InventoryCommandOptions, cmd: Command) => {
			setExit(await planCommand(file, mergeInventoryOpts(opts, cmd), deps))
		})

	program
		.command("apply")
		.description("apply a confirmed Change_Plan (WRITER; requires interactive confirmation)")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.option("-i, --instance <id>", "target one Managed_Instance (defaults to the primary)")
		.option("--confirm-deletions", "confirm the plan's deletions (required when the plan deletes)")
		.action(async (file: string, opts: ApplyCommandOptions & { confirmDeletions?: boolean }, cmd: Command) => {
			const merged: ApplyCommandOptions = {
				...mergeInventoryOpts(opts, cmd),
				confirmDeletions: opts.confirmDeletions === true,
			}
			setExit(await applyCommand(file, merged, deps))
		})

	program
		.command("rollback")
		.description("rollback to a Route_Backup (WRITER; requires interactive confirmation)")
		.argument("<backupId>", "the Route_Backup id to restore")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.requiredOption("-i, --instance <id>", "the Managed_Instance to roll back")
		.action(async (backupId: string, file: string, opts: RollbackCommandOptions) => {
			setExit(await rollbackCommand(backupId, file, opts, deps))
		})

	program
		.command("metrics")
		.description("print the Fleet_Observer metrics report for a window (read-only)")
		.argument("<window>", "the window: 1h, 24h, or 7d")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.action(async (window: string, file: string, _opts: unknown, cmd: Command) => {
			setExit(await metricsCommand(window, file, observerOpts(cmd), deps))
		})

	program
		.command("estimate")
		.description("estimate free local Slot fractions for a candidate revision (read-only)")
		.argument("<revision>", "the candidate Fleet_Inventory_Revision commit")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.action(async (revision: string, file: string, _opts: unknown, cmd: Command) => {
			setExit(await estimateCommand(revision, file, observerOpts(cmd), deps))
		})

	program
		.command("evaluate")
		.description("run the post-deployment Arrangement_Evaluator (read-only)")
		.argument("<file>", "path to the Fleet_Inventory KDL file")
		.action(async (file: string, _opts: unknown, cmd: Command) => {
			setExit(await evaluateCommand(file, observerOpts(cmd), deps))
		})

	return program
}

/** Merge a subcommand's options with the global `--revision` option. */
function mergeInventoryOpts(opts: InventoryCommandOptions, cmd: Command): InventoryCommandOptions {
	const globalRevision = cmd.parent?.opts<{ revision?: string }>().revision
	return { ...opts, revision: opts.revision ?? globalRevision }
}

/** Build the observer command options, carrying the global `--revision`. */
function observerOpts(cmd: Command): ObserverCommandOptions {
	const globalRevision = cmd.parent?.opts<{ revision?: string }>().revision
	return { revision: globalRevision }
}

/** Entry point: parse argv and run. Exported handlers above are what tests drive. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
	await buildProgram().parseAsync(argv as string[])
}

// Run only when invoked as the program entry (not when imported by a test).
const invokedPath = process.argv[1] ?? ""
if (invokedPath.endsWith("cli/index.js") || invokedPath.endsWith("fleetctl")) {
	void main()
}
