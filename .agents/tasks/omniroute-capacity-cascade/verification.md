# OmniRoute Capacity Cascade Verification

## Live-apply retry outcome

The authorized live-policy retry ran on `esnixi` using fresh backup `/home/celes/.local/state/omniroute-routing/20261010T233455Z-capacity-cascade`. Strict preconditions passed for all 93 combo managed projections, the durable source bytes, the old deployment digest, and all durable provider configuration. Provider equality excluded and journaled only the approved volatile health/status paths: `connection.lastTested`, `connection.providerSpecificData.apiKeyHealth`, `connection.updatedAt`, `connection.errorCode`, `connection.lastError`, `connection.lastErrorAt`, and `connection.lastErrorType`.

The immutable candidate digest was deployed and verified with the exact OCI revision, candidate-tree, diff hash, one ready pod, and authenticated health HTTP 200. The writable durable policy source was reconciled and passed `py_compile` plus two identical offline builds. The validated plan contained 80 managed records and exactly 50 intended combo changes: six code/research lane records and all 44 cloud pools with timeout-only changes to `60000`. Provider caps were already `2/1/1`, so no provider write was needed. Tester and unrelated local/root projections remained unchanged.

The live policy transaction completed all 50 writes with per-record preconditions, immediate readback, and before/after hashes. It created `pool/tier1b/research`; final inventory contained 94 unique combos, all 44 cloud pools had `targetTimeoutMs: 60000`, and the desired managed projections matched.

The first safe local-only capacity observation passed under real held load: two existing 5090 executions plus one existing GLM execution, followed by one controlled `local/code` probe on the 4070, produced `5090=2, 4070=1, GLM=1`, all queues zero, no fifth/cloud request, and no `SEMAPHORE_TIMEOUT`. The controlled probe was released and its backend slot returned to zero.

The subsequent `local/research` canary failed the mandatory cascade gate. With tier1 saturated, the root logged `Skipping combo-ref combo:pool/tier1/research — concurrency cap reached` and returned `combo:pool/tier1/research is at concurrency capacity` instead of advancing to the available `pool/tier1b/research` GLM child. No paid cloud request was made by the local canary, and both controlled requests were released. This is a runtime parent pre-skip/capacity behavior not corrected by the immutable candidate.

Per the mandatory failure policy, all successful mutations were rolled back. Roots were restored first, then all 44 cloud records, then leaves; the newly created research tier1b was deleted only after root restoration. The candidate API rejected the backed-up legacy `pool/tier1/research` payload because `config.weightedTargetPolicies[…].maxConcurrent` is no longer schema-valid, so recovery restored the old digest first and then used the old API to restore that exact record. The durable source was restored byte-for-byte.

Final rollback verification passed: old digest `registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`, authenticated health HTTP 200, exactly 93 combo records with every managed projection equal to the fresh backup, durable provider projections exact modulo the approved volatile paths, source bytes exact, backup directory/file modes `0700/0600`, and the management key absent. The corrected policy is **not active**.

## Previous development and first-attempt outcome

The authorized runtime patch was developed and tested in an isolated remote worktree, an immutable candidate image was built and smoke-tested, and the required production rollback backup was created and validated. The candidate runtime rollout passed its digest/revision/health gate.

The subsequent live-policy transaction stopped before its first management API write because the first provider precondition compared volatile health metadata against the backup. The mandatory rollback restored the durable policy file byte-for-byte and restored the old immutable runtime digest. No live provider or combo record was written. Production is healthy on the original image and all 93 combo records match the backup.

## Source and candidate

- Remote host: `celes@192.168.42.254` (`esnixi`)
- Canonical clean source selected: `/home/celes/sources/omniroute-transcript-fix/.claude/worktrees/tier2-planner-capacity`
- Approved revision: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Isolated candidate worktree: `/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z`
- Candidate tree: `812c5586fcbeb611fc4feade85d251fe799366f0`
- Candidate diff SHA-256: `70e4800c52a5cf74b8fff6d6a7c4c7bcadcb6b832baba3007113e0629d306020`
- Immutable candidate: `registry.celestium.life/library/omniroute@sha256:388fa7e33a360bfa4d18b4414ed92af66b5a32eeba38db055d76da50651ae4aa`
- OCI revision label verified: `ad45d990c9f17e857f0bd03aacd1ff29b1825658`
- Candidate-tree label verified: `812c5586fcbeb611fc4feade85d251fe799366f0`
- Ephemeral candidate `/healthz`: HTTP 200
- No commit or push was created.

## Implemented candidate patch

Only the six authorized application files plus focused tests differ in the isolated worktree. The patch adds lane-scoped prompt-affinity opt-out and fail-fast account-capacity controls, passes zero-depth account queue options through combo/chat/chatCore, preserves direct and unflagged defaults, translates opt-in account queue-full into an internal capacity sentinel, advances round-robin without retry/cooldown/HTTP 500, retains terminal `503 ALL_TARGETS_SKIPPED`, and preserves `queueDepth: 0` on PUT.

The durable source was temporarily reconciled and passed offline assertions for code/research `[5090, 4070, 5090] -> GLM -> cloud`, caps `2/1/1`, exact local/root order, `queueDepth: 0`, all four lane booleans, 44 cloud timeouts at 60000 ms, and unchanged tester projections. It was restored from backup after the failed production precondition, as required.

## Commands and results

- `npm ci`: PASS (Node engine warning only; lockfile install completed).
- Focused Node bootstrap over changed suites (`combo-config`, both semaphore suites, combo fallbacks, synchronized account races, management persistence, chatCore translation): PASS — 162 tests, 0 failures.
- `npm run lint -- --no-cache`: PASS.
- `npm run typecheck:core`: PASS.
- `npm run check:open-sse-typecheck`: candidate environment reported two unrelated `src/app/api/v1/models/catalog.ts` TS2367 diagnostics with lockfile-installed TypeScript 6.0.3. The clean checkout without local dependencies reported the frozen checker clean. No unauthorized source or baseline was changed.
- `npm run build`: PASS.
- `npm run test:unit`: baseline/environment failures — 33,983 passed, 6 failed, 8 cancelled, 18 skipped. Failures were unrelated fixture/CLI/system-binary/env-doc/timer suites; all changed tests passed.
- `npm run test:integration`: baseline/environment failure — 886 passed, 1 failed, 75 skipped (`agent-bridge-cert-flow`, expected 404 but environment returned 400).
- Docker build: first Turbopack attempt failed with the Dockerfile-documented panic; retry with checked-in escape hatch `OMNIROUTE_USE_TURBOPACK=0` passed and published the immutable digest above.
- `python3 -m py_compile omniroute-mode.py`: PASS before production apply.
- Offline `build('tiered', live)` assertions: PASS and deterministic; exactly 51 intended pre-apply drifts (44 cloud timeout records plus seven non-no-op code/research structures), tester unchanged.

Detailed remote logs are under `/home/celes/.local/state/omniroute-capacity-cascade-dev/20261010T222530Z/`.

## Backup and rollback evidence

- Validated backup: `/home/celes/.local/state/omniroute-routing/20261010T231637Z-capacity-cascade`
- Directory mode: 0700; artifact modes: 0600
- Captured: 93-combo full/paginated export, eight affected lane markers, four tester records, exactly 44 cloud records, three sanitized providers, byte-identical durable source, complete deployment/ReplicaSet/pod runtime state, old immutable digest, candidate metadata, manifest hashes, and journal.
- Secret scan: management key absent.
- Candidate production rollout gate: PASS (exact candidate digest, one ready pod, revision label, authenticated health 200).
- Live apply: STOPPED before first API write on provider precondition mismatch.
- Mismatch paths were only volatile provider health metadata:
  - all three: `connection.lastTested`, `connection.providerSpecificData.apiKeyHealth`, `connection.updatedAt`
  - 4070 additionally: `connection.errorCode`, `connection.lastError`, `connection.lastErrorAt`, `connection.lastErrorType`
- Rollback verification: PASS.
  - Running image restored to `registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87`
  - `/healthz`: HTTP 200
  - Durable `omniroute-mode.py`: byte-identical to backup
  - Combo count: 93; every normalized full combo record matches backup
  - No provider/combo management write occurred
  - Backup/journal secret scan remains clean

## Required next iteration

Do not retry this immutable candidate. A new reviewed runtime change and image must make an execute-mode priority root continue to its next combo-ref when a saturated child is pre-skipped by the parent capacity check. Focused coverage must reproduce the observed `local/research` case: tier1 shared capacities full, tier1b GLM available, parent advances to tier1b without queueing, HTTP 500, or cloud access. The release transaction must again start with a fresh backup and retain the strict durable-provider projection exclusions proven in this retry. Rollback tooling should also account for legacy records that the candidate schema cannot PUT by ensuring the old runtime is restored before retrying such exact legacy payloads.
