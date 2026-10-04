# ToolHive adoption + searxng-enhanced routed into all four editors

This change introduces the ToolHive (`thv`) MCP-container architecture to the nix-darwin flake and routes a single server, `searxng-enhanced`, into the existing four-editor MCP config. It adds a new darwin module (`modules/darwin/toolhive.nix`) that declares a `launchd.user.agents` entry running a resilient one-shot reconciler start script, wires that module into the `darwinConfigurations.stabulous` module list in `flake.nix`, and injects one url-style server entry into the shared `mcpConfig` in `modules/home/kiro-local-model-mcp.nix` so it flows to Kiro/Zoo/Roo/Cline through the unchanged `mkMergeActivation`. The implementation follows the APPROVED design and plan exactly, including the deliberate module placement under `modules/darwin/` rather than `modules/home/` (the design justifies this: the module declares `launchd`, `system.activationScripts`, and `environment.systemPackages`, which are darwin-level options).

Watch for: nothing blocking. The module placement differs from the task-prompt header line (`modules/home/toolhive.nix`) but matches the APPROVED design's `modules/darwin/toolhive.nix` and is documented as a deliberate deviation (confirmed). The commit staged exactly the three task files despite a large pre-existing unrelated working tree (confirmed).

**Verdict**: APPROVED

## High-level view

The launchd mechanism matches the imported-agent precedent (`omniroute.nix`): a `launchd.user.agents."com.celes.toolhive-mcp"` with `command` pointing at a `writeShellScript` store path and a `serviceConfig` block carrying `RunAtLoad=true`, `KeepAlive=false`, `ThrottleInterval=10`, log paths under `~/ai/logs`, `EnvironmentVariables`, and `ExitTimeOut=30`. This is a supported mechanism in this flake, not an invented one.

The start script is resilient by construction: no `set -e`/`-u`, a 30×1s Docker wait loop, a `run_if_needed` helper that skips a running instance and otherwise `thv rm`+`thv run`, and an unconditional `exit 0` so activation and the agent never fail. The secret-read `[ -f ]` pattern is preserved as a comment stub (searxng needs no secrets). There is no `thv client register` line, matching Decision 5.

The `thv run` flags are byte-for-byte the ones the plan requires: `--name searxng-enhanced --proxy-port 19104 --transport stdio --network host --isolate-network=false -e SEARXNG_ENGINE_API_BASE_URL=http://10.1.1.12:30888/search -e DESIRED_TIMEZONE=America/Los_Angeles ghcr.io/celesrenata/mcp-searxng-enhanced:latest`.

The mcpConfig change adds a single url-style entry (`url`, `type=streamable-http`, both `autoApprove` and `alwaysAllow`) alongside the existing servers, before the `// chatServers` merge. The merge machinery, the four activation calls, `retiredServerNames`, `chatServers`, and every native server are untouched. The coder's jq simulation against the four live files confirms the entry reaches all four editors exactly once, retains the OmniRoute chat servers and total-pc-control, and never reintroduces chat-codex/chat-gpt52.

The commit `deb734d` contains exactly `flake.nix`, `modules/darwin/toolhive.nix`, and `modules/home/kiro-local-model-mcp.nix` — none of the ~30 pre-existing unrelated working-tree changes leaked in.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. The implementation matches the approved plan and design; verification evidence is present and consistent with the diff.

</details>

<details>
<summary>Details</summary>

### launchd mechanism and agent shape

The module declares `launchd.user.agents."com.celes.toolhive-mcp"` with `command = "${startScript}"` and a `serviceConfig` block whose keys (`Label`, `RunAtLoad=true`, `KeepAlive=false`, `ThrottleInterval=10`, `StandardOutPath`/`StandardErrorPath` under `${home}/ai/logs/toolhive-mcp.log`, `EnvironmentVariables = { HOME; PATH }`, `ExitTimeOut=30`) match the imported `omniroute.nix` precedent named in the plan. `KeepAlive=false` is the correct choice for a one-shot reconciler — the script runs `thv run` and exits, and `thv` itself keeps the proxy/container alive. The agent evaluates with the expected Label (`nix eval` → `"com.celes.toolhive-mcp"` in verification §2a), proving the option landed in the built system.

### Start-script resilience and run_if_needed semantics

The script sets `PATH` to the qdrant-shape entry set plus `thv`/`coreutils`, `mkdir -p`s the log dir defensively, and waits for Docker with `for i in $(seq 1 30); do docker info ... && break; sleep 1; done` followed by a post-loop WARN if Docker is still down. It omits `set -e`/`-u`, wraps every fallible call (`thv rm ... || true`, `thv run ... || echo WARN`), and ends `exit 0` — so it can never fail activation or crash-loop the agent, matching the `total-pc-control-patch.nix` discipline the design cites.

`run_if_needed` implements the exact skip-if-running-else-rm-then-run contract: `thv list | grep -q "^$name "` returns 0 (leave alone) if the instance is up, otherwise `thv rm "$name" 2>/dev/null || true` then `thv run "$@"`. The `[ -f ]` secret-read pattern is preserved as a comment (no secret needed for searxng), and there is no `thv client register` call.

### thv run flags

The single `run_if_needed searxng-enhanced` call passes `--name searxng-enhanced --proxy-port 19104 --transport stdio --network host --isolate-network=false -e SEARXNG_ENGINE_API_BASE_URL=http://10.1.1.12:30888/search -e DESIRED_TIMEZONE=America/Los_Angeles ghcr.io/celesrenata/mcp-searxng-enhanced:latest`. This is an exact match to the flags the task and plan require (confirmed by reading the module).

### postActivation image pull and systemPackages

`system.activationScripts.postActivation.text` guards a best-effort `docker pull` of the searxng image behind a `docker info` check and suffixes `|| true`, so a stopped Docker or offline registry never fails activation. `environment.systemPackages = [ pkgs.toolhive ]` puts `thv` on the interactive PATH for the documented `thv list` verification. Both match the design's Implementation surface items 4 and 5.

### mcpConfig url-entry injection and merge safety

The `searxng-enhanced` entry is added inside `mcpConfig.mcpServers` immediately before the `} // chatServers;` line, as a url-style object (`url = "http://localhost:19104/mcp"`, `type = "streamable-http"`, and both `autoApprove` and `alwaysAllow` set to `["search_web" "get_website" "get_current_datetime"]`). Setting both approval keys is correct and necessary: the merge only overlays a preserved key that already exists on the live server; it never creates one, so Roo/Cline (which carry neither key) would otherwise get no auto-approval. `mkMergeActivation`, the four `home.activation.*McpConfig` calls, `retiredServerNames = [ "chat-codex" "chat-gpt52" ]`, `chatServers`, and every native server (including `total-pc-control` and `local-model`) are untouched.

The coder's jq simulation (verification §3) replicates the module's exact merge program against the four live files, writing output to `/tmp` only. It confirms for the generated config and all four merged outputs: the searxng entry is present and url-style, carries both approval arrays, no chat-codex/chat-gpt52 appear, chat-reasoning/chat-coding/chat-fast/total-pc-control all persist, and server counts are consistent (Kiro/Zoo union = live 31 + 1 = 32; Roo/Cline dropUserOnly = flake count 32), with `searxng-enhanced` appearing exactly once everywhere. Per the task constraints I did not re-run the simulation; the evidence is present and internally consistent with the diff.

### Build and resolution evidence

Verification §2 shows a clean `nix build --no-link .#darwinConfigurations.stabulous.system` with `toolhive-0.43.0` fetched into the closure and the `toolhive-mcp-start`, `com.celes.toolhive-mcp.plist`, and `kiro-mcp.json` derivations built. A clean build proves `pkgs.toolhive` resolves for aarch64-darwin, the agent and start script evaluate, and the mcpConfig attrset has no duplicate-key eval error (which would be the Nix-level guard against a native/ToolHive name collision — not triggered, since searxng has no native counterpart).

### Commit scope

Commit `deb734d` ("feat(toolhive): add ToolHive agent and route searxng-enhanced to all editors") contains exactly three files: `flake.nix`, `modules/darwin/toolhive.nix`, `modules/home/kiro-local-model-mcp.nix`. The flake.nix diff is a single added line (`./modules/darwin/toolhive.nix` after `open-webui-tools.nix`, before `basert`). The working tree still holds ~30 unrelated pre-existing changes (omniroute modules, asitop, local-model-proxy, etc.); none were committed. This satisfies the "stage only the task's files by name" requirement.

### Module placement note

The task-prompt header referenced `modules/home/toolhive.nix`, but the module lives at `modules/darwin/toolhive.nix`. This is the placement the APPROVED design and plan specify, with a documented rationale: the module declares `launchd.user.agents`, `system.activationScripts`, and `environment.systemPackages`, which are darwin-level options wired through the `flake.nix` darwin module list, not home-manager. The implementation correctly follows the approved artifacts over the header line.

</details>

<details>
<summary>File map</summary>

- `modules/darwin/toolhive.nix` (new) — launchd user agent `com.celes.toolhive-mcp` running the resilient one-shot start script, postActivation image pull, `thv` in systemPackages.
- `flake.nix` — one added line wiring `./modules/darwin/toolhive.nix` into the `darwinConfigurations.stabulous` module list.
- `modules/home/kiro-local-model-mcp.nix` — one added `searxng-enhanced` url-style server entry in `mcpConfig.mcpServers`.

Full diff: `git show deb734d` in `/Users/celes/sources/m5max-darwin-flake`.

</details>
