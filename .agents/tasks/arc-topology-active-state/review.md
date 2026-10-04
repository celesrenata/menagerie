# Arc embedding/audio nodes in Provider Topology with live active state

The home Provider Topology used to build nodes only from providers that had an active connection, so the connectionless Arc provider-nodes (arc-embed, ovms-arc, arc-whisper, arc-kokoro) never showed up. The embeddings and audio handlers also never emitted the `request.started`/`completed`/`failed` events that light a node. This change adds a small `beginLiveRequest` helper built on the chat path's own terminal-event resolver. That resolver now lives in a dependency-light module, and `attemptLogging` re-exports it. The helper is wired into `handleEmbedding`, the speech route, and the transcription route. The topology merges embeddings/audio provider-nodes in as idle entries keyed by lowercased prefix, keeps the node row id as an alias and as the click-through target, and routes every active/last/error lookup through one alias-aware matcher. ovms-arc gets its own node because it carries most of the Zoo indexing traffic.

Watch for: a node that also has a connection row is keyed by node id, while its handlers emit the prefix, so it never lights (confirmed, latent for today's no-connection Arc nodes). The audio routes finish the live request only after success post-processing, so a throw in that window leaves the node pulsing (confirmed path, low likelihood).

**Verdict**: APPROVED

## High-level view

The lifecycle helper reuses `resolveRequestLifecycleEvent` verbatim, so embedding/audio payloads match chat's: same success rule (2xx/3xx with no error), same sanitized error projection, same id pairing. Emission goes through `setImmediate`, which keeps started-before-terminal ordering, and `finish` is idempotent. Moving the resolver into its own module was needed to keep `typecheck:core` at 0. Re-exporting it from `attemptLogging` leaves chat callers untouched.

Provider ids line up with node keys. Embeddings emits `runtime.provider`, which for dynamic nodes is `node.prefix` (`buildDynamicEmbeddingProvider` sets `id: node.prefix`). Audio emits the parsed provider. That is the prefix when a request uses the prefix form and the node row id when it uses the id form (`audioProviderNodes` registers both). The id form is covered by the alias. Transcription emits the post-alternate-gateway provider, which matches what call logs record.

The topology merge only adds nodes that are not already present. When a connection-backed entry already exists under the node id, the merge skips the node entirely and adds no prefix alias. Prefix-keyed events then miss that entry. Today this is latent, because the plan confirms the Arc nodes have no connections.

Test coverage is focused and lands at the right layer: helper unit tests, a real `handleEmbedding` run, real audio routes against loopback nodes, and pure merge/matcher tests. The full suite's 7 failures were shown to be pre-existing at base `541aa4c0b`. The speech-combo path, `/v1/audio/translations`, and live browser behaviour are explicitly out of scope or deferred to live-verify.

<details>
<summary>Issues (3)</summary>

1. **Connection-backed node never lights**: when an embeddings/audio node already has a topology entry keyed by its node id (it has a connection), `withProviderNodeEntries` skips it without adding the prefix as an alias on the existing entry, so prefix-keyed lifecycle events never match. Add the node prefix to the existing entry's aliases instead of skipping, and flip the `byId` test to assert the alias.
2. **Audio finish after post-processing**: in both audio routes, `live.finish({status:200})` runs after `clearRecoveredProviderState`/`calculateModalCost`/`attachOmniRouteMetaToResponse`. A throw there leaves an unmatched `request.started`, and `useLiveRequests` has no TTL, so the node pulses until reload. Call `finish` right after the handler returns (based on `response.ok`/`status`), or wrap the tail in try/finally.
3. **Speech combos stay dark**: `executeSpeechCombo` returns before `beginLiveRequest`, so TTS through a combo (e.g. a combo targeting arc-kokoro) never lights the node. This is in the plan's scope exclusions. Track it as a follow-up if kokoro is reached through combos.

</details>

<details>
<summary>Details</summary>

### Node keying vs. emitted provider id

```
embeddings: service.ts → buildDynamicEmbeddingProvider(id = prefix) → handleEmbedding → emit provider "arc-embed"
audio:      parseSpeech/TranscriptionModel(dynamicProviders: {id: prefix} + {id: nodeId}) → emit prefix | nodeId
topology:   entry { provider: prefix, aliases: [nodeId], routeId: nodeId }  ← isTopologyEntryInSet matches either
```

This lines up for connectionless nodes. The asymmetry is in the dedupe branch (confirmed, `topologyUtils.ts`, `if (taken.has(key) || (nodeIdKey && taken.has(nodeIdKey))) continue;`). `addProvider` in `HomePageClient` keys connection-backed entries by `normalizeProviderId(conn.provider)`, which is the node id for compatible nodes, and those entries carry no aliases. If an Arc embedding or audio node ever gets a connection row (for example an API key added to arc-whisper behind an authenticating gateway), the merge sees the node id already taken and drops it. The surviving entry's key is the node id, while embeddings always emit the prefix and audio emits the prefix for the common `arc-whisper/...` form. The node renders but never goes active. The existing test `withProviderNodeEntries does not duplicate a node already present by prefix or id` asserts this skip, so it locks in the gap. The fix is small: when the id is taken, add the prefix as an alias on the existing entry instead of skipping.

### Lifecycle completeness in the audio routes

The handler call is wrapped, so thrown errors, a missing response, and non-ok responses all finish. The success branch finishes last, after `clearRecoveredProviderState` (a DB write when credentials carry a `connectionId`), `calculateModalCost`, and `attachOmniRouteMetaToResponse` (confirmed, both routes). None of these are inside the try, so a throw from any of them propagates without a terminal event. `useLiveRequests` holds `active` entries until the matching id arrives and has no expiry, so the node stays lit for the rest of the dashboard session. For today's no-connection Arc nodes the DB call returns early, which keeps this unlikely. It is still the "stuck green" class of bug the chat-side resolver was extracted to fix. `handleEmbedding` does not have this problem, because it finishes immediately around `executeEmbedding`.

### Scope gaps

The speech-combo branch returns before the live request begins, and translations are excluded. Embedding combos go through `handleEmbedding` per target, so they light correctly but omit `comboName`, unlike chat (minor, informational). Image nodes are filtered out of the merge so they don't sit permanently idle. That is consistent with their handlers emitting nothing.

</details>

<details>
<summary>File map</summary>

- `open-sse/utils/liveRequestLifecycle.ts`: new begin/finish helper emitting paired lifecycle events.
- `open-sse/handlers/chatCore/requestLifecycleEvent.ts`: resolver moved here verbatim.
- `open-sse/handlers/chatCore/attemptLogging.ts`: imports and re-exports the resolver.
- `open-sse/handlers/embeddings.ts`: wraps `executeEmbedding` with the live lifecycle.
- `src/app/api/v1/audio/speech/route.ts`, `src/app/api/v1/audio/transcriptions/route.ts`: live lifecycle around the handler call.
- `src/app/(dashboard)/home/topologyUtils.ts`: `withProviderNodeEntries`, `isTopologyEntryInSet`, row/entry types.
- `src/app/(dashboard)/home/ProviderTopology.tsx`: alias-aware rank/state lookups, `routeId` click-through.
- `src/app/(dashboard)/dashboard/HomePageClient.tsx`, `HomeProviderTopologySection.tsx`: merge call and prop pass-through.
- `tests/unit/{live-request-lifecycle-helper,embeddings-live-request-events,audio-live-request-events,topology-provider-nodes-arc}.test.ts`: new coverage.

Full diff: `git show bc64a1293` in `/Users/celes/sources/celesrenata/OmniRoute`.

</details>
