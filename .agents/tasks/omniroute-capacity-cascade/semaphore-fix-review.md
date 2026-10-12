# Account-semaphore lifecycle repair with trusted capacity cascade

The candidate repairs the quality-tee cancellation leak, establishes attempt-scoped account-permit ownership, releases Antigravity sibling rotations, cancels discarded fallback responses, and carries internal queue-full classification through the production combo path. The prior provenance blocker is closed by stripping the reserved capacity header from every ordinary executor response and adding it only for internally classified semaphore failures. Focused evidence covers the lifecycle matrix through real `handleChatCore` and exported `handleChat` boundaries while preserving direct and unflagged behavior. Watch for: **confirmed** production remains on the rollback digest; this approval covers the new immutable candidate, not deployment or canary execution.

**Verdict**: APPROVED

## High-level view

Replay cancellation now reaches the locked quality reader through one shared promise. Canceling both tee branches reaches the original semaphore-finalized source once; EOF and repeated complete/cancel cycles return occupancy to baseline.

`chatCore` owns a permit from acquisition until one-shot transfer to a streaming finalizer or non-stream consumer. Attempt cleanup covers post-acquire tracing, pending-scope updates, dispatch, rotation, and wrapper-construction failures.

Quality-rejected streams and ordinary failures are canceled only when discarded for retry or fallback. Antigravity BYOP rotation cancels its 422 response and releases the old account before sibling dispatch.

Flagged round-robin lanes pass zero-depth controls into the real account semaphore. Internal queue-full skips avoid a waiter, retry, target metric, cooldown, attempt inflation, and HTTP 500, then continue through the next member and execute-mode priority parent; timeout and unflagged/direct paths retain prior handling.

The reserved capacity header is removed before provider-specific and streaming returns. A production spoofing regression proves an upstream success carrying the header cannot force fallback.

Evidence records 230/230 focused tests, passing lint, `typecheck:core`, and production build, with only the documented unrelated open-SSE baseline diagnostic. New digest `sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525` carries the final revision/tree/diff labels and passed `/healthz`.

<details>
<summary>Issues (0)</summary>

No actionable review findings.

</details>

<details>
<summary>Details</summary>

## Replay cancellation closes the quality-tee leak

`validateResponseQuality` backs replay `cancel(reason)` with one cached promise, awaits `readerToForward.cancel(reason)`, and settles the reader once across pull/cancel races. `releaseRejectedQualityResponse` awaits both quality and original branches, preventing fallback while the rejected source still owns its account permit.

Regressions use the real account semaphore and stream finalizer for direct EOF, combo EOF after content and `[DONE]`, cancellation after `[DONE]` with an open source, cancellation before and after first content, one original-source cancellation, and forty alternating completion/cancellation cycles. A real `handleChatCore` abort test supplies the transport signal, cancels the returned reader as the HTTP layer does, and observes one source cancellation, one release log, and zero occupancy before and after useful content.

## Attempt ownership covers every post-acquire exit

Ownership becomes active only after acquisition succeeds. Acquisition, `trace("post_semaphore")`, and the pending-scope update are inside the attempt `try/finally`; retries and rotations release current ownership, streaming and non-stream paths transfer one-shot owners, wrapper-construction failures finalize transferred ownership, and `attempt_finally` releases anything untransferred.

The non-stream consumer releases after its body read and on read failure. Streaming ownership stays with the finalized source until EOF, error, or cancellation. One-shot transfer plus the semaphore’s idempotent callback prevents double decrement without depending on cleanup races.

## Antigravity and discarded responses release before redispatch

The Antigravity BYOP sibling path cancels the discarded 422 body and releases with `antigravity_byop_rotation` before `continue`. Its regression observes the old account at `running=1` during the first request and `running=0` before sibling dispatch.

Both combo quality paths await rejected-response disposal. Generic failures are canceled at same-model retry or next-target transfer points after quota and error classification, leaving terminal or parent-inspected bodies readable. The shared-account regression observes zero occupancy before fallback and one rejected-source cancellation.

## Trusted queue-full classification reaches member and parent cascade

With `failFastOnAccountCapacity`, round-robin passes resolved queue depth and timeout through `SingleModelTarget`, `handleSingleModelChat`, and `clientRawRequest` to `handleChatCore`. `SEMAPHORE_QUEUE_FULL` becomes typed `account_semaphore_capacity` plus the internal `queue-full` marker. Round-robin consumes it before failure accounting, reverses the speculative attempt count, and advances without retry or cooldown; acquisition creates neither a permit nor waiter.

The production integration stores a flagged round-robin leaf below an execute-mode priority parent and enters exported `handleChat`. A real occupied OpenAI account reaches actual `chatCore` acquisition, causes no OpenAI fetch, waiter, target metric, or cooldown, then Claude is attempted once and Gemini succeeds through the parent tier. Direct/unflagged coverage proves queue options remain absent by default, direct occupancy still queues normally, and unflagged combo exception behavior is unchanged.

The all-combo-ref priority-parent pre-skip was approved in the preceding candidate review. It remains restricted to pre-dispatch capacity checks on priority roots made entirely of combo references; dispatched non-capacity failures and mixed/direct roots keep existing protected semantics.

## Reserved capacity provenance is fail-closed

Immediately after executor normalization, `chatCore` rebuilds an ordinary upstream response without `x-omniroute-account-capacity`. This precedes Codex/Antigravity branches, no-body streaming returns, stream wrappers, and non-stream construction. Only the internal semaphore-capacity catch adds the marker, and only opt-in queue controls expose it to combo orchestration.

The spoofing regression enters exported `handleChat` with a stored flagged combo and an OpenAI success carrying forged `queue-full`. It proves that response is returned without the reserved header, no fallback dispatch occurs, and metrics remain on the legitimate target.

## Verification, scope, and immutable artifact

The A–J matrix covers replay-to-source cancellation; direct EOF; combo EOF; cancel-after-`[DONE]`; abort before content; abort after content; repeated idempotency cycles; quality-rejection release before fallback; Antigravity release before rotation; and real account-capacity member/parent cascade. Mechanical cases use real semaphore/finalizer objects; production-sensitive boundaries enter real `handleChatCore` or exported `handleChat` rather than mocking the combo result.

The final evidence records 230/230 focused tests, lint exit 0 without suppression growth, `typecheck:core` exit 0, and build exit 0. `check:open-sse-typecheck` reports only the documented unrelated `src/app/api/v1/models/catalog.ts` TS2367 frozen-baseline category; no authorized file emits a diagnostic. No verification command was rerun during review.

Remote status matches the 18-path allowlist with no changelog or changeset. Identity is revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658`, tree `49b1623b10e6a622e9432d09f3a2c0a318f91352`, and diff SHA-256 `907e4d09e1fa2579218e40a1a60fbea8aa1fc10889ad84a48ba6f94acaa5e724`. Digest `sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525` differs from prohibited `sha256:388fa7e…` and `sha256:fb059a4…`, carries those labels, and returned `/healthz` HTTP 200 `ok`.

Semaphore logs sanitize request tokens, truncate connection identifiers, and contain no credential material. No watchdog, reset, bypass, or automatic decrement was added; observability cannot release or widen a gate.

</details>

<details>
<summary>File map</summary>

- `open-sse/handlers/chatCore.ts` — owns permits per attempt, sanitizes reserved headers, and emits typed opt-in capacity results.
- `open-sse/services/combo.ts` — disposes discarded responses and fast-skips trusted queue-full results.
- `open-sse/services/combo/runtimeUnits.ts` — continues approved priority-parent pre-skips across local child tiers.
- `open-sse/services/combo/types.ts` — types per-target account queue controls.
- `open-sse/services/combo/validateQuality.ts` — forwards replay cancellation and awaits rejection disposal.
- `src/app/api/combos/[id]/route.ts` — preserves persisted zero queue depth.
- `src/shared/validation/schemas/combo.ts` — validates lane capacity and affinity flags.
- `src/sse/handlers/chat.ts` — bridges queue controls through production single-model dispatch.
- `tests/integration/chat-pipeline.test.ts` — covers genuine member/parent cascade and forged-header rejection.
- `tests/unit/accountSemaphore.test.ts` — covers zero-depth rejection without a waiter.
- `tests/unit/antigravity-byop-account-rotation.test.ts` — covers release before sibling dispatch.
- `tests/unit/chatcore-translation-paths.test.ts` — covers defaults, typed capacity, and real chatCore abort lifecycle.
- `tests/unit/combo-capacity-cascade-persistence.test.ts` — covers persistence of zero and lane flags.
- `tests/unit/combo-config.test.ts` — covers capacity/affinity schema preservation.
- `tests/unit/combo-runtime-unit-concurrency.test.ts` — covers parent pre-skip continuation and exhaustion.
- `tests/unit/combo-semaphore-lifecycle.test.ts` — covers EOF, cancellation forwarding, and repeated baseline return.
- `tests/unit/combo-shared-account-race.test.ts` — covers shared races and rejected-stream disposal.
- `tests/unit/combo-strategy-fallbacks.test.ts` — covers immediate skips, unchanged defaults, and affinity opt-out.

Full diff: `ssh celes@192.168.42.254 'git -C /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z diff HEAD'`; the three untracked tests are included in the recorded candidate tree and remote status.

</details>
