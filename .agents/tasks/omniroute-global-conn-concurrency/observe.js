// Observe recent 27B dispatch across 5090 (vllm/esnixi-5090) and 4070 Ti overflow
// (ollama-local/gremlin-4070ti-ollama). Shows per-request combo + account + interval,
// plus the max-concurrent sweep on the shared 5090 connection.
const Database = require("better-sqlite3");
const since = process.argv[2] || null;
const db = new Database("/app/data/storage.sqlite", { readonly: true });

let sql =
  "SELECT id, timestamp, duration, model, provider, account, combo_name, status FROM call_logs WHERE (model LIKE '%27b%' OR model LIKE '%27:%' OR model LIKE '%nvfp4%')";
const params = [];
if (since) {
  sql += " AND timestamp >= ?";
  params.push(since);
}
sql += " ORDER BY timestamp ASC";
const rows = db.prepare(sql).all(...params);

console.log(`rows=${rows.length} since=${since || "(all)"}`);
for (const r of rows) {
  const end = Date.parse(r.timestamp);
  const start = end - (Number(r.duration) || 0);
  console.log(
    `${new Date(start).toISOString()} -> ${r.timestamp}  [${r.combo_name || "-"}]  ${r.model}  ${r.provider}/${r.account}  status=${r.status}  dur=${r.duration}ms`,
  );
}
