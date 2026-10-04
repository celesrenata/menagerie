# Verification — arc-topology-active-state (iteration 1)

Repo `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo`. No review.json existed → first iteration, implemented from plan.md.

## Commit state (read this first)

The step said "commit nothing yet". While the full `test:unit` run was in progress, an external actor (author "Celes Hillyerd", 00:39:14) committed the
exact working-tree changes from this step as `bc64a1293 feat(dashboard): show Arc embedding/audio nodes in topology with live active state`
(14 files, +820/−88). It then fast-forwarded `fix/priority-tier-ceiling` (`d5de1f49e`, unrelated combo work) onto the branch. I did not
create either commit. The working tree is clean, and `bc64a1293` is the full deliverable of this step.

## Changes (all in bc64a1293)

- `open-sse/utils/liveRequestLifecycle.ts` (new): `beginLiveRequest({provider, model, comboName})` → `{ id, finish({status, error, tokens}) }`.
  It emits `request.started` and then exactly one `request.completed`/`request.failed` (idempotent `finish`) via `setImmediate`, wrapped in try/catch.
- `open-sse/handlers/chatCore/requestLifecycleEvent.ts` (new): `resolveRequestLifecycleEvent` was moved here verbatim from `attemptLogging.ts`.
  `attemptLogging.ts` imports it and re-exports it (existing imports and tests are unchanged, and chat behaviour is byte-identical).
  **Deviation from plan:** the plan imported the resolver straight from `attemptLogging.ts`. Doing that pulled the executor graph into
  `tsconfig.typecheck-core.json` (via `src/lib/db/providers.ts` → … → embeddings) and took `typecheck:core` from 0 to 46 errors in
  executors/default.ts, auggie.ts, etc. The dependency-light module brings it back to 0.
- `open-sse/handlers/embeddings.ts` `handleEmbedding`: wraps `executeEmbedding` with begin/finish (provider = `runtime.provider` = node prefix, e.g. `arc-embed`).
  No events are emitted for the pre-dispatch early returns, which matches chat.
- `src/app/api/v1/audio/speech/route.ts` and `transcriptions/route.ts` (`transcribeWithModel`): begin before the handler call. They finish 200 on ok,
  finish `response.status` + error text on failure, finish 502 when there is no response, and finish 500 + rethrow on throw. Provider = parsed
  provider (prefix, or the post-alternate-gateway provider for transcriptions).
- `src/app/(dashboard)/home/topologyUtils.ts`: `TopologyNodeRow`, `TopologyEntry`, `withProviderNodeEntries()` (embeddings / audio-speech /
  audio-transcriptions nodes with a prefix, keyed by lowercased prefix, `status:"idle"`, `aliases=[nodeId]`, `routeId=nodeId`, deduped),
  and `isTopologyEntryInSet()`.
- `ProviderTopology.tsx`: every active/last/error lookup (rank + per-node state) now goes through `isTopologyEntryInSet`. The click handler uses
  `data.routeId || data.providerId || …`, and the `router.push` line is unchanged.
- `HomeProviderTopologySection.tsx`: pass-through `aliases?`/`routeId?` on `TopologyProvider`.
- `HomePageClient.tsx`: imports the helper, `useState<TopologyNodeRow[]>`, returns `withProviderNodeEntries(Array.from(byProvider.values()), providerNodes)`.
  The file shrank by 2 lines (1344→1342 by split). The deps line and the health/hasActiveConn code are untouched.
- ovms-arc is shown as its own node, per the plan's decision.
- Click-through: node ids start with `openai-compatible-`. `providers/[id]/ProviderDetailPageClient.tsx` treats those as compatible nodes
  (`isOpenAICompatibleProvider`), so `/dashboard/providers/<node-id>` should open the node page. I checked this by reading the code. It has not been verified in a browser.

## Commands run (from repo root) and results

`RUN` = `env DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit`

| Command                                                                                                                                                                                                                                                 | Result                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUN tests/unit/live-request-lifecycle-helper.test.ts tests/unit/topology-request-lifecycle-emit.test.ts tests/unit/embeddings-live-request-events.test.ts tests/unit/audio-live-request-events.test.ts tests/unit/topology-provider-nodes-arc.test.ts` | 22/22 pass                                                                                                                                   |
| `RUN tests/unit/embeddings-*.test.ts tests/unit/embedding-*.test.ts tests/unit/10347-embed-402-cooldown.test.ts tests/unit/13601-embed-retry.test.ts`                                                                                                   | 113/113 pass                                                                                                                                 |
| `RUN tests/unit/audio-*.test.ts tests/unit/media-cost-headers-handlers.test.ts tests/unit/issue-6686-quota-preflight-coverage.test.ts`                                                                                                                  | 132/132 pass                                                                                                                                 |
| `RUN tests/unit/topology-*.test.ts tests/unit/8328-topology-custom-providers.test.ts tests/unit/home-provider-topology-default-4596.test.ts tests/unit/ui/edgeStyles.test.ts tests/unit/home-page-client-hook-imports-4759.test.ts`                     | 46/46 pass                                                                                                                                   |
| `RUN` on every test importing attemptLogging (chatcore-attempt-logging, attempt-logging-_, video-bridge-_, call-log-in-memory-usage, chatcore-translation-paths, call-logs-id-collision, responses-continuation-passthrough-client-payload)             | 138/138 pass                                                                                                                                 |
| `npx vitest run --config vitest.config.ts tests/unit/ui/home-page-client-dashboard-smoke-4615.test.tsx tests/unit/ui/home-provider-topology-section-4606.test.tsx tests/unit/ui/home-topology-last-used-node-color.test.tsx`                            | 3 files / 5 tests pass (these `.tsx` files are vitest-only and fail by design under `node --test`, which is not part of `test:unit`'s globs) |
| `npm run typecheck:core`                                                                                                                                                                                                                                | exit 0, 0 errors                                                                                                                             |
| `npm run check:dashboard-typecheck`                                                                                                                                                                                                                     | OK — 196 pre-existing errors, all within frozen baseline                                                                                     |
| `npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0 <14 touched/new files>`                                                                                                                                    | clean; `config/quality/eslint-suppressions.json` unchanged                                                                                   |
| `npx prettier --check <14 touched/new files>`                                                                                                                                                                                                           | all formatted                                                                                                                                |
| `npm run check:file-size`                                                                                                                                                                                                                               | 3 violations, all pre-existing per plan §5 (`executors/base.ts`, `handlers/chatCore.ts`, `utils/stream.ts`); none for touched files          |
| `npm run test:unit` (full)                                                                                                                                                                                                                              | 44976 tests: 44940 pass, 7 fail, exit 1                                                                                                      |

### The 7 full-suite failures are pre-existing

These files fail the same 7 tests (95 tests: 88 pass, 7 fail) in a temporary detached worktree at the pre-change base `541aa4c0b`
(since removed): `api/v1/relay-completions-errors`, `binaryManager`, `call-log-file-rotation`, `check-provider-asset-provenance`,
`cli-runtime-detection`, `provider-node-reserved-prefix`, `provider-translate-path-golden`. None of them touch the code changed here.

## Tests added

- `tests/unit/live-request-lifecycle-helper.test.ts`: started→completed share an id with provider `arc-embed`; 500 → `request.failed` statusCode 500; `finish` is idempotent.
- `tests/unit/embeddings-live-request-events.test.ts`: `handleEmbedding` with an `arc-embed` provider. Success → started + completed with the same id; upstream 500 → failed, statusCode 500, same id.
- `tests/unit/audio-live-request-events.test.ts`: real routes with `arc-kokoro`/`arc-whisper` loopback provider-nodes. Speech success → completed; speech upstream 500 → failed; transcription → completed with provider `arc-whisper`.
- `tests/unit/topology-provider-nodes-arc.test.ts`: the merge adds all four Arc nodes (names, idle, alias/routeId), skips chat/images/prefix-less nodes, does not duplicate by prefix or id, and does not mutate inputs. Active-set matching covers arc-embed/kokoro/whisper by prefix, by node-id alias, case-insensitively, and does not match unrelated ids. Source guards cover ProviderTopology and HomePageClient.

## Not verified

- Live dashboard behaviour (WS pulse in a browser) and the deployed `AUDIO_REMOTE_PROVIDER_NODES` flag for `*.svc.cluster.local` audio nodes. Both are left to the live-verify step, per the plan's notes.
- Scope exclusions, per plan: `/v1/audio/translations`, the speech-combo path (`executeSpeechCombo`), images, rerank.
