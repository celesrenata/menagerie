# OmniRoute Fail-Fix Deploy Report

**Status: DEPLOYED and STABLE in production.** The 3.8.52 fail-fix image is live, the k8s rollout
succeeded, git↔live parity is reconciled, and the Zoo Code VS Code extension carrying the FEAT-005
tier dropdown is installed. One class of verification (live-chat FEAT-002/005) remains blocked purely
by a missing inference key — a user-owned credential gap, not a deploy failure.

---

## 1. What Shipped

| Item                  | Value                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| OmniRoute image tag   | `registry.celestium.life/library/omniroute:3.8.52-failfixes-feat002-005-20261001`                                |
| Image digest          | `sha256:cb0750ca7ad168ba6672a84543a9c90cc615738996e15f46ce87fd9cbc4a51d8`                                        |
| Live running digest   | `sha256:cb0750ca…` — **MATCHES build digest** (authoritative, not just the tag)                                  |
| k8s rollout result    | `deployment "omniroute" successfully rolled out`                                                                 |
| Live pod              | `omniroute-774d5b74d4-2t9vz` — `ready=true`, `restarts=0`, `started=true`                                        |
| Manifest commit SHA   | `405efdf38d220383288837b9053973ec56f7db71` (`~/sources/kube/omniroute/omniroute.yaml` line 61, clean tree)       |
| Source commit (image) | `8d9d5f7a811f87099ac200cedd5fbbc01e7832c6` on `feat/hybrid-reader-combo`                                         |
| Build target          | `runner-cli` (matches live CLI sidecars: droid/openclaw/codex/claude/git/node), built natively on esnixi (amd64) |

FEAT commits baked into the image:

- **FEAT-002** `db3586f9e` — system-first memory injection for self-hosted strict Qwen/GLM providers
- **FEAT-004** `f48cdb12a` — empty-output 502 diagnostic (provider + memory-injection state)
- **FEAT-005** `8d9d5f7a8` — per-request `X-OmniRoute-Tier` cost-tier ceiling

### Rollout history (why there was a flap)

The first 3.8.52 pod (`omniroute-774d5b74d4-5dg2m`) flapped: its liveness probe (`/livez`, 5s × 3)
timed out during the slow cold start (DB open, cleanup sweeps, ModelSync, CredentialHealth testing 12
upstreams, several timing out — notably the esnixi 5090 vLLM reader). The kubelet SIGTERM-killed and
restart-looped it, producing ~45–60s ingress "no available server" windows. An operator rolled the
image back to 3.8.50 (temporary, uncommitted) **and added a `startupProbe`** (`GET /healthz`,
`failureThreshold=36 × periodSeconds=5` ≈ 180s cold-start budget). The image was then re-set to
3.8.52 with the startupProbe retained; the probe absorbed the cold start and the pod came up stable
with **0 SIGTERM kills**. The flap was a runtime startup-timing issue, not an image-content or
FEAT-code defect.

---

## 2. Verification Evidence

| FEAT / check                                            | Result                                    | Detail                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------- |
| FEAT-002 — no System-first 500                          | **PASS (image live) / live-chat PENDING** | Fix in running image (unit-verified 29/29 at build). **0** "System message must be at the beginning" 500s in fresh pod logs. Live strict-template chat verification blocked only by the inference-key gap.         |
| FEAT-005 — `X-OmniRoute-Tier` tier header               | **PASS (image live) / live-chat PENDING** | Fix `8d9d5f7a8` in running image. Header tier-2/tier-3 vs no-header-default behavior pending a valid inference key.                                                                                                |
| FEAT-004 — empty-502 `mem=` diagnostic                  | **PASS (image live) / not triggered**     | Fix `f48cdb12a` in running image. No empty-502 occurred in the window to observe the `mem=true                                                                                                                     | false | ?` line live. |
| FEAT-001/003 — capability overrides + tier-5 still live | **PENDING live read**                     | Re-read coder `131072/98304`, balanced `131072/65536`, tier-5 `gpt-5.6-terra` via management API once the `/api/combos` read path is stable (parent owns that path).                                               |
| Clean log window                                        | **PASS**                                  | New pod: `SIGTERM=0`, `restarts=0`, 0 System-first 500s. Startup-probe timeouts during cold start did **not** escalate to a kill. External `/healthz` = 200 on all 13 samples over ~5 min (07:11:40–07:16:30 UTC). |
| Three Zoo lanes                                         | **PARTIAL**                               | `hybrid/code` and `hybrid/planner` present on gateway combos; **`hybrid/reader` ABSENT**. Restoring `hybrid/reader` (+ `pool/tierN/reader`) is owned by the parent session.                                        |

Note: `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` is **not set** in the live env — now redundant since the
image itself carries the FEAT-002 fix, as anticipated.

---

## 3. Rollback Command

```
kubectl set image deploy/omniroute -n omniroute omniroute=registry.celestium.life/library/omniroute:3.8.50-native-ovms-spacing-20260929
```

**When to use:** If the live 3.8.52 pod starts flapping again (SIGTERM kills / restart loop /
`/healthz` non-200 / 503 empty-endpoints at the ingress) and the cause cannot be quickly isolated to
a transient upstream. This reverts to the last known-good 3.8.50 image. The command was documented
and tested during the flap (it successfully restored service) but is **not currently in effect** —
live runs 3.8.52. After a rollback, re-commit the manifest to keep git↔live parity.

---

## 4. Zoo Deploy Status

**DEPLOYED.** The Zoo Code VS Code extension carrying the FEAT-005 per-request tier dropdown is built
and installed.

| Item               | Value                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch             | `feat/omniroute-tier-dropdown-feat005`                                                                                                                                   |
| Head commit        | `fa00ee99c0ce94cae36421177f36de666671d223`                                                                                                                               |
| Version            | `3.84.4`                                                                                                                                                                 |
| VSIX               | `bin/zoo-code-3.84.4.vsix` (33 MB), built via `pnpm vsix`                                                                                                                |
| Install method     | `code --install-extension --force` (VS Code CLI) — reported success                                                                                                      |
| Post-install proof | installed `extension.js` → 1 `X-OmniRoute-Tier` hit; webview `index.js` → 4 `omniRouteTier` hits; mtime `2026-10-02 01:15` (replaced stale Oct 1 build with 0 tier hits) |

The OmniRoute verify gate was explicitly waived by the user: the only `verify.json` blocker was
live-chat verification pending a valid inference key, which is unrelated to this UI feature.
`darwin-rebuild` was not exercised; standard CLI install was used per parent-session direction.

**Action required by user:** Reload the VS Code window (`Developer: Reload Window`) for the newly
installed build to load. The per-request cost-tier dropdown ($…$$$$$ for Tier 1–5) will then appear
next to YOLO mode.

---

## 5. Remaining Operator / Follow-Up Steps

None of the following block the OmniRoute deploy (it is live and stable).

1. **esnixi `nixos-rebuild switch` (operator sudo).** On esnixi (`celes@192.168.42.254`), the
   `vllm-switch.py` context `131072` change (FEAT-001/003 esnixi-side) is committed on
   `feat/nvfp4-reader-fabric` but needs operator `sudo nixos-rebuild switch`. The **LIVE overrides
   are already applied via API**, so this rebuild only makes the switcher's advertised limits match
   declaratively — it does **not** change live behavior and does **not** block the OmniRoute deploy.
   Run:
    ```
    sudo nixos-rebuild switch
    ```
2. **Inference key (user).** Mint/supply a valid inference key so live FEAT-002/005 chat
   verification can run; both known keys (old `sk-1e7cfaf…` and the zoo key) return 401 on
   `/v1/chat`.
3. **`hybrid/reader` restore (parent session).** The combo (+ `pool/tierN/reader`) is absent from the
   public gateway; parent restores it via the management API.
4. **FEAT-001/003 live read.** Re-read capability-overrides (coder `131072/98304`, balanced
   `131072/65536`) and tier-5 `gpt-5.6-terra` against the live 3.8.52 once the `/api/combos` read
   path is stable.
5. **Zoo window reload (user).** `Developer: Reload Window` in VS Code to activate the installed
   3.84.4 tier-dropdown build.
6. **Do NOT re-deploy without the startupProbe.** The 3.8.52 image is only stable because the
   deployment template now carries the `startupProbe` (~180s cold-start budget). Keep it in any
   future manifest change; it absorbs the slow credential-health cold start.

---

_Related context resolved out of scope:_ the esnixi RTX 5090 vLLM 8s `/v1/models` timeout was the
reader EngineCore crash (flashinfer `mm_fp4` cute-dsl on SM120), already fixed live via
`--linear-backend cutlass` + an operator rebuild; `vllm-reader` now serves `qwen3.5-9b-nvfp4-reader`.
