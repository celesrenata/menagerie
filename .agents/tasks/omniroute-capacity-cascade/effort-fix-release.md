# OmniRoute Ollama-local Qwen reasoning-effort fix — production release

## Outcome

**Released successfully.** The new immutable image is live and passed a separate final readback.

- Final live image: `registry.celestium.life/library/omniroute@sha256:299deb44f3169c5fe0fa6eef065580ecd0fee51610d64fce763ed41b1052bfe6`
- Ready pod: `omniroute-7f9d7d8b7c-r5chw`; exactly one ready replica
- Authenticated `/healthz`: HTTP 200, body `ok`, through a fresh service port-forward
- Policy: unchanged at 94 combos with the exact code/research `5090 / 4070 / 5090 -> GLM -> cloud` topology
- Provider caps: unchanged at vLLM 2, Ollama-local 1, llama-cpp 1
- Cloud pools: exactly 44, all unchanged at `targetTimeoutMs=60000`
- Durable source SHA-256: unchanged at `7e814e4271368ffa64a873272c747554e57de3b28a216dafaccc1453b14072f8`
- Paid-cloud requests: zero
- Rollback invoked during the overall release operation: **yes, once**, for an initial verifier-only false rejection; that rollback completed and was independently confirmed before the successful fresh transaction. The successful transaction did not roll back, and no rollback is pending.

No combo, provider, timeout, or durable-source write was performed. The only production configuration mutation in each transaction was the deployment image patch.

## Read-only preflight

The fail-closed preflight passed before the first production mutation:

- Current configured/running image was `registry.celestium.life/library/omniroute@sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486`.
- Exactly one pod was ready: `omniroute-7f9bf6dbcc-rj699`.
- Authenticated health was HTTP 200 `ok`.
- The management API returned 94 unique combos.
- Code and research tier1 were exact round-robin `[vLLM 5090, Ollama-local 4070, vLLM 5090]`, tier1b was the single llama-cpp GLM target, local roots were tier1 → tier1b, and hybrid roots were tier1 → tier1b → tiers 2–5.
- Provider caps were exactly 2/1/1.
- Exactly 44 cloud pools were present and all had `targetTimeoutMs=60000`.
- Durable `omniroute-mode.py` matched SHA-256 `7e814e4271368ffa64a873272c747554e57de3b28a216dafaccc1453b14072f8`.
- `effort-fix-review.json` verdict was `APPROVED` with zero findings.
- Candidate OCI labels matched exactly:
  - revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
  - candidate tree: `71bf54d2a14efbe39ebe883e40aa9f3967d61b20`
  - binary diff SHA-256: `772b914710206f7b87ded8622e382cb4c4321ebcdfba162e8f55eee6c64f26f9`

## Successful fresh backup

The successful transaction's first production mutation created:

`/home/celes/.local/state/omniroute-routing/20261011T053711Z-effort-fix-image-only`

- Directory mode: `0700`
- Every artifact mode: `0600`
- Manifest SHA-256: `822e460f95a70ae95bb48de51d811bc49f401f4ec2ba6da29cc614a90af61228`
- Final journal SHA-256 after the separate readback: `5a7e21ea5935fa7efc6076c8fb8b232f9f47a1bccf7e62541a49d3966eceb44a`
- Full combo snapshot SHA-256: `e21675dcc281a172366ec47316ad1f0fb8996ee5e7c82f672ebbc2cd257b0d98`
- Sanitized provider snapshot SHA-256: `732d2ecb351bcb8a906c6799c837382024eb0a8ec1975fc35315497226c2ea25`
- Durable source backup SHA-256: `7e814e4271368ffa64a873272c747554e57de3b28a216dafaccc1453b14072f8`

The backup includes deployment, ReplicaSets, pods/current digest, full paginated and flattened 94-combo data, sanitized providers, exact durable-source bytes, candidate metadata/labels, per-file hashes, and the fsynced journal. The management key was absent from every artifact. Provider credentials were sanitized, and provider policy comparisons excluded exactly these eight volatile paths and no additional policy fields:

1. `connection.lastTested`
2. `connection.providerSpecificData.apiKeyHealth`
3. `connection.updatedAt`
4. `connection.errorCode`
5. `connection.lastError`
6. `connection.lastErrorAt`
7. `connection.lastErrorType`
8. `connection.syncedModelsAt`

Backup validation passed before rollout and again after final acceptance.

## Deployment and immutable runtime verification

The deployment was patched to the candidate digest and rollout completed successfully. Verification established:

- configured deployment image equals the exact candidate digest;
- sole ready pod `imageID` equals the exact candidate digest;
- deployment has exactly one ready replica;
- candidate labels remain exact;
- authenticated health is HTTP 200 `ok` through a newly created port-forward;
- all 94 combo projections equal the fresh backup;
- all provider projections equal the fresh backup after only the eight approved volatile exclusions;
- durable source is byte-identical to the fresh backup.

No management API mutation endpoint was called for combos or providers, and `omniroute-mode.py` was never rewritten.

## Direct reasoning-effort canaries

All canaries used `ollama-local/qwen3.8:27b-iq3-code144k`, a tiny `Reply OK.` prompt, `max_tokens=2`, non-streaming responses, metadata-safe journaling, and response hashes rather than response content.

| Requested effort | HTTP | API accepted | Required sanitizer evidence | Enum/Jinja error | Fallback / HTTP 500 |
|---|---:|---|---|---|---|
| omitted | 200 | yes | no omission, as expected | none | none |
| `low` | 200 | yes | preserved; no omission | none | none |
| `medium` | 200 | yes | preserved; no omission | none | none |
| `high` | 200 | yes | one `REASONING_SANITIZE` top-tier omission | none | none |
| `xhigh` | 200 | yes | one `REASONING_SANITIZE` top-tier omission | none | none |
| `max` | 200 | yes | one `REASONING_SANITIZE` top-tier omission | none | none |

Every direct response identified the expected Ollama model/provider in safe `x-omniroute-*` metadata. In particular, `high` returned HTTP 200, produced the required omission, emitted no `Unexpected reasoning effort` or Jinja enum error, and burned no fallback.

## Hybrid/code 4070 canary

A marked `hybrid/code` request was sent with tier constrained to 1, `reasoning_effort=high`, the same tiny prompt, and `max_tokens=2`. The first attempt selected the 4070 path:

- HTTP 200
- decision: round-robin, Ollama provider
- model: `qwen3.8:27b-iq3-code144k`
- one required `REASONING_SANITIZE` omission
- account queue remained zero
- no timeout, enum/Jinja error, fallback, or HTTP 500
- no cloud tier was eligible and paid-cloud requests were zero

This confirms the existing capacity-routing path remains active and the 4070 request no longer burns an enum-error fallback.

## Semaphore and bounded log observation

The account-semaphore baseline before canaries was zero running/queued for vLLM, Ollama-local, and llama-cpp; all rate-queue counters were also zero. Every request returned to its exact pre-request baseline, and the final state exactly equaled the initial all-zero baseline.

- Maximum account waiters observed: 0
- Account/rate queues at final readback: 0/0 for all three local providers
- Queue/semaphore timeout evidence: none
- HTTP 500 evidence: none
- New `Unexpected reasoning effort` entries: none
- Jinja enum errors: none
- Bounded post-canary observation: 10 seconds

The high-frequency monitor observed a transient rate-admission counter of 1 during the in-flight `medium` and `high` calls; it returned to zero before each request completed. This was not an account waiter, account queues remained zero throughout, and no rate-limit wait/timeout or failure occurred.

## Recovered initial attempt

The first transaction used backup:

`/home/celes/.local/state/omniroute-routing/20261011T053543Z-effort-fix-image-only`

Its omitted, low, and medium canaries all returned HTTP 200 with clean logs and exact baseline restoration. During the high canary, the initial verifier incorrectly treated the normal transient rate-admission counter as an account queue. It failed closed and rolled the image back to `sha256:3cada1d2...`.

Rollback verification passed: exact old configured/running digest, one ready replica, health 200, all 94 combo projections unchanged, providers unchanged modulo only the eight approved volatile fields, and durable source byte-identical. No policy/source restore writes were needed because none had been changed. The verifier was corrected to continue requiring zero account waiters, exact final account/rate baseline restoration, and no timeout/500 evidence without misclassifying in-flight rate admission. A new transaction then began with the separate fresh backup documented above.

## Independent final readback

A separate post-transaction readback returned `INDEPENDENT_READBACK_OK` and confirmed:

- final configured/running image is the new candidate digest;
- ready pod is `omniroute-7f9d7d8b7c-r5chw` and exactly one replica is ready;
- authenticated health is HTTP 200 `ok`;
- candidate labels are exact;
- 94-combo policy and all 44 cloud timeouts remain exact;
- provider caps remain 2/1/1;
- combo/provider projections equal the successful fresh backup;
- durable-source hash remains exact;
- backup modes, hashes, JSON/JSONL integrity, and secret scan pass;
- no rollback is pending.

## Final state

The reasoning-effort fix image remains live. The prior live digest is retained only as the verified rollback target. Rollback was invoked and completed once during the recovered verifier-only attempt; it was **not** invoked for the successful transaction.
