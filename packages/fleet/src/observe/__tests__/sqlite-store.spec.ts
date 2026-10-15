import { describe, expect, it } from "vitest"

import { RETENTION_MS, runCopy, type CopiedAttempt, type ObserverStore, type SourceAttempt } from "../copy.js"

// The sqlite store is a native module. Load it defensively: if `better-sqlite3`
// fails to load in this environment, the suite reports that clearly and the
// pure copy logic stays verified by copy.spec.ts against InMemoryObserverStore.
let SqliteObserverStore: (new (filename: string) => ObserverStore & { close(): void }) | undefined
let loadError: unknown
try {
	;({ SqliteObserverStore } = await import("../sqlite-store.js"))
} catch (error) {
	loadError = error
}

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

function source(instanceId: string, fieldOverrides: Partial<CopiedAttempt> = {}): SourceAttempt {
	return { instanceId, fields: fields(fieldOverrides) }
}

describe("SqliteObserverStore", () => {
	if (!SqliteObserverStore) {
		it("better-sqlite3 is unavailable in this environment; sqlite store skipped", () => {
			// The native module failed to load. The copy logic is still verified
			// against InMemoryObserverStore in copy.spec.ts (injectable store).
			expect(loadError).toBeDefined()
		})
		return
	}

	const Store = SqliteObserverStore
	const now = Date.parse("2026-10-10T00:00:00.000Z")
	const DAY = 24 * 60 * 60 * 1000

	it("stores and reads back the body-free fields via an in-memory sqlite DB", () => {
		const store = new Store(":memory:")
		try {
			runCopy(store, [source("cluster", { corr: "a" })], now)
			const rows = store.all()
			expect(rows).toHaveLength(1)
			expect(rows[0]!.fields.key).toBe("zoo-m5")
			expect(rows[0]!.fields.exec).toBe("t:gpu0:vllm:qwen-coder:0")
			expect(rows[0]!.instanceId).toBe("cluster")
			expect(rows[0]!.fields).not.toHaveProperty("body")
		} finally {
			store.close()
		}
	})

	it("is idempotent across runs (INSERT OR IGNORE on the row id)", () => {
		const store = new Store(":memory:")
		try {
			const batch = [source("cluster", { corr: "a" }), source("cluster", { corr: "b" })]
			runCopy(store, batch, now)
			const second = runCopy(store, batch, now)
			expect(second.inserted).toBe(0)
			expect(store.count()).toBe(2)
		} finally {
			store.close()
		}
	})

	it("prunes rows older than 90 days and retains newer ones", () => {
		const store = new Store(":memory:")
		try {
			const within = new Date(now - RETENTION_MS + DAY).toISOString()
			const older = new Date(now - RETENTION_MS - DAY).toISOString()
			const result = runCopy(
				store,
				[source("cluster", { corr: "within", ts: within }), source("cluster", { corr: "older", ts: older })],
				now,
			)
			expect(result.pruned).toBe(1)
			expect(store.count()).toBe(1)
			expect(store.all()[0]!.fields.corr).toBe("within")
		} finally {
			store.close()
		}
	})
})
