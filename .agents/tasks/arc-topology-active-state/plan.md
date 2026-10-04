# Arc nodes in the home Provider Topology (active / last / error state)

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo`. Work directly on
this branch, no worktree (operator instruction, overrides the repo AGENTS.md worktree rule). Use absolute
paths. No changesets, no CHANGELOG edits. Commit format: Conventional Commits, scope `dashboard` / `sse`,
no AI `Co-Authored-By` trailers (commit-msg hook rejects them).

## Findings (what exploration established)

1. **topologyProviders does NOT include provider-nodes.** `HomePageClient.tsx` `topologyProviders`
   (~line 467) only adds ids via `addProvider()`, which drops any id with no row in
   `providerConnections` (`hasActiveConn`). `providerNodes` (from `/api/provider-nodes`, ~line 286) is
   used only for display labels. The Arc nodes are local no-auth nodes with no connection whose
   `provider` is `arc-embed`, so they are filtered out even when `providerMetrics` (call logs) contains
   `arc-embed`. That is why they never render.
2. **Embeddings and audio handlers emit NO live-request events.** The only emitters of
   `request.started` / `request.completed` / `request.failed` are `open-sse/handlers/chatCore.ts:580`
   (`setImmediate(() => emit("request.started", { id: traceId, model, provider, timestamp, comboName }))`)
   and `open-sse/handlers/chatCore/attemptLogging.ts:630-650` (terminal event built by the exported pure
   `resolveRequestLifecycleEvent()` and emitted via `setImmediate`). `open-sse/handlers/embeddings.ts`,
   `src/app/api/v1/audio/speech/route.ts`, `src/app/api/v1/audio/transcriptions/route.ts` write
   `saveCallLog` only. So `useLiveRequests` (`src/hooks/useLiveDashboard.ts:409-470`, WS channel
   `requests`) never sees Arc traffic and the node can never go "active".
3. **Provider id that would be emitted:**
    - Embeddings: `runtime.provider` = `providerConfig.id`. `buildDynamicEmbeddingProvider`
      (`open-sse/config/embeddingRegistry.ts:61`) and the prefix fallback in
      `src/lib/embeddings/service.ts:~282` both set `id: node.prefix` → `"arc-embed"` / `"ovms-arc"`.
      Matches call logs (`provider=arc-embed`, `model=arc-embed/qwen3-embedding-0.6b`).
    - Audio: `buildDynamicAudioProvider` (`open-sse/config/audioRegistry.ts:659`) sets `id: node.prefix`,
      but `selectAudioProviderNodes` (`src/app/api/v1/_shared/audioProviderNodes.ts`) ALSO registers each
      node under its row id. A request addressed by node id (combos, `/v1/models` ids) therefore emits
      `provider = "openai-compatible-audio-...-<uuid>"`, not the prefix. The topology must alias node id →
      prefix (handled client-side, item 5).
    - Chat (reference): `provider` is the connection provider id (node id for compat chat nodes), which
      matches the connection-keyed topology entries. Chat behaviour is unchanged by this plan.
4. **Last/error state already works for any topology key**: `/api/provider-metrics` returns
   `topology.lastProvider` / `topology.errorProvider` from `getProviderMetrics()` (call_logs `provider`
   column, i.e. `arc-embed`). `ProviderTopology.buildLayout` matches them against the node key, so once
   the node exists (keyed `arc-embed`, aliased by node id) last/error come for free.
5. **File-size gate**: `config/quality/file-size-baseline.json` freezes
   `src/app/(dashboard)/dashboard/HomePageClient.tsx` at 1344 lines (`split("\n").length`, currently
   exactly 1344). Net growth in that file is forbidden, so the merge logic goes in
   `src/app/(dashboard)/home/topologyUtils.ts` and HomePageClient's edit must be net ≤ 0 lines.
   `npm run check:file-size` is already red on this branch for `open-sse/executors/base.ts`,
   `open-sse/handlers/chatCore.ts`, `open-sse/utils/stream.ts` (pre-existing, not ours). Do not touch
   chatCore.ts. Never run the script with `--update`.
6. Recent Requests panel (`HomeRecentRequests.tsx`) polls call-logs, not the WS, so new events do not
   change that panel. Event bus history is capped at 100, so embedding bursts are bounded.

## Decisions

- **Which nodes become topology nodes**: every provider-node whose `apiType` is `embeddings`,
  `audio-speech`, or `audio-transcriptions` and has a non-empty `prefix`, keyed by lowercased prefix,
  labelled with `node.name`. These are exactly the types whose handlers emit lifecycle events after this
  change. `chat`/`responses` nodes stay connection-driven (unchanged); `images-generations` is excluded
  because image handlers emit no events, so the node could never light up.
- **ovms-arc ("Arc OVMS (zoo alias)") is shown as its own node.** It is the prefix the Zoo editor
  indexing uses, so most real embedding traffic is logged as `ovms-arc`. Hiding or folding it into
  `arc-embed` would leave Arc looking idle while it is busy, and folding would need a baseUrl-host
  heuristic. One node per prefix keeps the rule simple and truthful.
- **Rest state for these nodes is `"idle"`** (grey). They have no connection test, so there is no
  honest "connected" signal; live traffic → active (pulse), recent → amber dot, most recent failed →
  red, exactly like other providers.
- **Alias matching lives on the entry**: entries carry optional `aliases?: string[]` (node row id) and
  `routeId?: string` (node row id, for click-through). `ProviderTopology` checks provider key OR any
  alias against active/last/error sets. This avoids threading providerNodes into the section/hook.
- **Event emission helper**: one small shared helper reused by embeddings + both audio routes, built on
  the existing `resolveRequestLifecycleEvent` so payloads match chat byte-for-byte. Emission is at the
  single-target dispatch point, so combos emit once per attempted target (same as chat).
- **Scope exclusions** (documented, not done): `/v1/audio/translations`, the speech combo path
  (`executeSpeechCombo`), images, rerank.

## Implementation Plan

Common test command prefix (matches `npm run test:unit`):
`DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit <files>`
(run from `/Users/celes/sources/celesrenata/OmniRoute`). Referred to below as `RUN <files>`.

- [ ]   1. Add the shared live-request lifecycle helper.
       Create `open-sse/utils/liveRequestLifecycle.ts` exporting
       `beginLiveRequest(input: { provider: string; model?: string | null; comboName?: string }):
{ id: string; finish(outcome: { status: number; error?: string | null; tokens?: unknown }): void }`.
       `id = globalThis.crypto.randomUUID()`; `startTime = Date.now()`; emit `request.started`
       (`{ id, model: model || "unknown", provider: provider || "unknown", timestamp: startTime, comboName }`)
       via `setImmediate`, mirroring chatCore.ts:579-587. `finish` is idempotent (second call is a no-op),
       builds the terminal event with `resolveRequestLifecycleEvent({ traceId: id, status, error, model,
provider, comboName, tokens, latencyMs: Date.now() - startTime })` imported from
       `../handlers/chatCore/attemptLogging.ts`, and emits it via `setImmediate` (FIFO after started). Import
       `emit` from `@/lib/events/eventBus`. Wrap emission in try/catch so it never throws into the request
       path. No `any`.
       Add `tests/unit/live-request-lifecycle-helper.test.ts`: subscribe with `on()` from
       `src/lib/events/eventBus.ts` (unsubscribe in `finally`), await `new Promise(setImmediate)` twice, assert:
       started then completed share the same id and `provider === "arc-embed"`; status 500 + error →
       `request.failed` with `statusCode 500` and the same id; calling `finish` twice emits one terminal event.
       Files: `open-sse/utils/liveRequestLifecycle.ts`, `tests/unit/live-request-lifecycle-helper.test.ts`
       Verify: `RUN tests/unit/live-request-lifecycle-helper.test.ts tests/unit/topology-request-lifecycle-emit.test.ts` passes.

- [ ]   2. Emit lifecycle events from the embeddings handler (depends on 1).
       In `open-sse/handlers/embeddings.ts` `handleEmbedding()` (line ~740), after `prepared` succeeds and
       the info log, replace `return executeEmbedding(runtime, prepared);` with: begin
       `beginLiveRequest({ provider: runtime.provider, model: runtime.model || String(runtime.body.model) })`,
       `await executeEmbedding(...)` inside try/catch (on throw: `finish({ status: 500, error: message })`
       then rethrow), then `finish({ status: result.success ? 200 : result.status, error: result.success ?
null : result.error, tokens: result.success ? result.data.usage : undefined })` and return the result.
       Do not emit for early returns before dispatch (validation/modalities/prepare failures), matching chat.
       This covers `/v1/embeddings`, `/v1/providers/[provider]/embeddings`, embedding combos, and internal
       memory/qdrant callers (all go through `handleEmbedding`).
       Add `tests/unit/embeddings-live-request-events.test.ts` modelled on
       `tests/unit/embeddings-flatten-single-row-9089.test.ts` (temp `DATA_DIR`, `globalThis.fetch` mock,
       `resolvedProvider: { id: "arc-embed", baseUrl: "http://localhost:8000/v3/embeddings", authType:
"none", authHeader: "none", models: [] }`): success → `request.started` + `request.completed` with
       `provider "arc-embed"` and equal ids; upstream 500 → `request.failed` with `provider "arc-embed"`,
       `statusCode 500`, same id as the started event.
       Files: `open-sse/handlers/embeddings.ts`, `tests/unit/embeddings-live-request-events.test.ts`
       Verify: `RUN tests/unit/embeddings-live-request-events.test.ts tests/unit/embeddings-*.test.ts tests/unit/embedding-*.test.ts tests/unit/10347-embed-402-cooldown.test.ts tests/unit/13601-embed-retry.test.ts` all pass.

- [ ]   3. Emit lifecycle events from `/v1/audio/speech` and `/v1/audio/transcriptions` (depends on 1).
       Speech (`src/app/api/v1/audio/speech/route.ts`): immediately before `handleAudioSpeech(...)`, begin
       with `{ provider, model: resolvedModel || body.model }`; wrap the handler call in try/catch (throw →
       finish 500 + rethrow); in the `response?.ok` branch call `finish({ status: 200 })`, in the error
       branch `finish({ status: response.status, error: errorText.slice(0, 500) || \`HTTP ${status}\` })`,
and if `response`is falsy`finish({ status: 502, error: "No response" })`.
Transcriptions (`src/app/api/v1/audio/transcriptions/route.ts` `transcribeWithModel`): same pattern
immediately before `handleAudioTranscription(...)`(~line 162), using the final`provider`value
(after the alternate-gateway reassignment at ~line 140) and`resolvedModel`; finish in the same two
saveCallLog branches. Combo transcription targets go through `transcribeWithModel`, so they are covered.
Add `tests/unit/audio-live-request-events.test.ts`modelled on`tests/unit/audio-transcriptions-combo-resolution.test.ts`(temp`DATA_DIR`, `createProviderNode`for
prefix`arc-kokoro`apiType`audio-speech`and prefix`arc-whisper`apiType`audio-transcriptions`,
both `baseUrl: "http://localhost:18999/v1"`so they pass`isLoopbackNodeHost`; `globalThis.fetch`mock returning audio bytes /`{ text: "hi" }`; reuse its `makeWav()`approach). Assert: speech POST`model: "arc-kokoro/kokoro"`→ started+completed with`provider "arc-kokoro"`; transcription POST
`model: "arc-whisper/distil-whisper-large-v3-int8-ov"`→ started+completed with`provider
       "arc-whisper"`; an upstream 500 on speech → `request.failed`. Check how existing route tests call the
`withInjectionGuard`-wrapped speech `POST`(see`tests/unit/media-cost-headers-handlers.test.ts`).
Files: `src/app/api/v1/audio/speech/route.ts`, `src/app/api/v1/audio/transcriptions/route.ts`,
`tests/unit/audio-live-request-events.test.ts`Verify:`RUN tests/unit/audio-live-request-events.test.ts tests/unit/audio-\*.test.ts tests/unit/media-cost-headers-handlers.test.ts tests/unit/issue-6686-quota-preflight-coverage.test.ts` all pass.

- [ ]   4. Add pure topology helpers in `src/app/(dashboard)/home/topologyUtils.ts` (independent of 1-3).
       Add (keep the file free of React/browser imports):
        - `export type TopologyNodeRow = { id?: string; prefix?: string; name?: string; apiType?: string | null }`
        - `export type TopologyEntry = { id: string; provider: string; name?: string; status?: "active" | "error" | "idle"; aliases?: string[]; routeId?: string }`
        - `const TOPOLOGY_NODE_API_TYPES = new Set(["embeddings", "audio-speech", "audio-transcriptions"])`
        - `export function withProviderNodeEntries<T extends TopologyEntry>(entries: T[], nodes: TopologyNodeRow[] | null | undefined): Array<T | TopologyEntry>`:
          returns a NEW array = entries + one entry per qualifying node (apiType in the set, trimmed prefix
          non-empty), key = `prefix.trim().toLowerCase()`, `name = node.name?.trim() || prefix`, `status:
"idle"`, `aliases = [id.toLowerCase()]` when `id` differs from key, `routeId = node.id`. Skip a node
          when an existing entry's `provider` (lowercased) or any alias equals the key or the node id; dedupe
          nodes against each other. Never mutate inputs.
        - `export function isTopologyEntryInSet(entry: { provider: string; aliases?: string[] }, set: Set<string>): boolean`
          → true if `set` has `entry.provider.toLowerCase()` or any lowercased alias.
          Add `tests/unit/topology-provider-nodes-arc.test.ts` with the real node shapes (arc-embed id
          `openai-compatible-embeddings-1710a12f-6af6-4052-8f0b-a3c17175dabb` name "Arc Embeddings"; ovms-arc
          id `openai-compatible-embeddings-8a59c128-2c08-45bb-8aae-554a2440bd00` name "Arc OVMS (zoo alias)";
          arc-whisper `audio-transcriptions` "Arc Whisper"; arc-kokoro `audio-speech` "Arc Kokoro"; plus a
          `chat` node and an `images-generations` node). Cover: all four Arc nodes added with names, idle
          status, alias + routeId = node id; chat/images/prefix-less nodes skipped; an existing entry keyed
          `arc-embed` (or by node id) is not duplicated; inputs not mutated; `isTopologyEntryInSet` matches
          `arc-embed`, `arc-kokoro`, `arc-whisper` by prefix, matches the arc-whisper entry when the set holds
          its node id (audio-by-id case), is case-insensitive, and does not match unrelated ids.
          Files: `src/app/(dashboard)/home/topologyUtils.ts`, `tests/unit/topology-provider-nodes-arc.test.ts`
          Verify: `RUN tests/unit/topology-provider-nodes-arc.test.ts tests/unit/topology-active-requests-3507.test.ts` pass.

- [ ]   5. Use alias-aware matching and click routing in `ProviderTopology` (depends on 4).
       In `src/app/(dashboard)/home/ProviderTopology.tsx`: extend `ProviderEntry` with `aliases?: string[];
routeId?: string`; in `buildLayout` replace every `activeSet.has(id|pid)`, `errorSet.has(...)`,
       `lastSet.has(...)` with `isTopologyEntryInSet(p, <set>)` (rank sort and per-node state). Add
       `routeId?: string` to `ProviderNodeData`, set it from `p.routeId`, and in `handleNodeClick` resolve
       `const providerId = data?.routeId || data?.providerId || node.id.replace(/^provider-/, "")` keeping the
       existing `router.push(\`/dashboard/providers/${providerId}\`)`line verbatim (guarded by`tests/unit/topology-filtering-and-click.test.ts`). In
`src/app/(dashboard)/dashboard/HomeProviderTopologySection.tsx`add`aliases?: string[]; routeId?:
       string`to`TopologyProvider`(pass-through only).
Needs verification during implementation: that`/dashboard/providers/<node-id>`opens the node's
page for an embeddings/audio provider-node; if it 404s, fall back to`/dashboard/providers`(fix only
if confirmed).
Add one source-guard assertion to`tests/unit/topology-provider-nodes-arc.test.ts`that
ProviderTopology.tsx uses`isTopologyEntryInSet(p, activeSet)`.
Files: `src/app/(dashboard)/home/ProviderTopology.tsx`, `src/app/(dashboard)/dashboard/HomeProviderTopologySection.tsx`, `tests/unit/topology-provider-nodes-arc.test.ts`Verify:`RUN tests/unit/topology-\*.test.ts tests/unit/8328-topology-custom-providers.test.ts tests/unit/home-provider-topology-default-4596.test.ts tests/unit/ui/edgeStyles.test.ts tests/unit/ui/home-provider-topology-section-4606.test.tsx tests/unit/ui/home-topology-last-used-node-color.test.tsx` all pass.

- [ ]   6. Merge provider-nodes into `topologyProviders` in HomePageClient with net ≤ 0 lines (depends on 4, 5).
       In `src/app/(dashboard)/dashboard/HomePageClient.tsx`:
        - add `import { withProviderNodeEntries, type TopologyNodeRow } from "../home/topologyUtils";`
          (must fit on one line, printWidth 100);
        - collapse the 3-line `useState<Array<{ id?: string; prefix?: string; name?: string }>>` (lines
          ~134-136) to `useState<TopologyNodeRow[]>([])` (TopologyNodeRow is a superset, so
          `getProviderDisplayLabel(rawProviderId, providerNodes)` still type-checks);
        - change `return Array.from(byProvider.values());` to
          `return withProviderNodeEntries(Array.from(byProvider.values()), providerNodes);`.
          Keep the deps line `}, [providerStats, providerMetrics, providerNodes, providerConnections]);` and the
          `healthByProvider` / `hasActiveConn` code byte-identical (regex-guarded by
          `tests/unit/topology-connection-health.test.ts` and `tests/unit/topology-filtering-and-click.test.ts`).
          Add a source-guard assertion in `tests/unit/topology-provider-nodes-arc.test.ts` that HomePageClient
          calls `withProviderNodeEntries(`.
          Files: `src/app/(dashboard)/dashboard/HomePageClient.tsx`, `tests/unit/topology-provider-nodes-arc.test.ts`
          Verify: `npm run check:file-size` shows NO line for HomePageClient.tsx (the three pre-existing
          violations listed in Findings §5 are expected and not ours); `RUN tests/unit/topology-*.test.ts
tests/unit/home-page-client-hook-imports-4759.test.ts tests/unit/ui/home-page-client-dashboard-smoke-4615.test.tsx` pass.

- [ ]   7. Full static + regression verification.
       Run from the repo root:
        - `npm run typecheck:core` and `npm run check:dashboard-typecheck` → no new errors in touched files.
        - `npx eslint --suppressions-location config/quality/eslint-suppressions.json <every touched/new file>`
          → clean, no new suppressions (fix violations; no `as any`; tests must not use `any`).
        - `npx prettier --check <touched files>`.
        - `npm run test:unit` → passes (or only failures that also fail on `git stash`-clean HEAD; record
          them). If the full suite is too slow, at minimum run every command from items 1-6 plus
          `RUN tests/unit/topology-request-lifecycle-emit.test.ts`.
          Files: none new.
          Verify: commands above succeed; record command output summary in the review evidence.

## Live verification notes (for the commit / deploy / live-verify steps)

- Orchestrator correction (authoritative): **the arc-whisper backend IS deployed and healthy.** The
  `speaches` StatefulSet in namespace `speaches-service` has 4/4 pods (OVMS distil-whisper behind an nginx
  v1-compat proxy), reachable from the omniroute pod at
  `http://speaches.speaches-service.svc.cluster.local:8000/v1/models` (model id
  `distil-whisper-large-v3-int8-ov`). In live-verify, `POST /v1/audio/transcriptions` (multipart `file` +
  `model=arc-whisper/distil-whisper-large-v3-int8-ov`) must return 200 and light up the arc-whisper node.
  Treat any failure as a real bug to report, not an expected error. Get a test clip by calling arc-kokoro
  `POST /v1/audio/speech` first.
- Needs verification during live-verify: audio provider-nodes with a `*.svc.cluster.local` baseUrl are
  NOT loopback per `src/shared/network/loopbackNodeHost.ts` (only localhost/127.0.0.1/172.16/12), so they
  are only routable when feature flag `AUDIO_REMOTE_PROVIDER_NODES` is enabled (env or DB override,
  `src/shared/utils/featureFlags.ts`). If transcription/speech returns
  `400 Invalid ... model` / `No credentials for provider`, check that flag first and report it; changing
  the deployed flag is a deployment config change, so describe it to the user rather than flipping it
  silently. Embedding nodes use `isPrivateHost` and are unaffected.
- Expected dashboard result after deploy: Provider Topology shows "Arc Embeddings", "Arc OVMS (zoo
  alias)", "Arc Whisper", "Arc Kokoro" nodes (grey at rest); each pulses green while a request is in
  flight, gets the amber dot when it was the most recent call, and red when its latest call failed.
  Fire an embedding (`arc-embed/qwen3-embedding-0.6b`), a speech call and a transcription call and watch
  each node light. The live WS must be connected (`/api/v1/ws` handshake) for the pulse.
