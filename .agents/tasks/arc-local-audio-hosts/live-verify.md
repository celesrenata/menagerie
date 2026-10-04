# Live verify: OMNIROUTE_LOCAL_AUDIO_HOSTS (3.8.59)

Target: https://omniroute.celestium.life, pod `omniroute-fbf85dcb-4nrrv` (started 08:48:47Z, 0 restarts), image
`registry.celestium.life/library/omniroute:3.8.59-local-audio-hosts-20261003`, imageID digest
`sha256:42f32da56b5c63eb6bbebd5d5c07518f91cc59c0ec49b324c921cb99ffd90fe4` (matches the pushed digest). The commit is
`c2bd104a2` on OmniRoute `feat/hybrid-reader-combo`. Run: 2026-10-03 ~08:50–08:52 UTC. Auth: management key used as Bearer (not recorded).

## Verdict: PASS, with `AUDIO_REMOTE_PROVIDER_NODES` off

| #   | Check                                                                                                                                                   | Result                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/settings/feature-flags` → `AUDIO_REMOTE_PROVIDER_NODES`                                                                                       | `effectiveValue: "false"`, `source: "default"`. No override was set. In the pod, `OMNIROUTE_LOCAL_AUDIO_HOSTS` = `kokoro-tts.kokoro-service.svc.cluster.local,speaches.speaches-service.svc.cluster.local` |
| 2   | `POST /v1/audio/speech` `arc-kokoro/Kokoro-82M-int8-ov`, voice `af_heart`, `response_format: wav`, input "The quick brown fox jumps over the lazy dog." | **HTTP 200**, 312,044 bytes, a RIFF WAVE file (IEEE float, mono, 24 kHz), 6.4 s. Headers `x-omniroute-provider: arc-kokoro`, `x-omniroute-model: Kokoro-82M-int8-ov`, request id `18f6da79-…`              |
| 3   | `POST /v1/audio/transcriptions` (multipart) `arc-whisper/distil-whisper-large-v3-int8-ov`, file = the WAV from step 2                                   | **HTTP 200**, `{"text":" The quick brown fox jumps over the lazy dog."}`, 1.1 s. The round-trip text is exact                                                                                              |
| 4   | Live WS `requests` channel                                                                                                                              | `request.started` → `request.completed status=success` for **arc-kokoro** (08:50:58.278 → 08:51:04.569) and **arc-whisper** (08:51:04.741 → 08:51:05.779)                                                  |
| 5   | `POST /v1/embeddings` `arc-embed/qwen3-embedding-0.6b`                                                                                                  | **HTTP 200**, 1024-dim vector. WS shows `request.started`/`completed success` for `arc-embed` (08:51:05.840 → .889)                                                                                        |

Raw WS log (filtered to `arc-*` providers):

```
08:50:46.006Z welcome ["requests"]
08:50:58.278Z request.started   provider=arc-kokoro  model=Kokoro-82M-int8-ov              id=e0165b2b-…
08:51:04.569Z request.completed provider=arc-kokoro  model=Kokoro-82M-int8-ov              status=success id=e0165b2b-…
08:51:04.741Z request.started   provider=arc-whisper model=distil-whisper-large-v3-int8-ov id=b7e685f3-…
08:51:05.779Z request.completed provider=arc-whisper model=distil-whisper-large-v3-int8-ov status=success id=b7e685f3-…
08:51:05.840Z request.started   provider=arc-embed   model=qwen3-embedding-0.6b            id=831bebca-…
08:51:05.889Z request.completed provider=arc-embed   model=qwen3-embedding-0.6b            status=success id=831bebca-…
```

Compared with the previous run (`arc-topology-active-state/live-verify.md`), both audio routes went from HTTP 400 (`Invalid … model` with the flag
off, `No credentials for provider` with it on) to 200. Live events now fire for both audio nodes, so they light up in the topology.

## How events were observed

As in the previous run, a listener ran inside the pod and connected to the `/live-ws` sidecar (`127.0.0.1:20132`). It authenticated with a
dashboard-session cookie that expires in 10 minutes and was minted in-pod from `JWT_SECRET`, which was never exported or printed. API-key WS auth was not retried.

## Side notes (not blockers)

- The speech response carries `content-type: application/json; charset=utf-8` while the body is WAV. OmniRoute passes the upstream header
  through unchanged: calling kokoro directly from the pod also returns `application/json` for a 200 WAV. The bug is in kokoro's server,
  not in this fix. Clients that trust the header would parse the audio as JSON. Correction: the backend is OVMS
  (`openvino/model_server:latest-gpu`, StatefulSet `kokoro-tts`), not Kokoro-FastAPI. It also returns WAV for every `response_format`.

## Follow-up: content-type fix (deployed)

- `c4b0b79c3`: keep the upstream type only if it is `audio/*`, else default to the type of `response_format`. Shipped as
  3.8.60 (`sha256:e8c29237…`). That labelled `wav` correctly, but an `mp3` request came back as `audio/mpeg` over WAV bytes, because OVMS ignores the format.
- `193fbfb3c`: sniff the first chunk (RIFF/WAVE, OggS, fLaC, ID3, MPEG/ADTS sync) before falling back. Shipped as
  `omniroute:3.8.61-audio-sniff-20261003`, digest `sha256:e1252a4c537b35aef533db91cbdf937332a1e8c0cfedfc45ac590d98e6c1fa4c`.
  Kube commits `e5f6234` (3.8.60) and `09b454a` (3.8.61), not pushed. `kubectl diff` showed only the image line each time.
- Live on pod `omniroute-57cb57d6db-g576m` (0 restarts, digest matches): `wav`/`mp3`/`opus` speech each returned 200 with
  `content-type: audio/wav`, matching the RIFF/WAVE body. 6/6 repeat requests did the same. Transcription of the WAV is 200 with exact text.
  Embeddings 200. `AUDIO_REMOTE_PROVIDER_NODES` is still `false`/`default`.
- Tests: 136/136 across 17 audio test files. `typecheck:core` and eslint are clean.
- Rollback: set the image back to `3.8.59-local-audio-hosts-20261003`.
- `x-omniroute-version` reports `3.8.52`, even though the image tag says 3.8.59. That is the package.json version and has no functional effect.

## Cleanup

The in-pod listener was stopped and `/tmp/lv-ws.cjs` was removed from the pod, along with the esnixi log and the local temp files (the WAV, headers and
embedding JSON). No settings or API keys were created or changed.
