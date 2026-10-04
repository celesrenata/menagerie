# Live verify: Arc provider-topology active state

Target: https://omniroute.celestium.life, pod `omniroute-678df9895d-gxqst`, image
`registry.celestium.life/library/omniroute:3.8.57-arc-topology-20261003` (commit `bc64a1293`).
Run: 2026-10-03 ~08:00–08:14 UTC. Auth: management key as Bearer (not recorded here).

## Verdict

- **arc-embed: PASS.** `/v1/embeddings` returns HTTP 200, and `request.started` / `request.completed`
  live events for provider `arc-embed` arrive on the live WS. The node lights up.
- **arc-kokoro: BLOCKED** on the local-audio-host code fix.
- **arc-whisper: BLOCKED** on the local-audio-host code fix.

    Both Arc audio backends are healthy from inside the pod. Without the flag, OmniRoute rejects the
    requests as an invalid model (HTTP 400). With `AUDIO_REMOTE_PROVIDER_NODES` on, it rejects them
    with `No credentials for provider` (HTTP 400). The cause: `*.svc.cluster.local` hosts are not
    loopback, so `buildDynamicAudioProvider()` in `open-sse/config/audioRegistry.ts` builds the node as
    `authType: "apikey"`, and no provider connection exists to supply the key. The fix goes in that
    function and in `selectAudioProviderNodes()` in `src/app/api/v1/_shared/audioProviderNodes.ts`, both
    of which should honour `OMNIROUTE_LOCAL_AUDIO_HOSTS` (details below). Both nodes do appear in the
    topology. They stay grey/idle without crashing, but they never turn red, because the 400 happens
    before any call log is written.

- **Flag state:** the `AUDIO_REMOTE_PROVIDER_NODES` override was removed at ~08:14 UTC. The value was
  confirmed afterwards as `false`, source `default`. No code changes were made.

## Results

| Check                                                                                                         | Result                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/embeddings` `arc-embed/qwen3-embedding-0.6b`                                                        | HTTP 200, 1024-dim vector                                                                                                                                                                                                                                   |
| Live events for `arc-embed`                                                                                   | Observed: `request.started` then `request.completed status=success`, provider `arc-embed` (~110 ms apart), for each probe and for ongoing Zoo indexing traffic                                                                                              |
| `POST /v1/audio/speech` `arc-kokoro/Kokoro-82M-int8-ov` (also tried `arc-kokoro/kokoro` and the node-id form) | Round 1: HTTP 400 `Invalid speech model ... Use format: provider/model`. Round 2 (flag on): HTTP 400 `No credentials for provider: arc-kokoro`                                                                                                              |
| Live events for `arc-kokoro`                                                                                  | None (the request is rejected before dispatch, where the emitter lives)                                                                                                                                                                                     |
| `POST /v1/audio/transcriptions` `arc-whisper/distil-whisper-large-v3-int8-ov`                                 | HTTP 400 `Invalid transcription model ...`                                                                                                                                                                                                                  |
| arc-whisper / arc-kokoro in topology                                                                          | Yes. Ran the deployed `withProviderNodeEntries()` against the live `/api/provider-nodes` payload: it yields `arc-kokoro`, `arc-whisper`, `arc-embed`, `ovms-arc` as idle entries. `isTopologyEntryInSet` matches arc-whisper by prefix and by node-id alias |
| Error state for arc-whisper                                                                                   | Not set. The 400 happens before dispatch and writes no call log, so `/api/provider-metrics` `topology.errorProvider` stayed `vllm`. The node shows grey/idle. Nothing crashes, but it also doesn't go red                                                   |

## Root cause of the audio 400s

The backends work. From inside the pod, kokoro `/v1/models` returns 200 (`Kokoro-82M-int8-ov`) and speaches
`/v1/models` returns 200 (`distil-whisper-large-v3-int8-ov`). The speaches pods are deployed, despite what the brief said.

OmniRoute drops both audio nodes. `selectAudioProviderNodes()` only accepts a node when
`isLoopbackNodeHost(baseUrl)` is true or the `AUDIO_REMOTE_PROVIDER_NODES` flag is on. A
`*.svc.cluster.local` host fails the loopback check, and `GET /api/settings/feature-flags` reports
`AUDIO_REMOTE_PROVIDER_NODES = false (source: default)`. The deployment sets
`OMNIROUTE_LOCAL_AUDIO_HOSTS=kokoro-tts...,speaches...`, but no OmniRoute source reads that variable, so it does nothing.

## Round 2: `AUDIO_REMOTE_PROVIDER_NODES` DB override (user-approved option a)

Applied at 2026-10-03 ~08:12 UTC:

```
PUT /api/settings/feature-flags  {"key":"AUDIO_REMOTE_PROVIDER_NODES","value":"true"}
-> 200 {"effectiveValue":"true","source":"db","previousValue":"false","previousSource":"default","requiresRestart":false}
```

- Previous value: `false`, source `default` (no DB override and no env var).
- Undo: remove the override, which restores the default `false`:
    ```
    curl -X PUT -H "Authorization: Bearer <management key>" -H 'Content-Type: application/json' \
      -d '{"key":"AUDIO_REMOTE_PROVIDER_NODES"}' https://omniroute.celestium.life/api/settings/feature-flags
    ```
    (A missing `value` deletes the override, see `PUT` in `src/app/api/settings/feature-flags/route.ts`.)
- Status: **reverted** (user chose option 3). The undo `PUT` above returned 200 with
  `{"effectiveValue":"false","source":"default","previousValue":"true","previousSource":"db"}`, and a
  follow-up `GET` confirmed `false` / `default`.

Re-test with the in-pod live WS listener running:

| Request                                                                        | Result                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `POST /v1/audio/speech` `arc-kokoro/Kokoro-82M-int8-ov`, voice `af_heart`, wav | HTTP 400 `No credentials for provider: arc-kokoro`             |
| `POST /v1/audio/transcriptions` `arc-whisper/distil-whisper-large-v3-int8-ov`  | HTTP 400 `No credentials for provider: arc-whisper`            |
| Live WS events for arc-kokoro / arc-whisper                                    | None, because both requests are still rejected before dispatch |

With the flag on, the nodes now parse. The 400 moved from "Invalid model" to "No credentials".
The cause: when a node is not loopback, `buildDynamicAudioProvider()` builds it as
`authType: "apikey"` keyed by `credentialProviderId = node.id`. The route then needs a provider
connection under that node id. `/api/providers` has 19 connections and none of them is for an audio
node. The flag only makes remote nodes eligible. It does not make them credential-less, so it
cannot get these local-cluster nodes to 200 by itself. Because speech failed, no clip was produced,
so the transcription test sent no audio. It still got the same credentials 400, which happens before
the file is read.

## Where `OMNIROUTE_LOCAL_AUDIO_HOSTS` should be read (follow-up)

Both of the "loopback?" decisions for audio need the allowlist. Nothing reads the variable today:

1. `open-sse/config/audioRegistry.ts`, `buildDynamicAudioProvider()`.
   `const isLocal = isLoopbackNodeHost(node.baseUrl);` decides `authType`/`authHeader`
   (`"none"` versus `"apikey"`/`"bearer"`). An allowlisted host must give `isLocal = true` so that no credential is required.
2. `src/app/api/v1/_shared/audioProviderNodes.ts`, `selectAudioProviderNodes()`.
   The eligibility filter `return isLoopbackNodeHost(node.baseUrl) || allowRemote;` must also
   accept allowlisted hosts, so `AUDIO_REMOTE_PROVIDER_NODES` can stay off.

Suggested shape: an audio-local helper, for example `isLocalAudioNodeHost(baseUrl)` in
`open-sse/config/audioRegistry.ts`. It returns `isLoopbackNodeHost(baseUrl)` OR a case-insensitive
exact hostname match against the comma-separated `OMNIROUTE_LOCAL_AUDIO_HOSTS`, read at call time.
Both sites above would use it. `audioProviderNodes.ts` already re-exports the loopback check under the
name `isLocalAudioNodeHost`, so that export should point at the new helper. Do not change the shared
`src/shared/network/loopbackNodeHost.ts`, which rerank and health checks also use. With this in place,
the flag override above should be removed.

## Side finding: live WS rejects valid API keys

The `/live-ws` sidecar (port 20132) returned `Invalid API key`. This happened both for the management key and for
a freshly created DB API key, even though the same key got HTTP 200 on `/v1/embeddings`. Events were observed by
connecting from inside the pod with a short-lived dashboard-session cookie (minted in-pod from `JWT_SECRET`,
never exported). That is the same path the browser uses. Browser dashboards on cookie auth are unaffected.
API-key WS clients look broken. This is a separate issue and was not investigated further.

## Cleanup

- Temporary API key `live-verify-arc-topology-temp` was deleted (HTTP 200 on delete, 401 when used afterwards).
- Port-forward and listeners were stopped, and the in-pod script and local temp files were removed.
