# Implementation Plan — Wire Uzu as a managed backend

Worktree root (all paths below are under it unless noted):
`/Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend`

The step agent cwd is NOT the worktree. Use absolute paths, and for git use
`git -C /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend`.

Do NOT run `darwin-rebuild`. The user runs the rebuild and will tell you when to
verify live behavior. All verification in this plan is static (parse/eval/JSON),
no live ports, no installs.

---

## Design decisions discovered during exploration (read before editing)

These decisions shape the tasks below. They come from reading the actual
worktree, and three of them diverge from the brief's stated file layout. The
divergences are real and are called out so the implementer edits the right
files instead of chasing files that do not exist here.

1. **Two server patterns exist; Uzu follows the GLM/ds4 "exec a binary" pattern,
   NOT the MLX "build a python env" pattern.** `modules/darwin/mlx-server.nix`
   builds a nix python environment via `modules/shared/mlx-packages.nix`. Uzu is
   a self-contained vendor Mach-O on disk — it must NOT be repackaged through
   nix. The structurally correct sibling to mirror is
   `modules/darwin/deepseek-v4-server.nix` + `modules/shared/deepseek-v4-packages.nix`,
   where each `writeShellScriptBin` just `exec`s an on-disk binary with
   host/port flags and the launchd agent points at that script. The brief says
   "model closely on mlx-server.nix"; we mirror mlx-server.nix's **launchd agent
   block shape** (Label/RunAtLoad/KeepAlive/ThrottleInterval/StdPaths/ExitTimeOut)
   but mirror deepseek's **exec-a-binary launcher** style for the script itself.
   This matches the brief's own instruction to use RunAtLoad=false/KeepAlive=false
   "same as glm53/mlx agents" and to exec the on-disk uzu path directly.

2. **No `uzu-bootstrap` helper.** `mlx-server.nix` itself defines no bootstrap
   helper (the `mlx-qwen-convert`/download helpers live in the shared packages
   file, not the server module). The brief gates the bootstrap on mlx-server.nix
   defining an equivalent — it does not — so we SKIP the bootstrap helper. The
   model is already on disk; a download helper is out of scope.

3. **The proxy forwards request bodies verbatim.** `model_proxy.py` reads the
   raw body (`body_bytes = await request.read()`) and sends it to the upstream
   with `data=body_bytes` in every handler. It parses JSON only to read
   `model`/`stream` for routing — it never strips or rewrites fields. Therefore
   a top-level `enable_thinking` field already passes through to Uzu untouched.
   **No `model_proxy.py` change is required for Task 2's passthrough.** This is
   stated as a finding, with the exact lines, so the reviewer can confirm it
   rather than assume a change was skipped.

4. **The numeric OmniRoute lane ladder (1=5090, 2=4070 Ti, 3=5090, 4=glm,
   5+=free) is NOT in this worktree.** `scripts/configure-omniroute.sh` does not
   exist here (there is no `scripts/configure-omniroute.sh`; `scripts/` contains
   only builder/model helpers). `modules/home/omniroute-editors.nix` states
   plainly: "OmniRoute owns all routing/tiering; these profiles only select
   OmniRoute model/route ids per mode." The lane ladder is server-side OmniRoute
   config living in the menagerie repo / OmniRoute fabric, not in this flake.
   What this worktree holds is **prose** describing the tiers, in two files:
   `modules/home/zoo/omniroute-zoo-profiles.template.json` and
   `modules/home/zoo/custom_modes.yaml`. The template is the committed source;
   `custom_modes.yaml` carries the same orchestrator text verbatim and is the
   real second file (the brief named `configure-omniroute.sh`, which is absent).
   Task 3 is therefore a **prose-only** edit in those two files: add the M5/Uzu
   worker to the generation-ladder sentence and leave GLM's mastermind sentence
   untouched. The substantive numeric-lane change (insert Uzu at lane 3, demote
   second-5090 to lane 4, remove GLM from the worker ladder) must be made
   server-side in OmniRoute, which is out of this worktree's scope — see Task 3
   notes and the final "Out of scope / follow-up" section.

5. **`docs/local-inference.md` does not exist** (`docs/` has basert*, deepseek-v4-mlx-findings,
   kiro-local-model-mcp). Task 4 therefore CREATES it. Match the markdown
   table/section style of the existing `docs/deepseek-v4-mlx-findings.md`.

6. **`models.json.new` is stale and NOT kept in sync.** The live source
   `packages/local-model-proxy/models.json` has backends
   `qwen38-mlx / glm53 / deepseek-v41-uncensored / qwen35-reader-262k`, while
   `models.json.new` has a different, older set (`ds4 / evocua`). They are not
   mirrors. Per the brief ("update it too only if it exists AND is kept in
   sync"), we edit ONLY `models.json` and leave `models.json.new` alone. Note
   this in the commit message so the reviewer knows it was a deliberate choice.

7. **Uzu CLI shape confirmed** (via `uzu server --help`, read-only): usage is
   `uzu server --model <MODEL> --host <HOST> --port <PORT>`; all three flags are
   on the `server` subcommand; `--model` takes the model **directory**. The
   brief's invocation is exactly correct.

---

## Task 1 — New launchd agent module `modules/darwin/uzu-server.nix`

- [ ] 1. Create `modules/darwin/uzu-server.nix` defining the Uzu launcher inline
      (no shared packages file needed — single self-contained binary) and the
      launchd user agent that runs it.
      - Module header: `{ pkgs, username, ... }:` (both `mlx-server.nix` and
        `deepseek-v4-server.nix` use exactly this signature; `username` is
        supplied by `specialArgs` in `flake.nix`).
      - In the `let` block, define a launcher with `pkgs.writeShellScript`
        (mlx-server.nix uses `writeShellScriptBin` from the shared file; here a
        bare `writeShellScript` is enough since the agent `command` points at it
        directly). Script body, mirroring the deepseek launchers' `exec`-a-binary
        style and using the absolute on-disk path (do NOT nix-package the binary):
        ```sh
        #!/bin/sh
        exec /Users/${username}/ai/uzu/qwen3.8-s/uzu/uzu server \
          --model /Users/${username}/ai/uzu/qwen3.8-s \
          --host 127.0.0.1 \
          --port 8073
        ```
        Use the module's `username` variable rather than hardcoding `celes`
        (both sibling modules parameterize the user this way).
      - launchd agent block, mirroring the EXACT field set and style of the
        `com.celes.mlx-qwen-server` block in `modules/darwin/mlx-server.nix` and
        the glm53/ds4 blocks in `modules/darwin/deepseek-v4-server.nix`:
        ```nix
        launchd.user.agents."com.celes.uzu-server" = {
          command = "${uzuServer}";   # path to the writeShellScript
          serviceConfig = {
            Label = "com.celes.uzu-server";
            RunAtLoad = false;
            KeepAlive = false;
            ThrottleInterval = 10;
            StandardOutPath = "/Users/${username}/ai/logs/uzu-server.log";
            StandardErrorPath = "/Users/${username}/ai/logs/uzu-server.log";
            ExitTimeOut = 30;
          };
        };
        ```
        (`writeShellScript` returns a store path to the script file, so
        `command = "${uzuServer}";` with no `/bin/...` suffix — unlike the
        `writeShellScriptBin` siblings which append `/bin/<name>`. Pick ONE
        consistently: if you prefer `writeShellScriptBin "uzu-server"` to match
        the siblings 1:1, then use `command = "${uzuServer}/bin/uzu-server";`.
        Mirroring the siblings exactly is the lower-risk choice — prefer
        `writeShellScriptBin`.)
      - RunAtLoad=false and KeepAlive=false are required: the proxy launches it
        on demand via `launchctl kickstart`, same as glm53/mlx.
      - Do NOT add a bootstrap/download helper (design decision 2).
      Files: `modules/darwin/uzu-server.nix` (new)
      Verify: `nix-instantiate --parse /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend/modules/darwin/uzu-server.nix`
      exits 0 (parses with no syntax error). Expected: prints the parsed
      expression, exit code 0.

- [ ] 2. Wire the new module into the flake wherever `mlx-server.nix` is
      imported. Grep confirmed exactly ONE import site:
      `flake.nix` line ~94, in the `darwinConfigurations.${hostname}.modules`
      list, between `./modules/darwin/mlx-server.nix` and
      `./modules/darwin/deepseek-v4-server.nix`. Add
      `./modules/darwin/uzu-server.nix` to that list (place it right after the
      deepseek line to keep the inference servers grouped). There is no separate
      `modules/darwin` aggregator and no host-level module list that imports
      mlx-server.nix — `flake.nix` is the only site.
      Files: `flake.nix`
      Verify (static, no rebuild): from the worktree root run
      `nix eval --impure --expr 'builtins.attrNames (builtins.getAttr "launchd" ((import <nixpkgs> {}).lib.evalModules { modules = []; }).config)'`
      is NOT a reliable module-list check; instead use the flake-level eval:
      `nix flake check --no-build /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend`
      — expected: no evaluation errors (it will evaluate the darwin
      configuration's module list including uzu-server.nix). If `nix flake check`
      is too heavy/slow in this environment, fall back to
      `nix eval --impure /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend#darwinConfigurations.stabulous.config.launchd.user.agents --apply builtins.attrNames`
      and confirm `"com.celes.uzu-server"` appears in the printed list. Either
      command evaluating without error, with the uzu agent present, is the pass
      condition.

---

## Task 2 — Proxy backend in `packages/local-model-proxy/models.json`

- [ ] 3. Add the `qwen38-uzu` launchctl backend to the SOURCE file
      `packages/local-model-proxy/models.json` (NEVER the live nix-store
      symlink; NEVER `models.json.new` — design decision 6). Match the exact
      schema used by sibling launchctl backends `qwen38-mlx` and `glm53`:
      keys `type`, `service`, `base_url`, `health_url`, optional
      `startup_timeout`, `upstream_model`, `model_names`. Add as a new top-level
      key under `"backends"` (object order is cosmetic; place after `glm53`):
      ```json
      "qwen38-uzu": {
        "type": "launchctl",
        "service": "gui/$UID/com.celes.uzu-server",
        "base_url": "http://127.0.0.1:8073/v1",
        "health_url": "http://127.0.0.1:8073/v1/models",
        "startup_timeout": 120,
        "upstream_model": "qwen3.8-s",
        "model_names": [ "qwen3.8-27b-uzu", "uzu-qwen3.8-27b" ]
      }
      ```
      Notes on reconciliation with the file's conventions:
      - `service` uses the literal `gui/$UID/<label>` form exactly like
        `qwen38-mlx` ("gui/$UID/com.celes.mlx-qwen-server") — `$UID` is expanded
        at load time by `load_config()` in `model_proxy.py`. Keep `$UID`
        literally; do NOT substitute a numeric uid.
      - The launchd label `com.celes.uzu-server` must match Task 1 exactly.
      - `startup_timeout` 120 is kept because Uzu cold start is ~12s but the
        health poll in `health_wait()` must tolerate first-load weight mapping;
        `qwen38-mlx` uses 300, `glm53` omits it (defaults in code). 120 is a
        deliberate value for Uzu's ~12s cold start plus margin.
      - `upstream_model` `qwen3.8-s` matches the on-disk model dir name
        (`/Users/celes/ai/uzu/qwen3.8-s`); it is informational for this backend
        type (the proxy forwards the client's `model` field unchanged).
      - `model_names` are the names OmniRoute/clients route on; keep both
        `qwen3.8-27b-uzu` and `uzu-qwen3.8-27b` so Task 3/Task 4 can reference
        either. These do not collide with any existing `model_names` in the file.
      Files: `packages/local-model-proxy/models.json`
      Verify: `python3 -m json.tool /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend/packages/local-model-proxy/models.json`
      exits 0 and pretty-prints the file with the new `qwen38-uzu` block present.
      Expected: valid JSON, exit code 0.

- [ ] 4. Confirm (do NOT edit) that `model_proxy.py` forwards a top-level
      `enable_thinking` field to the upstream unchanged. Read the four POST
      handlers (`handle_chat_completions`, `handle_responses`, `handle_messages`,
      `handle_completions`): each does `body_bytes = await request.read()` then
      `json.loads(body_bytes)` only to extract `model`/`stream`, and forwards
      with `data=body_bytes`. Because the original bytes are forwarded,
      `enable_thinking` (top-level) reaches Uzu intact. No code change needed.
      Record this explicitly in the commit message and in `docs/local-inference.md`
      (Task 4) so it is auditable. (If a future reviewer wants a server-side
      default instead, the place would be a new per-backend field consumed in
      `handle_chat_completions` — explicitly out of scope here since passthrough
      already works.)
      Files: none (read-only confirmation)
      Verify: `grep -n "data=body_bytes" /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend/packages/local-model-proxy/model_proxy.py`
      shows the verbatim-forward in all POST handlers; this is a confirmation
      check, not the acceptance test for the task (the acceptance test is step 3's
      JSON validity).

---

## Task 3 — OmniRoute routing prose (worker ladder vs mastermind)

Important scope note (design decision 4): the real numeric lane ladder lives
server-side in OmniRoute, not in this worktree. Within this worktree the only
representation of the ladder is prose in two files. We update that prose so the
generation/worker ladder names the M5/Uzu lane, and we leave GLM's mastermind
sentence exactly as-is. The authoritative numeric reassignment (Uzu→lane 3,
second-5090→lane 4, GLM out of the worker ladder) is a separate OmniRoute
server-side change tracked in "Out of scope / follow-up" below.

The two files and the exact landmarks:

- `modules/home/zoo/omniroute-zoo-profiles.template.json` — committed source,
  consumed by `home.activation.zooOmniRouteImport` in
  `modules/home/omniroute-editors.nix`. The orchestrator prose is the
  `customInstructions` string of the `spec-orchestrator` custom mode
  (`globalSettings.customModes[0]`), on **line 453**.
- `modules/home/zoo/custom_modes.yaml` — the live Zoo modes store, consumed by
  `home.activation.zooCustomModes`. The same orchestrator text appears as YAML
  block scalars: the mastermind sentence on **line 8**, the worker-ladder
  sentence on **line 12**.

LEAVE UNCHANGED — the GLM mastermind sentence (both files):
> "You coordinate on hybrid/planner (tier 1 is GLM only) as the lightweight
> mastermind - doing implementation or large reads yourself in the parent keeps
> everything on GLM and defeats the fabric, so push that work onto dispatched
> workers."
GLM stays the mastermind. Do not touch this clause in either file.

EDIT — the worker/generation ladder sentence (both files). Current text:
> "Keep implementation in Code on hybrid/code at the selected tier with high
> reasoning effort; OmniRoute can place independent Code workers on the 5090,
> 4070 Ti Super, or M5 Max when eligible."
This already excludes GLM from the worker list and already names the M5 Max.

- [ ] 5. In BOTH files, make the worker-ladder sentence state the Uzu M5 lane
      explicitly and its single-stream character, without altering the mastermind
      clause. Replace "or M5 Max when eligible" with language that names the Uzu
      backend and its single-stream positioning, e.g.:
      > "...OmniRoute can place independent Code workers on the 5090, the
      > 4070 Ti Super, or the M5 Max (Uzu Qwen3.8-27B-S, model `qwen3.8-27b-uzu`)
      > when eligible; the M5 Max/Uzu lane is single-stream and non-batching, so
      > it suits interactive, low-concurrency work rather than high-concurrency
      > fan-out."
      Make the SAME textual change in both the JSON string (line 453, keeping it
      a single valid JSON string — escape as needed, no raw newlines) and the
      YAML block scalar (line 12). Do not reword the mastermind sentence.
      Also, in the two reader-lane descriptions that already say "27B on
      5090/4070 Ti Super/M5" (template line 453 body and the `project-research`
      `description` fields), no change is required — they already include M5.
      Files: `modules/home/zoo/omniroute-zoo-profiles.template.json`,
      `modules/home/zoo/custom_modes.yaml`
      Verify (JSON): `python3 -m json.tool /Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend/modules/home/zoo/omniroute-zoo-profiles.template.json`
      exits 0 (still valid JSON after the string edit). Verify (YAML):
      `python3 -c "import yaml,sys; yaml.safe_load(open('/Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend/modules/home/zoo/custom_modes.yaml')); print('ok')"`
      prints `ok` (still valid YAML). If PyYAML is unavailable, fall back to
      `nix eval --impure --expr '(import <nixpkgs> {}).lib.trivial.id true'` is
      not a YAML check — instead confirm no tab/indent corruption by re-reading
      the edited lines. Also confirm the mastermind clause "tier 1 is GLM only"
      and "lightweight mastermind" still appears unchanged in both files via
      `grep -c "lightweight mastermind"` returning the same count as before the
      edit (one per file).

---

## Task 4 — Docs: create `docs/local-inference.md`

- [ ] 6. Create `docs/local-inference.md` documenting local inference backends
      with Uzu added. Match the heading + table style of
      `docs/deepseek-v4-mlx-findings.md` (read it first for tone/format). The doc
      must include a backend table with at least columns: Backend | Port | Model
      names | Launchd label | Notes, with rows for the existing managed backends
      (mlx qwen38 @8070, glm53 @8082, ds4.1-uncensored @8084) and the new Uzu row:
      - Backend: Uzu (Qwen3.8-27B-S, 2.4-bit)
      - Port: 8073
      - Model names: `qwen3.8-27b-uzu`, `uzu-qwen3.8-27b`
      - Launchd label: `com.celes.uzu-server`
      Then a "Uzu" section stating the measured/known facts:
      - macOS 26.4+ required; Apple Silicon (M5 Max here).
      - 2.4-bit quant, ~15 GB resident, built-in speculator.
      - Single-stream throughput: predictable/greedy ~141-145 tok/s; natural
        prose ~35-39 tok/s (single-user latency tier).
      - **No continuous batching**: Uzu serializes concurrent requests; aggregate
        throughput stays flat ~34-38 tok/s. It is a single-user latency champion,
        NOT an aggregate-throughput backend — hence the interactive/low-concurrency
        lane positioning.
      - OpenAI-compatible API; wants a TOP-LEVEL `enable_thinking` field (NOT
        `chat_template_kwargs.enable_thinking`, which is the MLX path). Note that
        `local-model-proxy` forwards request bodies verbatim, so top-level
        `enable_thinking` reaches Uzu unmodified (ref design decision 3).
      - Cold start ~12s; proxy `startup_timeout` set to 120.
      - On-disk paths: binary `/Users/celes/ai/uzu/qwen3.8-s/uzu/uzu`, model dir
        `/Users/celes/ai/uzu/qwen3.8-s`.
      If the doc documents routing, note the ladder change: Uzu takes an
      interactive worker lane; GLM remains the mastermind/orchestrator and is not
      a generation worker. (State plainly that the authoritative numeric lane
      ordering is configured server-side in OmniRoute, not in this flake.)
      Files: `docs/local-inference.md` (new)
      Verify: file exists and is well-formed markdown — run
      `python3 -c "import pathlib,sys; t=pathlib.open if False else open('/Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend/docs/local-inference.md').read(); sys.exit(0 if ('qwen3.8-27b-uzu' in t and '8073' in t and 'enable_thinking' in t) else 1)"`
      exits 0 (contains the key facts). There is no markdown build step in this
      repo, so content-presence is the verification.

---

## Final combined static validation (no rebuild, no live ports)

- [ ] 7. Run the full static validation sweep from the worktree root and confirm
      all pass:
      1. `nix-instantiate --parse <worktree>/modules/darwin/uzu-server.nix` → exit 0.
      2. `nix flake check --no-build <worktree>` → no eval errors (or the
         `nix eval ...#darwinConfigurations.stabulous.config.launchd.user.agents`
         fallback from step 2 showing `com.celes.uzu-server`).
      3. `python3 -m json.tool <worktree>/packages/local-model-proxy/models.json` → exit 0.
      4. `python3 -m json.tool <worktree>/modules/home/zoo/omniroute-zoo-profiles.template.json` → exit 0.
      5. YAML load of `custom_modes.yaml` → `ok`.
      6. `grep -c "lightweight mastermind"` in both zoo files unchanged (GLM
         mastermind clause intact).
      Files: none (validation only)
      Verify: every command above exits 0 / prints its expected success token.

- [ ] 8. Commit locally on branch `uzu-managed-backend` (do NOT push, do NOT
      rebuild). Stage only the touched files explicitly:
      `modules/darwin/uzu-server.nix`, `flake.nix`,
      `packages/local-model-proxy/models.json`,
      `modules/home/zoo/omniroute-zoo-profiles.template.json`,
      `modules/home/zoo/custom_modes.yaml`, `docs/local-inference.md`.
      Commit message should note: (a) Uzu wired as on-demand launchctl backend on
      8073; (b) `model_proxy.py` unchanged because it forwards bodies verbatim so
      top-level `enable_thinking` already passes through; (c) `models.json.new`
      left untouched because it is stale/not a mirror; (d) OmniRoute numeric lane
      ladder is server-side and out of this worktree — only the worker-ladder
      prose was updated and GLM's mastermind role was left intact.
      Files: git commit
      Verify: `git -C <worktree> show --stat HEAD` lists exactly the six files;
      `git -C <worktree> status` is clean.

---

## Out of scope / follow-up (flag to the user)

The user's routing change as a *numeric lane ladder*
(1=5090, 2=4070 Ti Super, 3=M5 Max Uzu 27B-S, 4=second-5090, 5+=free/low-cost,
GLM removed from the worker ladder) is **not representable in this flake
worktree** — that ladder is OmniRoute server-side config and
`scripts/configure-omniroute.sh` does not exist here. This plan makes the
in-worktree prose consistent with the new intent (Uzu as an interactive worker
lane; GLM as mastermind only). The authoritative lane reassignment must be
applied in the OmniRoute fabric / menagerie repo as a separate change. GLM's
mastermind/orchestrator role is deliberately left untouched everywhere, per the
user's "glm is still the mastermind".
