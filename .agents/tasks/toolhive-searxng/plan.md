# Implementation Plan: ToolHive + searxng-enhanced on nix-darwin

Derived from the APPROVED design at `.agents/tasks/toolhive-searxng/design.md`
(gate: `design-review.json` verdict APPROVED). This plan sequences the work; it
does not re-decide the architecture. All paths are absolute. The target repo is
**`/Users/celes/sources/m5max-darwin-flake`** (outside the agent workspace — relative
paths would land in the wrong tree, so always use the absolute paths below).

## Grounding facts confirmed during exploration (do not re-derive)

- Target flake: `/Users/celes/sources/m5max-darwin-flake/flake.nix`, host attr
  `darwinConfigurations.stabulous`, `hostname = "stabulous"`, `username = "celes"`,
  `system = "aarch64-darwin"`. `specialArgs = { inherit inputs username hostname system; }`.
- `pkgs.toolhive` resolves to **0.43.0** and `meta.platforms` lists `aarch64-darwin`
  (verified via `nix eval`). The clean `nix build` is the authoritative proof it resolves.
- Agent-shape precedent (verified live/imported): `modules/darwin/omniroute.nix`
  (`{ pkgs, username, ... }`, `launchd.user.agents."com.celes.omniroute"` with `command =
"${script}"` + `serviceConfig` block, `mkdir -p "${home}/ai/logs"` inside the script,
  `RunAtLoad=true`, `KeepAlive`, `ThrottleInterval=10`, `StandardOutPath/StandardErrorPath`,
  `EnvironmentVariables = { HOME; PATH; ... }`, `ExitTimeOut=30`).
- Docker-from-launchd PATH idiom: `modules/darwin/qdrant.nix` uses PATH
  `"${pkgs.docker}/bin:/Users/celes/.docker/bin:/usr/local/bin:/usr/bin:/bin"`. **qdrant.nix
  is NOT imported** — use it for PATH shape only, not as runtime proof.
- Resilience idiom (never fail activation, log to stderr, `exit 0`): `modules/home/total-pc-control-patch.nix`.
- `modules/home/ai.nix` line 251 creates `$HOME/ai/logs`; the start script also `mkdir -p`s it defensively.
- MCP config module: `modules/home/kiro-local-model-mcp.nix`. `mcpConfig.mcpServers` is a plain
  attrset ending `} // chatServers;`. `retiredServerNames = [ "chat-codex" "chat-gpt52" ]`.
  `mkMergeActivation` jq treats each server as an opaque whole object; `$f` (flake) is the base
  in every branch where a server appears. Four activations call it: `kiroMcpConfig`,
  `zooMcpConfig`, `rooMcpConfig` (dropUserOnly=true), `clineMcpConfig` (dropUserOnly=true).
- Live config state (verified via jq): all four files exist as real files (NOT symlinks → the
  **merge** branch runs, not first-deploy), each has **31 servers**, **zero** url-style servers,
  **zero** `chat-codex`/`chat-gpt52`, and **no** `searxng-enhanced`. Approval keys: Kiro has
  `autoApprove` on 6 servers / `alwaysAllow` on 0; Zoo has `alwaysAllow` on 30 / `autoApprove` on 0;
  Roo and Cline have **neither** key on any server. This confirms Decision 2's "set BOTH keys".
- flake.nix module list: darwin service modules are wired in the `modules = [ ... ]` list of
  `darwinConfigurations.stabulous`; `./modules/darwin/open-webui-tools.nix` is the last
  `modules/darwin/*.nix` service entry before `./modules/darwin/basert`.
- The darwin flake has **no AGENTS.md / CONTRIBUTING.md / .kiro/steering**; `docs/` has reference
  notes only (`docs/kiro-local-model-mcp.md`, `docs/local-inference.md`). No contribution gate to satisfy.
- Current git branch is `main` with pre-existing staged/unstaged changes. Do NOT commit unrelated
  files; stage only the three files this plan touches if committing.

## Must-not-break invariants (verify in step 5)

- 4-editor unification (`mkMergeActivation` + the four `home.activation.*McpConfig` calls) unchanged.
- `total-pc-control` native/patched server entry unchanged.
- OmniRoute chat servers `chat-reasoning` / `chat-coding` / `chat-fast` (from `chatServers`) unchanged.
- `retiredServerNames = [ "chat-codex" "chat-gpt52" ]` prune unchanged; do NOT reintroduce either name.
- No duplicate server names (native + ToolHive). `searxng-enhanced` has no native counterpart, so it is safe.
- No `darwin-rebuild switch`. No `thv run`. No container starts. Verification is parse + build + jq-simulate only.

---

- [ ]   1. Create the new darwin module `modules/darwin/toolhive.nix`.
       Signature `{ pkgs, username, ... }:`. `let` bindings: `thv = "${pkgs.toolhive}/bin/thv";`
       `home = "/Users/${username}";` searxng proxy port `19104`, image
       `ghcr.io/celesrenata/mcp-searxng-enhanced:latest`. Define
       `startScript = pkgs.writeShellScript "toolhive-mcp-start" ''...''` that, per the design
       (Decision 1/5 + Implementation surface item 2): sets PATH to
       `${pkgs.toolhive}/bin:${pkgs.docker}/bin:${pkgs.coreutils}/bin:${home}/.docker/bin:/usr/local/bin:/usr/bin:/bin`;
       `mkdir -p "${home}/ai/logs"` defensively; does NOT use `set -e`/`-u` (resilient, each
       fallible step `|| echo "WARN: ..." >&2`); waits for Docker with
       `for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done`; defines
       `run_if_needed()` (`thv list | grep -q "^$name "` → return 0 if up; else
       `thv rm "$name" 2>/dev/null || true`; then `thv run "$@" || echo "WARN: failed to start $name" >&2`);
       keeps the `[ -f ]`-guarded secret-read pattern as a comment/stub (none needed for searxng);
       has NO `thv client register` lines (Decision 5); makes ONE `run_if_needed searxng-enhanced`
       call with EXACTLY these flags: `run --name searxng-enhanced --proxy-port 19104 --transport stdio
--network host --isolate-network=false -e SEARXNG_ENGINE_API_BASE_URL=http://10.1.1.12:30888/search
-e DESIRED_TIMEZONE=America/Los_Angeles ghcr.io/celesrenata/mcp-searxng-enhanced:latest`; ends `exit 0`.
       Declare `launchd.user.agents."com.celes.toolhive-mcp"` with `command = "${startScript}";` and
       `serviceConfig` { `Label="com.celes.toolhive-mcp"`, `RunAtLoad=true`, `KeepAlive=false`,
       `ThrottleInterval=10`, `StandardOutPath`/`StandardErrorPath` = `${home}/ai/logs/toolhive-mcp.log`,
       `EnvironmentVariables = { HOME = home; PATH = <same PATH string>; }`, `ExitTimeOut=30` }.
       Add `system.activationScripts.postActivation.text` that, guarded by a `docker info` check,
       best-effort `${pkgs.docker}/bin/docker pull ghcr.io/celesrenata/mcp-searxng-enhanced:latest || true`
       (must never fail activation). Add `environment.systemPackages = [ pkgs.toolhive ];`.
       Model the agent/serviceConfig shape on `modules/darwin/omniroute.nix`; model the resilience
       discipline on `modules/home/total-pc-control-patch.nix`.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/darwin/toolhive.nix`
       Verify: `cd /Users/celes/sources/m5max-darwin-flake && nix-instantiate --parse modules/darwin/toolhive.nix >/dev/null && echo PARSE_OK`
       — prints `PARSE_OK` (syntax valid). Build-level verification happens in step 4.

- [ ]   2. Wire the new module into the flake's darwin module list.
       Add the line `./modules/darwin/toolhive.nix` to the `modules = [ ... ]` list of
       `darwinConfigurations.stabulous`, immediately after `./modules/darwin/open-webui-tools.nix`
       (and before `./modules/darwin/basert`). This is the darwin-service wiring point — NOT
       `home/celes.nix` (which imports home modules only; the config edit in step 3 is the only
       home-side change).
       Files: `/Users/celes/sources/m5max-darwin-flake/flake.nix`
       Verify: `cd /Users/celes/sources/m5max-darwin-flake && nix-instantiate --parse flake.nix >/dev/null && echo PARSE_OK`
       — prints `PARSE_OK`.

- [ ]   3. Add the `searxng-enhanced` URL server entry to the generated `mcpConfig`.
       In `mcpConfig.mcpServers` (the attrset ending `} // chatServers;`), add a single entry
       alongside the existing servers (e.g. near `nixos`/`total-pc-control`, before the
       `// chatServers` merge):
       `searxng-enhanced = { url = "http://localhost:19104/mcp"; type = "streamable-http"; autoApprove = [ "search_web" "get_website" "get_current_datetime" ]; alwaysAllow = [ "search_web" "get_website" "get_current_datetime" ]; };`
       Set BOTH `autoApprove` (Kiro/Zoo) and `alwaysAllow` (Roo/Cline/Zoo) per Decision 2 — the live
       configs confirm Roo/Cline carry neither key, so only an entry that ships both pre-approves
       search in all four. Make NO change to `mkMergeActivation`, the four `home.activation.*McpConfig`
       calls, `retiredServerNames`, `chatServers`, or any native server. Do not re-add
       `chat-codex`/`chat-gpt52`. Do not add a ToolHive duplicate of any native server.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
       Verify: `cd /Users/celes/sources/m5max-darwin-flake && nix-instantiate --parse modules/home/kiro-local-model-mcp.nix >/dev/null && echo PARSE_OK`
       — prints `PARSE_OK`.

- [ ]   4. Build the full darwin system to prove evaluation, `pkgs.toolhive` resolution, and the agent/config land.
       Run the no-link build (NON-destructive, no switch).
       Files: none (verification only).
       Verify: `cd /Users/celes/sources/m5max-darwin-flake && nix build --no-link .#darwinConfigurations.stabulous.system 2>&1 | tail -20`
       — build completes with no error (the successful build proves `pkgs.toolhive` resolves for
       aarch64-darwin and that the attrset has no duplicate-key eval error). Then confirm the agent
       and the config entry evaluate:
       `nix eval --json .#darwinConfigurations.stabulous.config.launchd.user.agents.\"com.celes.toolhive-mcp\".serviceConfig.Label` → `"com.celes.toolhive-mcp"`;
       `nix eval --raw .#darwinConfigurations.stabulous.config.home-manager.users.celes.home.file.\"ai/mcp/local-model-mcp/index.js\".source >/dev/null` is not required — instead confirm the generated JSON contains searxng in step 5.

- [ ]   5. jq-simulate the generated `mcpConfig` and the four editor merge outputs against the LIVE files.
       Build the generated `kiro-mcp.json` from the flake and run the SAME jq merge program the module
       uses (opaque-object merge; `$f` as base; `delpaths` for `retiredServerNames`) against each of
       the four live files, writing results to a temp dir (NEVER overwrite the live files). For the
       generated config and for each of the four simulated merges, assert: (a) `searxng-enhanced` is
       present AND is a url-style server (`.url == "http://localhost:19104/mcp"`, `.type ==
"streamable-http"`); (b) `searxng-enhanced` carries both `autoApprove` and `alwaysAllow` equal
       to `["search_web","get_website","get_current_datetime"]`; (c) NO `chat-codex` and NO `chat-gpt52`
       appear; (d) `chat-reasoning`, `chat-coding`, `chat-fast`, and `total-pc-control` all still appear;
       (e) no existing server is duplicated — merged server count equals the live count + 1 for the Kiro
       merge (union branch; live had 31, no searxng → 32) and equals the generated-config count for the
       Roo/Cline merges (dropUserOnly=true keeps only flake keys; count must match the generated set and
       include searxng exactly once). Use the flake's `pkgs.jq` and read `retiredServerNames`/`preservedKeys`
       exactly as the module defines them. Do NOT run `thv run` or start any container.
       Files: none (verification only; write temp outputs under `/tmp`).
       Verify: a jq-driven check script that prints PASS for every assertion above across all four
       simulated merges and the generated config; any FAIL means the entry or merge is wrong — fix
       step 1/3 and re-run steps 4-5.

- [ ]   6. (Optional, only if committing) Stage ONLY the three changed files and commit on `main`.
       Do NOT commit the pre-existing unrelated staged/unstaged changes already in the tree. Do NOT push.
       Files: `flake.nix`, `modules/darwin/toolhive.nix`, `modules/home/kiro-local-model-mcp.nix`
       Verify: `cd /Users/celes/sources/m5max-darwin-flake && git diff --cached --name-only` lists exactly
       those three paths. Commit only if the user/loop requires it; otherwise leave changes unstaged.

## Notes / assumptions

- The task-prompt header line said `modules/home/toolhive.nix`, but the APPROVED design and its
  review place the module under `modules/darwin/` (it declares `launchd.user.agents` +
  `system.activationScripts` + `environment.systemPackages`, which are darwin-level options wired via
  the `flake.nix` darwin module list, not home-manager). This plan follows the APPROVED design:
  **`modules/darwin/toolhive.nix`**, wired into `flake.nix`.
- Post-switch runtime verification (launchctl list, `thv list`, `curl http://localhost:19104/mcp`,
  live-editor connect) is explicitly OUT OF SCOPE here per the task (no switch, no containers). The
  design records those as a manual pass the user runs on the real machine.
