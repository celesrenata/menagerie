// Interval-overlap sweep: max concurrent in-flight on a given model across ALL combos.
// interval = [timestamp - duration, timestamp]  (duration is ms; timestamp is completion time)
// Usage: node concurrency_sweep.js <model> [sinceISO]
const Database = require("better-sqlite3");

const model = process.argv[2] || "qwen3.8-27b-nvfp4";
const since = process.argv[3] || null; // ISO string lower bound on completion timestamp

const db = new Database("/app/data/storage.sqlite", { readonly: true });

let sql =
  "SELECT id, timestamp, duration, combo_name, provider, account FROM call_logs WHERE model = ? AND duration IS NOT NULL AND timestamp IS NOT NULL";
const params = [model];
if (since) {
  sql += " AND timestamp >= ?";
  params.push(since);
}
sql += " ORDER BY timestamp ASC";

const rows = db.prepare(sql).all(...params);

// Build intervals in epoch ms.
const intervals = rows.map((r) => {
  const end = Date.parse(r.timestamp);
  const dur = Number(r.duration) || 0;
  const start = end - dur;
  return { id: r.id, start, end, combo: r.combo_name, account: r.account };
});

// Sweep: +1 at start, -1 at end. Process starts before ends at equal time to be conservative (count boundary overlaps).
const events = [];
for (const iv of intervals) {
  events.push({ t: iv.start, delta: +1, iv });
  events.push({ t: iv.end, delta: -1, iv });
}
// Sort: at equal timestamps, process ends (-1) BEFORE starts (+1) so a request that finishes
// exactly when another starts is NOT counted as overlapping (true in-flight concurrency).
events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));

let cur = 0;
let max = 0;
let maxAt = null;
let maxInFlight = [];
const active = new Set();
for (const e of events) {
  if (e.delta === +1) {
    cur++;
    active.add(e.iv);
  } else {
    cur--;
    active.delete(e.iv);
  }
  if (cur > max) {
    max = cur;
    maxAt = e.t;
    maxInFlight = [...active].map((iv) => ({
      id: iv.id,
      combo: iv.combo,
      account: iv.account,
      start: new Date(iv.start).toISOString(),
      end: new Date(iv.end).toISOString(),
    }));
  }
}

console.log(
  JSON.stringify(
    {
      model,
      since: since || "(all time)",
      totalRequests: rows.length,
      maxConcurrent: max,
      maxConcurrentAt: maxAt ? new Date(maxAt).toISOString() : null,
      maxInFlight,
      combosSeen: [...new Set(rows.map((r) => r.combo_name))],
    },
    null,
    2,
  ),
);
