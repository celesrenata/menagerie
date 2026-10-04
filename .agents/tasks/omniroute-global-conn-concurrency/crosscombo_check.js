// Check specifically for the cross research/coder failure mode on the shared 5090:
// any time window where >=2 qwen3.8-27b-nvfp4 (vllm/esnixi-5090) intervals from
// DIFFERENT combos overlap. Reports the worst case and whether any cross-combo overlap >2.
const Database = require("better-sqlite3");
const since = process.argv[2] || null;
const db = new Database("/app/data/storage.sqlite", { readonly: true });

let sql =
  "SELECT id, timestamp, duration, combo_name FROM call_logs WHERE model = 'qwen3.8-27b-nvfp4' AND account = 'esnixi-5090' AND duration IS NOT NULL";
const params = [];
if (since) {
  sql += " AND timestamp >= ?";
  params.push(since);
}
sql += " ORDER BY timestamp ASC";
const rows = db.prepare(sql).all(...params);

const iv = rows.map((r) => {
  const end = Date.parse(r.timestamp);
  return { id: r.id, start: end - (Number(r.duration) || 0), end, combo: r.combo_name };
});

const events = [];
for (const x of iv) {
  events.push({ t: x.start, d: +1, x });
  events.push({ t: x.end, d: -1, x });
}
events.sort((a, b) => a.t - b.t || a.d - b.d);

let max = 0,
  maxCombos = new Set(),
  maxAt = null,
  worstCrossComboCount = 0;
const active = new Set();
for (const e of events) {
  if (e.d === +1) active.add(e.x);
  else active.delete(e.x);
  if (active.size > max) {
    max = active.size;
    maxAt = e.t;
    maxCombos = new Set([...active].map((a) => a.combo));
  }
  const combos = new Set([...active].map((a) => a.combo));
  if (combos.size >= 2 && active.size > worstCrossComboCount) {
    worstCrossComboCount = active.size;
  }
}

console.log(
  JSON.stringify(
    {
      since: since || "(all)",
      shared5090Requests: rows.length,
      maxConcurrentOn5090: max,
      maxConcurrentAt: maxAt ? new Date(maxAt).toISOString() : null,
      combosAtMax: [...maxCombos],
      worstConcurrentWithMixedCombos: worstCrossComboCount,
    },
    null,
    2,
  ),
);
