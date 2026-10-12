# OmniRoute Ollama-local Qwen reasoning-effort fix — implementation evidence

## Outcome

Implemented the narrow reasoning-effort regression fix in the required remote candidate worktree:

`/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`

The worktree remains at base revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658`. No commit, push, deployment, routing update, combo update, timeout update, semaphore update, CHANGELOG entry, or changeset was created. The prior 20-path capacity-cascade candidate remains intact.

Final immutable candidate:

- Tag: `registry.celestium.life/library/omniroute:capacity-cascade-effort-fix-final-20261011T053059Z`
- Digest: `registry.celestium.life/library/omniroute@sha256:299deb44f3169c5fe0fa6eef065580ecd0fee51610d64fce763ed41b1052bfe6`
- Revision label: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate-tree label: `71bf54d2a14efbe39ebe883e40aa9f3967d61b20`
- Binary diff SHA-256 label: `772b914710206f7b87ded8622e382cb4c4321ebcdfba162e8f55eee6c64f26f9`
- Ephemeral `/healthz`: HTTP 200, body `ok`

The prior live image `sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486` was not reused or overwritten. An intermediate image from the first test-coverage pass, `sha256:0d4c3473d1688889d94aa8a9902d9124e58393ab5a121ee53839c66ab8bce9d2`, was superseded after expanding explicit Qwen 3.5 coverage to all three top-tier values; it is not the final candidate.

## Iteration and investigation

`effort-fix-review.json` and `effort-fix-review.md` did not exist, so this was the first implementation iteration. Before editing, I read:

- `reasoning-effort-investigation.md`
- `deployed-release.md`
- `tier1b-fix-impl.md`, `tier1b-fix-review.md`, and `tier1b-fix-release.md`
- semaphore implementation/review/release artifacts
- the current candidate sanitizer/executor/tests
- the prior validated snapshot under `/home/celes/sources/omniroute-reasoning-effort-build`

Initial remote checks confirmed HEAD was the required revision and status contained exactly the prior 20 candidate paths. The current sanitizer and provider-model files matched HEAD; no Ollama-local effort fix was present.

## Narrow implementation

Only `open-sse/executors/base/reasoningEffort.ts` changed in runtime source for this fix.

### Closed family matching

`getOllamaLocalQwenEffortFamily()`:

- requires provider equality with the exact string `ollama-local`;
- strips only an exact `ollama-local/` provider prefix when present;
- requires an Ollama tag separator (`:`), so bare `qwen3.8` does not match;
- extracts the complete segment before the first colon;
- accepts only exact, case-sensitive family segments `qwen3.5` or `qwen3.8`;
- returns no match for Qwen 3, Qwen3-VL, Gemma, `qwen3.80`, unrelated Ollama models, and non-Ollama providers.

This is fail-closed and does not broaden to generic Qwen 3 models.

### Carrier cleanup and semantics

For the matched provider/families only:

- `low` and `medium` are returned unchanged;
- `high`, `xhigh`, and `max` remove the effort carrier entirely;
- the existing shared `stripEffortValue()` helper removes every present carrier: top-level `reasoning_effort`, nested `reasoning.effort`, and nested `output_config.effort`;
- sibling fields in `reasoning` and `output_config`, plus all unrelated body fields, remain intact;
- empty carrier objects retain the helper’s existing cleanup behavior;
- no mapping to `xhigh`, `max`, `high`, or `medium` is introduced.

The omission branch executes in the final provider sanitizer before the existing generic registry clamp and xhigh/max handling. The existing reactive 400/422 learner and all HTTP 500 behavior remain unchanged.

### Override precedence and logging

The sanitizer retains the prior validated optional operator-override seam. It resolves an exact tagged-model override first and then a bare-family override. Any override suppresses the special omission policy and participates in the existing declared-vocabulary clamp: an override accepting `high` preserves it, while an exact override capped at `medium` clamps to `medium` rather than omitting.

Each omission emits `REASONING_SANITIZE` with provider/model, the omitted effort value, and the reason that the backend exposes its top tier only through the omitted default. It includes no prompt, messages, request body, credential, or secret content.

No supporting registry/provider metadata files were needed; avoiding them kept the fix isolated from unrelated changes in the reference snapshot.

## Regression coverage

### Focused Ollama-local suite

Added `tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts`, covering:

- tagged Qwen 3.8 `high`, `xhigh`, and `max` omission;
- tagged Qwen 3.5 `high`, `xhigh`, and `max` omission;
- `low`/`medium` identity preservation;
- all three carriers;
- sibling/request-field preservation;
- metadata-safe omission logs that do not expose a prompt marker;
- exact/fail-closed exclusions for Qwen 3, Qwen3-VL, Gemma, unrelated Ollama, `qwen3.80`, untagged `qwen3.8`, and non-Ollama;
- exact-tag and bare-family operator override precedence;
- code/research/tester round-robin selection with the exact `[5090, 4070, 5090]` target shape, proving job 2 reaches the 4070, the body is sanitized, HTTP 200 is returned, and no enum-error fallback is burned.

### Executor boundary

Added a regression to the already-authorized `tests/unit/chatcore-translation-paths.test.ts`. It enters real `handleChatCore` with an OpenAI-shaped `reasoning_effort: high` request bound to `ollama-local/qwen3.8:27b-iq3-code144k`, captures the body at the mocked global fetch boundary, and proves the effort field is absent while messages and temperature survive. This demonstrates sanitation occurs after request transformation and before fetch.

## Verification commands and results

All source, test, static-analysis, build, identity, image, and smoke commands ran over SSH on `celes@192.168.42.254`. All git operations used `git -C /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z` or an equivalent command rooted there.

### Targeted regression

Command used the repository’s Node/tsx setup, Open-SSE polyfill, isolated test data, forced single-run exit, and concurrency 1 against the new focused file and the chatCore executor test.

Result: PASS — 85 tests, 85 passed, 0 failed. This invocation included the complete chatCore test file plus the new focused tests.

### Final complete focused suite

Final command:

`DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=1 tests/unit/combo-config.test.ts tests/unit/accountSemaphore.test.ts tests/unit/rateLimitSemaphore.test.ts tests/unit/combo-strategy-fallbacks.test.ts tests/unit/combo-shared-account-race.test.ts tests/unit/combo-capacity-cascade-persistence.test.ts tests/unit/chatcore-translation-paths.test.ts tests/unit/combo-runtime-unit-concurrency.test.ts tests/unit/validate-response-quality.test.ts tests/unit/combo-semaphore-lifecycle.test.ts tests/unit/antigravity-byop-account-rotation.test.ts tests/integration/chat-pipeline.test.ts tests/unit/tier-routing.test.ts tests/unit/base-executor-sanitize-effort.test.ts tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts`

Result: PASS — 301 tests, 301 passed, 0 failed, 0 cancelled, 0 skipped; 2 suites passed; duration 67.06 seconds. This retains all 238 capacity-cascade focused tests and adds the prior base-sanitizer suite plus the new focused coverage.

### Static and build gates

- `npm run lint -- --no-cache`: PASS, exit 0. No lint suppression file changed and suppression counts did not increase.
- `npm run typecheck:core`: PASS, exit 0.
- `npm run check:open-sse-typecheck`: expected known unrelated baseline result, exit 1. It reported `openSseTypecheckErrors=7` and only `src/app/api/v1/models/catalog.ts TS2367 (baseline 0, live 2)` as the frozen-baseline regression. No authorized file produced a diagnostic and the baseline was not widened.
- `npm run build`: PASS, exit 0. Next.js 16.3.1 production build and standalone colocation completed.
- `git diff --check`: PASS after formatting, after build, and before final identity calculation.
- Real git index: unchanged/empty.

### Safe backend probe

A non-secret, local-only probe sent `Reply with OK.` with `max_tokens: 1` to `http://10.1.1.12:2701/v1/chat/completions` for model `qwen3.8:27b-iq3-code144k`. No production prompt, credential, API key, or authorization header was used or recorded.

Results:

- effort omitted: HTTP 200, curl exit 0
- `reasoning_effort: low`: HTTP 200, curl exit 0
- `reasoning_effort: medium`: HTTP 200, curl exit 0

This independently confirms the backend/template-safe outbound shapes are non-500.

## Exact changed-path allowlist and identity

A temporary external `GIT_INDEX_FILE` was loaded from HEAD, exactly the allowlist below was added, `git write-tree` was run, and `git diff --cached --binary --full-index HEAD` was SHA-256 hashed. The real index remained empty.

Identity:

- Revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `71bf54d2a14efbe39ebe883e40aa9f3967d61b20`
- Binary diff SHA-256: `772b914710206f7b87ded8622e382cb4c4321ebcdfba162e8f55eee6c64f26f9`
- Allowlist count: 22

Exact allowlist:

```text
open-sse/executors/base/reasoningEffort.ts
open-sse/handlers/chatCore.ts
open-sse/services/combo.ts
open-sse/services/combo/runtimeUnits.ts
open-sse/services/combo/tierRouting.ts
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
tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts
tests/unit/tier-routing.test.ts
```

Relative to the prior validated 20-path capacity candidate, the only newly authorized paths are:

- `open-sse/executors/base/reasoningEffort.ts`
- `tests/unit/ollama-local-reasoning-effort-qwen35-qwen38.test.ts`

The executor-boundary regression was added to the already-authorized `tests/unit/chatcore-translation-paths.test.ts`.

## Image publication and verification

Final publication used:

`docker buildx build --platform linux/amd64 --target runner-base --build-arg OMNIROUTE_USE_TURBOPACK=0 --label org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658 --label life.celestium.omniroute.candidate-tree=71bf54d2a14efbe39ebe883e40aa9f3967d61b20 --label life.celestium.omniroute.diff-sha256=772b914710206f7b87ded8622e382cb4c4321ebcdfba162e8f55eee6c64f26f9 --tag registry.celestium.life/library/omniroute:capacity-cascade-effort-fix-final-20261011T053059Z --push .`

Result: PASS, exit 0.

`docker buildx imagetools inspect` resolved the tag to:

`registry.celestium.life/library/omniroute@sha256:299deb44f3169c5fe0fa6eef065580ecd0fee51610d64fce763ed41b1052bfe6`

Published labels were read back exactly:

- `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- `life.celestium.omniroute.candidate-tree=71bf54d2a14efbe39ebe883e40aa9f3967d61b20`
- `life.celestium.omniroute.diff-sha256=772b914710206f7b87ded8622e382cb4c4321ebcdfba162e8f55eee6c64f26f9`

A bounded ephemeral container was created from the final immutable tag+digest, started on an ephemeral loopback port, and polled at `/healthz`. Result: HTTP 200, body `ok`. The container was removed; exact-name container count after cleanup was zero.

No production runtime or policy was mutated.
