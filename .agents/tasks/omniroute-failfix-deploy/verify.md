# OmniRoute Fail-Fix Deploy — Production Verification

**Result: DEPLOY PASS.** The 3.8.52 fail-fix image is now **live and stable** in production, running
with the startupProbe that absorbs the slow cold start. The FEAT-002/004/005 fixes are therefore in
the running image. The only outstanding item is **live-chat verification**, which is blocked by the
absence of a valid inference key (a credential gap owned by the user, **not** a deploy failure).

---

## Re-deploy summary (this step)

1. Confirmed the live deployment template already carried the `startupProbe`
   (`GET /healthz`, `failureThreshold=36 × periodSeconds=5` ≈ 180s cold-start budget) and that
   `kubectl set image` would not disturb it.
2. `kubectl set image deploy/omniroute -n omniroute omniroute=…:3.8.52-failfixes-feat002-005-20261001`
   → `deployment.apps/omniroute image updated`.
3. `kubectl rollout status … --timeout=300s` → `deployment "omniroute" successfully rolled out`.
4. Verified the running image **digest** (authoritative, not the tag).
5. Watched stability for ~5 minutes.

---

## Live state (verified against the cluster)

| Fact                                  | Value                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Live pod                              | `omniroute-774d5b74d4-2t9vz` — `ready=true`, `restarts=0`, `started=true`         |
| Live pod image                        | `registry.celestium.life/library/omniroute:3.8.52-failfixes-feat002-005-20261001` |
| Live running digest                   | `sha256:cb0750ca7ad168ba6672a84543a9c90cc615738996e15f46ce87fd9cbc4a51d8`         |
| Build digest (expected)               | `sha256:cb0750ca…` — **MATCH** (not the 3.8.50 `dcb77a84`)                        |
| startupProbe                          | present and effective (~180s budget on `/healthz`)                                |
| SIGTERM count (new pod logs)          | **0** — container never killed                                                    |
| System-first-500 count (new pod logs) | **0**                                                                             |

**Stability watch (external `/healthz` + pod state), 13 samples over ~5 min:**

```
07:11:40 phase=Running ready=true restarts=0 ext_healthz=200
07:12:00 ... 200
07:12:21 ... 200
07:13:28 ... 200
07:13:48 ... 200
07:14:08 ... 200
07:14:29 ... 200
07:14:49 ... 200
07:15:09 ... 200
07:15:30 ... 200
07:15:50 ... 200
07:16:10 ... 200
07:16:30 phase=Running ready=true restarts=0 ext_healthz=200
```

During cold start the kubelet logged transient `Startup probe failed`, one `Liveness probe failed`,
and `Readiness probe failed` (all `context deadline exceeded`) while the heavy init ran (DB open,
`[Cleanup]` sweeps, `ModelSync`, `CredentialHealth`). Crucially these did **not** escalate to a kill:
`SIGTERM count = 0`, `restarts = 0`. The startupProbe held liveness enforcement off until the app
warmed up. This is the exact difference from the earlier 3.8.50-era flap (which SIGTERM-killed and
restart-looped) — **the flap is resolved**.

---

## git ↔ live parity (reconciled)

- Committed manifest `405efdf` (`~/sources/kube/omniroute/omniroute.yaml` line 61) declares
  `3.8.52-failfixes-feat002-005-20261001`; the file is clean (no uncommitted diff).
- Live now runs exactly that image, so the temporary `kubectl set image` rollback to 3.8.50 (done
  during the flap, uncommitted) is superseded and git↔live agree again.
- The `startupProbe` is present in both the committed manifest and the live deployment.

---

## FEAT results

| FEAT                                         | Result                            | Detail                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- |
| FEAT-002 (System-first memory injection)     | **image LIVE; live-chat PENDING** | The fix (`db3586f9e`, unit-verified 29/29 at build) is in the running 3.8.52 image. 0 "System message must be at the beginning" 500s in the fresh pod logs. Live strict-template chat verification is blocked only by the inference-key gap (old `sk-1e7cfaf…` and zoo key both 401 on `/v1/chat`). Not a deploy failure. |
| FEAT-005 (`X-OmniRoute-Tier` ceiling)        | **image LIVE; live-chat PENDING** | Fix `8d9d5f7a8` is in the running image. Header tier-2/tier-3 vs no-header default behavior pending a valid inference key.                                                                                                                                                                                                |
| FEAT-004 (empty-502 `mem=` diagnostic)       | **image LIVE; not-triggered**     | Fix `f48cdb12a` is in the running image. No empty-502 occurred in the window to observe the `mem=true                                                                                                                                                                                                                     | false | ?` line live. |
| FEAT-001/003 (capability overrides + tier-5) | **pending live read**             | Re-read coder `131072/98304`, balanced `131072/65536`, and tier-5 `gpt-5.6-terra` via the management API against the now-live 3.8.52 once the combos read path is stable (parent owns that path).                                                                                                                         |
| Log check                                    | **clean**                         | New pod: `SIGTERM=0`, `restarts=0`, 0 System-first 500s; startup probe timeouts did not escalate to a kill.                                                                                                                                                                                                               |
| Zoo lanes                                    | **partial**                       | `hybrid/code` and `hybrid/planner` present on gateway combos; **`hybrid/reader` ABSENT**. Parent session owns restoring `hybrid/reader` (+ `pool/tierN/reader`).                                                                                                                                                          |

- `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` is **not set** in the live env — now redundant since the image
  carries the fix, exactly as the brief anticipated.
- The **esnixi RTX 5090 vLLM 8s `/v1/models` timeout** is **resolved out of scope**: it was the
  reader EngineCore crash (flashinfer `mm_fp4` cute-dsl on SM120), fixed live via
  `--linear-backend cutlass` + an operator `nixos-rebuild switch`; `vllm-reader` now serves
  `qwen3.5-9b-nvfp4-reader`.

---

## Follow-ups

1. **Inference key (user).** Mint/supply a valid inference key so live FEAT-002/005 chat
   verification can run (both known keys are 401 on `/v1/chat`).
2. **`hybrid/reader` restore (parent session).** Combo (+ `pool/tierN/reader`) absent from the public
   gateway; parent restores via the management API.
3. **FEAT-001/003 live read.** Re-read capability-overrides/tier-5 against the live 3.8.52 once the
   combos read path is stable.

Rollback command (documented, **not executed**):
`kubectl set image deploy/omniroute -n omniroute omniroute=registry.celestium.life/library/omniroute:3.8.50-native-ovms-spacing-20260929`
