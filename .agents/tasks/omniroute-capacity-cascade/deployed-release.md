# OmniRoute capacity-cascade final production deployment

## Outcome

**Released successfully. The approved candidate and corrected policy remain live after an independent readback.**

- Live immutable image: `registry.celestium.life/library/omniroute@sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486`
- Ready pod: `omniroute-7f9bf6dbcc-rj699`
- Authenticated `/healthz`: HTTP 200, body `ok`
- Live combo count: 94
- Cloud pools: exactly 44, all `targetTimeoutMs=60000`
- Provider caps: vLLM 2, Ollama 1, llama-cpp 1
- Durable source SHA-256: `7e814e4271368ffa64a873272c747554e57de3b28a216dafaccc1453b14072f8`
- Rollback invoked in the successful transaction: no

No application source, tests, image, CHANGELOG, changeset, commit, push, or paid-cloud request was created or changed during this final release. The approved image was not rebuilt or re-reviewed.

## Approved immutable identity

Read-only preflight and the separate post-release verifier both confirmed:

- Review verdict: `APPROVED`; zero findings.
- Revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate tree: `dfa5ef0b9142c57aee9915869620a47eea3bd310`
- Binary diff SHA-256: `be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080`
- Exact 20-path candidate allowlist; clean `git diff --check`; real index unchanged.
- Exact OCI labels:
  - `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
  - `life.celestium.omniroute.candidate-tree=dfa5ef0b9142c57aee9915869620a47eea3bd310`
  - `life.celestium.omniroute.diff-sha256=be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080`

The preflight verified the healthy rolled-back baseline before mutation: old digest `sha256:41a9b0a6…`, one ready pod, 93 exact baseline combos, provider caps 2/1/1, durable baseline source bytes, and an offline plan of exactly 50 changes, 44 cloud pools, and 80 generator-managed records.

## Transaction and secured backup

Successful transaction backup:

`/home/celes/.local/state/omniroute-routing/20261011T035941Z-capacity-cascade`

- Backup directory mode: 0700
- Every backup artifact mode: 0600
- Manifest SHA-256: `d453cad59c19fcb6094680fccaac55c87eb9ab3b979e1165099bdb0c1f1942b6`
- Final journal SHA-256: `a6cc265d16aeecc6ba8870f6077b8540c09d0805299380f123a954cca8896db2`
- Full 93-combo baseline, affected code/research/tester records, all 44 cloud records, sanitized providers, durable source bytes, deployment/ReplicaSets/pods, candidate metadata, hashes, and fsynced journal were captured.
- Backup validation and management-key scan passed.

Provider comparisons excluded exactly these eight volatile paths and no others:

1. `connection.lastTested`
2. `connection.providerSpecificData.apiKeyHealth`
3. `connection.updatedAt`
4. `connection.errorCode`
5. `connection.lastError`
6. `connection.lastErrorAt`
7. `connection.lastErrorType`
8. `connection.syncedModelsAt`

The backup was the first production-state mutation. Strict preconditions passed against that fresh backup before deployment.

## Runtime deployment

The deployment was patched to the exact immutable candidate digest. Rollout verification confirmed:

- configured image equals the candidate digest;
- the sole ready pod's `imageID` equals the candidate digest;
- exactly one deployment replica is ready;
- candidate labels remain exact;
- authenticated health is HTTP 200 `ok` through a fresh port-forward.

The successful transaction has one candidate runtime gate and no rollback event.

## Exact policy applied

Exactly 50 management API writes completed with immediate per-record readback:

- six structural code/research changes;
- all 44 `pool/tier[2-5]/*` timeout changes.

The resulting policy is:

- Code and research tier1 round-robin order: 5090, 4070 Ti Super, 5090.
- Tier1 config: concurrency 2, queue depth 0, queue timeout 1000 ms, retries 0, session stickiness disabled, prompt-cache affinity disabled, fail-fast account capacity enabled, failover-before-retry enabled, local timeout 600000 ms.
- Code and research tier1b: one GLM target (`llama-cpp/ds4-glm53`), round-robin, concurrency 1, queue depth 0, queue timeout 1000 ms, the same fail-fast/affinity/retry flags, local timeout 600000 ms.
- Hybrid code/research roots: tier1 → tier1b → tier2 → tier3 → tier4 → tier5.
- Local code/research roots: tier1 → tier1b.
- Exactly 44 tier2–tier5 cloud pools: timeout 60000 ms; no managed cloud pool remains at 30000 ms.
- Tester non-cloud projections: unchanged; tester cloud records changed only through the shared 60000 ms timeout update.
- Shared caps: vLLM 2, Ollama 1, llama-cpp 1.

Durable `omniroute-mode.py` was reconciled atomically. `py_compile` passed, two offline builds were byte-identical, and the persistence canary proved numeric `queueDepth: 0`, `disablePromptCacheAffinity: true`, and `failFastOnAccountCapacity: true` survive POST/GET/PUT/GET before its cleanup.

## Correlation-aware canary evidence

The transaction did not repeat the disruptive saturation canary and injected no fillers.

The short marked smoke ran only after observing every local account semaphore and account/rate queue at zero. Marker:

`release-final-smoke-1791691222014768717`

Results:

- root: `local/code` (local-only);
- response: HTTP 200 SSE with safe headers captured;
- selected provider: vLLM;
- observed request-specific occupancy: vLLM 0 → 1;
- account and rate queues: unchanged at zero;
- release: vLLM 1 → 0, with the complete post-request state exactly equal to the zero pre-request baseline;
- request-attributable queue growth: none;
- 120-second/300-second semaphore timeout evidence: absent;
- marked capacity HTTP 500: absent;
- fillers injected: no;
- users preempted: no;
- paid cloud requests: zero.

Production does not emit debug-level `ACCOUNT_SEMAPHORE` marker lifecycle lines, so acceptance used the exact observed permit delta and exact baseline restoration rather than requiring an unavailable log signal.

The final journal also incorporates the immutable successful saturation evidence from:

`/home/celes/.local/state/omniroute-routing/20261011T034606Z-capacity-cascade/journal.jsonl`

That unchanged candidate/policy evidence proves tier1 occupancy at vLLM 2/2 plus Ollama 1/1, no-header `local/research` advancement to tier1b GLM with HTTP 200, all-local exhaustion as HTTP 503 `ALL_TARGETS_SKIPPED` rather than 500, no account/rate waiter, exact reverse release to zero, and no paid cloud request.

## Independent final readback

A separate process, after the successful transaction helper exited, independently verified:

- configured and running image: exact candidate digest;
- candidate revision/tree/diff labels: exact;
- one ready pod and authenticated health 200;
- 94 unique live combos;
- all 80 generator-managed projections equal a fresh durable-source build;
- two fresh durable-source builds are identical;
- exact code/research tier1 and tier1b targets, config, and root chains;
- 44 cloud records, all at 60000 ms;
- provider caps 2/1/1 and provider projections equal baseline modulo only the eight approved volatile fields;
- durable source SHA-256 `7e814e4271368ffa64a873272c747554e57de3b28a216dafaccc1453b14072f8`;
- `py_compile` passes.

Final independent status: `INDEPENDENT_READBACK_OK`.

## Earlier failed-closed attempt

An earlier final attempt used fresh backup:

`/home/celes/.local/state/omniroute-routing/20261011T035714Z-capacity-cascade`

Its marked smoke returned HTTP 200, but the verifier incorrectly required debug-level semaphore lifecycle log lines that production does not emit before completing the occupancy-release assertion. It failed closed and executed the required rollback order. The journal confirms both candidate and old-digest runtime gates plus `rollback_verified=ok`; a fresh baseline preflight then passed before the successful transaction. The verifier was narrowed to the production-supported exact occupancy/release signal; candidate, policy, source, tests, and image were unchanged.

## Final state

The approved candidate digest and corrected 60-second cloud policy remain live. No rollback is pending or required.
