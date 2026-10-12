# OmniRoute `tier1b` Logical-Tier Fix — Implementation Evidence

## Outcome

Implemented the narrow `tier1b` parser correction in the required remote candidate worktree:

`/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`

The worktree remains at base revision `ad45d990c9f17e857f0bd03aacd1ff29b1825658`. No commit or push was created. No CHANGELOG or changeset path changed. The prior 18-path candidate remains intact; the only newly authorized paths are the required source `open-sse/services/combo/tierRouting.ts` and direct test `tests/unit/tier-routing.test.ts`. The exact production-shape regression was added to the already-authorized `tests/unit/combo-runtime-unit-concurrency.test.ts`.

Final immutable candidate:

- Tag: `registry.celestium.life/library/omniroute:capacity-cascade-tier1b-fix-20261011T032725Z`
- Digest: `registry.celestium.life/library/omniroute@sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486`
- Revision label: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `dfa5ef0b9142c57aee9915869620a47eea3bd310`
- Binary diff SHA-256: `be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080`
- Ephemeral `/healthz`: HTTP 200, body `ok`

The stale candidate `sha256:59baefb947595594966f53abf56cc0922475b0045062c041c218657940329525` was not reused.

## Iteration check and initial state

`tier1b-fix-review.json` did not exist, so this was the first implementation iteration. I read `research-503-investigation.md`, including the three exact projections in section 2, before editing.

Initial remote checks established:

- `git -C ... rev-parse HEAD`: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`.
- `git -C ... status --short --branch`: the expected branch and prior 18 candidate paths only.
- `git -C ... diff --name-only` plus `ls-files --others --exclude-standard`: exactly the prior 18 candidate paths.
- `git -C ... show HEAD:open-sse/services/combo/tierRouting.ts`: confirmed the old `^pool/tier([1-5])/` parser.
- `git -C ... grep -n "selectRequestedTier" -- "*.ts"`: found the call at `combo.ts:740` and existing direct coverage in `tests/unit/tier-routing.test.ts`.
- Source reads of `combo.ts:690-785`, `combo/types.ts`, `tests/unit/tier-routing.test.ts`, and all of `tests/unit/combo-runtime-unit-concurrency.test.ts`: confirmed the established tier-3 contract and reusable real account-semaphore harness.
- Newline inspection: all three target files used LF only.

## Exact source diff

Only `open-sse/services/combo/tierRouting.ts` changed in runtime source: 13 insertions and 2 deletions relative to HEAD.

The change adds one private, documented `parseLogicalPoolTier(comboName)` helper. `selectRequestedTier()` now uses its logical number instead of directly extracting a single numeric character. The surrounding policy/header behavior is untouched: policy absence still bypasses tier selection; invalid tier headers still return 400; requests above `maximumTier` still return 403; and an empty eligible set still returns the existing 503 message.

No runtime source outside `tierRouting.ts` was changed for this fix. Existing modifications in the other prior candidate source paths were preserved byte-for-byte by this iteration.

### Exhaustive parser mapping

| Root combo-ref form | Parser result | Selection behavior |
|---|---:|---|
| `pool/tier1/<category>` | 1 | Accepted as logical local tier 1. |
| `pool/tier1b/<category>` | 1 | Accepted as logical local tier 1. |
| `pool/tier2/<category>` | 2 | Accepted as tier 2. |
| `pool/tier3/<category>` | 3 | Accepted as tier 3. |
| `pool/tier4/<category>` | 4 | Accepted as tier 4. |
| `pool/tier5/<category>` | 5 | Accepted as tier 5. |
| `pool/tier1c/<category>` | `null` | Excluded, preserving the old fail-closed behavior. |
| `pool/tier2b/<category>` | `null` | Excluded; suffix variants are not broadened. |
| `pool/tier01/<category>`, `pool/tier6/<category>` | `null` | Excluded as malformed/unknown. |
| `pool/tier1` without the required slash, or a non-`pool/` prefix | `null` | Excluded as malformed/unknown. |

The category suffix after the tier-name slash is not parsed and cannot affect the logical tier.

### Preserved selection contract

- Default/local tier 1 with `maximumTier: 1`: retains `tier1` and `tier1b` in declared order.
- Requested or default tier 2 with `maximumTier: 2`: retains `tier1`, `tier1b`, and `tier2` in declared order.
- Requested tier 3 under the existing contract: starts at tier 3, excluding `tier1`, `tier1b`, and tier 2; higher tiers remain ordered fallbacks through the configured maximum.
- The source does not disable or remove `tierRouting` and does not reinterpret any header.

## Tests added and retained

### Direct tier-routing tests

Added to `tests/unit/tier-routing.test.ts`:

1. `tier1b maps to logical tier 1 with exact order and tier semantics`
   - proves default local tier 1 selects exact references `[tier1, tier1b]`;
   - proves default tier 2 and explicit `X-OmniRoute-Tier: 2` select `[tier1, tier1b, tier2]`;
   - proves explicit tier 3 selects tiers 3–5 and excludes both local variants;
   - places malformed `tier1c` and `tier2b` entries among valid entries to prove exclusion does not disturb declared valid order;
   - uses `pool/tier1b/arbitrary-category` to prove the category does not affect parsing.
2. `unknown and malformed pool tier names retain fail-closed exclusion`
   - covers `tier1c`, `tier2b`, `tier01`, `tier6`, missing category slash, and wrong root prefix;
   - proves an all-malformed managed combo returns the existing HTTP 503 selection error and is not mutated.

The four pre-existing direct tests remain and were included in the final focused suite.

### Exact production-shape `handleComboChat` regressions

Added to the existing `tests/unit/combo-runtime-unit-concurrency.test.ts` harness without replacing its simplified executor regressions. The fixture reproduces all three section-2 projections, including:

- exact names and descriptions for `local/research`, `pool/tier1/research`, and `pool/tier1b/research`;
- real connection IDs `e9bd13fb-c6b6-4c18-b42f-3395266348ce`, `b20e0770-3e14-40c1-87cd-85c34b34381a`, and `70b82fc9-6f96-41ac-aa16-8da6099dd7ac`;
- exact provider IDs, model IDs, model names, weights 1/1/1 and 100, top-level strategies, context lengths, cache-protection flags, and every config flag/value from the report;
- root `tierRouting: { defaultTier: 1, maximumTier: 1 }` enabled;
- `fallbackOnlyOnQuotaExhaustion` absent from both root references;
- no tier request header;
- a marked streaming chat body.

Added cases:

1. `exact production local/research shape dispatches only free tier1b GLM`
   - seeds real provider/connection rows at caps vLLM 2, Ollama 1, llama-cpp 1;
   - holds vLLM at 2/2 and Ollama at 1/1 while proving GLM is 0/1;
   - enters through `handleComboChat()`;
   - asserts HTTP 200 and exactly one model dispatch: `llama-cpp/ds4-glm53`;
   - asserts the exact marked body reached that dispatch and no account waiter was created.
2. `exact production local/research shape returns ALL_TARGETS_SKIPPED when all local pools are full`
   - holds all three accounts at 2/2, 1/1, and 1/1;
   - asserts HTTP 503, error code `ALL_TARGETS_SKIPPED`, no model dispatch, and queued count 0 for every account;
   - therefore proves no waiter and no HTTP 500.

Retained simplified executor regressions:

- `priority parent skips saturated tier1 combo-ref and immediately serves tier1b GLM`;
- `priority local root returns ALL_TARGETS_SKIPPED when every child combo-ref is full`;
- `priority combo-ref parent keeps non-capacity child errors terminal`.

## Validation results

### Formatting and targeted regression

Formatter command:

`npm --prefix <worktree> exec -- prettier --write <tierRouting.ts> <tier-routing.test.ts> <combo-runtime-unit-concurrency.test.ts>`

Result: PASS. Only the intended target files were formatted.

Targeted test command used system Node, the worktree-resolved `tsx/esm` loader, `TSX_TSCONFIG_PATH=<worktree>/tsconfig.json`, repository polyfills/setup, test concurrency 1, and the pattern `tier1b maps|unknown and malformed|exact production local/research`.

Result: PASS — 4 tests, 4 passed, 0 failed.

### Complete focused suite

The final suite used the repository Node/tsx setup with concurrency 1 against:

- `tests/unit/combo-config.test.ts`
- `tests/unit/accountSemaphore.test.ts`
- `tests/unit/rateLimitSemaphore.test.ts`
- `tests/unit/combo-strategy-fallbacks.test.ts`
- `tests/unit/combo-shared-account-race.test.ts`
- `tests/unit/combo-capacity-cascade-persistence.test.ts`
- `tests/unit/chatcore-translation-paths.test.ts`
- `tests/unit/combo-runtime-unit-concurrency.test.ts`
- `tests/unit/validate-response-quality.test.ts`
- `tests/unit/combo-semaphore-lifecycle.test.ts`
- `tests/unit/antigravity-byop-account-rotation.test.ts`
- `tests/integration/chat-pipeline.test.ts`
- `tests/unit/tier-routing.test.ts`

Result: PASS — 238 tests, 238 passed, 0 failed, 0 cancelled, 0 skipped; 2 suites passed; duration 64.3 seconds. This is the prior 230-test candidate suite plus six direct tier-routing tests and two exact production-shape regressions.

### Static and build gates

- `npm --prefix <worktree> run lint -- --no-cache`: PASS, exit 0.
- `npm --prefix <worktree> run typecheck:core`: PASS, exit 0.
- `npm --prefix <worktree> run check:open-sse-typecheck`: expected known unrelated baseline result, exit 1. It reported `openSseTypecheckErrors=7` and only `src/app/api/v1/models/catalog.ts TS2367 (baseline 0, live 2)` as the frozen-baseline regression. No authorized file produced a diagnostic and the baseline was not widened.
- `npm --prefix <worktree> run build`: PASS, exit 0. Next.js 16.3.1 production build and standalone colocation completed.
- `git -C <worktree> diff --check`: PASS after formatting/build and again in the final hygiene snapshot.
- Final `git -C <worktree> diff --cached --name-only`: empty; the real index was not mutated.

## Exact isolated reproduction after all gates

A final one-test invocation ran `exact production local/research shape dispatches only free tier1b GLM` with a dedicated `TMPDIR=/tmp/omniroute-tier1b-repro-uNmQDJ` and the real test harness.

Result:

- HTTP assertion: 200.
- Dispatch assertion: only `llama-cpp/ds4-glm53`.
- Occupancy at selection: vLLM 2/2, Ollama 1/1, llama-cpp 0/1.
- Test result: 1 passed, 0 failed, duration 2.69 seconds.
- The test teardown had already removed its SQLite directory: `DATABASES_BEFORE_WRAPPER_CLEANUP=0`.
- The dedicated wrapper directory was then removed and checked: `TEMP_BASE_REMOVED=True`.

No production API, deployment, provider, or durable policy was touched by this reproduction.

## Exact authorized allowlist and identity

The final status was asserted to equal these 20 paths exactly:

```text
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
tests/unit/tier-routing.test.ts
```

A Python wrapper invoked only `git -C <worktree> ...` operations, created a temporary external `GIT_INDEX_FILE`, loaded HEAD with `read-tree`, added exactly the allowlist, ran `write-tree`, and SHA-256 hashed `git diff --cached --binary --full-index HEAD`.

Result:

```text
REVISION=ad45d990c9f17e857f0bd03aacd1ff29b1825658
TREE=dfa5ef0b9142c57aee9915869620a47eea3bd310
DIFF_SHA256=be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080
ALLOWLIST_COUNT=20
STATUS_ALLOWLIST=PASS
REAL_INDEX_MUTATED=NO
```

## Image publication and verification

Successful publication command:

`docker buildx build --platform linux/amd64 --target runner-base --build-arg OMNIROUTE_USE_TURBOPACK=0 --label org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658 --label life.celestium.omniroute.candidate-tree=dfa5ef0b9142c57aee9915869620a47eea3bd310 --label life.celestium.omniroute.diff-sha256=be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080 --tag registry.celestium.life/library/omniroute:capacity-cascade-tier1b-fix-20261011T032725Z --push /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`

Result: PASS, exit 0.

`docker buildx imagetools inspect` resolved the tag to:

`sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486`

Published labels were read back exactly:

- `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- `life.celestium.omniroute.candidate-tree=dfa5ef0b9142c57aee9915869620a47eea3bd310`
- `life.celestium.omniroute.diff-sha256=be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080`

An ephemeral container created from the immutable digest bound loopback port 32775. `/healthz` returned HTTP 200 with body `ok`. The container was removed and an exact-name lookup returned empty (`SMOKE_CONTAINER_REMOVED=true`).

## Complete command/attempt record

All source, formatting, test, static-analysis, build, identity, image, and smoke operations ran over SSH on `celes@192.168.42.254`; all git operations used `git -C /home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`.

1. Review-artifact search: no `tier1b-fix-review.json` or `.md`; first iteration.
2. Read `research-503-investigation.md`: PASS; copied section-2 projections.
3. Initial `git status/rev-parse/diff` and `git show HEAD:tierRouting.ts`: PASS; exact base and prior 18 paths.
4. `git grep`/Python source reads for selection, tests, semaphore APIs, package scripts, and types: PASS; established contract and harness identified.
5. First remote edit-script invocation: stopped on an insertion-marker assertion before any write because the source had one extra blank line. Target-file status confirmed no mutation.
6. Corrected edit-script invocation: PASS; the temporary remote and local transport scripts were removed.
7. First format/test command: Prettier passed, then test launch failed because `pnpm` was unavailable in the noninteractive remote PATH. No test executed.
8. Toolchain lookup (`command -v node/npm/npx`): PASS.
9. Second test launch via `npm exec node`: harness failure; npm selected transient Node 26 and could not resolve `tsx` from `/home/celes`. It did not alter package manifests or the final git allowlist.
10. Third test launch with explicit worktree `tsx`: harness failure because TS path aliases resolved without the project tsconfig.
11. Targeted launch with `TSX_TSCONFIG_PATH`: PASS, 4/4.
12. First complete-suite launch from `/home/celes`: 235/238 passed; three unchanged call-log tests failed because their artifact worker requires project-root `process.cwd()`. No changed behavior failed.
13. Identical complete suite through an explicit child process rooted at the project: PASS, 238/238.
14. Lint and `typecheck:core`: PASS in parallel, both exit 0.
15. `check:open-sse-typecheck`: only the documented unrelated `catalog.ts` TS2367 baseline; exit 1 as expected.
16. Production build followed by `git diff --check`: PASS, exit 0.
17. Dedicated exact-payload reproduction and temporary-database cleanup: PASS, GLM 200, 1/1, database absent after teardown.
18. Temporary-index identity computation and exact status assertion: PASS; 20 paths, tree/diff values above, real index untouched.
19. `docker buildx build --push`: PASS; fresh tag and digest above.
20. `docker buildx imagetools inspect` plus label formatting: PASS; immutable digest and exact labels above.
21. Ephemeral digest health smoke: PASS; HTTP 200 `ok`; container removed.
22. Final revision/status/staged/diff-check snapshot: PASS; exact base, exact 20-path allowlist, empty staged diff, no CHANGELOG/changeset, no temporary edit script.

No dependency, package manifest, lockfile, lint suppression file, CHANGELOG, or changeset was changed. No commit, push, deployment, or production mutation occurred.
