# OmniRoute Parent-Cascade Production Release Report

## Outcome

The fresh production transaction **did not release the candidate**. The candidate Recreate rollout command succeeded, but the runtime verification helper then failed with an internal return-value bug before it could prove the candidate pod digest, labels, and authenticated health as one gate. Per plan item 12, forward work stopped immediately and the deployment was restored to the captured old immutable digest. No durable-policy edit, provider write, combo write, temporary canary record, backend-load canary, or paid cloud request occurred.

Full rollback verification subsequently passed. Production is healthy on:

`registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`

The corrected policy is **not active**.

## Fresh backup

- Backup: `/home/celes/.local/state/omniroute-routing/20261011T003051Z-capacity-cascade`
- Created as the first production mutation.
- Directory mode: `0700`; every artifact mode: `0600`.
- Captured 93 unique combos through stable pagination and full export.
- Captured all eight affected lane markers, including a null marker for absent `pool/tier1b/research`.
- Captured all four tester records and exactly 44 anchored `pool/tier[2-5]/*` cloud records.
- Captured sanitized item-read records for all three local providers.
- Captured byte-for-byte durable `omniroute-mode.py`, deployment JSON, ReplicaSet/pod/runtime state, old digest, candidate metadata, file hashes/counts/modes, and initialized journal.
- Backup manifest hashes validated; source backup matched the writable source byte-for-byte.
- Management-key and credential-material scans were clean before deployment and after rollback.
- Final journal SHA-256: `796955057ebaf21a88cdd5ad1ba93b68e68f8e8a863c95b9ffd9a5f6080c206d`.

Provider durable preconditions used only the approved volatile exclusions:

- `connection.lastTested`
- `connection.providerSpecificData.apiKeyHealth`
- `connection.updatedAt`
- `connection.errorCode`
- `connection.lastError`
- `connection.lastErrorAt`
- `connection.lastErrorType`

No other provider paths were excluded.

## Candidate identity and pre-deployment verification

Candidate:

`registry.celestium.life/library/omniroute@sha256:fb059a4d0364f7afced60cf4d20b7644ef57bb14439bde1a3ca51b69202aaf9b`

Registry inspection resolved one immutable manifest and verified these exact OCI labels:

- `org.opencontainers.image.revision=ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- `life.celestium.omniroute.candidate-tree=aea994df380df929bee410618dfe5bd41ee9006e`
- `life.celestium.omniroute.diff-sha256=ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e`

The existing candidate build evidence and successful ephemeral `/healthz` smoke test were present under `/home/celes/.local/state/omniroute-capacity-cascade-dev/parent-skip-20261010T235518Z/`. Fresh registry inspection, `git diff --check`, approved revision verification, and application/test allowlist inspection passed before the production backup.

## Live write ledger

### Kubernetes deployment image writes

1. Old digest → candidate digest at `2026-10-11T00:31:07Z`.
   - `kubectl patch deployment/omniroute`: success.
   - Recreate rollout: success at `2026-10-11T00:32:23Z`.
   - Before-reference SHA-256: `ffe0214375b9bb1db55e748f2eeab422c1e64a776b003ef309f3662d415b9ce2`.
   - After-reference SHA-256: `c59a98c679fdd884c812eb93add31b17d8a38ec0501ec208137de5642a06b2dd`.

2. Candidate digest → old digest at `2026-10-11T00:32:23Z` after the verification-helper failure.
   - `kubectl patch deployment/omniroute`: success.
   - Recreate rollback rollout: success at `2026-10-11T00:32:30Z`.
   - Before-reference SHA-256: `c59a98c679fdd884c812eb93add31b17d8a38ec0501ec208137de5642a06b2dd`.
   - After-reference SHA-256: `ffe0214375b9bb1db55e748f2eeab422c1e64a776b003ef309f3662d415b9ce2`.

### Durable and management-policy writes

None. The deployment gate failed before plan item 7.

- Durable `omniroute-mode.py` writes: 0.
- Provider PUTs: 0.
- Combo PUTs: 0.
- Combo POSTs: 0.
- Combo DELETEs: 0.
- Temporary canary writes: 0.

There are therefore no provider/combo before/after mutation hashes to report. The journal records `policyWrites: 0`.

## Failed gate

The rollout helper's command wrapper returned `None` on successful commands because its `return` was accidentally scoped to the nonzero-return branch. Parsing the successful `kubectl get deployment ... -o json` result therefore raised:

`TypeError: the JSON object must be str, bytes or bytearray, not NoneType`

Although the candidate rollout command had completed, this prevented the transaction from proving the required exact candidate runtime identity and authenticated health as a single gate. The same helper defect initially labeled rollback inspection as failed after the old rollout command succeeded. A corrected read-only verification then established the actual recovered state. No retry of the candidate deployment was attempted in this transaction.

## Canary and acceptance results

Canaries were intentionally **not run** because the deployment gate failed and item 12 required immediate rollback.

- Safe local occupancy `5090=2, 4070=1, GLM=1`: not run.
- Mandatory saturated-tier1 parent advance to tier1b GLM for research: not run.
- Local/code repetition: not run.
- Mixed-lane contention: not run.
- No-second-4070/GLM-waiter timing assertions: not run.
- Continuing-session and explicit `prompt_cache_key` affinity resistance: not run.
- Structural job5+ cloud-chain canary: not run.
- Verification of all 44 live cloud timeouts at `60000`: not run/applied; production records remain at the fresh backup state.
- Verification of vLLM `--max-num-seqs 2`: not reached in this transaction.
- Fresh durable `py_compile` and two identical offline `build('tiered', live)` results: not reached.
- Exact/idempotent corrected code/research projection: not reached.
- Tester comparison after apply: no apply occurred; tester and every combo remain byte-for-byte equal to the backup export.
- Paid cloud requests: 0.

The approved candidate's pre-production focused source tests and image smoke test remain documented in `parent-skip-impl.md`; they do not substitute for the production canaries that this transaction correctly skipped after rollback began.

## Rollback verification

Final recovery checks passed:

- Deployment configured image equals the captured old immutable digest.
- One ready pod: `omniroute-5d8c776fff-j84hs`.
- Running pod image ID exactly equals the old digest.
- `kubectl rollout status deployment/omniroute`: successful.
- Authenticated `/healthz`: HTTP 200, body `ok`.
- Complete combo readback: exactly 93 records and object-for-object equal to `combos.full.json`.
- Provider durable projections: exact after removing only the seven logged volatile paths.
- Durable source: byte-for-byte equal to backed-up `omniroute-mode.py`.
- Backup modes remain `0700/0600`; captured manifest hashes remain valid.
- Management key absent from all backup, journal, runtime, and recovery evidence.
- No commit or push was created; no CHANGELOG or changeset was modified.

This is a recovered failed-gate outcome under plan item 12, not a successful release. Production was not left partially applied.
