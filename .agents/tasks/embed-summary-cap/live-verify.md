# Live verification: embed-summary-cap (3.8.62-embed-summary-cap-20261003)

Window: 2026-10-03 12:24:57Z → 12:46:10Z (~21 min). Read-only, apart from one `/v1/embeddings` POST. I made no cluster or node changes. I used the management key only as a shell variable/Bearer token and never printed it.

## Commits and image

- OmniRoute `feat/hybrid-reader-combo` HEAD: `a2169c18fae93e84ef471469b6d6612077397b22` fix(combo): respect prefix-cache gate on fallback compression. It contains `2226275c8` (per-item cap), `fb41c23f9` (memory chunking), and `5b30a1ea3` (no resend after timeout/5xx).
- Kube repo (not pushed):
    - `dc8c1c36e04066c4fdb39d4383b98e5f413abdb3` chore(omniroute): deploy 3.8.62-embed-summary-cap-20261003
    - `67a40942d59165fa21e4dac7049425be474c8c00` fix: ovms-embeddings max_length 4096 (OmniRoute caps/chunks inputs)
- Image: `registry.celestium.life/library/omniroute:3.8.62-embed-summary-cap-20261003`
- Digest: `sha256:0b7f7b71bd57edadfe6beb152577e3a3339754941275d4e902e524a45f69c50e`. Live pod `omniroute-5f67c57c69-s2drr` (gremlin-1) imageID matches, 0 restarts.
- No `*EMBED*` env overrides on the omniroute deployment, so defaults apply: cap 4096 est. tokens, overflow `auto`.

## 1. External 20k-char POST: PASS (documented behavior)

`POST https://omniroute.celestium.life/v1/embeddings` at 12:25:22Z. Body: `model=arc-embed/qwen3-embedding-0.6b`, a single 20,000-char string input (20,057-byte JSON).

- Status: HTTP 400
- Latency: 0.063 s total (well under 20 s)
- Response shape:
    ```json
    {
    	"error": {
    		"message": "Embedding input item 0 is ~6667 tokens, over the 4096-token per-item limit for arc-embed; split the input or set OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=truncate",
    		"type": "upstream_error",
    		"code": "upstream_error"
    	}
    }
    ```
- This is the documented `auto` behavior for external callers: reject with 400 naming the item index, the estimate (20000/3 ≈ 6667), the cap, and the env var. There was no upstream dispatch: the 400 left no `call_logs` row and no `[EMBED]` log line, and no OVMS replica received it.
- Nit (not a failure): the error is labelled `type/code: "upstream_error"`, but it is a local validation rejection.

## 2. Internal summary embedder path (`api_key_name IS NULL`): NOT OBSERVED (no oversize internal input in window)

Read-only `better-sqlite3` query of `/app/data/storage.sqlite` `call_logs`, embeddings rows since 12:20Z:

| timestamp (Z) | api_key_name | tokens_in       | duration | status |
| ------------- | ------------ | --------------- | -------- | ------ |
| 12:21:47.745  | null         | 146             | 192 ms   | 200    |
| 12:44:13.132  | zoo-m5       | 2781 (14 items) | 2005 ms  | 200    |
| 12:44:13.369  | zoo-m5       | 2781 (14 items) | 1676 ms  | 200    |
| 12:44:57.233  | null         | 1864            | 829 ms   | 200    |

- Every internal row is far below 4096 tokens, and the longest embedding took 2.0 s. There were no 5xx, no 504/timeouts, and OmniRoute logged no truncation/overflow warnings.
- Pre-deploy, from 08:00 to 12:20Z, there were 8 internal rows over 4096 tokens (max 8850 tokens, 18.7 s). Hourly history shows these oversize summary inputs arrive only 1–2 per hour, and none arrived in this ~21-min window. So I could not observe a ~20k-char summary splitting into multiple ≤12k-char chunk rows live. That behavior is covered by the `memory-embed-summary-chunking` (8/8) and `embeddings-item-cap` (11/11) suites. I did not try to trigger it, because that would need synthetic long-context chat traffic, which is beyond this step's one-POST scope.
- To confirm later: look for `api_key_name IS NULL` rows with `tokens_in` ≤ ~4000 that arrive in tight sequential bursts of 2–3 within a few seconds, and no rows over 4096.

## 3. Kernel fences and OVMS restarts: PASS

Read-only `journalctl -k` / `dmesg` over SSH to gremlin-1..4. Nodes run on PDT, so the window start of 05:24:00 PDT is 12:24Z.

| node      | NEW `Fence expiration time out` since 05:24 PDT | dmesg matches | last fence before window |
| --------- | ----------------------------------------------- | ------------- | ------------------------ |
| gremlin-1 | 0                                               | 0             | 03:30:38 PDT (10:30Z)    |
| gremlin-2 | 0                                               | 0             | 03:13:52 PDT             |
| gremlin-3 | 0                                               | 0             | 03:20:37 PDT             |
| gremlin-4 | 0                                               | 0             | 03:29:02 PDT             |

`ovms-embeddings` (namespace `omniroute-memory`) at 12:46Z, all 1/1 Running with 0 restarts:

| pod               | node      | restarts | started (Z) |
| ----------------- | --------- | -------- | ----------- |
| ovms-embeddings-0 | gremlin-4 | 0        | 12:23:51    |
| ovms-embeddings-1 | gremlin-1 | 0        | 12:23:22    |
| ovms-embeddings-2 | gremlin-3 | 0        | 12:23:01    |
| ovms-embeddings-3 | gremlin-2 | 0        | 12:22:36    |

The only `Killing` events are the planned max_length-4096 rollout at ~12:22–12:23Z. There were no Unhealthy/BackOff events afterwards.

## Summary

- Pass: external oversize input is rejected in 63 ms with the documented 400. Live digest matches the pushed digest.
- Pass: 0 new fences on all 4 gremlins over ~21 min. 0 ovms-embeddings restarts.
- Not observed: no oversize internal summary embed arrived in the window. Every internal embed was ≤1864 tokens and under 1 s. The live check of multi-chunk splitting is still open, and the next 1–2 hours of `call_logs` can confirm it.
