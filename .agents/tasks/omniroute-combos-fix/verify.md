# OmniRoute `/api/combos` — final live verification

## Method

- Retrieved the management API key with `cat /run/secrets/omniroute_management_api_key`
  (confirmed readable both on esnixi, `192.168.42.254`, and locally; same key, prefix
  `sk-5e477e158fbbbca9-...`).
- Called the live public endpoint `https://omniroute.celestium.life/api/combos` directly over
  HTTPS with that key as a Bearer token (not from inside a pod, not from logs).

## Result 1 — `GET /api/combos?limit=300`

```
HTTP_STATUS: 200
```

Before the fix, this call returned `400` (`paginationSchema`'s hard `max(200)` rejection — per
`plan.md` Evidence 4). It now returns **`200`** with the clamped page containing **all 91**
combos (`"total":91` in the body, 91 entries in the `combos` array). The old 400-as-200/0-combos
read-without-status-check symptom is gone.

Response body shape (combo names list only, per output guidance — full combo objects include
model/connection ids and were not dumped here):

```
local/5090, local/m5max, local/4070ti, local/code, local/fast, local/long, local/any,
cloud/fast, hybrid/fast, cloud/openai, cloud/code, hybrid/code, hybrid/long, hybrid/any,
cloud/bedrock, free/aihorde, free/code, free/fast, free/any, free/mistral, hybrid/planner,
hybrid/reviewer, hybrid/tester, hybrid/frontier, hybrid/tiny, local/m5-reader,
pool/tier1/code .. pool/tier5/code, pool/tier1/tester .. pool/tier5/tester,
pool/tier1/reviewer .. pool/tier5/reviewer, pool/tier1/planner .. pool/tier5/planner,
pool/tier1/long .. pool/tier5/long, pool/tier1/research .. pool/tier5/research,
pool/tier1/fast .. pool/tier5/fast, pool/tier1/tiny .. pool/tier5/tiny,
pool/tier1/reader .. pool/tier5/reader, pool/tier1/any .. pool/tier5/any,
pool/tier1/frontier .. pool/tier5/frontier, local/tester, local/reviewer, local/planner,
local/research, hybrid/research, local/tiny, local/reader, hybrid/reader, local/frontier,
local/5090-reader
```

`pool/tier5/reader` — **present** (`sortOrder` 75 in the tier-grouped reader block).
`pool/tier5/frontier` — **present** (`sortOrder` 90 in the tier-grouped frontier block).

## Result 2 — `GET /api/combos?all=true`

```
HTTP_STATUS: 200
```

`"total":91`, 91 entries in `combos`. Identical count to `limit=300`.

## Consistency with plan.md's root cause

`plan.md` found the live table always held 91 well-formed rows, and that the earlier "5 results"
reading was an artifact of the pod-churn window (07:10-07:25 UTC, 2026-10-02), not a reproducible
code defect — the actual, reproducible bug was `limit=300` hard-failing with a 400 due to
`paginationSchema`'s `.max(200)`. Both live calls above now return the same, full count (91),
with no divergence between `limit=300` (clamped) and `all=true` (unbounded) — exactly the
behavior Fix 1 (clamp instead of reject) predicts, and exactly what plan.md's Evidence 3 showed
pre-deploy from inside the pod. No 5-result or 0-result anomaly reproduces against the live
public endpoint post-deploy.

## Namespace cleanup

```
kubectl get pods -n omniroute
NAME                                  READY   STATUS      RESTARTS   AGE
omniroute-f67669fd4-9fb2l             1/1     Running     0          ~2m
omniroute-nfs-backup-29848680-mb9n6   0/1     Completed   0          ~3h28m
```

Only two pods exist: the live `omniroute` deployment pod (do not touch) and a `Completed` pod
owned by the scheduled `omniroute-nfs-backup-29848680` Job (a CronJob-managed backup run, not a
debug/throwaway pod created by this investigation). No debug pods were found or deleted.

## Verdict

**PASS** — `limit=300` → 200, 91/91 combos. `all=true` → 200, 91/91 combos. Both counts match
and are consistent with plan.md's root cause. `pool/tier5/reader` and `pool/tier5/frontier` are
both present. No leftover debug pods in the `omniroute` namespace.
