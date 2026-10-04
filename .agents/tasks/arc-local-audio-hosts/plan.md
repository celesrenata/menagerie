# Implementation Plan: honor OMNIROUTE_LOCAL_AUDIO_HOSTS for Arc audio nodes

Repo: `/Users/celes/sources/celesrenata/OmniRoute` (branch `feat/hybrid-reader-combo`, no worktree; HEAD `d5de1f49e`).
Always use absolute paths or `cd` into the repo. Relative paths resolve to the menagerie workspace.

Focused test command (run from the repo root; the same flags `npm run test:unit` uses):

```
node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit <files>
```

Below, `TEST <files>` means that command.

## Facts confirmed during exploration

- The live deployment env is `OMNIROUTE_LOCAL_AUDIO_HOSTS=kokoro-tts.kokoro-service.svc.cluster.local,speaches.speaches-service.svc.cluster.local`, read via `kubectl -n omniroute get deploy omniroute`. It is not in `/Users/celes/sources/kube/omniroute/omniroute.yaml`, so it is set some other way (patched or applied separately). The entries are exact hostnames, so exact matching is enough. There is no wildcard or suffix support.
- Nothing reads the variable today.
- `open-sse/config/audioRegistry.ts` is imported by a client component (`src/app/(dashboard)/dashboard/cache/media/MediaPageClient.tsx`). The new code there must stay pure: no `node:` imports and no `@/lib/env` imports. Guard with `typeof process !== "undefined"`.
- Sibling open-sse modules read env directly with `process.env.X?.trim()` (for example `open-sse/config/providerPluginManifestUrl.ts`). `src/lib/env/runtimeEnv.ts` is a startup validator that pulls in `secretsValidator`, so it is not usable from open-sse.
- When `authType === "none"`, every audio handler throws the credential away (`open-sse/handlers/audioSpeech.ts:877`, `audioTranscription.ts:913`, `audioTranslation.ts:92`). So "if a key is configured, still send it" cannot be expressed as `authType: "none"`. `buildAuthHeaders` (`open-sse/config/registryUtils.ts:114`) already returns `{}` when the token is null.
- Credential-gate call sites for dynamic audio providers: the speech route (`:90`), the transcriptions route (`:121`, which also has an alternate-gateway fallback), the translations route (`:88`), and `open-sse/services/speechCombo.ts:98`.
- `beginLiveRequest().finish` is idempotent (`open-sse/utils/liveRequestLifecycle.ts`).
- Env vars are contract-checked by `scripts/check/check-env-doc-sync.mjs` (`npm run check:env-doc-sync`). A new var must be added to both `.env.example` (next to `AUDIO_REMOTE_PROVIDER_NODES`, around line 2855) and `docs/reference/ENVIRONMENT.md` (around line 248).

## Design decisions

1. **Allowlist helper lives in `audioRegistry.ts`.** It is a pure parser plus a matcher, and the raw env string is read at call time. The parsed `Set` is memoized against the raw string, so the env is parsed only once per distinct value, and tests can still change `process.env` between cases. This matches how open-sse reads env elsewhere and keeps the module safe for the browser bundle.
2. **Matching rules.** Entries are split on `,`, then trimmed and lowercased; empty entries are dropped. An entry with no port matches `URL.hostname` exactly. An entry of the form `host:port` matches `URL.host` exactly (lowercased). URLs that carry `username`/`password` never match, which mirrors the SSRF rule in `loopbackNodeHost.ts`, and neither does any protocol other than `http:`/`https:`. There is no wildcard or suffix matching. `src/shared/network/loopbackNodeHost.ts` stays unchanged.
3. **Allowlisted nodes use optional credentials, not `authType: "none"`.** `buildDynamicAudioProvider` builds an allowlisted non-loopback node as `authType: "apikey"`, `authHeader: "bearer"`, `credentialsOptional: true`. Routes and handlers then use a connection key if one exists, and otherwise go ahead unauthenticated. Loopback nodes keep `authType: "none"`. Non-allowlisted remote nodes keep today's required-key behaviour. This is the only shape that meets both parts of the brief: no credentials required, and a configured key is still sent.
4. **Live-request tail.** Add a small helper `runLiveRequestTail(live, tail)` to `liveRequestLifecycle.ts`. It awaits `tail()`; on a throw it calls `live.finish({ status: 500, error })` and rethrows. Because `finish` is idempotent, normal finishes inside the tail still win. The helper makes "finish on error" directly unit-testable, which the routes' real post-processing (it never throws naturally) does not allow. This is the reviewer's try/finally guarantee, written as catch-and-rethrow so the error message is kept.
5. **Topology alias gap (finding 1) is small, so fix it.** In `withProviderNodeEntries`, when a node's prefix is not taken but its node id is already taken by an existing entry, replace that entry in `result` with a copy that has the prefix added to its `aliases`, instead of skipping it. Inputs are not mutated. A node whose prefix is already taken is still skipped, as today. That keeps the existing `dupNodes` assertion valid.
6. **No workflow restructure.** The work is about 4 tightly coupled small items in one repo. The existing implement/review loop handles it.

## Items

- [ ]   1. Add the allowlist helpers and use them for selection and provider build.
       In `open-sse/config/audioRegistry.ts`:
        - Export `LOCAL_AUDIO_HOSTS_ENV = "OMNIROUTE_LOCAL_AUDIO_HOSTS"`.
        - Export `parseLocalAudioHosts(raw: string | undefined | null): Set<string>`, following decision 2.
        - Export `isAllowlistedLocalAudioHost(baseUrl: string, raw = readLocalAudioHostsEnv()): boolean`. The private `readLocalAudioHostsEnv()` returns `typeof process !== "undefined" ? process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS : undefined`. The parse is memoized by raw string.
        - Export `isLocalAudioNodeHost(baseUrl) = isLoopbackNodeHost(baseUrl) || isAllowlistedLocalAudioHost(baseUrl)`.
        - Add `credentialsOptional?: boolean` to `AudioProvider` with a doc comment.
        - In `buildDynamicAudioProvider`: if the node is loopback, keep `authType`/`authHeader` as `"none"`. Else, if it is allowlisted, use `"apikey"`/`"bearer"` with `credentialsOptional: true`. Else use `"apikey"`/`"bearer"` (unchanged). Update the JSDoc.

        In `src/app/api/v1/_shared/audioProviderNodes.ts`:
        - Replace `export { isLoopbackNodeHost as isLocalAudioNodeHost }` with a re-export of the new `isLocalAudioNodeHost`.
        - Change the filter to `return isLocalAudioNodeHost(node.baseUrl) || allowRemote;`.
        - Update the header comment, axis 2, to mention the allowlist.

        Add docs for `OMNIROUTE_LOCAL_AUDIO_HOSTS`:
        - In `.env.example`, a commented example next to `AUDIO_REMOTE_PROVIDER_NODES`.
        - In `docs/reference/ENVIRONMENT.md`, a table row next to `AUDIO_REMOTE_PROVIDER_NODES`: default empty, source `open-sse/config/audioRegistry.ts`. Describe it as "comma-separated exact hostnames (optionally host:port) treated as local for /v1/audio/\* provider nodes: eligible without AUDIO_REMOTE_PROVIDER_NODES and no credential required; a configured connection key is still sent".

        New test file `tests/unit/audio-local-hosts-allowlist.test.ts`. Save and restore `process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS` in `afterEach`. Cases:
        - Parser: `undefined`/`""`/`" , ,"` give an empty set; `" Kokoro-TTS.kokoro-service.svc.cluster.local , speaches.speaches-service.svc.cluster.local:8000 ,"` gives the two lowercased entries.
        - Matcher: the exact hostname matches at any port; a `host:port` entry matches only that port; `evil-kokoro-tts.kokoro-service.svc.cluster.local` and `kokoro-tts.kokoro-service.svc.cluster.local.evil.com` do not match; `http://user:pw@kokoro-tts...` does not match; `ftp://` does not match; a malformed URL returns false.
        - `isLocalAudioNodeHost` is still true for `localhost` and false for `[::1]` when the env is unset.
        - Selection: with the env set to the live value and `allowRemote: false`, `selectAudioProviderNodes` admits an `audio-speech` node at `http://kokoro-tts.kokoro-service.svc.cluster.local:8880/v1`, under both prefix and id. With the same flag off, it still rejects `https://stt.example.com/v1`. With the env unset, the cluster node is rejected.
        - Build: for the allowlisted node, `buildDynamicAudioProvider` gives `credentialsOptional === true`, `authHeader === "bearer"`, and `credentialProviderId === node.id`. A non-allowlisted remote node has no `credentialsOptional`. A loopback node keeps `authType "none"`.

        Files: `open-sse/config/audioRegistry.ts`, `src/app/api/v1/_shared/audioProviderNodes.ts`, `.env.example`, `docs/reference/ENVIRONMENT.md`, `tests/unit/audio-local-hosts-allowlist.test.ts`
        Verify:
        - `TEST tests/unit/audio-local-hosts-allowlist.test.ts tests/unit/audio-provider-nodes-selection.test.ts tests/unit/audio-speech-dynamic-node-9096.test.ts` all pass (the existing selection tests are unchanged).
        - `npm run check:env-doc-sync` exits 0.

- [ ]   2. Honor `credentialsOptional` at every credential gate, so allowlisted nodes need no connection. Depends on 1.
       Routes:
        - In `src/app/api/v1/audio/speech/route.ts`, `src/app/api/v1/audio/translations/route.ts`, and `open-sse/services/speechCombo.ts`: inside the existing `authType !== "none"` block, after the credential lookup, treat `!credentials && providerConfig.credentialsOptional` as "proceed with `credentials = null`" instead of returning or recording the "No credentials" error. In speechCombo, a lookup that throws for an optional node also proceeds with null. Keep the rate-limited check for credentials that were found.
        - In `src/app/api/v1/audio/transcriptions/route.ts`: the same, but skip the alternate-gateway fallback when `credentialsOptional` (the allowlisted node is the intended target).

        Handlers:
        - In `open-sse/handlers/audioSpeech.ts:878`, `audioTranscription.ts:914`, and `audioTranslation.ts:93`: add `&& !providerConfig.credentialsOptional` to the missing-token 401 guard. The token expression stays `credentials?.apiKey || credentials?.accessToken`, and `buildAuthHeaders` already drops the header when the token is null.

        New test file `tests/unit/audio-local-hosts-routes.test.ts`, modelled on `tests/unit/audio-live-request-events.test.ts` (temp `DATA_DIR`, `createProviderNode`, `globalThis.fetch` stub capturing the request headers):
        - Set `process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS = "kokoro-tts.kokoro-service.svc.cluster.local,speaches.speaches-service.svc.cluster.local"` before importing routes.
        - Create the nodes `arc-kokoro` (`audio-speech`, `http://kokoro-tts.kokoro-service.svc.cluster.local:8880/v1`) and `arc-whisper` (`audio-transcriptions`, `http://speaches.speaches-service.svc.cluster.local:8000/v1`). Leave the feature flag at its default (off).
        - Speech with no connection: HTTP 200, the fetch went to `http://kokoro-tts.kokoro-service.svc.cluster.local:8880/v1/audio/speech`, and there is no `Authorization` header.
        - Transcription with model `arc-whisper/distil-whisper-large-v3-int8-ov`: HTTP 200, no `Authorization` header.
        - After `createProviderConnection({ provider: <arc-kokoro node id>, authType: "apikey", apiKey: "sk-local-test", isActive: true, testStatus: "active", priority: 1, name: "arc-kokoro-key" })` (shape from `tests/unit/10085-compatible-generic-vs-uuid-credential.test.ts`), speech sends `Authorization: Bearer sk-local-test`.
        - A node on a non-allowlisted host (`http://stt.example.test/v1`) is still rejected with HTTP 400.

        Files: the 3 routes, `open-sse/services/speechCombo.ts`, the 3 handlers, `tests/unit/audio-local-hosts-routes.test.ts`
        Verify: `TEST tests/unit/audio-local-hosts-routes.test.ts tests/unit/audio-live-request-events.test.ts tests/unit/audio-speech-handler.test.ts tests/unit/audio-transcription-handler.test.ts tests/unit/audio-translations-route.test.ts tests/unit/audio-nested-model-credential-fallback.test.ts tests/unit/9134-repro-audio-combo-rejection.test.ts tests/unit/issue-6686-quota-preflight-coverage.test.ts` all pass.

- [ ]   3. Always complete the live request in the audio routes (review finding 2). Independent of 1 and 2.
       Add and export `runLiveRequestTail<T>(live: LiveRequestHandle, tail: () => Promise<T>): Promise<T>` in `open-sse/utils/liveRequestLifecycle.ts`. It returns `await tail()`; on catch it calls `live.finish({ status: 500, error: message })` and rethrows.
       In `src/app/api/v1/audio/speech/route.ts` and `src/app/api/v1/audio/transcriptions/route.ts`, wrap everything from the `connectionId` computation through `return response` in `return runLiveRequestTail(live, async () => { ... })`. The existing `live.finish` calls stay inside it, so behaviour on the normal paths is unchanged.
       Add tests to `tests/unit/live-request-lifecycle-helper.test.ts`, following its existing event-capture pattern:
        - A throwing tail rethrows the same error and emits exactly one `request.failed` with the started id.
        - A tail that calls `finish({status:200})` and then throws emits only `request.completed` (idempotency).
        - A successful tail returns its value and emits nothing extra.

        Files: `open-sse/utils/liveRequestLifecycle.ts`, the 2 routes, `tests/unit/live-request-lifecycle-helper.test.ts`
        Verify: `TEST tests/unit/live-request-lifecycle-helper.test.ts tests/unit/audio-live-request-events.test.ts tests/unit/issue-13544-audio-transcription-call-log.test.ts tests/unit/media-cost-headers-handlers.test.ts` all pass.

- [ ]   4. Fix the topology prefix-alias gap (review finding 1). Independent.
       In `withProviderNodeEntries` (`src/app/(dashboard)/home/topologyUtils.ts`), first handle the case where the prefix key is taken: `continue` as today. Otherwise, if `nodeIdKey` is taken, find the index in `result` of the entry whose `provider` or `aliases` match `nodeIdKey` (case-insensitive). Replace it with `{ ...entry, aliases: [...(entry.aliases ?? []), key] }` unless `key` is already there, add `key` to `taken`, and `continue`. Do not mutate the input entries.
       In `tests/unit/topology-provider-nodes-arc.test.ts`, change the `byId` assertion: still no separate `arc-kokoro` entry, but the `ARC_KOKORO_ID` entry now has `aliases` including `"arc-kokoro"`, and `isTopologyEntryInSet(entry, new Set(["arc-kokoro"]))` is true. Add a check that the input entry object is unchanged.

        Files: `src/app/(dashboard)/home/topologyUtils.ts`, `tests/unit/topology-provider-nodes-arc.test.ts`
        Verify: `TEST tests/unit/topology-provider-nodes-arc.test.ts tests/unit/home-provider-topology-live-state.test.ts tests/unit/topology-active-requests-3507.test.ts tests/unit/topology-filtering-and-click.test.ts` all pass.

- [ ]   5. Integration gate.
       Run `npm run typecheck:core`, which must report 0 errors.
       Run `npx eslint --suppressions-location config/quality/eslint-suppressions.json` on every changed file, which must report 0 errors; `no-explicit-any` is an error in `open-sse/` and `tests/`.
       Run `npm run check:env-doc-sync`.
       Re-run all the focused test files from items 1–4 in one `TEST` invocation.
       Record the commands and results in `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/arc-local-audio-hosts/verification.md`. Commit locally on `feat/hybrid-reader-combo`, staging files by name, with a message like `fix(audio): honor OMNIROUTE_LOCAL_AUDIO_HOSTS for cluster audio nodes`. Do not push. Do not create changesets or CHANGELOG entries.

## Out of scope / follow-ups

- The live re-verify (image rebuild, then `POST /v1/audio/speech` `arc-kokoro/Kokoro-82M-int8-ov` and `/v1/audio/transcriptions` against the pod) happens after merge. `AUDIO_REMOTE_PROVIDER_NODES` is already back to its default `false`.
- `OMNIROUTE_LOCAL_AUDIO_HOSTS` is missing from `/Users/celes/sources/kube/omniroute/omniroute.yaml`, although the live deployment has it. Add it to the manifest so a re-apply doesn't drop it. That is a kube-repo change and is not part of this OmniRoute work.
- Speech combos still don't emit live events (review finding 3). Item 2 does make allowlisted nodes reachable through `speechCombo`.
- The live WS rejects API keys (live-verify side finding). This is unrelated.
