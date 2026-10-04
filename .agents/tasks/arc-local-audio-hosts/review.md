# OMNIROUTE_LOCAL_AUDIO_HOSTS allowlist for in-cluster audio nodes

Commit `c2bd104a2` on `feat/hybrid-reader-combo` lets operators name in-cluster audio services (Kokoro TTS, Speaches STT) as "local" for `/v1/audio/*` provider nodes. Allowlisted hosts pass node selection with `AUDIO_REMOTE_PROVIDER_NODES` off, and they are built as api-key providers flagged `credentialsOptional`, so a missing credential no longer blocks them while a configured key is still sent as a bearer token. The same commit wraps the speech and transcription route tails so the live dashboard request always reaches a terminal event, and it fixes the topology prefix-alias gap with a small local change in `topologyUtils.ts`. `src/shared/network/loopbackNodeHost.ts` is untouched.

Watch for: the allowlist bypasses host policy without a cloud-metadata denylist (possible, operator-controlled); a `host:80` / `host:443` entry never matches because `URL.host` drops default ports (confirmed, minor); the `speechCombo` credentials-optional branch has no test (confirmed).

**Verdict**: APPROVED

## High-level view

The allowlist lives in `open-sse/config/audioRegistry.ts`. It is parsed by splitting on commas, trimming, lowercasing, and dropping empty entries, and it matches exactly on either `hostname` or `host:port`. URLs with userinfo or a non-http(s) scheme are rejected. Suffix matching was left out, and that is correct because the manifest names the two services exactly. The coder read `process.env` directly instead of going through a config helper, with a comment explaining that this module is bundled client-side. That matches how the other `open-sse/config/*` modules read env, and parsing is memoized per raw value.

On the gating side, `selectAudioProviderNodes` now calls `isLocalAudioNodeHost`, which is loopback OR allowlisted, OR'd with the remote flag. Non-allowlisted remote hosts behave exactly as before. `buildDynamicAudioProvider` keeps loopback as `authType: "none"`, and an allowlisted node becomes `apikey`/`bearer` with `credentialsOptional: true`. Every credential gate (the speech, transcription, and translation routes, the three handlers, and `speechCombo`) now skips the "no credentials" rejection when that flag is set. `buildAuthHeaders` already omits the header for a null token, so unauthenticated calls go out with no `Authorization` header. The route test confirms this, and it also confirms that a configured key is sent as `Bearer`.

Topology finding (2): both audio routes already finish the live request on a dispatch throw. Their post-dispatch tail now runs inside `runLiveRequestTail`, which finishes the request as a 500 and rethrows. Every non-throwing branch (ok, non-ok, no response) already calls `finish`, and `finish` is idempotent, so a catch-and-rethrow covers what a `finally` would. Topology finding (1) is fixed: when a connection-backed entry already covers a node by id, the node prefix is added to that entry's aliases on a copy, so prefix-keyed live events light it up.

<details>
<summary>Issues (3)</summary>

1. **No metadata denylist on allowlisted hosts.** (possible) If an operator puts `metadata.google.internal` or `169.254.169.254` in `OMNIROUTE_LOCAL_AUDIO_HOSTS`, it would be routed to. The rerank path refuses cloud-metadata hosts even when remote nodes are on. Consider rejecting those entries in `parseLocalAudioHosts`. Non-blocking, because the allowlist is operator-set and the audio remote path never had such a check.
2. **Default-port entries never match.** (confirmed) `URL.host` drops `:80` for http and `:443` for https, so an entry like `kokoro…:80` silently matches nothing. Either normalize default ports when parsing, or document "omit default ports". Non-blocking.
3. **`speechCombo` optional-credential branch is untested.** (confirmed) The new catch branch (lookup throws, then proceed with null credentials) and the null-credential pass-through in `executeSpeechCombo` have no test. Add one combo-target test with an allowlisted node and no connection. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Allowlist matching semantics

`isAllowlistedLocalAudioHost` checks `hosts.has(url.hostname) || hosts.has(url.host)`. A bare-host entry matches on any port, and a `host:port` entry matches only that port. WHATWG URL parsing strips the default port from `host`. So a `host:port` entry whose port is the scheme default (an explicit `:80` on http, or `:443` on https) can never match. In-cluster services usually listen on non-default ports (Kokoro on 8880), so this is unlikely to bite, but nothing tells the operator the entry is dead.

The env is read on every call, but it is only re-parsed when the raw string changes. That fits the intent of "read once", and it still lets tests change the env.

### Trust boundary

The SSRF posture for audio nodes is enforced at selection time: loopback, or the remote flag. The allowlist adds a third, operator-declared way in. It is narrow: exact match, no wildcards, and userinfo and odd schemes are rejected. Non-allowlisted hosts are unchanged, and the route test covers a 400 with zero fetches for a non-allowlisted cluster host while the flag is off. Unlike `isEligibleProviderNodeHost` on the rerank path, there is no cloud-metadata guard. That is acceptable for an operator-controlled list, but it is cheap hardening.

Allowlisted nodes keep `credentialProviderId: node.id`, so the connection key lookup stays keyed by node id. They also keep the rate-limit check whenever a connection exists. In transcription, the alternate-gateway fallback is skipped for `credentialsOptional` providers, so a request meant for the cluster node can never drift to a paid gateway that serves the same nested model id. That matters given the user's concern about failover to paid providers.

### Live-request lifecycle

Request flow in the speech and transcription routes:

```
beginLiveRequest
  ├─ dispatch throws ─────────► finish(500), rethrow   (pre-existing)
  ├─ no response ─────────────► finish(502)
  └─ runLiveRequestTail(tail)
        ├─ ok / non-ok branch ► finish(status)
        └─ tail throws ───────► finish(500), rethrow   (new)
```

`clearRecoveredProviderState`, `calculateModalCost`, `peekDurationUsage`, and `attachOmniRouteMetaToResponse` were the unguarded throw points, and they are now covered. The translations route got only the credential-gate change and not the tail wrapper. That is consistent with the task, which scoped finding (2) to the two routes the topology shows.

### Test coverage

There are unit tests for parsing, exact and port matching, loopback behavior when the env is unset, selection with the flag off, provider shape, and the helper's three lifecycle cases. Route-level tests stub `fetch` and cover speech and transcription with no auth, a configured key sent as Bearer, and a non-allowlisted host rejected. The topology tests cover the alias path.

Not tested: the `speechCombo` credentials-optional path, the translation route with an allowlisted node, and the default-port entry case.

The coder's evidence shows 125/125 focused tests passing, plus `typecheck:core`, eslint on the 15 changed files with suppressions unchanged, and the env-doc sync check. The full suite was not run, and live cluster verification is pending an image rebuild. I did not re-run anything.

</details>

<details>
<summary>File map</summary>

- `open-sse/config/audioRegistry.ts`: allowlist parser and matcher, `isLocalAudioNodeHost`, and `credentialsOptional` on dynamic providers.
- `src/app/api/v1/_shared/audioProviderNodes.ts`: selection uses `isLocalAudioNodeHost`.
- `open-sse/handlers/audio{Speech,Transcription,Translation}.ts`: credential gate honors `credentialsOptional`.
- `open-sse/services/speechCombo.ts`: combo credential resolution honors `credentialsOptional`.
- `src/app/api/v1/audio/{speech,transcriptions,translations}/route.ts`: credential gates; speech and transcription tails wrapped in `runLiveRequestTail`.
- `open-sse/utils/liveRequestLifecycle.ts`: new `runLiveRequestTail` helper.
- `src/app/(dashboard)/home/topologyUtils.ts`: prefix aliased onto an id-matched entry.
- `.env.example`, `docs/reference/ENVIRONMENT.md`: env var documented.
- `tests/unit/audio-local-hosts-{allowlist,routes}.test.ts`, `live-request-lifecycle-helper.test.ts`, `topology-provider-nodes-arc.test.ts`: new and updated tests.

Full diff: `git show c2bd104a2` in `/Users/celes/sources/celesrenata/OmniRoute`.

</details>
