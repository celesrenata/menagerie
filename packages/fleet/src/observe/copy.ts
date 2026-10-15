// Fleet_Observer — the ≥90-day, body-free metrics copy (design §4 "Durable
// metrics copy", Requirement 16.12).
//
// At least once every 24 hours the observer copies, from each OmniRoute_
// Instance's attempt and Health_Probe records into its OWN store, every field
// that Requirement 16 criteria 1-7 and Requirement 17 use — and NO request or
// response body and NO credential value. The copy is retained for at least 90
// days so metrics windows outlast an OmniRoute_Instance's own retention. This
// is the exact body-free shape already exported to
// `baseline-attempts-20261007-20261014.jsonl.gz`; the field set here mirrors
// that extract's JSONL keys so the durable copy and the baseline extract are
// the same shape.
//
// The copy writes to the OBSERVER's own sqlite store (separate from OmniRoute,
// whose DB is only read read-only). The store is behind an interface so the
// logic is testable with an in-memory implementation and does not depend on the
// native `better-sqlite3` module loading in the test environment; a
// `better-sqlite3`-backed implementation is provided for production.

import type { CallLogRecord } from "../omniroute/client.js"

// ---------------------------------------------------------------------------
// The body-free field set (Requirement 16.12)
// ---------------------------------------------------------------------------

/**
 * One row of the durable copy: exactly the body-free fields the baseline
 * extract (`baseline-attempts-*.jsonl.gz`) carries, which are the fields
 * Requirement 16 criteria 1-7 and Requirement 17 use. Field names mirror the
 * extract's JSONL keys so the copy and the extract are the same shape:
 *
 *   ts, dur_ms, status, provider, model, requested_model, connection_id,
 *   tin, tout, key, combo, step, corr, exec, etype, ttft, wait
 *
 * It carries NO request/response body and NO credential value. `key` is the
 * client API-key NAME (`api_key_name`), never a key value (Requirement 16.12,
 * 22). `wait` is the Admission_Wait in ms; `dur_ms` is end-to-end latency, so
 * Upstream_Duration = dur_ms − wait (design §4, Requirement 17.3). A health
 * probe is marked by `probe = 1` so criterion 6 can count it apart from
 * client attempts (Requirement 16 criterion 9).
 */
export interface CopiedAttempt {
	/** Completion time, ISO-8601 UTC (`timestamp`). */
	readonly ts: string
	/** End-to-end latency in whole ms (`duration`). */
	readonly dur_ms: number | null
	/** HTTP status (`status`). */
	readonly status: number | null
	/** Provider (`provider`). */
	readonly provider: string | null
	/** Upstream model id (`model`). */
	readonly model: string | null
	/** Requested model id (`requested_model`). */
	readonly requested_model: string | null
	/** OmniRoute connection (`connection_id`). */
	readonly connection_id: string | null
	/** Input token count (`tokens_in`). */
	readonly tin: number | null
	/** Output token count (`tokens_out`). */
	readonly tout: number | null
	/** Client API-key NAME, never a value (`api_key_name`). */
	readonly key: string | null
	/** Combo name (`combo_name`). */
	readonly combo: string | null
	/** Combo step id (`combo_step_id`). */
	readonly step: string | null
	/** Correlation id (`correlation_id`). */
	readonly corr: string | null
	/** Combo execution key — carries the Target_Identifier (`combo_execution_key`). */
	readonly exec: string | null
	/** Error type (`error_type`). */
	readonly etype: string | null
	/** Time to first token in ms (`ttft_ms`). */
	readonly ttft: number | null
	/** Admission wait in ms (`added_wait_ms`). */
	readonly wait: number | null
}

/** The ordered column names of the durable copy, matching the baseline extract. */
export const COPY_COLUMNS = [
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

/** Fields that MUST never appear in the copy (Requirement 16.12, 22). */
const FORBIDDEN_FIELDS = ["body", "request", "response", "prompt", "completion", "secret", "credential", "apiKey", "authorization"] as const

/**
 * The identity + instance of one source record, paired with the body-free
 * fields. The source id (`instanceId` + `corr` + `ts` + `exec`) is what makes
 * the copy idempotent: re-copying the same record is a no-op.
 */
export interface SourceAttempt {
	readonly instanceId: string
	readonly isHealthProbe?: boolean
	readonly fields: CopiedAttempt
}

// ---------------------------------------------------------------------------
// The observer store (injectable; sqlite in production, in-memory in tests)
// ---------------------------------------------------------------------------

/**
 * One stored row: the body-free fields plus the instance id and a probe flag,
 * keyed by a stable row id so re-copying is idempotent (Requirement 16.12).
 */
export interface StoredRow {
	readonly rowId: string
	readonly instanceId: string
	readonly isHealthProbe: boolean
	readonly fields: CopiedAttempt
}

/**
 * The observer's durable store. `better-sqlite3` is synchronous, so this is a
 * synchronous interface. It is injectable so the copy logic is verified with an
 * in-memory implementation independent of the native module.
 */
export interface ObserverStore {
	/** Insert a row if its id is new; a repeated id is ignored (idempotent). */
	upsert(row: StoredRow): void
	/** Delete every row whose completion time is strictly before `cutoffMs`. */
	pruneOlderThan(cutoffMs: number): number
	/** Every stored row (for metrics reads and tests). */
	all(): StoredRow[]
	/** The number of stored rows. */
	count(): number
}

/**
 * The stable row id of a source record: instance + correlation + completion +
 * execution key. Two reads of the same attempt produce the same id, so the copy
 * is idempotent and incremental (Requirement 16.12).
 */
export function rowIdOf(source: SourceAttempt): string {
	const f = source.fields
	return [source.instanceId, f.corr ?? "", f.ts, f.exec ?? ""].join("\u0000")
}

// ---------------------------------------------------------------------------
// Mapping a live CallLogRecord to the body-free copy
// ---------------------------------------------------------------------------

/**
 * Project a live `CallLogRecord` onto the body-free copy fields. Only the
 * allowed fields are read; no body/credential field is read or carried
 * (Requirement 16.12). `exec` carries the recorded Target_Identifier when the
 * attempt had one (OmniRoute's `combo_execution_key`); `key` is the API-key
 * name (`session_tag` here is the Capability_Lane name, not copied into `key`).
 */
export function fromCallLog(
	record: CallLogRecord,
	extras: {
		readonly tokensIn?: number
		readonly tokensOut?: number
		readonly apiKeyName?: string
		readonly comboStepId?: string
		readonly comboExecutionKey?: string
		readonly durationMs?: number
	} = {},
): CopiedAttempt {
	return {
		ts: record.timestamp,
		dur_ms: extras.durationMs ?? null,
		status: record.status,
		provider: record.provider,
		model: record.model,
		requested_model: record.requestedModel ?? null,
		connection_id: record.connectionId ?? null,
		tin: extras.tokensIn ?? null,
		tout: extras.tokensOut ?? null,
		key: extras.apiKeyName ?? null,
		combo: record.comboName ?? null,
		step: extras.comboStepId ?? null,
		corr: record.correlationId ?? null,
		exec: extras.comboExecutionKey ?? null,
		etype: record.errorType ?? null,
		ttft: record.ttftMs ?? null,
		wait: record.addedWaitMs ?? null,
	}
}

/**
 * Assert a projected row carries no forbidden (body/credential) field. The copy
 * fields are a closed set, so this is a defensive guard that fails loudly if a
 * caller ever hands in an object with a stray body/credential key.
 */
export function assertBodyFree(fields: object): void {
	for (const forbidden of FORBIDDEN_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(fields, forbidden)) {
			throw new Error(`copied attempt carries forbidden field '${forbidden}'`)
		}
	}
}

// ---------------------------------------------------------------------------
// The copy run (idempotent / incremental, ≥90-day retention)
// ---------------------------------------------------------------------------

/** The retention floor: 90 days in milliseconds (Requirement 16.12 "at least 90 days"). */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** The outcome of one copy run. */
export interface CopyRunResult {
	/** Rows inserted this run (new source records). */
	readonly inserted: number
	/** Rows skipped as already present (idempotent re-copy). */
	readonly skipped: number
	/** Rows pruned for exceeding the retention floor. */
	readonly pruned: number
}

/**
 * Copy a batch of source records into the store and prune anything older than
 * the retention floor relative to `nowMs` (Requirement 16.12). Idempotent: a
 * record already present (same row id) is skipped, so a ≥24-hour re-run that
 * overlaps the previous window inserts only the new records. The caller supplies
 * `nowMs` so the run has no hidden clock.
 */
export function runCopy(store: ObserverStore, sources: readonly SourceAttempt[], nowMs: number): CopyRunResult {
	let inserted = 0
	let skipped = 0
	const seen = new Set<string>()
	for (const source of sources) {
		assertBodyFree(source.fields)
		const rowId = rowIdOf(source)
		// A row id already present this run (intra-batch dup) or already in the
		// store (a prior run) is skipped: the copy is idempotent/incremental.
		if (seen.has(rowId)) {
			skipped++
			continue
		}
		seen.add(rowId)
		const before = store.count()
		store.upsert({
			rowId,
			instanceId: source.instanceId,
			isHealthProbe: source.isHealthProbe ?? false,
			fields: source.fields,
		})
		if (store.count() > before) {
			inserted++
		} else {
			skipped++
		}
	}
	const pruned = store.pruneOlderThan(nowMs - RETENTION_MS)
	return { inserted, skipped, pruned }
}

// ---------------------------------------------------------------------------
// In-memory store (used in tests and when the native module is unavailable)
// ---------------------------------------------------------------------------

/** A pure in-memory `ObserverStore`, so the copy logic is verifiable without sqlite. */
export class InMemoryObserverStore implements ObserverStore {
	private readonly rows = new Map<string, StoredRow>()

	upsert(row: StoredRow): void {
		if (!this.rows.has(row.rowId)) {
			this.rows.set(row.rowId, row)
		}
	}

	pruneOlderThan(cutoffMs: number): number {
		let pruned = 0
		for (const [id, row] of this.rows) {
			if (Date.parse(row.fields.ts) < cutoffMs) {
				this.rows.delete(id)
				pruned++
			}
		}
		return pruned
	}

	all(): StoredRow[] {
		return [...this.rows.values()]
	}

	count(): number {
		return this.rows.size
	}
}
