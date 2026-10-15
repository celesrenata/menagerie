import { describe, expect, it } from "vitest"

import type { CallLogRecord } from "../../omniroute/client.js"
import {
	COPY_COLUMNS,
	InMemoryObserverStore,
	RETENTION_MS,
	assertBodyFree,
	fromCallLog,
	rowIdOf,
	runCopy,
	type CopiedAttempt,
	type ObserverStore,
	type SourceAttempt,
} from "../copy.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The exact body-free field set exported to baseline-attempts-*.jsonl.gz. */
const BASELINE_KEYS = [
	"ts",
	"dur_ms",
	"status",
	"provider",
	"model",
	"requested_model",
	"connection_id",
	"tin",
	"tout",
	"key",
	"combo",
	"step",
	"corr",
	"exec",
	"etype",
	"ttft",
	"wait",
] as const

function fields(overrides: Partial<CopiedAttempt> = {}): CopiedAttempt {
	return {
		ts: "2026-10-10T00:00:00.000Z",
		dur_ms: 224_728,
		status: 200,
		provider: "vllm",
		model: "qwen-coder",
		requested_model: "hybrid/code",
		connection_id: "vllm",
		tin: 77_084,
		tout: 4_193,
		key: "zoo-m5",
		combo: "hybrid/code",
		step: "code-t1-0",
		corr: "corr-1",
		exec: "t:gpu0:vllm:qwen-coder:0",
		etype: null,
		ttft: 8_878,
		wait: 0,
		...overrides,
	}
}

function source(overrides: Partial<SourceAttempt> = {}, fieldOverrides: Partial<CopiedAttempt> = {}): SourceAttempt {
	return {
		instanceId: "cluster",
		fields: fields(fieldOverrides),
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// Field set matches the baseline extract (Req 16.12)
// ---------------------------------------------------------------------------

describe("COPY_COLUMNS", () => {
	it("matches the baseline extract's JSONL field set exactly and in order", () => {
		expect([...COPY_COLUMNS]).toEqual([...BASELINE_KEYS])
	})

	it("the copied-attempt shape has exactly the baseline keys and no body/credential", () => {
		const f = fields()
		expect(Object.keys(f).sort()).toEqual([...BASELINE_KEYS].sort())
	})
})

describe("fromCallLog", () => {
	it("projects only body-free fields from a live CallLogRecord", () => {
		const record: CallLogRecord = {
			timestamp: "2026-10-10T00:00:00.000Z",
			status: 200,
			provider: "vllm",
			model: "qwen-coder",
			requestedModel: "hybrid/code",
			connectionId: "vllm",
			comboName: "hybrid/code",
			correlationId: "corr-1",
			ttftMs: 8_878,
			addedWaitMs: 0,
		}
		const copied = fromCallLog(record, {
			tokensIn: 77_084,
			tokensOut: 4_193,
			apiKeyName: "zoo-m5",
			comboStepId: "code-t1-0",
			comboExecutionKey: "t:gpu0:vllm:qwen-coder:0",
			durationMs: 224_728,
		})
		expect(Object.keys(copied).sort()).toEqual([...BASELINE_KEYS].sort())
		expect(copied.ts).toBe("2026-10-10T00:00:00.000Z")
		expect(copied.exec).toBe("t:gpu0:vllm:qwen-coder:0")
		expect(copied.key).toBe("zoo-m5")
	})
})

describe("assertBodyFree", () => {
	it("accepts a clean body-free row", () => {
		expect(() => assertBodyFree(fields())).not.toThrow()
	})

	it("rejects a row carrying a body field", () => {
		expect(() => assertBodyFree({ ...fields(), body: "secret prompt" })).toThrow(/forbidden field 'body'/)
	})

	it("rejects a row carrying a credential field", () => {
		expect(() => assertBodyFree({ ...fields(), credential: "sk-xxx" })).toThrow(/forbidden field/)
	})
})

// ---------------------------------------------------------------------------
// rowIdOf — stable id for idempotent copies
// ---------------------------------------------------------------------------

describe("rowIdOf", () => {
	it("is stable for the same source attempt", () => {
		expect(rowIdOf(source())).toBe(rowIdOf(source()))
	})

	it("differs across instance, correlation, completion, and execution key", () => {
		const a = rowIdOf(source())
		expect(rowIdOf(source({ instanceId: "secondary" }))).not.toBe(a)
		expect(rowIdOf(source({}, { corr: "corr-2" }))).not.toBe(a)
		expect(rowIdOf(source({}, { ts: "2026-10-11T00:00:00.000Z" }))).not.toBe(a)
		expect(rowIdOf(source({}, { exec: "c:openrouter:x" }))).not.toBe(a)
	})
})

// ---------------------------------------------------------------------------
// runCopy — shared behaviour across store implementations
// ---------------------------------------------------------------------------

function copyBehaviour(makeStore: () => ObserverStore): void {
	const DAY = 24 * 60 * 60 * 1000
	const now = Date.parse("2026-10-10T00:00:00.000Z")

	it("stores the body-free fields for each source record", () => {
		const store = makeStore()
		const result = runCopy(store, [source({}, { corr: "a" }), source({}, { corr: "b" })], now)
		expect(result.inserted).toBe(2)
		const rows = store.all()
		expect(rows).toHaveLength(2)
		const row = rows.find((r) => r.fields.corr === "a")!
		expect(Object.keys(row.fields).sort()).toEqual([...BASELINE_KEYS].sort())
		expect(row.fields.key).toBe("zoo-m5")
		expect(row.instanceId).toBe("cluster")
	})

	it("carries no body or credential field in any stored row", () => {
		const store = makeStore()
		runCopy(store, [source()], now)
		for (const row of store.all()) {
			expect(row.fields).not.toHaveProperty("body")
			expect(row.fields).not.toHaveProperty("prompt")
			expect(row.fields).not.toHaveProperty("credential")
			expect(row.fields).not.toHaveProperty("apiKey")
		}
	})

	it("is idempotent: re-copying the same records inserts nothing new", () => {
		const store = makeStore()
		const batch = [source({}, { corr: "a" }), source({}, { corr: "b" })]
		runCopy(store, batch, now)
		const second = runCopy(store, batch, now)
		expect(second.inserted).toBe(0)
		expect(second.skipped).toBe(2)
		expect(store.count()).toBe(2)
	})

	it("is incremental: an overlapping re-run inserts only the new records", () => {
		const store = makeStore()
		runCopy(store, [source({}, { corr: "a" }), source({}, { corr: "b" })], now)
		const second = runCopy(store, [source({}, { corr: "b" }), source({}, { corr: "c" })], now)
		expect(second.inserted).toBe(1)
		expect(store.count()).toBe(3)
	})

	it("retains records within 90 days and prunes records older than 90 days", () => {
		const store = makeStore()
		const within = new Date(now - RETENTION_MS + DAY).toISOString()
		const older = new Date(now - RETENTION_MS - DAY).toISOString()
		const result = runCopy(
			store,
			[source({}, { corr: "within", ts: within }), source({}, { corr: "older", ts: older })],
			now,
		)
		expect(result.pruned).toBe(1)
		const remaining = store.all()
		expect(remaining).toHaveLength(1)
		expect(remaining[0]!.fields.corr).toBe("within")
	})

	it("keeps a record exactly at the 90-day boundary", () => {
		const store = makeStore()
		const atBoundary = new Date(now - RETENTION_MS).toISOString()
		runCopy(store, [source({}, { corr: "boundary", ts: atBoundary })], now)
		expect(store.count()).toBe(1)
	})
}

describe("runCopy (InMemoryObserverStore)", () => {
	copyBehaviour(() => new InMemoryObserverStore())
})
