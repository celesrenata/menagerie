# OmniRoute shared account-semaphore permit leak investigation

## Summary answer

**Confirmed: the stale shared-account occupancy is a streaming-response lifecycle leak present in both the old production baseline and the capacity-cascade candidate.** `handleChatCore` intentionally transfers a streaming permit into a body finalizer, but combo response-quality validation calls `Response.clone()`, reads the clone only until it sees useful content, and then abandons that tee branch behind a replay stream whose `cancel()` does not forward to the locked tee reader. If the downstream client stops after SSE `[DONE]` or disconnects instead of pulling the network body through EOF, cancellation of the client-facing tee branch cannot cancel the shared source. The account finalizer is therefore never called and `accountSemaphore.getStats()` remains nonzero.

This explains the monitoring disagreement. `/api/admin/concurrency.semaphores` reads the actual in-memory shared account gates, while `/api/rate-limits` reads separate Bottleneck limiters. The Bottleneck job ends as soon as the executor returns a `Response`; the account permit intentionally remains held for the stream body. Therefore `rate-limits running=0/executing=0/queued=0` can coexist with leaked account `running>0`.

The live `COMBO-RR ... succeeded` and `[ProxyEgress] ... status=success` lines are **not completion evidence**. Both are emitted after a successful response/initial quality peek, before the response body has completed or been canceled. The actual stream lifecycle log occurs later.

The GLM request dispatched at `2026-10-11T01:04:24.393Z` was genuinely active at the time of the reported early snapshots: it did not log combo success until `01:08:00.974Z` and did not log stream completion until `01:08:49`. It was not an already-finished leak during that interval. Because it traverses the same vulnerable combo clone path, its permit could still leak *after* terminal delivery; the available authenticated snapshots do not establish its post-`01:08:49` semaphore value.

The candidate does not repair this leak. Its account-capacity fast-fail sentinel also has an end-to-end propagation gap: normal `chatCore` handling converts `SEMAPHORE_QUEUE_FULL` to a 429 result before the candidate's `chat.ts` exception catch can attach `x-omniroute-account-capacity: queue-full`. The candidate's combo test mocks the marker rather than exercising this real path.

**Narrowest fix:** add cancellation forwarding to the replay stream created by `validateResponseQuality` so canceling `quality.clonedResponse.body` calls `readerToForward.cancel(reason)`. This lets `releaseQualityClone()` genuinely cancel the quality tee branch; a later client cancellation then reaches the semaphore-wrapped source and releases exactly once. Also fix the pre-existing Antigravity BYOP rotation `continue` that skips `releaseAccountSemaphore()`, and close the small post-acquire/pre-`try` exception gap. Do not weaken or bypass the account gate.

The source candidate can be amended, but the already-reviewed/built candidate cannot be certified as-is. A runtime-code change requires a new immutable image digest, focused review, and clean-state canaries. The cluster rollout history showed candidate digest `sha256:fb059a4...` rolled back to old digest `sha256:41a9b0...`; neither contains the lifecycle fix.

## Evidence

### 1. Direct and combo dispatch reach the same acquisition site

There is one account-semaphore acquisition in the chat execution path; direct and combo requests converge on it:

- Combo dispatch calls `handleComboChat`, passing `handleSingleModelChat` as the per-target executor at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chat.ts:1032-1135` (the callback itself is at `1065-1114`).
- Direct dispatch calls the same `handleSingleModelChat` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chat.ts:1229-1265`.
- `handleSingleModelChat` calls `dispatchChatWithAffinityEviction` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chat.ts:1826-1873`.
- That seam calls `executeChatWithBreaker` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chatDispatch.ts:40-71`.
- `executeChatWithBreaker` calls `handleChatCore` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chatHelpers.ts:395-486` (call construction at `448-486`).
- Candidate `handleChatCore` computes the account key and calls `acquireAccountSemaphore` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/handlers/chatCore.ts:3050-3078`. The baseline call is the same logic at `/home/celes/sources/omniroute-transcript-fix/.claude/worktrees/tier2-planner-capacity/open-sse/handlers/chatCore.ts:3052-3070`; the candidate only adds optional `maxQueueSize` and `timeoutMs` arguments.

`accountSemaphore.acquire()` increments `gate.running` and returns an idempotent release callback at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/accountSemaphore.ts:141-160,182-218`. The callback decrements `running`, drains a waiter if present, and schedules idle-gate cleanup.

### 2. When release is invoked

Release ownership depends on the response mode:

- Executor or pre-body exception after entering the protected block: catch releases at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/handlers/chatCore.ts:3510-3513`.
- ModelScope retry: releases before retry delay at `chatCore.ts:3177-3193`.
- Codex account rotation/no-next-account streaming branch: releases at `chatCore.ts:3247-3259,3289-3294`.
- Streaming response without a body: releases immediately at `chatCore.ts:3346-3352`.
- Ordinary streaming response: release is installed as the finalizer of `createRecoverableStream` or `wrapReadableStreamWithFinalize` at `chatCore.ts:3392-3502` (callbacks at `3461-3466` and `3487-3491`). The streaming result then returns before the non-stream release block at `chatCore.ts:3517-3519`.
- Non-streaming response: callback ownership is copied from `_accountSemaphoreRelease`, the full body is read, then release is invoked at `chatCore.ts:3521-3557`; the surrounding catch releases on body-read failure at `3573-3575`.

The ordinary finalizer runs on source EOF, read error, or source cancellation—not on `Response` creation and not on logical SSE `[DONE]`: `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/handlers/chatCore/streamFinalize.ts:10-47`. The recovery-enabled equivalent has the same release-on-EOF/error/cancel contract at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/streamRecovery.ts:374-418,582-697`.

The downstream pipeline is designed to propagate client cancellation: `createDisconnectAwareStream.cancel()` records completion/disconnect and cancels its reader/aborts its writer at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/utils/streamHandler.ts:700-821` (cancel at `809-818`). The request abort signal also aborts the upstream controller at `streamHandler.ts:304-338,423-443`. This works for direct responses and fails only when another tee branch remains alive.

### 3. Why success logs precede release

`withRateLimit` schedules only the executor function and resolves when that function returns. Its scheduled promise ends at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/rateLimitManager.ts:546-629`, while the executor itself returns the upstream `Response` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/handlers/chatCore.ts:3084-3131`. No stream-body drain is awaited there.

`safeLogEvents` is launched fire-and-forget immediately after `dispatchChatWithAffinityEviction` returns, at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chat.ts:1895-1923`. It maps `result.success` directly to proxy status `success` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chatHelpers.ts:848-906` (status mapping at `886-900`). `logProxyEvent` then prints `[ProxyEgress]` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/lib/proxyLogger.ts:154-188`. None of these operations consumes the response body.

Round-robin combo success is logged after only bounded quality validation at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/combo.ts:3465-3524`. The other combo strategies do the same at `combo.ts:1662-1687,1778-1797`. A content-bearing SSE stream normally passes quality validation as soon as useful content is seen, not at EOF.

Live log correlation on old digest `sha256:41a9b0...` confirms the distinction:

- First VLLM request: dispatch `01:04:54.111Z`; combo “succeeded” `01:05:13.974Z`; no matching stream-complete/disconnect line was present in the inspected pod log.
- Second VLLM request: dispatch `01:06:26.215Z`; `[ProxyEgress] success` and combo “succeeded” `01:06:28.799Z`; stream lifecycle “complete” only at `01:08:47` (140,630 ms after dispatch).
- GLM: dispatch `01:04:24.393Z`; `[ProxyEgress] success` and combo “succeeded” at `01:08:00.974Z`; stream lifecycle “complete” at `01:08:49` (264,707 ms after dispatch).

Even a `STREAM ... complete` line is not proof that the semaphore source reached EOF: after a terminal marker, downstream cancellation calls `handleComplete()` before canceling the reader (`streamHandler.ts:809-818`). If tee cancellation is blocked by the orphan branch, completion can be logged while the permit remains held.

### 4. Confirmed combo tee leak

Both primary combo paths clone the successful response before quality inspection:

- Priority/weighted/etc.: `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/combo.ts:1662-1687`.
- Round-robin: `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/combo.ts:3465-3481`.

For streaming responses, `validateResponseQuality` obtains a reader on the clone at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/combo/validateQuality.ts:239-266`. On first useful content it returns a replay `Response` around that still-locked reader at `validateQuality.ts:407-443,544-570`.

The replay stream has `pull()` but **no `cancel()` hook** (`validateQuality.ts:412-443`). `releaseQualityClone()` calls `quality.clonedResponse.body.cancel()` at `validateQuality.ts:773-795`, but that only cancels the replay wrapper; it never calls `readerToForward.cancel()`. Consequently, the quality clone's `Response.clone()` tee branch remains locked and alive. If the client-facing branch later cancels, the tee cannot cancel its shared source until both branches cancel, so `wrapReadableStreamWithFinalize.cancel()` is never reached.

The relevant lifecycle files are byte-identical in baseline and candidate:

- `open-sse/services/combo/validateQuality.ts`: SHA-256 `f9b61655b9332b042613f090c7ccf21718df97e0fc95e73a782df47f95ff86fd` in both trees.
- `open-sse/handlers/chatCore/streamFinalize.ts`: SHA-256 `0351e7dcd9f63fcc182c171c633b39ad13ffe41218d4eb44a880f7e3b75fd8da` in both trees.

The candidate diff does not modify either file. Therefore the defect exists in both the baseline and candidate.

### 5. Focused isolated reproduction

A no-file, isolated Node/tsx probe was run in the candidate worktree. It acquired a real account semaphore, wrapped a synthetic SSE source with `wrapReadableStreamWithFinalize`, and exercised direct cancellation, combo clone/quality validation with complete EOF, and combo clone/quality validation followed by client cancellation after `[DONE]`.

Observed result:

```text
{"directAbort":{"cancelSettled":true,"running":0},
 "comboCompleteDrain":{"qualityValid":true,"running":0},
 "comboAbortAfterDone":{"qualityValid":true,"cancelSettled":false,"running":1}}
```

Thus:

- direct client abort releases;
- a truly drained combo body that reaches EOF releases;
- a successful combo client that stops after `[DONE]` leaves cancellation pending and leaks `running=1`.

The baseline worktree lacks installed `tsx`, so the same probe could not execute there without mutating/installing dependencies. The two source files implementing the reproduced behavior are byte-identical as shown above, and both worktrees share committed HEAD `ad45d990c9f17e857f0bd03aacd1ff29b1825658`, so the reproduction applies to both.

Existing focused tests all pass and do not catch this lifecycle seam. The command run in the candidate was the repository's Node test setup against:

- `tests/unit/accountSemaphore.test.ts`
- `tests/unit/validate-response-quality.test.ts`
- `tests/unit/combo-round-robin-streaming-lock-3811.test.ts`
- `tests/unit/combo-shared-account-race.test.ts`

Result: 24 tests passed, 0 failed. In particular, `validate-response-quality.test.ts` verifies that the replay body itself is canceled but does not verify cancellation reaches the underlying locked clone reader/source; `combo-shared-account-race.test.ts` mocks semaphore behavior rather than running the real chatCore/body lifecycle.

### 6. Other release-skip or delayed-release paths

| Path | Assessment |
|---|---|
| Streaming `Response` returned before non-stream `finally` | Intentional ownership transfer at `chatCore.ts:3517-3519`; safe only if the body reaches EOF/error/cancel. A never-consumed body retains the permit indefinitely. |
| Combo `Response.clone()` / tee | **Confirmed leak.** The abandoned quality branch is not actually canceled because replay cancellation does not forward to its reader (`validateQuality.ts:412-443,788-795`). |
| Client abort/cancel | Direct path propagates cancellation and releases. Combo path can block source cancellation on the orphan quality tee. |
| Downstream does not drain | Leaks by design of the current ownership model: without a read, error, or cancellation callback, no finalizer event occurs. The request abort signal may eventually abort the upstream, but there is no independent permit lease/deadline. |
| SSE `[DONE]` / keepalive | `[DONE]` is only parser state (`validateQuality.ts:355-363`; `streamHandler.ts:683-697`), not source EOF. A client stopping at `[DONE]` reproduces the leak. A keepalive/open connection legitimately retains occupancy until completion, but a client that disappears behind an unpropagated tee cancellation becomes stale. |
| Exception before body wrapper | Most post-acquire executor errors release in `chatCore.ts:3510-3513`. There is a small gap after acquisition and before that `try`: `trace("post_semaphore")` and `updatePendingScope` execute at `chatCore.ts:3079-3084`; an exception there would skip release. Move the acquire and these operations under one `try/finally` ownership scope. |
| Antigravity BYOP rotation | **Definite separate skip.** After acquisition, the successful sibling-credential rotation executes `continue` at `chatCore.ts:3297-3341` without first calling `releaseAccountSemaphore()`. Add release immediately before this `continue` (or use attempt-scoped `finally`). |
| ModelScope/Codex retry/fallback | Explicit releases exist at `chatCore.ts:3177-3193,3247-3259,3289-3294`. |
| Combo quality rejection | `releaseRejectedQualityResponse()` attempts to cancel clone and original at `validateQuality.ts:797-810`; the clone-reader forwarding defect still matters, but canceling the original plus a correctly forwarded clone cancel would release. |
| Combo non-OK fallback | Error parsing clones and drains the clone (`combo.ts:1958-2001,3612-3636`). Finite error bodies normally reach EOF and release; an open/malformed streaming error body can delay fallback or leave the original branch abandoned. Explicitly cancel discarded responses when moving to another target. |
| Stream recovery | Its finalizer is idempotent and called on its own EOF/error/cancel (`streamRecovery.ts:582-697`). It remains vulnerable if a later tee prevents cancellation from reaching it. |
| Candidate capacity rejection | `maxQueueSize: 0` rejects before incrementing `running` at `accountSemaphore.ts:203-218`, so that rejection does not itself need release. It cannot repair permits already leaked. |

### 7. Candidate account-capacity sentinel gap

The candidate forwards queue options to acquisition at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/handlers/chatCore.ts:3066-3077`. However, `chatCore` catches `SEMAPHORE_QUEUE_FULL`/timeout and returns a 429 streaming error result with `errorType: "account_semaphore_capacity"` at `chatCore.ts:3726-3753`. For a forced combo connection, `handleSingleModelChat` returns that result at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/sse/handlers/chat.ts:2110-2115`.

The candidate's new `x-omniroute-account-capacity: queue-full` response is only created in an outer exception catch at `chat.ts:1874-1893`. The normal `chatCore` capacity path does not throw through that catch. Round-robin checks for the header at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/combo.ts:3430-3437`, so the marker-based fast cascade is not proven end-to-end. Fix either by preserving a typed capacity result/header through `chatCore` or by having combo orchestration recognize the trusted structured capacity error; add a real chatCore-to-combo integration test rather than a mocked `Response`.

### 8. Monitoring authority and disagreement

`/api/admin/concurrency` returns both independent structures, including `semaphores: getSemaphoreStats()`, at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/app/api/admin/concurrency/route.ts:1-18`. `getSemaphoreStats()` directly iterates the module-level account `gates` map and reports `running`, `queued`, and `maxConcurrency` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/accountSemaphore.ts:20-45,328-345`. This is the authoritative state consulted by the shared account gate in that process.

`/api/rate-limits` instead calls `rateLimitManager.getRateLimitStatus()` and `getAllRateLimitStatus()` at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/src/app/api/rate-limits/route.ts:31-60`. Those functions read Bottleneck `counts()` from a separate `limiters` map at `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z/open-sse/services/rateLimitManager.ts:77-101,790-830`. Therefore the reported disagreement is expected and is strong evidence that execution returned while account-body ownership remained stale.

A later loopback GET from inside the pod returned 401 for both management endpoints; no authentication material was accessed or exposed. The investigation relied on the supplied authenticated snapshots plus source and logs.

## Conclusions and recommendations

1. **Patch replay cancellation, not the capacity limit.** Add `cancel(reason) { return readerToForward.cancel(reason); }` (with safe error handling) to the `ReadableStream` created in `validateResponseQuality.buildReplayResponse`. Keep `releaseQualityClone` best-effort, but test that underlying source cancellation actually occurs.
2. **Use attempt-scoped release ownership.** In `handleChatCore`, declare the release callback before acquisition and put every post-acquire action under one `try/finally`, transferring ownership only when a streaming wrapper or non-stream result explicitly takes it. This removes the post-acquire/pre-`try` gap and makes retries auditable.
3. **Fix BYOP rotation.** Release before the Antigravity sibling-rotation `continue`; add a focused regression test that two rotations leave account stats at zero.
4. **Fix and test the candidate capacity sentinel end-to-end.** Exercise real `handleSingleModelChat`/`handleChatCore` capacity rejection and assert the round-robin combo immediately advances without retrying the same saturated account and without incrementing attempts incorrectly.
5. **Add exact lifecycle tests:**
   - successful streaming direct request, full EOF => semaphore `running=0`;
   - successful streaming combo request, full EOF after content and `[DONE]` => `running=0`;
   - combo request where client reads through `[DONE]` then cancels while upstream remains open => cancellation settles and `running=0`;
   - request abort signal before first content and after first content => `running=0`;
   - quality-rejected stream followed by combo fallback => first target `running=0` before second dispatch;
   - clone/replay cancellation reaches the original source cancel hook;
   - Antigravity BYOP rotation => old account releases before retry;
   - account-capacity rejection => no semaphore increment and real combo advances to next lane.
6. **Add observability after the fix.** Emit a sanitized account-semaphore acquire/release reason and request correlation ID, and consider a bounded stale-permit diagnostic watchdog. Do not silently auto-decrement an allegedly stale gate without proving the owning body is dead; that could oversubscribe real long generations.
7. **Do not run canaries against stale occupancy and do not weaken the gate.** Such canaries either block/fail or skip the intended first lanes, so they cannot certify routing order or concurrency. Bypassing/resetting the gate while leaked upstream work may still exist risks GPU oversubscription and duplicate concurrent dispatch. Use a clean process only after the fix is reviewed, then run completion and abort canaries while checking `/api/admin/concurrency.semaphores` returns to zero after each request.
8. **Build and review a new image.** The capacity-cascade source worktree may be amended, but runtime semantics will differ from the approved `sha256:fb059a4...` candidate. Produce a new digest, review the lifecycle and sentinel changes, verify the focused tests, then perform clean-state canaries before rollout.

## Investigation hygiene

No live API, deployment, provider, combo, durable source, server, or semaphore state was mutated. No commit or push was performed. The isolated reproduction ran in a separate Node process and called `resetAll()` only inside that process before exit. Focused tests wrote only their normal temporary data under `/tmp`. Git status after investigation matched the pre-existing candidate modifications and the clean baseline status.
