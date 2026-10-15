// Fleet_Observer — the `better-sqlite3`-backed durable store (design §4,
// Requirement 16.12).
//
// This is the production `ObserverStore`: the observer's OWN sqlite database (a
// file path, separate from OmniRoute's DB — OmniRoute is only read read-only).
// The pure copy logic in `copy.ts` never imports this module, so a native-module
// load failure in a logic test never affects the copy logic; tests that want a
// store use `InMemoryObserverStore`. A test that specifically wants to exercise
// the sqlite schema opens `:memory:`.
//
// `better-sqlite3` is synchronous, matching the `ObserverStore` interface. The
// stored row carries only the body-free copy fields plus the instance id and a
// probe flag — no body, no credential (Requirement 16.12).

import Database from "better-sqlite3"

import { COPY_COLUMNS, type CopiedAttempt, type ObserverStore, type StoredRow } from "./copy.js"

/** The table that holds the durable copy. One row per source attempt/probe. */
const TABLE = "observed_attempts"

/** `CREATE TABLE` for the durable copy: the body-free fields + identity + probe flag. */
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  row_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  is_health_probe INTEGER NOT NULL,
  ts TEXT NOT NULL,
  dur_ms INTEGER,
  status INTEGER,
  provider TEXT,
  model TEXT,
  requested_model TEXT,
  connection_id TEXT,
  tin INTEGER,
  tout INTEGER,
  key TEXT,
  combo TEXT,
  step TEXT,
  corr TEXT,
  exec TEXT,
  etype TEXT,
  ttft INTEGER,
  wait INTEGER
);
`

/** An index on completion time so pruning the retention floor is cheap. */
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_ts ON ${TABLE} (ts);`

/** The row shape as it comes back from sqlite (snake_case, probe as 0/1). */
interface Row {
	row_id: string
	instance_id: string
	is_health_probe: number
	ts: string
	dur_ms: number | null
	status: number | null
	provider: string | null
	model: string | null
	requested_model: string | null
	connection_id: string | null
	tin: number | null
	tout: number | null
	key: string | null
	combo: string | null
	step: string | null
	corr: string | null
	exec: string | null
	etype: string | null
	ttft: number | null
	wait: number | null
}

/**
 * The `better-sqlite3`-backed `ObserverStore`. Open with a file path for the
 * durable store, or `:memory:` for a schema test. The table is created on
 * construction. Writes go only to this store — OmniRoute's DB is never written.
 */
export class SqliteObserverStore implements ObserverStore {
	private readonly db: Database.Database

	constructor(filename: string) {
		this.db = new Database(filename)
		this.db.pragma("journal_mode = WAL")
		this.db.exec(CREATE_TABLE)
		this.db.exec(CREATE_INDEX)
	}

	upsert(row: StoredRow): void {
		const f = row.fields
		// INSERT OR IGNORE: a repeated row_id is a no-op, so the copy is idempotent.
		const stmt = this.db.prepare(
			`INSERT OR IGNORE INTO ${TABLE}
			 (row_id, instance_id, is_health_probe, ${COPY_COLUMNS.join(", ")})
			 VALUES (@row_id, @instance_id, @is_health_probe, @ts, @dur_ms, @status, @provider, @model,
			         @requested_model, @connection_id, @tin, @tout, @key, @combo, @step, @corr, @exec,
			         @etype, @ttft, @wait)`,
		)
		stmt.run({
			row_id: row.rowId,
			instance_id: row.instanceId,
			is_health_probe: row.isHealthProbe ? 1 : 0,
			ts: f.ts,
			dur_ms: f.dur_ms,
			status: f.status,
			provider: f.provider,
			model: f.model,
			requested_model: f.requested_model,
			connection_id: f.connection_id,
			tin: f.tin,
			tout: f.tout,
			key: f.key,
			combo: f.combo,
			step: f.step,
			corr: f.corr,
			exec: f.exec,
			etype: f.etype,
			ttft: f.ttft,
			wait: f.wait,
		})
	}

	pruneOlderThan(cutoffMs: number): number {
		const cutoffIso = new Date(cutoffMs).toISOString()
		const result = this.db.prepare(`DELETE FROM ${TABLE} WHERE ts < ?`).run(cutoffIso)
		return Number(result.changes)
	}

	all(): StoredRow[] {
		const rows = this.db.prepare(`SELECT * FROM ${TABLE} ORDER BY ts`).all() as Row[]
		return rows.map(toStoredRow)
	}

	count(): number {
		const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as { n: number }
		return Number(row.n)
	}

	/** Close the underlying database handle. */
	close(): void {
		this.db.close()
	}
}

/** Reconstruct a `StoredRow` from a sqlite row. */
function toStoredRow(row: Row): StoredRow {
	const fields: CopiedAttempt = {
		ts: row.ts,
		dur_ms: row.dur_ms,
		status: row.status,
		provider: row.provider,
		model: row.model,
		requested_model: row.requested_model,
		connection_id: row.connection_id,
		tin: row.tin,
		tout: row.tout,
		key: row.key,
		combo: row.combo,
		step: row.step,
		corr: row.corr,
		exec: row.exec,
		etype: row.etype,
		ttft: row.ttft,
		wait: row.wait,
	}
	return {
		rowId: row.row_id,
		instanceId: row.instance_id,
		isHealthProbe: row.is_health_probe === 1,
		fields,
	}
}
