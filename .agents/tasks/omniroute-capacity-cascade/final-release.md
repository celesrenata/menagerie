# OmniRoute Capacity-Cascade Production Retry Report

## Outcome

The approved candidate was **not released**. The final fresh production transaction successfully passed candidate identity/runtime gates, reconciled and offline-validated the durable policy, applied all 50 intended policy changes, and passed the management persistence canary. Mandatory backend canaries could not begin safely because production-held local work did not release the required slots during the five-minute idle gate: vLLM/5090 remained at `running=2, queued=0`, Ollama/4070 at `running=0, queued=0`, and llama-cpp/GLM at `running=1, queued=0`.

Per the mandatory failure policy, the helper restored the old runtime digest before replaying legacy combo payloads, restored all 50 policy mutations, removed the newly created research tier1b only after roots were restored, and restored the durable source byte-for-byte. Independent post-transaction verification passed.

Production is healthy and fully rolled back on:

`registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`

The corrected policy is **not active**. All 44 cloud pools remain at the rolled-back `targetTimeoutMs=30000`; they are not at the desired 60000.

## Candidate and helper verification

Unchanged candidate:

`registry.celestium.life/library/omniroute@sha256:fb059a4d0364f7afced60cf4d20b7644ef57bb14439bde1a3ca51b69202aaf9b`

Exact OCI labels were reverified:

- `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- `life.celestium.omniroute.candidate-tree=aea994df380df929bee410618dfe5bd41ee9006e`
- `life.celestium.omniroute.diff-sha256=ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e`

The release command wrapper was corrected and smoke-tested before mutation. A successful JSON-producing command returned captured stdout and parsed successfully; a failing command raised with its return code, stdout, and stderr. The same corrected wrapper parsed `kubectl get deployment ... -o json` and raised on a deliberately absent deployment.

The helper was further corrected to own a dedicated service port-forward and restart it after each Recreate rollout, rather than relying on a tunnel attached to the deleted pod. A read-only offline policy gate was also added before rollout; it proved exactly 80 managed records, exactly 50 intended changes, exactly 44 cloud pools, and no tester/unrelated drift.

## Authorized provider precondition exclusion

The parent authorized one additional volatile path after read-only preflight found autosync timestamp drift:

- `connection.syncedModelsAt`

The complete logged exclusion list was therefore:

- `connection.lastTested`
- `connection.providerSpecificData.apiKeyHealth`
- `connection.updatedAt`
- `connection.errorCode`
- `connection.lastError`
- `connection.lastErrorAt`
- `connection.lastErrorType`
- `connection.syncedModelsAt`

No other provider path was excluded. Provider identity, active state, provider/base/auth settings, rate limits, caps, proxy/quota configuration, model configuration, and all other durable provider fields remained strict.

## Final fresh backup

The final transaction's first production-state mutation created:

`/home/celes/.local/state/omniroute-routing/20261011T005826Z-capacity-cascade`

It captured and validated:

- 93 unique complete combo records and stable pagination;
- all eight affected code/research markers, including absent `pool/tier1b/research`;
- all four tester records;
- exactly 44 anchored `pool/tier[2-5]/*` cloud records;
- all three sanitized provider records;
- byte-for-byte durable `omniroute-mode.py`;
- deployment, ReplicaSets, pods, configured/running immutable digest, and candidate metadata;
- owner-only modes and artifact hashes;
- an fsynced mutation/rollback journal;
- a clean management-key scan.

Modes remained directory `0700` and every artifact `0600`, including the rollout tunnel log.

- Final journal SHA-256: `7edc39d35e8dec8ce6ad8aa31fa6a29f7d159f0de7c9cca056ce3e67489ec4fd`
- Manifest SHA-256: `043d68692c2cb0069e0b83a105234c377f1c6f92ad33dea0d506088bde339bbc`

## Successful forward gates

The final transaction completed these gates before the live-load blocker:

1. Strict preconditions passed against the fresh backup: old digest, 93 combo projections, source bytes, and providers modulo only the eight logged volatile paths.
2. Candidate Recreate rollout succeeded. The configured image and single ready pod image ID matched the candidate digest; exact registry labels matched; authenticated `/healthz` returned HTTP 200.
3. Durable source reconciliation passed Python compilation and two identical offline `build('tiered', live)` projections.
4. The offline result contained 80 managed records and exactly 50 intended changes: six code/research structures plus all 44 cloud timeout records. Tester local structures were unchanged.
5. All 50 live writes passed per-record preconditions and immediate readback:
   - PUT `pool/tier1/code`
   - PUT `pool/tier1/research`
   - PUT `pool/tier1b/code`
   - POST `pool/tier1b/research`
   - PUT all 44 tier2–tier5 cloud pools
   - PUT `hybrid/research`
   - PUT `local/research`
6. Live readback contained 94 unique combos and matched the desired managed projection.
7. A temporary unreferenced persistence canary proved POST/GET/PUT/GET preservation of numeric `queueDepth: 0`, `disablePromptCacheAffinity: true`, and `failFastOnAccountCapacity: true`; cleanup succeeded.

Provider caps were already `2/1/1`, so provider writes were zero.

## Failed mandatory gate

Before controlled occupancy, the helper required the three local provider semaphores to be idle so canary traffic could establish and attribute exact placement without interfering with production work. They did not become idle within five minutes:

- 5090/vLLM: `running=2`, `queued=0`
- 4070/Ollama: `running=0`, `queued=0`
- GLM/llama-cpp: `running=1`, `queued=0`

The failed assertion was:

`local providers did not become idle`

This is a live-capacity/environment gate failure, not a candidate identity, policy persistence, queue-depth, or rollback failure. The transaction did not cancel or preempt user workloads.

Because occupancy could not be established safely, the following mandatory acceptance canaries were not run and cannot be claimed:

- controlled local-only `5090=2, 4070=1, GLM=1` placement;
- saturated research tier1 advancing to available tier1b GLM;
- local/code repetition and mixed-lane contention;
- same-session and explicit prompt-cache-key affinity resistance;
- controlled fifth-request `ALL_TARGETS_SKIPPED` timing;
- runtime no-second-4070/GLM-waiter assertions;
- live log assertions for no 120s/300s semaphore timeout;
- vLLM `--max-num-seqs 2` acceptance in the final canary phase.

No paid cloud request was made by the transaction.

## Rollback

Rollback order complied with the legacy-schema constraint:

1. Candidate digest was replaced with the captured old immutable digest.
2. The old deployment rolled out and authenticated health returned HTTP 200 through a fresh service tunnel.
3. Roots were restored first.
4. Leaf and all 44 cloud records were restored.
5. `pool/tier1b/research` was deleted only after roots no longer referenced it.
6. Providers required no restore write.
7. Durable `omniroute-mode.py` was restored byte-for-byte.

The journal records 50 successful forward policy mutations and 50 successful rollback records.

## Final independent verification

Independent readback after the helper's rollback verification confirmed:

- configured deployment image equals the old immutable digest;
- exactly one ready pod, with running `imageID` equal to the old digest;
- authenticated `/healthz` HTTP 200;
- exactly 93 combo records and all managed projections equal to the fresh backup;
- all three providers exact after removing only the eight authorized volatile paths;
- durable source byte-identical to the fresh backup;
- backup directory/files remain `0700/0600`;
- management key absent from backup artifacts and journal;
- corrected candidate/policy not active;
- all 44 rolled-back cloud pools at 30000 ms.

## Earlier recovered attempts in this step

For transparency, two earlier fresh transactions also rolled back before policy mutation:

- `20261011T005224Z-capacity-cascade`: candidate rollout succeeded, but a stale pod-bound API tunnel disconnected during runtime health verification. Old digest, 93 combos, providers, and source were independently recovered exactly; policy writes were zero.
- `20261011T005548Z-capacity-cascade`: candidate runtime gate passed, but pre-write offline generator validation rejected an incomplete 41-cloud projection. Old digest and source were restored; policy writes were zero. The helper was then strengthened to require the exact 44-cloud/50-change projection before another rollout.

No application source, tests, requirements, design, image, CHANGELOG, or changeset was modified. No image was rebuilt or republished. No commit or push was created.
