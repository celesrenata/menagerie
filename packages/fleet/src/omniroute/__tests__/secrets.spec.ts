import { describe, expect, it } from "vitest"

import { MissingSecretError, type SecretResolver } from "../client.js"
import {
	CREDENTIAL_UNAVAILABLE_REASON,
	FileAndEnvSecretResolver,
	SecretResolutionError,
	describeSecretFailure,
	parseSecretRef,
	resolveSecret,
	resolveSecretOrThrow,
	unsentReadAsUnverified,
	unsentWriteAsError,
	type SecretFailure,
	type SecretSource,
} from "../secrets.js"

// An in-memory resolver so the tests never touch the real environment or
// filesystem. `delayMs` optionally defers resolution so the deadline path can
// be exercised; `hang:true` never settles so a zero deadline must win the race.
const makeResolver = (
	entries: Readonly<Record<string, string | undefined>>,
	opts: { delayMs?: number; hang?: boolean } = {},
): SecretResolver => ({
	resolve: (ref: string) => {
		if (opts.hang) {
			return new Promise<string | undefined>(() => {
				// never settles
			})
		}
		const value = entries[ref]
		if (opts.delayMs && opts.delayMs > 0) {
			return new Promise((resolve) => setTimeout(() => resolve(value), opts.delayMs))
		}
		return Promise.resolve(value)
	},
})

// A resolver that throws, to exercise the `unreadable` cause.
const throwingResolver = (): SecretResolver => ({
	resolve: () => Promise.reject(new Error("permission denied")),
})

const FIELD = "fleet.instances[0].managementSecret"

// A credential value that must never appear in any report/outcome.
const SECRET_VALUE = "sk-super-secret-bearer-value"

describe("resolveSecret — present secret", () => {
	it("resolves a present non-empty secret to its value", async () => {
		const resolver = makeResolver({ "secret:mgmt-key": SECRET_VALUE })
		const result = await resolveSecret(resolver, "secret:mgmt-key", FIELD)
		expect(result).toEqual({ ok: true, value: SECRET_VALUE })
	})
})

describe("resolveSecret — missing secret", () => {
	it("reports a not-found secret as absent with ref + field path and NO value", async () => {
		const resolver = makeResolver({})
		const result = await resolveSecret(resolver, "secret:mgmt-key", FIELD)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.failure).toEqual<SecretFailure>({
			ref: "secret:mgmt-key",
			fieldPath: FIELD,
			cause: "absent",
		})
	})

	it("maps a thrown resolver error to the unreadable cause", async () => {
		const result = await resolveSecret(throwingResolver(), "secretfile:/run/keys/mgmt", FIELD)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.failure.cause).toBe("unreadable")
	})
})

describe("resolveSecret — empty-string secret treated as missing", () => {
	it("rejects an empty value with the empty cause", async () => {
		const resolver = makeResolver({ "secret:mgmt-key": "" })
		const result = await resolveSecret(resolver, "secret:mgmt-key", FIELD)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.failure.cause).toBe("empty")
	})

	it("rejects a whitespace-only value with the empty cause", async () => {
		const resolver = makeResolver({ "secret:mgmt-key": "   \n\t" })
		const result = await resolveSecret(resolver, "secret:mgmt-key", FIELD)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.failure.cause).toBe("empty")
	})
})

describe("resolveSecret — injected timeout", () => {
	it("reports the timeout cause when a never-settling resolver exceeds the deadline", async () => {
		const resolver = makeResolver({}, { hang: true })
		const result = await resolveSecret(resolver, "secret:mgmt-key", FIELD, { timeoutMs: 0 })
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.failure.cause).toBe("timeout")
	})

	it("resolves a value that settles within the deadline", async () => {
		const resolver = makeResolver({ "secret:mgmt-key": SECRET_VALUE }, { delayMs: 1 })
		const result = await resolveSecret(resolver, "secret:mgmt-key", FIELD, { timeoutMs: 1000 })
		expect(result).toEqual({ ok: true, value: SECRET_VALUE })
	})
})

describe("resolveSecretOrThrow", () => {
	it("returns the value for a present secret", async () => {
		const resolver = makeResolver({ "secret:mgmt-key": SECRET_VALUE })
		await expect(resolveSecretOrThrow(resolver, "secret:mgmt-key", FIELD)).resolves.toBe(SECRET_VALUE)
	})

	it("throws a SecretResolutionError (a MissingSecretError) with ref/field/cause and no value", async () => {
		const resolver = makeResolver({})
		await expect(resolveSecretOrThrow(resolver, "secret:mgmt-key", FIELD)).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(SecretResolutionError)
			expect(error).toBeInstanceOf(MissingSecretError)
			const e = error as SecretResolutionError
			expect(e.ref).toBe("secret:mgmt-key")
			expect(e.fieldPath).toBe(FIELD)
			expect(e.cause).toBe("absent")
			expect(JSON.stringify({ m: e.message, ref: e.ref, fp: e.fieldPath, c: e.cause })).not.toContain(
				SECRET_VALUE,
			)
			return true
		})
	})
})

describe("unsent write represented as an error (Requirement 22.9)", () => {
	it("marks an unsent write as not-sent and errored, carrying only the failure", () => {
		const failure: SecretFailure = { ref: "secret:mgmt-key", fieldPath: FIELD, cause: "timeout" }
		const outcome = unsentWriteAsError(failure)
		expect(outcome).toEqual({ sent: false, errored: true, failure })
	})
})

describe("unsent read values represented as unverified (Requirement 22.9)", () => {
	it("produces one unverified entry per covered read operation with the credential-unavailable reason", () => {
		const failure: SecretFailure = { ref: "secret:mgmt-key", fieldPath: FIELD, cause: "absent" }
		const entries = unsentReadAsUnverified("cluster", ["listCombos", "listConnections"], failure)
		expect(entries).toHaveLength(2)
		for (const entry of entries) {
			expect(entry.instanceId).toBe("cluster")
			expect(entry.reason.startsWith(CREDENTIAL_UNAVAILABLE_REASON)).toBe(true)
			expect(entry.reason).toContain("secret:mgmt-key")
			expect(entry.reason).toContain(FIELD)
		}
		expect(entries.map((e) => e.operation)).toEqual(["listCombos", "listConnections"])
	})
})

describe("no-value-leak", () => {
	it("never includes a resolved value in any failure outcome or description", async () => {
		// Empty-value failure: the (empty) value must not appear, and no other
		// outcome should ever carry the real secret in these failure paths.
		const emptyResolver = makeResolver({ "secret:mgmt-key": "" })
		const emptyResult = await resolveSecret(emptyResolver, "secret:mgmt-key", FIELD)
		expect(emptyResult.ok).toBe(false)
		if (emptyResult.ok) throw new Error("expected failure")

		const failure = emptyResult.failure
		const serialized = JSON.stringify(failure)
		// The failure record exposes only ref/fieldPath/cause — no `value` key.
		expect(Object.keys(failure).sort()).toEqual(["cause", "fieldPath", "ref"])

		const description = describeSecretFailure(failure)
		const writeOutcome = JSON.stringify(unsentWriteAsError(failure))
		const readOutcome = JSON.stringify(unsentReadAsUnverified("cluster", ["listCombos"], failure))

		for (const text of [serialized, description, writeOutcome, readOutcome]) {
			expect(text).not.toContain(SECRET_VALUE)
		}
	})
})

describe("parseSecretRef", () => {
	it("parses secret:/secretfile:/bare references and rejects invalid values", () => {
		expect(parseSecretRef("secret:MGMT_KEY")).toEqual({ kind: "env", key: "MGMT_KEY" })
		expect(parseSecretRef("secretfile:/run/keys/mgmt")).toEqual({ kind: "secretfile", key: "/run/keys/mgmt" })
		expect(parseSecretRef("MGMT_KEY")).toEqual({ kind: "env", key: "MGMT_KEY" })
		// Inline value with a space is not a valid reference.
		expect(parseSecretRef("sk-live has a space")).toBeUndefined()
	})
})

describe("FileAndEnvSecretResolver", () => {
	const makeSource = (
		env: Readonly<Record<string, string | undefined>>,
		files: Readonly<Record<string, string | undefined>>,
	): SecretSource => ({
		readEnv: (name) => env[name],
		readFile: (path) => Promise.resolve(files[path]),
	})

	it("resolves an env-backed secret reference", async () => {
		const resolver = new FileAndEnvSecretResolver(makeSource({ MGMT_KEY: SECRET_VALUE }, {}))
		await expect(resolver.resolve("secret:MGMT_KEY")).resolves.toBe(SECRET_VALUE)
	})

	it("resolves a bare reference from the environment", async () => {
		const resolver = new FileAndEnvSecretResolver(makeSource({ MGMT_KEY: SECRET_VALUE }, {}))
		await expect(resolver.resolve("MGMT_KEY")).resolves.toBe(SECRET_VALUE)
	})

	it("resolves a file-backed secret reference, stripping a single trailing newline", async () => {
		const resolver = new FileAndEnvSecretResolver(
			makeSource({}, { "/run/keys/mgmt": `${SECRET_VALUE}\n` }),
		)
		await expect(resolver.resolve("secretfile:/run/keys/mgmt")).resolves.toBe(SECRET_VALUE)
	})

	it("returns undefined for an absent env variable and absent file (resolveSecret maps to absent)", async () => {
		const resolver = new FileAndEnvSecretResolver(makeSource({}, {}))
		await expect(resolver.resolve("secret:MISSING")).resolves.toBeUndefined()
		await expect(resolver.resolve("secretfile:/run/keys/missing")).resolves.toBeUndefined()

		const result = await resolveSecret(resolver, "secret:MISSING", FIELD)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error("expected failure")
		expect(result.failure.cause).toBe("absent")
	})

	it("does not cache: a changed source value is picked up on the next resolve (Requirement 22.3)", async () => {
		const env: Record<string, string | undefined> = { MGMT_KEY: "first" }
		const resolver = new FileAndEnvSecretResolver({
			readEnv: (name) => env[name],
			readFile: () => Promise.resolve(undefined),
		})
		await expect(resolver.resolve("secret:MGMT_KEY")).resolves.toBe("first")
		env.MGMT_KEY = "second"
		await expect(resolver.resolve("secret:MGMT_KEY")).resolves.toBe("second")
	})
})
