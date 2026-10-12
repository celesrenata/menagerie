# OmniRoute Execute-Mode Parent Capacity Skip Implementation

## Outcome

Implemented and verified the execute-mode priority-parent capacity fix in the isolated remote worktree `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z` at approved revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658`. No commit or push was created. No deployment, durable-policy mutation, canary, or mutating management API call occurred. Production remained on rollback digest `registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87` at final readback.

New immutable candidate:

- Digest: `registry.celestium.life/library/omniroute@sha256:fb059a4d0364f7afced60cf4d20b7644ef57bb14439bde1a3ca51b69202aaf9b`
- Candidate tag: `registry.celestium.life/library/omniroute:capacity-cascade-parent-skip-20261011T000233Z`
- Approved OCI revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `aea994df380df929bee410618dfe5bd41ee9006e`
- Dirty-tree binary diff SHA-256: `ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e`
- Ephemeral `/healthz`: HTTP 200
- Prior failed candidate `sha256:388fa7e33a360bfa4d18b4414ed92af66b5a32eeba38db055d76da50651ae4aa` was not reused.

## Proven pre-skip terminal path

The failure was reproduced in the current isolated source before changing runtime behavior. In `open-sse/services/combo/runtimeUnits.ts`, the execute-mode loop checked child capacity before dispatch. The relevant original path was:

```ts
lastResponse = errorResponse(503, `${unitDisplayName(unit)} is at concurrency capacity`);
await observeFailure(lastResponse, unit);
if (protectedPriorityUnit) return { response: finalFailure(lastResponse), unit };
fallbackCount += 1;
continue;
```

This was the terminal path observed in production: when a priority root's tier1 combo-ref had `fallbackOnlyOnQuotaExhaustion`, parent precheck saturation generated the child capacity 503 and returned it immediately instead of trying tier1b. The new incident-shaped test was run before the runtime edit and failed exactly as required:

- tier1-full/tier1b-available expected 200 but got 503;
- all children full expected `ALL_TARGETS_SKIPPED` but got generic `service_unavailable`;
- the initial non-capacity assertion was corrected to account for the child round-robin trying all three tier1 members while still proving that the parent never enters tier1b.

Pre-fix targeted command result: 3 tests run, 0 passed, 3 failed. The first two failures proved the runtime defect; the third exposed an overly narrow call-count assertion in the new test, not a product defect.

## Narrow additive runtime change

Only `open-sse/services/combo/runtimeUnits.ts` was added to the previous candidate's authorized application surface. The executor now identifies a priority execute-mode root whose runtime units are exclusively combo references:

```ts
const priorityComboRefRoot =
  effectiveStrategy === "priority" &&
  orderedUnits.length > 0 &&
  orderedUnits.every((unit) => unit.kind === "combo-ref");
```

The pre-skip branch now counts capacity-skipped combo refs and does not apply quota-protection as a terminal condition for that root shape:

```ts
if (priorityComboRefRoot) capacitySkippedComboRefs += 1;
if (protectedPriorityUnit && !priorityComboRefRoot) {
  return { response: finalFailure(lastResponse), unit };
}
fallbackCount += 1;
continue;
```

When every child combo-ref was pre-skipped for capacity, the parent returns the existing OpenAI-shaped terminal contract: HTTP 503, `type: service_unavailable`, `code: ALL_TARGETS_SKIPPED`. This prevents the last child's generic capacity response from obscuring all-local exhaustion.

The scope is deliberately narrow:

- It applies only inside the existing execute-mode runtime-unit executor.
- It requires effective strategy `priority`.
- It requires every root unit to be a `combo-ref`.
- It changes only the pre-dispatch concurrency-cap branch.
- Non-capacity child responses still use the existing status/retry/quota-protection logic.
- Direct model roots, mixed model/combo-ref roots, unrelated strategies, validation failures, cycle/depth failures, and ordinary dispatch errors are unchanged.
- A local root with no usable later child remains terminal; an all-combo-ref local root exhausted solely by pre-skip capacity now uses the established `503 ALL_TARGETS_SKIPPED` terminal shape.

The previous candidate's lane-scoped round-robin corrections remain present: corrected leaves can set `disablePromptCacheAffinity: true` so prompt affinity cannot reset/reorder their `[5090, 4070, 5090]` cyclic capacity order, and `failFastOnAccountCapacity: true` forwards zero-depth account queue controls. Existing focused tests continue to cover flagged affinity opt-out versus unchanged unflagged behavior. Cloud pools remain specified at `targetTimeoutMs: 60000`; this implementation did not mutate policy.

## New deterministic regression coverage

Updated `tests/unit/combo-runtime-unit-concurrency.test.ts` with a production-shaped `local/research` topology:

1. `pool/tier1/research` is round-robin `[5090, 4070, 5090]` using shared connection caps 2 and 1.
2. `pool/tier1b/research` is one-target round-robin GLM with cap 1.
3. The execute-mode priority parent contains tier1 then tier1b, both quota-protected combo refs.
4. With both 5090 slots and the 4070 slot held, the parent logs the tier1 pre-skip, immediately tries tier1b, and returns GLM success. Calls contain only `llama-cpp/ds4-glm53`; the root contains no cloud child; response is not 500; shared queues remain zero.
5. With 5090, 4070, and GLM all held, no model dispatch occurs and the local root returns HTTP 503 with `error.code === "ALL_TARGETS_SKIPPED"`; every account queue remains zero.
6. A child HTTP 400 remains terminal at the parent. The child retains its existing internal round-robin semantics, all three tier1 targets are attempted, and tier1b GLM is not called.

Post-fix targeted rerun: 3 tests run, 3 passed, 0 failed.

## Commands and results

All source/build commands ran over SSH on `celes@192.168.42.254` in `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z` unless noted.

### Source and regression proof

- `git rev-parse HEAD`, `git status --short`, `git diff --name-only`, and targeted source reads/searches: PASS. HEAD was exactly `ad45d990c9f17e857f0bd03aacd1ff29b1825658`; only the previous authorized candidate patch/tests were initially dirty.
- Pre-fix Node bootstrap with `--test-name-pattern="priority parent skips|priority local root returns|keeps non-capacity child errors" tests/unit/combo-runtime-unit-concurrency.test.ts`: expected regression proof — 3 tests, 0 pass, 3 fail as detailed above.
- Post-fix same targeted command: PASS — 3 tests, 3 pass, 0 fail.
- `npx prettier --write open-sse/services/combo/runtimeUnits.ts tests/unit/combo-runtime-unit-concurrency.test.ts`: PASS.

### Complete focused candidate suite

Command:

```text
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=1 tests/unit/combo-config.test.ts tests/unit/accountSemaphore.test.ts tests/unit/rateLimitSemaphore.test.ts tests/unit/combo-strategy-fallbacks.test.ts tests/unit/combo-shared-account-race.test.ts tests/unit/combo-capacity-cascade-persistence.test.ts tests/unit/chatcore-translation-paths.test.ts tests/unit/combo-runtime-unit-concurrency.test.ts
```

Result: PASS — 176 tests, 176 passed, 0 failed, 0 cancelled, 0 skipped; 2 suites passed.

This includes all focused tests from the previous candidate plus the new parent pre-skip coverage.

### Static and build gates

- `npm run lint -- --no-cache`: PASS, exit 0.
- `npm run typecheck:core`: PASS, exit 0.
- `npm run check:open-sse-typecheck`: baseline/environment failure, exit 1. It reported 7 total scoped errors and one frozen-baseline category regression: `src/app/api/v1/models/catalog.ts TS2367 (baseline 0, live 2)`. This is the same unrelated TypeScript 6.0.3 diagnostic documented for the previous candidate; no authorized file produced a diagnostic and the baseline was not widened.
- `npm run build`: PASS, exit 0, Next.js production build completed.
- `git diff --check`: PASS.

### Candidate identity, image publication, and smoke test

Candidate identity was computed without modifying the real index by loading HEAD into a temporary `GIT_INDEX_FILE`, adding exactly the allowlisted files, then running `git write-tree` and hashing `git diff --cached --binary --full-index HEAD` with SHA-256. Result: tree `aea994df380df929bee410618dfe5bd41ee9006e`, diff `ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e`.

Image command (successful invocation):

```text
docker buildx build --platform linux/amd64 --target runner-base --build-arg OMNIROUTE_USE_TURBOPACK=0 --label org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658 --label life.celestium.omniroute.candidate-tree=aea994df380df929bee410618dfe5bd41ee9006e --label life.celestium.omniroute.diff-sha256=ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e --tag registry.celestium.life/library/omniroute:capacity-cascade-parent-skip-20261011T000233Z --push .
```

Result: PASS, exit 0. The checked-in webpack escape hatch was used because the prior candidate had already documented the container-only Turbopack panic.

Operational retries recorded for completeness:

- The first foreground image invocation was interrupted by the agent transport while Next.js compilation was in progress; no process remained and tag inspection proved no image had been published.
- The first detached retry failed before building with `invalid tag ""` because its shell extraction produced an empty ref; no image was published.
- The successful detached invocation used the exact already-recorded explicit tag above.
- The first health command started the image successfully but its dynamic host-port parser produced an invalid curl port; the container was removed by its trap. The retry bound ephemeral host port 32129, observed one startup connection reset, then returned `/healthz` HTTP 200 and removed the container.

`docker buildx imagetools inspect` resolved the tag to the new immutable digest above. Published config labels were verified exactly:

- `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- `life.celestium.omniroute.candidate-tree=aea994df380df929bee410618dfe5bd41ee9006e`
- `life.celestium.omniroute.diff-sha256=ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e`

Remote build evidence is under `/home/celes/.local/state/omniroute-capacity-cascade-dev/parent-skip-20261010T235518Z/` (`candidate.env`, `image-build.log`, `image-build.status`).

## Authorized-file allowlist diff

Final temporary-index/status allowlist validation passed with exactly 14 files. Application source is the previous six authorized files plus the narrowly required parent executor file; all remaining files are focused tests:

```text
open-sse/handlers/chatCore.ts
open-sse/services/combo.ts
open-sse/services/combo/runtimeUnits.ts
open-sse/services/combo/types.ts
src/app/api/combos/[id]/route.ts
src/shared/validation/schemas/combo.ts
src/sse/handlers/chat.ts
tests/unit/accountSemaphore.test.ts
tests/unit/chatcore-translation-paths.test.ts
tests/unit/combo-capacity-cascade-persistence.test.ts
tests/unit/combo-config.test.ts
tests/unit/combo-runtime-unit-concurrency.test.ts
tests/unit/combo-shared-account-race.test.ts
tests/unit/combo-strategy-fallbacks.test.ts
```

No CHANGELOG or changeset file changed. No commit or push was created.
