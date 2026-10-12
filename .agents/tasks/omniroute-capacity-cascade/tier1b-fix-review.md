# Logical tier-1b routing for local overflow capacity

The correction makes `pool/tier1b/<category>` logical tier 1 while retaining numeric tiers 1–5 and fail-closed handling for unknown names. It fixes the production failure where root tier selection removed the free GLM pool before nested capacity routing considered it. Direct selector coverage and an exact `handleComboChat()` incident regression exercise GLM success and all-local exhaustion. The prior parent pre-skip and lane-scoped round-robin changes remain in the combined candidate.

Watch for: **confirmed** the broader scoped open-SSE type-check still reports only the known unrelated `catalog.ts` baseline diagnostics; core type-check, lint, build, focused tests, changed-file diagnostic review, and isolated reproduction passed.

**Verdict**: APPROVED

## High-level view

Tier parsing is now a closed contract: `tier1` and `tier1b` map to 1, `tier2` through `tier5` map numerically, and malformed or invented variants remain excluded. Selection preserves declared order and the established distinction between local/default tiers and explicit tier-3-or-higher routing.

Production-shaped tests enter through `handleComboChat()` with tier routing enabled, no tier header, exact combo projections and connection identities, and 2/2, 1/1, 0/1 account occupancy. Only GLM dispatches with HTTP 200 when tier1 is saturated; complete local saturation returns HTTP 503 `ALL_TARGETS_SKIPPED` without queueing.

The priority combo-ref parent still skips saturated children, non-capacity child errors remain terminal, lane ordering and fail-fast account-capacity controls remain enabled, and simplified executor regressions remain alongside the incident tests.

Candidate scope is the prior 18 paths plus tier-routing source and test. Recorded temporary-index identity, image labels, digest, and health smoke correspond to this 20-path candidate without commit, push, CHANGELOG, or changeset mutation.

<details>
<summary>Issues (0)</summary>

No blocking or actionable findings.

</details>

<details>
<summary>Details</summary>

## Closed tier-name grammar fixes upstream eligibility loss

`parseLogicalPoolTier()` accepts only `pool/tier1/<category>`, `pool/tier1b/<category>`, and numeric `pool/tier2` through `pool/tier5` forms. Requiring a slash after the tier token rejects `tier1c` and `tier2b`, while the uninspected category suffix cannot alter the result. Unknown prefixes, out-of-range tiers, leading-zero forms, and missing category separators retain the previous fail-closed behavior, including the existing 503 when no eligible pool remains.

A default local policy retains tier1 then tier1b; tier 2 retains tier1, tier1b, then tier2; explicit tier 3 begins at tier3 and keeps later configured fallbacks. Header validation, maximum-tier rejection, policy bypass when tier routing is absent, and non-mutation of saved routing remain covered.

## Incident topology reaches GLM after parent capacity pre-skip

The regression reproduces `local/research`, `pool/tier1/research`, and `pool/tier1b/research`, including IDs, weights, provider/model names, timeout and affinity flags, context metadata, and absent `fallbackOnlyOnQuotaExhaustion`. Root `tierRouting` remains default/maximum tier 1, and omitting request headers exercises the production default.

With vLLM held at 2/2 and Ollama at 1/1, selection retains both logical-tier-1 references. Parent capacity inspection skips tier1, GLM remains 0/1, and the only dispatch is `llama-cpp/ds4-glm53` with the marked streaming body and HTTP 200. Holding GLM at 1/1 produces no dispatch, zero queued waiters on all accounts, and HTTP 503 `ALL_TARGETS_SKIPPED` rather than 500.

## Capacity-cascade semantics remain beneath tier selection

Parent pre-skip remains limited to priority roots composed entirely of combo references. Capacity-skipped children fall through, complete pre-dispatch exhaustion receives `ALL_TARGETS_SKIPPED`, and non-capacity failures retain terminal behavior. The three simplified executor regressions remain, so the production fixture supplements rather than replaces narrow coverage.

Round-robin still honors `disablePromptCacheAffinity` and forwards zero-depth account queue controls only with `failFastOnAccountCapacity`. The `[5090, 4070, 5090]` order, one-slot 4070 lane, GLM overflow, and 60-second cloud timeout contract remain intact. The recorded 238-test suite includes prior semaphore, shared-account race, persistence, translation, strategy, lifecycle, quality, provider-rotation, and integration coverage.

## Reviewed tree and immutable artifact stay aligned

Final status contains the reported 20 paths: the prior 18 plus `open-sse/services/combo/tierRouting.ts` and `tests/unit/tier-routing.test.ts`. The incident regression uses the already-authorized runtime concurrency test. No dependency, manifest, lockfile, lint suppression, CHANGELOG, or changeset entered the candidate; HEAD remains `ad45d990c9f17e857f0bd03aacd1ff29b1825658`, the index is empty, and no commit or push occurred.

The recorded tree is `dfa5ef0b9142c57aee9915869620a47eea3bd310` with binary diff SHA-256 `be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080`. Those identities and the base revision were read back from digest `sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486`; an ephemeral container returned `/healthz` HTTP 200 `ok` and was removed.

</details>

<details>
<summary>File map</summary>

- `open-sse/handlers/chatCore.ts` — preserves response cleanup and account-capacity signaling.
- `open-sse/services/combo.ts` — preserves lane affinity opt-out, fail-fast fallback, and response cleanup.
- `open-sse/services/combo/runtimeUnits.ts` — preserves parent pre-skip and all-skipped classification.
- `open-sse/services/combo/tierRouting.ts` — maps tier1b to logical tier 1 through a closed parser.
- `open-sse/services/combo/types.ts` — retains capacity-routing configuration typing.
- `open-sse/services/combo/validateQuality.ts` — retains response-quality lifecycle corrections.
- `src/app/api/combos/[id]/route.ts` — retains persisted combo configuration handling.
- `src/shared/validation/schemas/combo.ts` — retains validation for capacity and lane flags.
- `src/sse/handlers/chat.ts` — retains chat semaphore and response handling.
- `tests/integration/chat-pipeline.test.ts` — retains integrated capacity-cascade coverage.
- `tests/unit/accountSemaphore.test.ts` — retains semaphore saturation and queue coverage.
- `tests/unit/antigravity-byop-account-rotation.test.ts` — retains account-rotation coverage.
- `tests/unit/chatcore-translation-paths.test.ts` — retains response translation and cleanup coverage.
- `tests/unit/combo-capacity-cascade-persistence.test.ts` — retains cascade flag persistence coverage.
- `tests/unit/combo-config.test.ts` — retains configuration default and normalization coverage.
- `tests/unit/combo-runtime-unit-concurrency.test.ts` — adds exact incident cases and retains parent-skip tests.
- `tests/unit/combo-semaphore-lifecycle.test.ts` — retains semaphore release coverage.
- `tests/unit/combo-shared-account-race.test.ts` — retains shared-account race coverage.
- `tests/unit/combo-strategy-fallbacks.test.ts` — retains lane order and fallback coverage.
- `tests/unit/tier-routing.test.ts` — covers tier1b, order, category independence, and malformed names.

Full diff: `git -C /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z diff` on `celes@192.168.42.254`.

</details>
