# OmniRoute Semaphore Lifecycle and Capacity Sentinel Fix

## Outcome

Implemented and verified the semaphore lifecycle, streaming cancellation, Antigravity BYOP rotation, discarded-response disposal, and real account-capacity sentinel fixes in the isolated remote worktree:

`/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`

The worktree remains at approved revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658`. No commit or push was created. No deployment, management API write, durable policy mutation, or production canary occurred. Read-only deployment verification showed production remains on rollback image:

`registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`

Final immutable candidate after the capacity-sentinel provenance review fix:

- Tag: `registry.celestium.life/library/omniroute:capacity-cascade-semaphore-sentinel-final-20261011T023611Z`
- Digest: `registry.celestium.life/library/omniroute@sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525`
- OCI revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `49b1623b10e6a622e9432d09f3a2c0a318f91352`
- Binary diff SHA-256: `907e4d09e1fa2579218e40a1a60fbea8aa1fc10889ad84a48ba6f94acaa5e724`
- Ephemeral `/healthz`: HTTP 200, body `ok`

The earlier provenance-fix image `sha256:28200276a8c11b1e9c3f7ae23015224b78d038331deb423e188dad2ffbcf9eac`, prior review candidate `sha256:8500cd122c5ed30b8a8d7767235ea8d2906f56c69789fc5494d150db48977548`, and earlier `sha256:bbc45c0...` image are superseded. The prohibited `sha256:388fa7e...` and `sha256:fb059a4...` images were not reused.

The previous prohibited candidate digests `sha256:388fa7e...` and `sha256:fb059a4...` were not reused. An intermediate newly built digest `sha256:1a74922ede255a2f1df2249a99f031b3635a27cc2acfee6b1d1f30c46d545542` was superseded after final allowlist review found and removed one formatting-only test diff. It is not the candidate for review or release.

## Implemented fixes

### Replay-stream cancellation forwarding

`open-sse/services/combo/validateQuality.ts` now gives the replay `ReadableStream` an idempotent `cancel(reason)` implementation. It awaits `readerToForward.cancel(reason)`, safely releases the locked reader, tolerates races with an in-flight pull, and settles cancellation exactly once. This allows cancellation of the quality tee branch to reach the original semaphore-finalized source when the client-facing tee branch is also canceled.

`releaseRejectedQualityResponse` is now async and awaits disposal of the original and clone branches. Both combo callers await it, so a quality-rejected target releases its permit before the next target dispatch.

### Audited account-permit ownership

`open-sse/handlers/chatCore.ts` now establishes attempt-scoped permit ownership before acquisition. Every post-acquire operation, including `trace("post_semaphore")` and `updatePendingScope`, is inside a `try/finally`. Ownership is explicitly released or transferred:

- retry/rotation paths release attempt ownership;
- streaming wrappers receive a one-shot transferred finalizer;
- wrapper-construction failures invoke the transferred finalizer;
- non-stream consumers receive a one-shot transferred callback;
- attempt `finally` releases any ownership not explicitly transferred.

The pre-existing idempotent semaphore callback remains the final safeguard, but ownership is now explicit and auditable rather than relying on double-release tolerance.

### Antigravity BYOP rotation

The successful sibling-credential rotation path now cancels the discarded 422 response and releases the old account permit before `continue`. The integration regression proves the old permit is running during the first account request and is zero before the sibling account dispatch.

### Discarded combo responses

Quality-rejected streams are fully disposed before fallback. Generic non-success responses are canceled only at actual retry/fallback transfer points, after all quota/error classification has completed. Terminal responses that must be returned or inspected by a nested parent remain readable. This placement was corrected after an initial focused-suite run exposed premature cancellation during nested quota aggregation.

### Trusted capacity sentinel

For opt-in account queue controls only, the normal `chatCore` capacity result adds:

- `x-omniroute-account-capacity: queue-full` for internally caught `SEMAPHORE_QUEUE_FULL`;
- `x-omniroute-account-capacity: timeout` defensively for internally caught `SEMAPHORE_TIMEOUT`.

Ordinary provider responses can no longer supply this sentinel: `chatCore` deletes the reserved header from both streaming and non-streaming upstream response headers before returning them to combo orchestration. The header is added only after an internally classified account-semaphore exception. The existing typed `errorType: account_semaphore_capacity` and `errorCode` are retained. Round-robin fast-skips only flagged internal `queue-full`; timeout retains normal timeout semantics. Direct and unflagged calls retain the prior default queued behavior and receive no capacity header.

### Sanitized observability

Account acquisition/release logs now include a sanitized request correlation token, provider, truncated connection identifier, and a reason (`provider_dispatch`, `stream_finalize`, `nonstream_consumer`, `antigravity_byop_rotation`, or `attempt_finally`). No API key, token, credential material, or full connection secret is logged. No watchdog resets or decrements gates automatically.

## Regression coverage

Added or extended focused tests proving:

- replay-clone cancellation reaches the locked reader and original source exactly once;
- cancellation promises settle and account `running` returns to zero;
- direct streaming full EOF returns to zero;
- combo full EOF after content plus `[DONE]` returns to zero;
- client reads through `[DONE]`, cancels while upstream remains open, cancellation settles, and `running` returns to zero;
- cancellation before first content and after first content returns to zero;
- 40 deterministic alternating complete/cancel cycles return to baseline every iteration;
- quality-rejected open stream releases before fallback dispatch;
- Antigravity BYOP old-account permit is held during its request and zero before sibling dispatch;
- real `chatCore` queue-full result reaches combo orchestration, advances immediately once, creates no waiter, and does not return HTTP 500;
- direct/unflagged account queue behavior remains queued/default;
- prior config, persistence, semaphore, fallback, shared-race, translation, and parent runtime-unit regressions remain green.

## Exact authorized allowlist and identity

A temporary `GIT_INDEX_FILE` was loaded from HEAD, exactly the files below were added, `git write-tree` produced the candidate tree, and `git diff --cached --binary --full-index HEAD` was SHA-256 hashed. Final status matched this allowlist exactly (18 files):

```text
open-sse/handlers/chatCore.ts
open-sse/services/combo.ts
open-sse/services/combo/runtimeUnits.ts
open-sse/services/combo/types.ts
open-sse/services/combo/validateQuality.ts
src/app/api/combos/[id]/route.ts
src/shared/validation/schemas/combo.ts
src/sse/handlers/chat.ts
tests/integration/chat-pipeline.test.ts
tests/unit/accountSemaphore.test.ts
tests/unit/antigravity-byop-account-rotation.test.ts
tests/unit/chatcore-translation-paths.test.ts
tests/unit/combo-capacity-cascade-persistence.test.ts
tests/unit/combo-config.test.ts
tests/unit/combo-runtime-unit-concurrency.test.ts
tests/unit/combo-semaphore-lifecycle.test.ts
tests/unit/combo-shared-account-race.test.ts
tests/unit/combo-strategy-fallbacks.test.ts
```

Identity result:

```text
REVISION=ad45d990c9f17e857f0bd03aacd1ff29b1825658
TREE=a60fadd486f26e7d456159ccd5087ca886ffd8c6
DIFF_SHA256=80367336ced2f6b029fb5c6053fa0e5bcdeddd02024e2e6dbf9c8bfafd750a87
ALLOWLIST_COUNT=18
```

`git diff --check` passed. No `CHANGELOG.md` or `.changeset` path changed. The final status contains only the 17 allowlisted prior-candidate, lifecycle-fix, and focused-test files.

## Commands and results

All source, test, build, image, and smoke commands ran over SSH on `celes@192.168.42.254` in the isolated candidate worktree unless explicitly described as a local artifact operation.

### Review iteration and source inspection

- Checked local `semaphore-fix-review.json` before each resumed iteration: it did not exist, so this was the first implementation iteration.
- Read all authoritative local evidence: `semaphore-leak-investigation.md`, `parent-skip-impl.md`, `parent-skip-review.json`, `final-release.md`, `requirements.md`, and `design.md`.
- `git rev-parse HEAD`: PASS, exact approved revision.
- `git status --short` / `git diff --name-only`: PASS, initial dirty state matched the previously reviewed candidate.
- Remote Python source reads inspected `validateQuality.ts`, `chatCore.ts`, `combo.ts`, `accountSemaphore.ts`, `streamFinalize.ts`, and the existing focused test harnesses before edits.
- Local guaranteed-free `local_model_chat` was not available in the provided tool set; implementation proceeded directly under the documented fallback rule.

### Formatting and targeted validation

- `npx prettier --write` was run only for touched implementation/test files during editing: PASS.
- Initial changed-test command covering lifecycle, quality, shared race, Antigravity, and chatCore translation: PASS, 101 tests, 101 passed.
- First complete focused-suite attempt: 199 tests, 198 passed, 1 failed. Failure was `nested child aggregate allows protected parent fallback when every failure is quota`; premature response disposal made quota classification lose its readable body.
- Corrective edit moved cancellation from before classification to actual retry/fallback transfer points.
- Targeted rerun for nested quota aggregation and quality-rejected fallback: PASS, 2 tests, 2 passed.
- Final complete focused suite:

```text
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 \
  --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit --test-concurrency=1 \
  tests/unit/combo-config.test.ts \
  tests/unit/accountSemaphore.test.ts \
  tests/unit/rateLimitSemaphore.test.ts \
  tests/unit/combo-strategy-fallbacks.test.ts \
  tests/unit/combo-shared-account-race.test.ts \
  tests/unit/combo-capacity-cascade-persistence.test.ts \
  tests/unit/chatcore-translation-paths.test.ts \
  tests/unit/combo-runtime-unit-concurrency.test.ts \
  tests/unit/validate-response-quality.test.ts \
  tests/unit/combo-semaphore-lifecycle.test.ts \
  tests/unit/antigravity-byop-account-rotation.test.ts
```

Result: PASS — 199 tests, 199 passed, 0 failed, 0 cancelled, 0 skipped; 2 suites passed.

After this pass, one formatting-only diff in `tests/unit/validate-response-quality.test.ts` was restored byte-for-byte from HEAD. It changed no test behavior or application source and was removed from the final allowlist before the final image build.

### Static and build gates

- `npm run lint -- --no-cache`: PASS, exit 0.
- `npm run typecheck:core`: PASS, exit 0.
- `npm run check:open-sse-typecheck`: known unrelated baseline/environment failure, exit 1. It reported 7 scoped errors and one frozen-baseline category regression: `src/app/api/v1/models/catalog.ts TS2367 (baseline 0, live 2)`. No authorized file produced a diagnostic and the baseline was not widened. This is the same documented TypeScript 6.0.3 baseline category from the previous candidate.
- `npm run build`: PASS, exit 0. Next.js production build and standalone assembly completed.
- `git diff --check`: PASS before identity calculation and again after final image publication.

### First implementation image publication (superseded)

The following records the first implementation iteration. Its final digest `sha256:bbc45c0...` passed that iteration's checks but is superseded by the review-fix digest recorded below; it is not the current candidate.

The first new image invocation completed successfully with tree `3b45c4d927c3ee75e8679b5e7ea1b38648cdbc2f`, diff `46301387dbb313477c6abde47f993830084fd6e6f09b99a4d929d242cad2a766`, tag `capacity-cascade-semaphore-fix-20261011T014150Z`, and digest `sha256:1a74922ede255a2f1df2249a99f031b3635a27cc2acfee6b1d1f30c46d545542`. Its health smoke returned HTTP 200. Final allowlist review then found a formatting-only existing-test diff; that image was superseded and is not the release candidate.

The first-iteration reviewed image command was:

```text
docker buildx build --platform linux/amd64 --target runner-base \
  --build-arg OMNIROUTE_USE_TURBOPACK=0 \
  --label org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658 \
  --label life.celestium.omniroute.candidate-tree=1810916495eedcc75587d96c57b7e29270eed4cb \
  --label life.celestium.omniroute.diff-sha256=32a6b6e91ed531528d8847b6ac5f3d50c8a700db059156a5db90613e2b9735e9 \
  --tag registry.celestium.life/library/omniroute:capacity-cascade-semaphore-fix-20261011T014715Z \
  --push .
```

Result: PASS, exit 0. The checked-in `OMNIROUTE_USE_TURBOPACK=0` container escape hatch was retained, consistent with the prior documented container-only Turbopack issue.

`docker buildx imagetools inspect` resolved that first-iteration tag to:

`sha256:bbc45c0b5686c78ccc4a79db23fb4334ff2cd7ebb3069f46f68cc5aae3c0b962`

Exact published labels were independently read back:

```text
org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658
life.celestium.omniroute.candidate-tree=1810916495eedcc75587d96c57b7e29270eed4cb
life.celestium.omniroute.diff-sha256=32a6b6e91ed531528d8847b6ac5f3d50c8a700db059156a5db90613e2b9735e9
```

### Ephemeral health smoke

Because the command guard rejected a single long-lived `docker run` invocation, the smoke was performed with bounded `docker create`, `docker start`, polling, and removal commands:

- Created final container from immutable digest `sha256:bbc45c0...`.
- Started it on ephemeral loopback port `32771`.
- Polled `http://127.0.0.1:32771/healthz`.
- Result: HTTP 200, body `ok`.
- Captured logs and removed the container; final container-name lookup was empty.

### Operational retries and non-mutating failures

- Several long inline SSH/Python edit commands were interrupted by the agent transport with exit `-1` before mutation; follow-up content checks confirmed those attempts had not changed their target files. The edits were retried via explicit temporary scripts copied to remote `/tmp`.
- One combined allowlist shell assertion exited 1 because of shell quoting around the `[id]` path. A Python temporary-index implementation replaced it and passed.
- The first compact label template used `.Image.config.Labels` and failed because the Go template field is `.Image.Config.Labels`; the corrected command passed and returned exact labels.
- The command guard rejected a monolithic long-lived `docker run` smoke command. No container was started by the rejected attempts. The bounded create/start/poll/remove sequence passed.
- No failed operation mutated production or reused a prior candidate digest.

## Review-fix iteration: production bridge and request-signal proof

`semaphore-fix-review.json` existed at the start of this iteration and reported `CHANGES_REQUESTED`. Both findings were fixed without changing runtime behavior or broadening application source:

1. `tests/integration/chat-pipeline.test.ts` now stores a flagged round-robin leaf and an execute-mode priority parent, then calls exported production `handleChat`. A real saturated OpenAI account returns the trusted queue-full result through `handleSingleModelChat`; no OpenAI fetch occurs, the next Claude member is attempted once, its ordinary 503 advances the parent, and the Gemini overflow child succeeds. Assertions prove HTTP 200 rather than 500, `queued=0`, no saturated-target metric/attempt inflation, no saturated-account cooldown, no same-account upstream retry, and both member and parent continuation.
2. `tests/unit/chatcore-translation-paths.test.ts` now passes an `AbortController.signal` in `clientRawRequest` to real `handleChatCore`. Before-content uses a role-only SSE frame; after-content consumes a content frame. Both abort the request signal, cancel the client reader as the HTTP transport does, await settlement, prove the upstream source is canceled once, prove one `ACCOUNT_SEMAPHORE` release log, and prove `running=0`.

The prior lower-level manually composed queue-full test and synthetic downstream reader-cancellation test remain, so these additions cover the missing production boundaries rather than replacing lower-layer coverage.

### Review iteration commands and results

All remote commands used `celes@192.168.42.254` and `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`. Local evidence/scripts were read or written only under `.agents/tasks/omniroute-capacity-cascade`.

- Checked and read `semaphore-fix-review.json` and `semaphore-fix-review.md`, then reread the implementation record and all authoritative investigation/design/release documents: PASS; two findings identified.
- `git -C ... rev-parse HEAD`, `status --short`, and `diff --name-only`: PASS; revision exactly `ad45d990c9f17e857f0bd03aacd1ff29b1825658`, prior 17-file candidate dirty state intact.
- Targeted source/test reads of the production callback, `handleSingleModelChat`, `chatCore`, streaming controller, combo metrics, persistence fixtures, and existing abort patterns: PASS.
- Applied the two regression tests and ran `npx prettier --write` on the two touched tests plus `git diff --check`: PASS.
- First production bridge targeted run: expected harness failure, 1 test/0 pass. The mock keyed on `Authorization` casing and returned the Gemini body for Claude. It nevertheless logged the real queue-full production bridge and parent continuation. The mock was corrected to classify provider URLs.
- First request-abort targeted run: harness failure after 80.5s. It awaited `handleChatCore` before issuing the pre-content abort, allowing stream readiness timeout to win. The abort was moved before awaiting the invocation.
- Production bridge rerun: PASS, 1/1. Logs showed real `handleChat` → stored parent → stored leaf → `handleSingleModelChat` → `chatCore`; OpenAI queue-full skipped with no fetch, Claude attempted once, then Gemini parent overflow succeeded.
- Second request-abort targeted run: harness failure after 80.5s. The synthetic fetch body did not reproduce native fetch's post-header body abort and an assertion targeted the mock fetch signal. The test was changed to the repository's established transport model: request-signal abort followed by response-reader cancellation, with role-only versus content-bearing frames.
- Final request-abort targeted run: PASS, 1/1 in 0.524s. Both `abort-before-content` and `abort-after-content` logged immediate disconnect, canceled the source once, released once, and returned account occupancy to zero.
- Complete focused suite command:

```text
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 \
  --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit --test-concurrency=1 \
  tests/unit/combo-config.test.ts \
  tests/unit/accountSemaphore.test.ts \
  tests/unit/rateLimitSemaphore.test.ts \
  tests/unit/combo-strategy-fallbacks.test.ts \
  tests/unit/combo-shared-account-race.test.ts \
  tests/unit/combo-capacity-cascade-persistence.test.ts \
  tests/unit/chatcore-translation-paths.test.ts \
  tests/unit/combo-runtime-unit-concurrency.test.ts \
  tests/unit/validate-response-quality.test.ts \
  tests/unit/combo-semaphore-lifecycle.test.ts \
  tests/unit/antigravity-byop-account-rotation.test.ts \
  tests/integration/chat-pipeline.test.ts
```

Result: PASS — 229 tests, 229 passed, 0 failed, 0 cancelled, 0 skipped; 2 suites passed, duration 63.2s.

- First `npm run lint -- --no-cache`: failed with 53 displayed `no-explicit-any` diagnostics because each legacy file added one new `as any`, causing its count-based suppression to stop matching and reveal existing suppressed instances. No suppression file was changed. The two new casts were replaced with a precise response type and a typed direct call.
- One combined remote edit/format/lint command was interrupted with exit `-1` before mutation; follow-up process/content inspection confirmed no edit or lint process remained. The same two-line correction was applied via a copied temporary script.
- Final `npm run lint -- --no-cache`: PASS, exit 0. Suppression counts did not increase; `config/quality/eslint-suppressions.json` is unchanged.
- `npm run typecheck:core`: PASS before and after the final typed lint correction, exit 0 both times.
- `npm run check:open-sse-typecheck`: known unrelated baseline/environment failure, exit 1. It reported `openSseTypecheckErrors=7` and the same frozen-baseline regression `src/app/api/v1/models/catalog.ts TS2367 (baseline 0, live 2)`. No authorized file produced a diagnostic and the baseline was not widened.
- `npm run build`: PASS, exit 0. Next.js 16.3.1 production build and standalone colocation completed. The isolated builder reported its normal EXDEV copy/remove fallback for stale standalone output.
- `git diff --check`: PASS before identity, before image publication, and after smoke cleanup.
- One status/hygiene shell command printed the correct 18-file status but its decorative `printf "--FILES--"` was parsed as an option. The command's final `|| true` yielded exit 0; the later Python allowlist assertion independently proved exact status and no CHANGELOG/changeset path.

### Final identity and allowlist proof

A temporary-index Python command asserted that porcelain status exactly equaled the 18 paths listed above, rejected any CHANGELOG/changeset path, loaded HEAD into a temporary `GIT_INDEX_FILE`, added exactly the allowlist, ran `git write-tree`, and SHA-256 hashed `git diff --cached --binary --full-index HEAD`. Result:

```text
REVISION=ad45d990c9f17e857f0bd03aacd1ff29b1825658
TREE=a60fadd486f26e7d456159ccd5087ca886ffd8c6
DIFF_SHA256=80367336ced2f6b029fb5c6053fa0e5bcdeddd02024e2e6dbf9c8bfafd750a87
ALLOWLIST_COUNT=18
```

No real index mutation, commit, or push occurred.

### New immutable image, labels, and smoke

Successful publication command:

```text
docker buildx build --platform linux/amd64 --target runner-base \
  --build-arg OMNIROUTE_USE_TURBOPACK=0 \
  --label org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658 \
  --label life.celestium.omniroute.candidate-tree=a60fadd486f26e7d456159ccd5087ca886ffd8c6 \
  --label life.celestium.omniroute.diff-sha256=80367336ced2f6b029fb5c6053fa0e5bcdeddd02024e2e6dbf9c8bfafd750a87 \
  --tag registry.celestium.life/library/omniroute:capacity-cascade-semaphore-review-fix-20261011T021023Z \
  --push .
```

Result: PASS, exit 0. `docker buildx imagetools inspect` resolved the tag to the new immutable digest:

`registry.celestium.life/library/omniroute@sha256:8500cd122c5ed30b8a8d7767235ea8d2906f56c69789fc5494d150db48977548`

Published config labels were read back exactly:

```text
org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658
life.celestium.omniroute.candidate-tree=a60fadd486f26e7d456159ccd5087ca886ffd8c6
life.celestium.omniroute.diff-sha256=80367336ced2f6b029fb5c6053fa0e5bcdeddd02024e2e6dbf9c8bfafd750a87
```

The image was created as isolated container `omniroute-semaphore-review-smoke`, started on loopback port `32772`, and polled at `/healthz`. Result: HTTP 200, body `ok`. The container and temporary remote tag file were removed; final container lookup was empty. Production was not deployed or mutated.

## Capacity-sentinel provenance review remediation

`semaphore-fix-review.json` existed at the start of this iteration with verdict `CHANGES_REQUESTED` and one finding: an ordinary provider could forge `x-omniroute-account-capacity: queue-full`. The review document and all authoritative investigation, parent-skip, release, requirements, design, and prior implementation evidence were reread before editing.

### Narrow fix

`open-sse/handlers/chatCore.ts` now strips the reserved capacity header immediately after normalizing every executor response, before any provider-specific rotation, no-body streaming return, or ordinary response path can reach combo orchestration. Streaming and non-streaming client response construction retain defensive deletion as well. The account-semaphore exception catch remains the only place that adds `queue-full` or defensive `timeout` classifications.

`tests/integration/chat-pipeline.test.ts` adds a production-boundary spoofing regression. It stores a flagged two-member round-robin combo, enters through exported `handleChat`, returns an ordinary successful OpenAI response carrying the forged header, and proves the legitimate first response is returned. It also proves the header is absent downstream, Claude is not dispatched, OpenAI receives normal request metrics, and the fallback target receives none. The existing genuine queue-full parent-cascade regression was rerun alongside it.

### Commands and results for this iteration

All source, formatting, test, build, identity, image, smoke, and final readback commands ran over SSH on `celes@192.168.42.254`; all git operations used `git -C /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`. Local evidence and temporary edit/identity scripts were written only under `.agents/tasks/omniroute-capacity-cascade`.

- Initial `git ... rev-parse HEAD`, `status --short`, and `diff --check`: PASS. HEAD was exactly `ad45d990c9f17e857f0bd03aacd1ff29b1825658`; status was the prior reviewed 18-file candidate.
- Read-only Python source inspections covered the `chatCore` streaming/non-stream header paths, internal capacity catch, combo header classification, existing capacity regressions, integration helpers, and test isolation setup: PASS; no mutation.
- Applied `/tmp/apply-semaphore-review-fix.py`, removed it, and ran `npx prettier --write open-sse/handlers/chatCore.ts tests/integration/chat-pipeline.test.ts`: PASS. Prettier changed only the intended source formatting; the test was already formatted.
- `git diff --check`: PASS after editing.
- First targeted integration command with `--test-name-pattern="spoofed upstream|carries account capacity" tests/integration/chat-pipeline.test.ts`: PASS — 2 tests, 2 passed, 0 failed. Logs showed the spoofed success remained on OpenAI and the real saturated-account path still skipped OpenAI, tried Claude once, and continued to Gemini.
- First complete focused suite: PASS — 230 tests, 230 passed, 0 failed, 0 cancelled, 0 skipped; 2 suites passed; 64.2 seconds.
- First final-gate pass: `npm run lint -- --no-cache`, `npm run typecheck:core`, and `npm run build` all passed with exit 0. `npm run check:open-sse-typecheck` returned only the documented unrelated `catalog.ts` TS2367 baseline regression.
- First identity/image pass produced tree `c0a497d48b6ad8ae6702182de0f2f41e21680300`, diff SHA-256 `1f3ee465cdf0c40d03363639a88bcd253290a1ebaa29d2fcd2040801e11e6a8b`, and newly published digest `sha256:28200276a8c11b1e9c3f7ae23015224b78d038331deb423e188dad2ffbcf9eac`; exact labels and `/healthz` HTTP 200 on loopback port `32773` passed.
- A final read-only return-path audit then found that provider-specific/no-body streaming returns occurred before the wrapper-level deletion. The first image was therefore superseded rather than reused.
- Applied `/tmp/apply-central-sentinel-sanitizer.py`, removed it, and ran Prettier: PASS. The reserved header is now removed immediately after executor-result normalization, before every provider-specific, no-body, streaming, or non-streaming return.
- Second targeted integration command plus `npm run typecheck:core`: PASS — 2/2 tests and typecheck exit 0.
- Final complete focused suite using the repository Node/tsx setup against combo config, account/rate-limit semaphores, strategy fallback, shared-account race, persistence, chatCore translation, parent runtime concurrency, response quality, semaphore lifecycle, Antigravity rotation, and chat pipeline: PASS — 230 tests, 230 passed, 0 failed, 0 cancelled, 0 skipped; 2 suites passed; 63.8 seconds.
- Final `npm run lint -- --no-cache`: PASS, exit 0. `config/quality/eslint-suppressions.json` did not change and suppression counts did not increase.
- Final `npm run typecheck:core`: PASS, exit 0 (run immediately after the central sanitizer edit).
- Final `npm run check:open-sse-typecheck`: known unrelated baseline/environment failure, exit 1. It reported `openSseTypecheckErrors=7` and only the frozen-baseline category regression `src/app/api/v1/models/catalog.ts TS2367 (baseline 0, live 2)`. No authorized file produced a diagnostic and the baseline was not widened.
- Final `npm run build`: PASS, exit 0. Next.js production build and standalone colocation completed.
- Final temporary-index identity command: PASS. It asserted porcelain status exactly equaled the 18-file allowlist, rejected CHANGELOG/changeset paths, loaded HEAD into a temporary `GIT_INDEX_FILE`, added exactly the allowlist, ran `git write-tree`, and SHA-256 hashed `git diff --cached --binary --full-index HEAD`. The real index was not modified.
- `docker buildx build ... --push`: PASS, exit 0. Evidence is stored remotely under `/home/celes/.local/state/omniroute-capacity-cascade-dev/semaphore-sentinel-final-20261011T023611Z/` in `candidate.env`, `image-build.log`, and `image-build.status`.
- `docker buildx imagetools inspect` on the new tag: PASS. It resolved the new digest and returned all three exact labels below.
- Bounded `docker create`/`start`/poll/remove smoke from the immutable digest: PASS. Loopback port `32774`, `/healthz` HTTP 200, body `ok`; the container was removed and final container count was zero.
- Final `git diff --check`, HEAD, status, production deployment image, and smoke-container readback: PASS. Production remained on the rollback digest and no transient smoke container remained.

The guaranteed-local `local_model_chat` tool was not available in the provided tool set, so the narrow edit used the documented direct-implementation fallback.

### Final exact candidate diff and identity

The full candidate allowlist remains exactly 18 paths: `open-sse/handlers/chatCore.ts`, `open-sse/services/combo.ts`, `open-sse/services/combo/runtimeUnits.ts`, `open-sse/services/combo/types.ts`, `open-sse/services/combo/validateQuality.ts`, `src/app/api/combos/[id]/route.ts`, `src/shared/validation/schemas/combo.ts`, `src/sse/handlers/chat.ts`, `tests/integration/chat-pipeline.test.ts`, `tests/unit/accountSemaphore.test.ts`, `tests/unit/antigravity-byop-account-rotation.test.ts`, `tests/unit/chatcore-translation-paths.test.ts`, `tests/unit/combo-capacity-cascade-persistence.test.ts`, `tests/unit/combo-config.test.ts`, `tests/unit/combo-runtime-unit-concurrency.test.ts`, `tests/unit/combo-semaphore-lifecycle.test.ts`, `tests/unit/combo-shared-account-race.test.ts`, and `tests/unit/combo-strategy-fallbacks.test.ts`.

Final identity:

- Revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `49b1623b10e6a622e9432d09f3a2c0a318f91352`
- Binary diff SHA-256: `907e4d09e1fa2579218e40a1a60fbea8aa1fc10889ad84a48ba6f94acaa5e724`
- Allowlist count: 18
- `git diff --check`: PASS
- CHANGELOG/changeset paths: none

### New immutable image and smoke

Successful publication command used platform `linux/amd64`, target `runner-base`, the documented `OMNIROUTE_USE_TURBOPACK=0` container escape hatch, and these exact labels:

- `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- `life.celestium.omniroute.candidate-tree=49b1623b10e6a622e9432d09f3a2c0a318f91352`
- `life.celestium.omniroute.diff-sha256=907e4d09e1fa2579218e40a1a60fbea8aa1fc10889ad84a48ba6f94acaa5e724`

Published artifact:

- Tag: `registry.celestium.life/library/omniroute:capacity-cascade-semaphore-sentinel-final-20261011T023611Z`
- Immutable digest: `registry.celestium.life/library/omniroute@sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525`
- `/healthz`: HTTP 200, body `ok`

The digest is new and differs from the superseded provenance image `sha256:28200276...`, prior candidate digests `sha256:8500cd...` and `sha256:bbc45c0...`, and the prohibited `sha256:388fa7e...` and `sha256:fb059a4...` digests.

## Final safety state

- Production deployment readback still points to old rollback digest `registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`.
- No live account gate was reset or bypassed.
- No diagnostic watchdog auto-decrement behavior was added.
- No management credential was read, printed, copied, or persisted.
- No commit, push, deployment, durable source edit, combo/provider write, or canary was performed.
