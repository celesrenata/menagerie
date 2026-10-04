const Database = require("better-sqlite3");
const db = new Database("/app/data/storage.sqlite", { readonly: true });
const models = db
  .prepare(
    "SELECT model, provider, account, count(*) c FROM call_logs WHERE model LIKE '%27%' OR model LIKE '%nvfp4%' GROUP BY model, provider, account ORDER BY c DESC",
  )
  .all();
console.log(JSON.stringify(models, null, 2));
console.log("---LATEST TS---");
console.log(JSON.stringify(db.prepare("SELECT max(timestamp) m FROM call_logs").get()));
