// Secret resolution and missing-secret handling (design §3 "Secret resolution",
// Requirements 22.3, 22.8, 22.9).
//
// Every credential the toolkit sends — a management bearer, a Serving_Endpoint
// key, an Alert_Destination credential, or a value an apply/restore/rollback
// writes into an OmniRoute connection — is resolved from its Fleet_Inventory
// secret reference AT USE TIME and never cached beyond the request that needs
// it (Requirement 22.3). The underlying `SecretResolver` is defined in
// `client.ts`; this module adds the use-time policy on top of it:
//
//   - A secret must resolve to a NON-EMPTY value within a 10 s deadline
//     (injectable for tests). The 10 s deadline, empty value, and
//     absent/unreadable source each produce a distinct cause (Requirement 22.8).
//   - When a needed secret does not resolve, NEITHER the request NOR any
//     substitute is sent; the operation reports the ref, the field path, and
//     the cause, carrying NO value (Requirement 22.8).
//   - An unsent write (apply/restore/rollback) is treated as a write that
//     returned an error; an unsent read's values are reported `unverified`
//     with a "credential unavailable" reason (Requirement 22.9). This module
//     provides the result shapes/helpers that apply.ts (6.2), rollback.ts
//     (6.3), and drift.ts (5.1) use to represent those two outcomes.

import { MissingSecretError, type SecretResolver } from "./client.js"
import { type ReadFailureReason, type UnverifiedRead } from "../reconcile/drift.js"

// ---------------------------------------------------------------------------
// Secret reference syntax
// ---------------------------------------------------------------------------

// The inventory's secret-reference syntax (aligned with the validator's
// SECRET_REF_RE): a `secret:<name>` / `secretfile:<path>` prefixed reference or
// a bare identifier/path token. The two prefixed forms select a source; a bare
// token is resolved from the environment by name (the production resolver's
// default source).
const SECRET_REF_RE = /^(secret|secretfile):\S+$|^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/

/** The three source kinds a secret reference can select. */
export type SecretRefKind = "env" | "secretfile"

/** A parsed secret reference: the source kind and the name/path to read. */
export interface ParsedSecretRef {
	readonly kind: SecretRefKind
	/** For `env`: the variable name. For `secretfile`: the file path. */
	readonly key: string
}

/**
 * Parse an inventory secret reference into its source kind and key. Returns
 * `undefined` for a value that is not a valid reference (the validator rejects
 * such values at validate time; this guards the use-time path too). The value
 * is never echoed back on failure.
 */
export const parseSecretRef = (ref: string): ParsedSecretRef | undefined => {
	if (!SECRET_REF_RE.test(ref)) {
		return undefined
	}
	if (ref.startsWith("secretfile:")) {
		return { kind: "secretfile", key: ref.slice("secretfile:".length) }
	}
	if (ref.startsWith("secret:")) {
		return { kind: "env", key: ref.slice("secret:".length) }
	}
	// Bare token: resolved from the environment by name.
	return { kind: "env", key: ref }
}

// ---------------------------------------------------------------------------
// Missing-secret cause (Requirement 22.8)
// ---------------------------------------------------------------------------

/**
 * Why a needed secret did not resolve. Carries NO value — only the machine
 * cause (Requirement 22.8: "secret or secret file absent, unreadable, or empty,
 * or resolution timed out").
 */
export type SecretFailureCause = "absent" | "unreadable" | "empty" | "timeout"

/** Human text for a cause, for the credential-free operation report. */
const CAUSE_TEXT: Record<SecretFailureCause, string> = {
	absent: "secret or secret file absent",
	unreadable: "secret or secret file unreadable",
	empty: "secret or secret file empty",
	timeout: "secret resolution timed out",
}

/**
 * A resolved-secret failure, reported in the result of the operation that
 * needed the credential (Requirement 22.8). Carries the secret reference, the
 * inventory field path that declares it, and the cause — never a value.
 */
export interface SecretFailure {
	readonly ref: string
	readonly fieldPath: string
	readonly cause: SecretFailureCause
}

/** Build a `SecretFailure` (credential-free by construction). */
export const secretFailure = (ref: string, fieldPath: string, cause: SecretFailureCause): SecretFailure => ({
	ref,
	fieldPath,
	cause,
})

/** A one-line, credential-free summary of a `SecretFailure` for reports/audit. */
export const describeSecretFailure = (failure: SecretFailure): string =>
	`secret '${failure.ref}' at '${failure.fieldPath}': ${CAUSE_TEXT[failure.cause]}`

/**
 * A `MissingSecretError` that also carries the machine cause, for callers
 * (client.ts, apply.ts) that resolve a secret through the error channel. It
 * extends `MissingSecretError` so existing `instanceof MissingSecretError`
 * checks still match; the added `cause` field never carries a value.
 */
export class SecretResolutionError extends MissingSecretError {
	readonly cause: SecretFailureCause

	constructor(ref: string, fieldPath: string, cause: SecretFailureCause) {
		super(ref, fieldPath)
		this.name = "SecretResolutionError"
		this.cause = cause
	}

	/** The credential-free failure record for an operation report. */
	toFailure(): SecretFailure {
		return secretFailure(this.ref, this.fieldPath, this.cause)
	}
}

// ---------------------------------------------------------------------------
// Use-time resolution with the non-empty + 10 s deadline rule (Req 22.8)
// ---------------------------------------------------------------------------

/** The 10 s deadline of Requirement 22.8. Overridable (small/0) in tests. */
export const DEFAULT_SECRET_TIMEOUT_MS = 10_000

export interface ResolveSecretOptions {
	/** Resolution deadline in ms (default 10 s). Set small/0 in tests. */
	readonly timeoutMs?: number
}

/** A resolved secret: the use-time value, available only to the caller. */
export type ResolveSecretResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly failure: SecretFailure }

const resolveWithDeadline = (
	resolver: SecretResolver,
	ref: string,
	timeoutMs: number,
): Promise<string | undefined> => {
	if (timeoutMs <= 0) {
		// A zero/negative deadline means "do not wait": race against an immediate
		// timeout so a never-settling resolver does not hang the operation. A
		// resolver that settles synchronously still wins the race.
		return Promise.race([
			resolver.resolve(ref),
			new Promise<string | undefined>((_resolve, reject) => {
				setTimeout(() => reject(new SecretTimeout()), 0)
			}),
		])
	}
	return Promise.race([
		resolver.resolve(ref),
		new Promise<string | undefined>((_resolve, reject) => {
			setTimeout(() => reject(new SecretTimeout()), timeoutMs)
		}),
	])
}

class SecretTimeout extends Error {
	constructor() {
		super("secret resolution timed out")
		this.name = "SecretTimeout"
	}
}

/**
 * Resolve a credential from its inventory secret ref at use time, enforcing the
 * non-empty + 10 s deadline rule (Requirement 22.8). The resolved value, when
 * present, is returned to the caller for immediate use and is never cached by
 * this helper. On failure the result carries only the credential-free
 * `SecretFailure` (ref, field path, cause) — never a value.
 */
export const resolveSecret = async (
	resolver: SecretResolver,
	ref: string,
	fieldPath: string,
	options: ResolveSecretOptions = {},
): Promise<ResolveSecretResult> => {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SECRET_TIMEOUT_MS

	let value: string | undefined
	try {
		value = await resolveWithDeadline(resolver, ref, timeoutMs)
	} catch (error) {
		const cause: SecretFailureCause = error instanceof SecretTimeout ? "timeout" : "unreadable"
		return { ok: false, failure: secretFailure(ref, fieldPath, cause) }
	}

	if (value === undefined || value === null) {
		return { ok: false, failure: secretFailure(ref, fieldPath, "absent") }
	}
	// An empty or whitespace-only value is treated as missing (Requirement 22.8).
	if (value.trim().length === 0) {
		return { ok: false, failure: secretFailure(ref, fieldPath, "empty") }
	}
	return { ok: true, value }
}

/**
 * Resolve a secret and throw a `SecretResolutionError` (a `MissingSecretError`)
 * on failure, for callers that drive resolution through the error channel
 * (e.g. the HTTP client's bearer resolution). The thrown error carries the ref,
 * field path, and cause — never a value.
 */
export const resolveSecretOrThrow = async (
	resolver: SecretResolver,
	ref: string,
	fieldPath: string,
	options: ResolveSecretOptions = {},
): Promise<string> => {
	const result = await resolveSecret(resolver, ref, fieldPath, options)
	if (!result.ok) {
		throw new SecretResolutionError(result.failure.ref, result.failure.fieldPath, result.failure.cause)
	}
	return result.value
}

// ---------------------------------------------------------------------------
// Unsent-request outcomes (Requirement 22.9)
// ---------------------------------------------------------------------------

// When a request is not sent because its secret did not resolve, the two kinds
// of request produce two outcomes, shared with drift.ts (reads) and apply.ts /
// rollback.ts (writes):
//
//   - An unsent READ reports each value it would have covered as `unverified`
//     with the "credential unavailable" reason (aligning with the drift
//     ReadFailureReason set and UnverifiedRead shape).
//   - An unsent WRITE (apply/restore/rollback) is treated as a write that
//     returned an error.

/** The drift read-failure reason for an unavailable credential (Req 22.9). */
export const CREDENTIAL_UNAVAILABLE_REASON: ReadFailureReason = "credential unavailable"

/**
 * Represent an unsent read as the drift `UnverifiedRead` entries it produces —
 * one per value/operation the read would have covered (Requirement 22.9). The
 * reason is "credential unavailable"; the credential-free `SecretFailure` is
 * attached to each entry's reason text so the report names the ref/field/cause
 * without a value.
 */
export const unsentReadAsUnverified = (
	instanceId: string,
	operations: readonly string[],
	failure: SecretFailure,
): UnverifiedRead[] =>
	operations.map((operation) => ({
		instanceId,
		operation,
		reason: `${CREDENTIAL_UNAVAILABLE_REASON}: ${describeSecretFailure(failure)}`,
	}))

/**
 * The outcome of a write (apply/restore/rollback op) that could not be sent
 * because its secret did not resolve. apply.ts and rollback.ts treat an
 * `errored` write-send outcome as a failed write (Requirement 22.9). Carries
 * only the credential-free `SecretFailure`.
 */
export type WriteSendOutcome =
	| { readonly sent: true }
	| { readonly sent: false; readonly errored: true; readonly failure: SecretFailure }

/** Build the error outcome for an unsent write (Requirement 22.9). */
export const unsentWriteAsError = (failure: SecretFailure): WriteSendOutcome => ({
	sent: false,
	errored: true,
	failure,
})

// ---------------------------------------------------------------------------
// Production SecretResolver: env var by name, file by secretfile: path
// ---------------------------------------------------------------------------

/**
 * The small source interface behind the production resolver, so tests inject an
 * in-memory source and never touch the real environment or filesystem. Each
 * method returns the raw value or `undefined` when the source has no entry, and
 * throws only on an actual read error (which `resolveSecret` maps to
 * `unreadable`).
 */
export interface SecretSource {
	/** Read an environment variable by name; `undefined` when unset. */
	readEnv(name: string): string | undefined
	/** Read a file by path; `undefined` when the file does not exist. */
	readFile(path: string): Promise<string | undefined>
}

/**
 * A `SecretResolver` that reads `secret:`/bare references from the environment
 * and `secretfile:` references from a file, through an injected `SecretSource`.
 * It performs no caching: every `resolve` reads the source afresh so a value
 * that changes behind the reference is picked up on the next use (Requirement
 * 22.3). It returns the raw value (including empty) and leaves the non-empty +
 * timeout policy to `resolveSecret`; a `secretfile:` value is trimmed of a
 * single trailing newline so a key stored with a line break resolves cleanly.
 */
export class FileAndEnvSecretResolver implements SecretResolver {
	private readonly source: SecretSource

	constructor(source: SecretSource) {
		this.source = source
	}

	async resolve(ref: string): Promise<string | undefined> {
		const parsed = parseSecretRef(ref)
		if (!parsed) {
			return undefined
		}
		if (parsed.kind === "env") {
			return this.source.readEnv(parsed.key)
		}
		const contents = await this.source.readFile(parsed.key)
		if (contents === undefined) {
			return undefined
		}
		return stripTrailingNewline(contents)
	}
}

/** Strip a single trailing `\n` or `\r\n` so a file-stored key resolves cleanly. */
const stripTrailingNewline = (value: string): string => {
	if (value.endsWith("\r\n")) {
		return value.slice(0, -2)
	}
	if (value.endsWith("\n")) {
		return value.slice(0, -1)
	}
	return value
}

/**
 * A `SecretSource` backed by `process.env` and the real filesystem, for
 * production use. Kept thin so the policy and parsing stay testable through the
 * in-memory source.
 */
export const nodeSecretSource = (): SecretSource => ({
	readEnv: (name: string): string | undefined => process.env[name],
	readFile: async (path: string): Promise<string | undefined> => {
		const { readFile } = await import("node:fs/promises")
		try {
			return await readFile(path, "utf8")
		} catch (error) {
			if (isNotFound(error)) {
				return undefined
			}
			throw error
		}
	},
})

/** True when a filesystem error is a "no such file" error (maps to `absent`). */
const isNotFound = (error: unknown): boolean =>
	typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
