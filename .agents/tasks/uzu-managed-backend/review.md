# Wire Uzu Qwen3.8-27B-S as an on-demand managed launchd backend

The change adds Uzu as a fourth managed inference backend alongside the existing MLX, GLM-5.3, and DeepSeek V4.1 servers. A new `com.celes.uzu-server` launchd user agent execs the on-disk Uzu binary on port 8073; the `local-model-proxy` gains a `qwen38-uzu` launchctl backend so it starts Uzu on demand and routes by model name. The OmniRoute Zoo worker-ladder prose now names the M5 Max/Uzu interactive lane as single-stream and non-batching, and a new `docs/local-inference.md` documents the full backend table plus Uzu's measured characteristics. The commit is a single focused commit, one ahead of `main`, working tree clean.

Watch for: the user's requested change is a *numeric* OmniRoute lane ladder (1=5090, 2=4070 Ti Super, 3=Uzu, 4=second-5090, 5+=free/low-cost, GLM out of the worker ladder). That ladder is **not representable in this worktree** — `scripts/configure-omniroute.sh` named in the brief does not exist here, and the only in-worktree ladder representation is prose (confirmed). The authoritative numeric reassignment must still be applied server-side in OmniRoute as a separate change; this commit does the in-worktree prose portion and leaves GLM's mastermind role untouched (confirmed). GLM's mastermind/orchestrator assignment is intact in both zoo files (confirmed), so the one blocking criterion is satisfied.

**Verdict**: APPROVED

## High-level view

The module `modules/darwin/uzu-server.nix` mirrors `mlx-server.nix`'s launchd agent block field-for-field (Label, RunAtLoad=false, KeepAlive=false, ThrottleInterval, Std paths to `ai/logs/uzu-server.log`, ExitTimeOut) while using the deepseek/glm "exec a binary" launcher style rather than building a nix python env — the correct choice since Uzu is a self-contained vendor Mach-O that must not be repackaged through nix. The binary is referenced at its on-disk path. It is imported in `flake.nix`, the sole site where `mlx-server.nix` is imported.

The proxy backend `qwen38-uzu` in `packages/local-model-proxy/models.json` (the source file, not the store symlink) matches the sibling launchctl backends' field names exactly, with port 8073, service `gui/$UID/com.celes.uzu-server`, upstream_model `qwen3.8-s`, and both model names `qwen3.8-27b-uzu` / `uzu-qwen3.8-27b`. `models.json.new` was deliberately left alone because it is a stale non-mirror (ds4/evocua), consistent with the brief's "only if kept in sync" condition.

The `enable_thinking` passthrough needs no proxy change: every POST handler reads the raw body and forwards it verbatim with `data=body_bytes`, parsing JSON only for `model`/`stream` routing. A top-level `enable_thinking` therefore reaches Uzu unmodified. This was verified by reading the handler, not assumed.

The OmniRoute worker-ladder prose was updated in both `omniroute-zoo-profiles.template.json` and `custom_modes.yaml` to name the Uzu lane and its single-stream character; GLM's mastermind sentence was left byte-identical. The substantive numeric lane reassignment lives in server-side OmniRoute config absent from this worktree, flagged as follow-up.

`docs/local-inference.md` is new and carries the backend table (including the Uzu row at port 8073 with both model names and the launchd label), the port/numbers/facts, and the no-continuous-batching caveat.

<details>
<summary>Issues (1)</summary>

1. **Numeric OmniRoute lane ladder is out of worktree scope** — the user's full request (insert Uzu at lane 3, demote second-5090 to lane 4, remove GLM from the worker ladder as numeric lanes) is server-side OmniRoute config not present in this flake; only the in-worktree prose was updated. This is correctly documented as follow-up, not a defect in the diff, but the server-side change must still be applied for the routing intent to take effect. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Module mirrors mlx-server.nix with the correct launcher style

`modules/darwin/uzu-server.nix` uses the `{ pkgs, username, ... }:` signature shared by both sibling modules. The launchd agent block is a field-for-field match of `com.celes.mlx-qwen-server`: `Label = "com.celes.uzu-server"`, `RunAtLoad = false`, `KeepAlive = false`, `ThrottleInterval = 10`, both Std paths pointing at `/Users/${username}/ai/logs/uzu-server.log`, `ExitTimeOut = 30`. RunAtLoad/KeepAlive false is required so the proxy owns the lifecycle via `launchctl kickstart`, same as the other managed backends.

The launcher diverges from mlx-server.nix deliberately and correctly. MLX builds a nix python environment via a shared packages file; Uzu instead `exec`s the on-disk binary directly through `writeShellScriptBin`, with `--model`, `--host 127.0.0.1`, `--port 8073` on the `server` subcommand. The binary at `/Users/${username}/ai/uzu/qwen3.8-s/uzu/uzu` is referenced at its on-disk path and is not repackaged through nix — exactly what the brief required for a self-contained vendor Mach-O. The `username` variable is used throughout rather than hardcoding `celes`, matching the sibling modules. The absence of an `EnvironmentVariables` block (which MLX needs for HF_HOME/PATH) is appropriate here since the exec'd binary is self-contained.

The import is wired in `flake.nix` right after the deepseek server line, grouping the inference servers together. Grep confirmed this is the only site importing `mlx-server.nix`, so the module is wired everywhere its sibling is.

### Proxy backend matches sibling schema

The `qwen38-uzu` entry in `packages/local-model-proxy/models.json` carries exactly the field set used by `qwen38-mlx` and `glm53`: `type` launchctl, `service` `gui/$UID/com.celes.uzu-server` (keeping the literal `$UID` the proxy expands at load time), `base_url` `http://127.0.0.1:8073/v1`, `health_url` `http://127.0.0.1:8073/v1/models`, `startup_timeout` 120, `upstream_model` `qwen3.8-s`, and `model_names` `[ "qwen3.8-27b-uzu", "uzu-qwen3.8-27b" ]`. The label matches the launchd module. The model names do not collide with any existing backend. This was edited in the source file, not the nix-store symlink, as required.

`models.json.new` was left untouched. It holds a stale, divergent set (`ds4`/`evocua`) that is not a mirror of the live `models.json`, so the brief's "update it too only if it exists AND is kept in sync" condition does not apply. The commit message records this as deliberate.

### enable_thinking reaches Uzu unmodified without a proxy change

Reading `handle_chat_completions` confirms the pattern: `body_bytes = await request.read()`, then `json.loads(body_bytes)` solely to extract `model` and `stream` for routing and streaming decisions, then the request is forwarded with `data=body_bytes` — the original bytes, not a re-serialized object. The same `data=body_bytes` forward appears in all four POST handlers (`handle_chat_completions`, `handle_responses`, `handle_messages`, `handle_completions`) plus the `/v1` catch-all. A grep for `enable_thinking` in the proxy returns nothing, so the proxy never strips or rewrites it. A top-level `enable_thinking` field therefore passes through to Uzu intact. The brief's concern — that the field must reach the upstream as a top-level field and not be shunted into `chat_template_kwargs` — is satisfied, and no proxy change was needed. This was verified against the code, not taken on faith.

### GLM mastermind untouched; worker-ladder prose names the Uzu lane

Both zoo files edit only the worker/generation ladder sentence, replacing "or M5 Max when eligible" with language naming the Uzu backend (`qwen3.8-27b-uzu`) and stating the M5 Max/Uzu lane is single-stream and non-batching, suiting interactive low-concurrency work rather than fan-out. The GLM mastermind sentence — "You coordinate on hybrid/planner (tier 1 is GLM only) as the lightweight mastermind..." — is byte-identical in both files. Grep confirms "lightweight mastermind" and "tier 1 is GLM only" each still appear exactly once per file, and the diff shows those spans are outside the changed region. GLM's mastermind/orchestrator role is fully preserved, so the brief's blocking criterion holds.

The numeric lane ladder (Uzu→3, second-5090→4, GLM removed from the worker ladder) is not in this worktree. The brief named `scripts/configure-omniroute.sh`; that file does not exist here (confirmed — `scripts/` contains only builder/model helpers, and a repo-wide search for `configure-omniroute*` finds nothing). The only in-worktree representation of the ladder is the two prose files, and a search for "4070 Ti" across tracked json/yaml/sh/nix files returns only those two. The numeric reassignment is genuinely OmniRoute server-side config outside this flake. The commit handles the in-worktree prose portion and flags the server-side numeric change as follow-up — the correct resolution for a brief that references an absent file, and it does not weaken GLM's role.

### Docs cover the Uzu row, numbers, and the batching caveat

`docs/local-inference.md` is new. It opens with a managed-backend table whose Uzu row lists port 8073, model names `qwen3.8-27b-uzu` / `uzu-qwen3.8-27b`, and label `com.celes.uzu-server`, alongside the existing MLX/GLM/DeepSeek rows. The Uzu section states the facts the brief asked for: macOS 26.4+ on Apple Silicon, 2.4-bit quant ~15 GB resident with a built-in speculator, single-stream throughput ~141-145 tok/s greedy and ~35-39 tok/s prose, cold start ~12s with the matching `startup_timeout` 120, and the on-disk binary/model paths. The no-continuous-batching caveat is explicit: Uzu serializes concurrent requests, aggregate throughput stays flat ~34-38 tok/s, making it a single-user latency champion rather than an aggregate-throughput backend — which is the stated justification for the interactive low-concurrency lane. A dedicated subsection documents the top-level `enable_thinking` passthrough and the verbatim-forward proxy behavior, and a routing note states GLM remains mastermind while the authoritative numeric ordering lives server-side.

### Commit hygiene and verification evidence

The commit is a single focused commit on `uzu-managed-backend`, one ahead of `main`, touching exactly the six intended files with a clean working tree. No `.changeset` or `CHANGELOG` changes. Main is untouched. No pre-existing dirty changes were pulled in.

The coder's `verification.md` records static validation appropriate to a no-rebuild change: `nix-instantiate --parse` on the module (exit 0), a targeted `nix eval` of the darwin agent list confirming `com.celes.uzu-server` is present and its Label resolves, `python3 -m json.tool` on both JSON files, a `yq-go` YAML parse of `custom_modes.yaml` (PyYAML unavailable), grep counts confirming the GLM clauses are unchanged, and a content-presence check on the docs. These are the right static gates; the live rebuild is the user's responsibility by design. I did not re-run the suites; the spot-checks I ran (sibling schema comparison, proxy handler read, GLM clause grep, absence of `configure-omniroute.sh`) corroborate the recorded evidence rather than duplicate it.

</details>

<details>
<summary>File map</summary>

- `modules/darwin/uzu-server.nix` (new) — `com.celes.uzu-server` launchd agent exec'ing the on-disk Uzu binary on port 8073; mirrors mlx-server.nix agent block, deepseek-style exec launcher.
- `flake.nix` — imports the new module at the sole mlx-server.nix import site.
- `packages/local-model-proxy/models.json` — adds the `qwen38-uzu` launchctl backend matching sibling schema.
- `modules/home/zoo/omniroute-zoo-profiles.template.json` — worker-ladder prose names the Uzu lane; mastermind clause unchanged.
- `modules/home/zoo/custom_modes.yaml` — same worker-ladder prose edit.
- `docs/local-inference.md` (new) — backend table + Uzu facts + no-continuous-batching caveat + enable_thinking passthrough + routing note.

Full diff: `git -C /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend diff main...uzu-managed-backend`

</details>
