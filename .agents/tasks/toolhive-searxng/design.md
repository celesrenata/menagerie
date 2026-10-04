# Design: Adopt ToolHive on macOS and route `searxng-enhanced` into all editors

## Overview

The user chose to "move to toolhive" as the MCP-server architecture on their nix-darwin
machine (`/Users/celes/sources/m5max-darwin-flake`), with the immediate concrete goal of
getting the `searxng-enhanced` MCP server into every editor. ToolHive (`thv`) runs MCP
servers as isolated Docker containers and exposes each one on a pinned localhost HTTP
proxy; the server inside the container speaks stdio, `thv` wraps that in a **streamable-HTTP**
proxy, and MCP clients connect to a stable URL (`http://localhost:19104/mcp` for searxng).
The Linux reference flake implements this with a `systemd.user.service` that runs a start
script, plus a `mcp.nix` that _seeds_ client configs if missing.

This darwin flake is different in two ways that drive the whole design:

1. **No systemd.** nix-darwin uses launchd. The reference `systemd.user.services.toolhive-mcp`
   must become a nix-darwin `launchd.user.agents` entry. This flake declares roughly ten
   **imported** launchd user agents in `modules/darwin/*.nix` — the verified-imported set is
   `autoraise.nix`, `mlx-server.nix`, `deepseek-v4-server.nix`, `local-model-proxy.nix`,
   `omniroute.nix`, `discord-priority.nix`, `lan-mouse.nix`, `clipboard-sync.nix`,
   `open-webui-tools.nix`, and `basert/launch-agent.nix` (all appear in the
   `darwinConfigurations.stabulous` `modules` list in `flake.nix`). These are the real
   precedents for the agent shape. **`modules/darwin/qdrant.nix` is NOT imported** (it is
   absent from the `flake.nix` module list and referenced nowhere in `home/` or `hosts/`),
   so it does not run and its `postActivation` never fires. It is useful only as a _pattern
   sketch_ for Docker-from-launchd (PATH shape, `docker create ... || true`), not as evidence
   of a working runtime. See Decision 1 for how this constrains grounding.

2. **Config is authoritative, not seed-if-missing.** This flake does **not** adopt the
   reference's "seed only if the file is missing" model. Instead
   `modules/home/kiro-local-model-mcp.nix` builds one `mcpConfig` server set and merges it
   authoritatively into **four** editors (Kiro, Zoo, Roo, Cline) on every rebuild via the
   shared `mkMergeActivation` jq program. We keep that machinery intact and inject the
   searxng URL server into `mcpConfig` so it propagates to all four editors — we do **not**
   port the reference seed-if-missing path.

The change is deliberately scoped to **ToolHive + `searxng-enhanced` only** (see Decision 3).
It introduces one new darwin module (`modules/darwin/toolhive.nix`), wires it into the
`darwinConfigurations.stabulous` module list in `flake.nix`, and adds one server entry to
`mcpConfig` in `modules/home/kiro-local-model-mcp.nix`.

## Technology stack (locked)

- **Container runtime:** Docker (installed and running). Colima stays an unused fallback;
  the design does not touch it. The start script waits for `docker info` to succeed.
- **MCP container manager:** `pkgs.toolhive` (`thv`), nixpkgs `0.43.0`, confirmed available
  for `aarch64-darwin` (`meta.platforms` lists it).
- **Service manager:** nix-darwin `launchd.user.agents` (NOT home-manager `launchd.agents`,
  NOT `launchd.daemons`). Rationale in Decision 1.
- **Server image:** `ghcr.io/celesrenata/mcp-searxng-enhanced:latest` run via `thv run`,
  matching the reference exactly. The reference's Python Nix derivation
  (`buildPythonMcpServer mcp-searxng-enhanced`) is **not** ported — the container image is
  the ToolHive-native path and avoids maintaining a Python build (see Decision 3).
- **Transport:** the client entry is **streamable-HTTP** at `http://localhost:19104/mcp`,
  confirmed against the reference (see Decision 2 and Decision 5). The entry carries an
  explicit `type = "streamable-http"`.
- **Secrets:** read from `/run/secrets/*` (SOPS mounts), guarded with `[ -f ]`. For
  searxng-only there are no secrets to read, but the pattern is preserved for follow-ons.
- **Config injection:** existing `mkMergeActivation` jq merge in
  `modules/home/kiro-local-model-mcp.nix`, unchanged.

---

## Decision 1 — launchd mechanism

**Decision:** Add a nix-darwin `launchd.user.agents."com.celes.toolhive-mcp"` in a new
**darwin** module `modules/darwin/toolhive.nix`, modeled on the live, imported agents
`modules/darwin/omniroute.nix` and `modules/darwin/mlx-server.nix` for the agent/serviceConfig
shape, and on the (unimported) `modules/darwin/qdrant.nix` only for its Docker-from-launchd
PATH idiom.

**Rationale (grounded in the real files):**

- This flake standardizes on `launchd.user.agents."com.celes.<name>"` with a `command` (a
  `pkgs.writeShellScript` store path) and a `serviceConfig` block (`Label`, `RunAtLoad`,
  `KeepAlive`, `ThrottleInterval`, `StandardOutPath`/`StandardErrorPath`, `EnvironmentVariables`,
  `ExitTimeOut`). This exact shape is verified in the imported `omniroute.nix` and
  `mlx-server.nix`. There is **zero** use of home-manager `launchd.agents` anywhere, and no
  systemd. The darwin agent form keeps the new service consistent with everything else.
- Darwin modules receive `username` via `specialArgs` (`flake.nix` passes
  `specialArgs = { inherit inputs username hostname system; }`; `omniroute.nix`, `mlx-server.nix`,
  and `qdrant.nix` are all `{ pkgs, username, ... }`). The new module uses the same signature.
- **No live module waits on Docker or runs `docker info` before acting.** The only live
  module that touches Docker from a launchd script is `open-webui-tools.nix`, which does
  `docker inspect`/`docker run`/`docker start` with `PATH="${pkgs.docker}/bin:/usr/bin:/bin"`
  but does **not** wait for the daemon. `qdrant.nix` demonstrates `docker create ... || true`
  from `postActivation` and a Docker PATH (`${pkgs.docker}/bin:…/.docker/bin:/usr/local/bin:…`),
  **but it is unimported and has never executed on this machine.** Therefore the toolhive
  module is effectively the **first running Docker-backed launchd agent in this flake**, and
  its Docker interaction (daemon wait loop, `thv run`, proxy exposure) **must be validated
  end-to-end in the manual pass** — it cannot lean on "qdrant proves this works." We copy
  qdrant's PATH _shape_ (a known-good set of entries) but treat the runtime behavior as
  unproven until the post-switch verification confirms it.

**launchd `serviceConfig` choices:**

- `RunAtLoad = true` — start at login so searxng is available when editors open (matches the
  imported `omniroute.nix`).
- `KeepAlive = false` — the start script is a **one-shot reconciler** (the systemd reference
  used `Type=oneshot` + `RemainAfterExit`). It runs `thv run` for servers that aren't up and
  exits 0. We do **not** want launchd to respawn it in a tight loop; `thv` itself keeps the
  proxy/container alive. The imported `mlx-server.nix` uses `KeepAlive = false` for exactly
  this non-respawning pattern (it also sets `RunAtLoad = false`; we want `RunAtLoad = true`
  like `omniroute.nix` — both are valid, no conflict). `ThrottleInterval = 10` guards against
  rapid restarts.
- `StandardOutPath`/`StandardErrorPath` = `/Users/${username}/ai/logs/toolhive-mcp.log`.
  `ai/logs` is created by `ai.nix`'s `aiDirectories` activation (verified: `ai.nix` line 251
  `mkdir -p "$HOME/ai/logs"`) and used by every other agent. The start script also
  `mkdir -p`s this directory itself, defensively, exactly as the imported `omniroute.nix`
  does (`mkdir -p "${home}/ai/logs"` inside its script) — so the log path never depends on
  activation ordering.
- No native launchd ordering key ties the agent to Docker — launchd on this flake has no
  `After=docker` equivalent, so **the start script self-waits for Docker** (loop on
  `docker info`, up to 30×1s), the darwin substitute for the systemd
  `After=docker.service`/`Wants=docker.service`.

**One-shot container/image prep:** Add a `system.activationScripts.postActivation.text` block
that, guarded by a `docker info` check, best-effort `docker pull`s
`ghcr.io/celesrenata/mcp-searxng-enhanced:latest` (`|| true`) so the first `thv run` after a
rebuild isn't blocked on an image fetch. This is safe to add because
`system.activationScripts.postActivation.text` is `types.lines` and **already merges across
multiple imported modules** — `clipboard-sync.nix`, `lan-mouse.nix`, and
`hosts/stabulous/configuration.nix` all define `postActivation.text` in the live config and it
evaluates, proving the option concatenates cleanly across modules. (The grounding is this
imported-module merge, **not** the unimported qdrant.) The pull must never fail activation
(`|| true`).

---

## Decision 2 — Config-model reconciliation (the crux)

**Decision:** Add the searxng server as a **URL-style entry inside the existing `mcpConfig`
attrset** in `modules/home/kiro-local-model-mcp.nix`, so it flows through the unchanged
`mkMergeActivation` into all four editors. Do **not** adopt the reference seed-if-missing
path, and do **not** write a separate per-editor seeding activation.

Concretely, add to the `mcpConfig.mcpServers` attrset (alongside `local-model`, `nixos`,
etc., before the `// chatServers` merge):

```nix
searxng-enhanced = {
  url = "http://localhost:19104/mcp";
  type = "streamable-http";
  autoApprove = [ "search_web" "get_website" "get_current_datetime" ];  # Kiro, Zoo
  alwaysAllow = [ "search_web" "get_website" "get_current_datetime" ];  # Roo, Cline, Zoo
};
```

**Why this works with the existing merge (verified line-by-line against the jq program):**

- `mkMergeActivation`'s jq treats each server as an **opaque whole object**. The branches are:
  (1) first deploy (file missing or still a store symlink) → `cp` the generated JSON verbatim;
  (2) merge, "in both" (`$f != null && $l != null`) → `$f` (flake object) as the base plus a
  `+ (if $l.<k> != null then {<k>:$l.<k>} else {} end)` overlay for each preserved key;
  (3) merge, "new flake server" (`$l == null`) → `$f` verbatim; (4) "user-only" (`$f == null`)
  → `$l` verbatim. **In every branch where searxng appears, the flake object `$f` is the base.**
  The jq never inspects `command`/`args`, so a `{ url; type; autoApprove; alwaysAllow; }`
  object flows through identically to a command object. No change to the merge is required.
- **Transport/type:** this is confirmed, not inferred. The reference `mcp.nix` defines
  `thvUrl = name: "http://localhost:${port}/mcp"` and `thvSseUrl = name: ".../sse"`, and the
  searxng entry uses `thvUrl` (`/mcp`), i.e. **streamable-HTTP, not SSE** (only two other
  servers use `/sse`+`transport="sse"`; searxng is not one). The reference ZooCode mapping is
  `type = server.transport or "streamable-http"` and the VS Code-native mapping is
  `type = server.transport or "http"` — so even the reference's own default for a transportless
  URL server is streamable-HTTP. We therefore pin `type = "streamable-http"` explicitly in the
  single flake entry rather than relying on any client's default inference. `type` is just
  another opaque key the merge carries, so it costs nothing and removes risk.

**Per-editor shape (the real nuance, now evidence-based):**

- **There is currently NO `url` entry, NO `type` key, and NO `omniroute-observability` server
  in ANY of the four live configs.** Verified by grep across `~/.kiro/settings/mcp.json`, Zoo
  `mcp_settings.json`, Roo `mcp_settings.json`, and Cline `cline_mcp_settings.json`: the only
  "omniroute" matches are `AI_CHAT_KEY = "omniroute-local"` env values inside command-style
  `chat-*` servers. So **per-editor acceptance of a URL entry is unverified** and must be
  confirmed during the manual implementation pass, not assumed. (The module's own comment
  mentioning "Zoo's omniroute-observability/playwright-mcp" refers to user-only _command_
  servers the merge preserves; it is not a URL-entry precedent.)
- Because acceptance is unverified, the plan is to emit the **explicit, fully-typed** object
  above to all four editors and verify in the post-switch pass. The reference proves the Kiro
  raw-`url` and Zoo `url`+`type` shapes work on Linux; the darwin clients are the same
  extensions, so this is the expected-good shape, but it stays a verification gate rather than
  an assumption.
- **Approval keys — both are set deliberately (resolves the Roo/Cline gap).** Verified: Kiro's
  live config carries `autoApprove`; Zoo carries `alwaysAllow`; **Roo and Cline carry neither
  `autoApprove` nor `alwaysAllow` at all** (they were re-keyed clean by `dropUserOnly = true`).
  The merge only _overlays_ a preserved key from the live file (`$l`) — it never _creates_ one.
  So an `autoApprove`-only entry would leave Roo/Cline (which key approvals off `alwaysAllow`)
  with **no auto-approval**, silently failing the user's goal of search tools being pre-approved
  there. We therefore set **both** keys on the single flake entry (option (b) from the review).
  This is safe: `$f` is the base in all branches, so on first deploy both keys are written
  verbatim to every editor, and on subsequent merges `$f` is still the base, so both persist.
  Kiro's `preservedKeys` does not include `alwaysAllow` — harmless: on first deploy Kiro gets
  the flake object verbatim (preservedKeys only governs the live→merged overlay on later
  rebuilds), so Kiro simply carries an extra `alwaysAllow` key it ignores. Zoo/Roo/Cline list
  `alwaysAllow` in `preservedKeys`, so if the user later edits approvals in those UIs their
  live value overlays back on the next rebuild — the intended user-owns-runtime-flags behavior.
- `autoApprove`/`alwaysAllow` being preserved keys means later user UI toggles survive
  subsequent rebuilds (flake wins on `url`/`type`, user wins on approvals). This is the
  intended ownership split documented in the module.

**Rejected alternative — reference seed-if-missing:** porting the reference's
`home.activation.seed*Mcp` (write only `if [ ! -f ]`) would fork config management: new
servers would never reach editors whose config file already exists, which is the exact bug
the current `mkMergeActivation` was built to fix (its comment calls out the old
all-or-nothing copy that "never delivered newly-added servers once the file had been edited
by hand"). Adopting it would regress the whole fleet. Rejected.

---

## Decision 3 — Which servers to port now

**Decision:** Port **`searxng-enhanced` only** in this change.

- Backend `10.1.1.12:30888/search` is **reachable** (probed), and searxng is the user's
  explicit ask.
- Run it via `thv run ghcr.io/celesrenata/mcp-searxng-enhanced:latest` on proxy port
  **19104**, with the **exact reference flags** (confirmed against the reference
  `toolhive.nix` lines 120-128):
  `--name searxng-enhanced --proxy-port 19104 --transport stdio --network host`
  `--isolate-network=false -e SEARXNG_ENGINE_API_BASE_URL=http://10.1.1.12:30888/search`
  `-e DESIRED_TIMEZONE=America/Los_Angeles`.
- **Two transport layers (resolves the apparent `--transport stdio` vs HTTP-URL contradiction):**
  `--transport stdio` describes how **`thv` talks to the container process** — the
  mcp-searxng-enhanced server speaks stdio inside the container. `thv` then **exposes that
  server as a streamable-HTTP proxy** at `http://localhost:19104/mcp` (the `--proxy-port`).
  The editor connects to _that proxy_ over streamable-HTTP, which is why the client entry is
  `{ url = "http://localhost:19104/mcp"; type = "streamable-http"; }`. The two are not in
  conflict; they are the container-facing and client-facing sides of the same proxy. Confirmed
  the reference searxng uses `/mcp` (via `thvUrl`), not `/sse`.
- Client entry: the fully-typed object from Decision 2, added to `mcpConfig`.

**Explicitly NOT ported now:**

- `postgres` — backend `10.1.1.12:30217` **unreachable** (probed).
- `redis` — upstream server broken (per task context).
- `ii-desktop` — Linux-only (Hyprland socket / D-Bus); meaningless on macOS.
- `chat-codex` — this flake already **retired** that slot (`retiredServerNames =
["chat-codex" "chat-gpt52"]`) in favor of the OmniRoute-routed `chat-reasoning/
chat-coding/chat-fast`. Re-adding it would fight the prune. Do not port.

**Prefer container over Python Nix derivation:** the reference `overlays/mcp-servers.nix`
builds a Python `mcp-searxng-enhanced`. We do **not** port that. ToolHive's model is to run
the container image, and the reference `thv run` already uses the ghcr image. Running the
image matches the reference command verbatim and avoids maintaining a Python build/FOD hash
on darwin. Decision: use the container image only.

**Documented follow-on servers (future, not in this change):** `github`, `memory`, `fetch`,
`playwright`, `k8s`, `context7`, `grafana`, `hass`. Reachability notes for when they're
added: `omniroute.celestium.life:443` and `grafana.celestium.life:443` reachable;
`~/.kube/config` present (k8s viable). **But `context7`, `sequential-thinking`, `memory`,
`fetch`, `git` are already provided natively by this flake** (see Decision 4) — if those are
ever moved to ToolHive they must _replace_, not duplicate, the native entries.

> **USER-FACING SCOPE NOTE (flag this):** This change ports the ToolHive _architecture_ plus
> `searxng-enhanced` only. All of your other MCP servers (filesystem, git, context7,
> sequential-thinking, the OmniRoute chat tiers, total-pc-control, and every hand-cloned
> node server) are **untouched** and keep running exactly as today. ToolHive becomes the
> management path for container-isolated servers going forward; the eight follow-on servers
> above can be added later one at a time. If you want more than searxng in this first cut,
> say so and the scope expands.

---

## Decision 4 — Interaction with existing native servers

**Decision:** ToolHive must **not** manage any server this flake already provides natively.
For the first cut (searxng only) there is no overlap, so this is a documented **policy**:

- This flake already ships `context7` (`pkgs.context7-mcp`), `sequential-thinking`
  (`pkgs.mcp-server-sequential-thinking`), `memory` (`pkgs.mcp-server-memory`), `fetch`
  (`pkgs.mcp-server-fetch`), and `git` (`pkgs.mcp-server-git`) as native nixpkgs binaries in
  `mcpConfig` (verified present in `kiro-local-model-mcp.nix`).
- The reference ToolHive stack also offers `context7`/`sequentialthinking`/`memory`/`fetch`.
  **Policy: do not add ToolHive versions of any server already present natively.** A
  ToolHive URL entry and a native command entry under the same name would produce
  duplicate/competing tools in every editor. If a native server is ever migrated to ToolHive,
  the native entry in `mcpConfig` must be **removed in the same change** (and if the key name
  changes, the old name appended to `retiredServerNames` so the merge self-cleans it from live
  configs).
- Also note the reference uses the key `sequentialthinking` (no hyphen) while this flake uses
  `sequential-thinking` (hyphen). This is an extra reason to never port it via ToolHive —
  the two keys would coexist as distinct servers. Keep the native one.
- A duplicate key is itself a cheap guard: attrset keys are unique, so adding a ToolHive
  `context7` while native `context7` exists is a Nix evaluation error, not a silent conflict.

`searxng-enhanced` has no native counterpart here, so it is safe to add.

---

## Decision 5 — `thv client register`

**Decision:** **Do not** run `thv client register kiro` / `thv client register vscode`.

**Rationale:** The reference registers clients because _its_ `mcp.nix` seeds config files and
relies on `thv` to help wire some clients. This flake writes the editor MCP JSON **itself**,
authoritatively, via `mkMergeActivation` into the four exact file paths
(`~/.kiro/settings/mcp.json`, Zoo/Roo/Cline `mcp_settings.json`). The client already learns
about searxng from the `url` entry we inject; `thv client register` would at best be a no-op
and at worst write a _competing_ config (e.g. its own `vscode` registration) that fights our
merge. We own the config, so we skip registration.

The start script therefore omits the `thv client register` lines entirely (a documented
divergence from the reference). It keeps only: wait-for-docker, `run_if_needed`, and the
single searxng `thv run`.

---

## Implementation surface (concrete)

### New file: `modules/darwin/toolhive.nix`

Signature `{ pkgs, username, ... }:` (matches `omniroute.nix`/`qdrant.nix`). Contents:

1. `let` bindings: `thv = "${pkgs.toolhive}/bin/thv";` `home = "/Users/${username}";`
   searxng proxy port `19104`, image `ghcr.io/celesrenata/mcp-searxng-enhanced:latest`.
2. `startScript = pkgs.writeShellScript "toolhive-mcp-start" ''...''` that:
    - sets `PATH` to include `${pkgs.toolhive}/bin:${pkgs.docker}/bin:${pkgs.coreutils}/bin`
      plus `${home}/.docker/bin:/usr/local/bin:/usr/bin:/bin` (qdrant PATH shape, which is a
      known-good entry set even though qdrant itself never ran).
    - `mkdir -p "${home}/ai/logs"` defensively (as `omniroute.nix` does), so the log path
      never depends on activation ordering.
    - **Does NOT use `set -e`/`-u` for the whole body** — the script must be _resilient and
      never fail activation or crash-loop the agent_. Use targeted error handling: each
      fallible step is `|| echo "WARN: ..." >&2` and the script `exit 0`s. (The reference used
      `set -euo pipefail`; here resilience is a stated requirement, so we drop `-e` and
      explicitly tolerate failures. See Error Handling.)
    - waits for Docker: `for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done`.
    - defines `run_if_needed()` as the reference: `thv list | grep -q "^$name "` → return 0 if
      up; else `thv rm "$name" 2>/dev/null || true`; then `thv run "$@" ||
echo "WARN: failed to start $name" >&2`.
    - secret reads guarded with `[ -f ]` (none needed for searxng, but keep the pattern so
      follow-ons drop in cleanly).
    - **no** `thv client register` (Decision 5).
    - one `run_if_needed searxng-enhanced` with the exact reference flags listed in Decision 3.
    - final `exit 0`.
3. `launchd.user.agents."com.celes.toolhive-mcp"` with `command = "${startScript}";` and the
   `serviceConfig` from Decision 1 (`RunAtLoad=true`, `KeepAlive=false`, `ThrottleInterval=10`,
   log paths under `${home}/ai/logs/toolhive-mcp.log`, `EnvironmentVariables = { HOME; PATH; }`,
   `ExitTimeOut=30`).
4. `system.activationScripts.postActivation.text` best-effort `docker pull` of the searxng
   image, guarded by a `docker info` check and suffixed `|| true` so a stopped Docker or
   offline registry never errors (grounded in `postActivation.text` being `types.lines` and
   already merging across the imported `clipboard-sync.nix`, `lan-mouse.nix`, and
   `hosts/stabulous/configuration.nix`).
5. `environment.systemPackages = [ pkgs.toolhive ];` — definite, not optional. The documented
   `thv list` verification step needs `thv` on the interactive PATH; adding it to
   systemPackages makes that work without a store-path dance. (The agent would pull `thv` into
   the closure via `${thv}` regardless; this just also puts it on the user's `PATH`.)

### Edit: `flake.nix`

Add `./modules/darwin/toolhive.nix` to the `modules = [ ... ]` list of
`darwinConfigurations.stabulous`, next to the other `./modules/darwin/*.nix` service modules
(e.g. right after `./modules/darwin/open-webui-tools.nix`, line 118). This is where darwin
service modules are wired — **not** `home/celes.nix` (that imports home modules only; the
client-config edit below is the only home-side change).

### Edit: `modules/home/kiro-local-model-mcp.nix`

Add the single fully-typed `searxng-enhanced` entry (Decision 2, with `url`, `type`,
`autoApprove`, and `alwaysAllow`) into the `mcpConfig.mcpServers` attrset. No change to
`mkMergeActivation`, the four `home.activation.*McpConfig` calls, `retiredServerNames`,
`chatServers`, or any native server.

### Must-not-break checklist (verified against the module)

- 4-editor unification: untouched — we only add one key to the shared `mcpConfig`.
- `total-pc-control` native/patched server: untouched (`total-pc-control-patch.nix` and its
  `mcpConfig` entry unchanged).
- OmniRoute chat servers (`chat-reasoning/chat-coding/chat-fast` via `chatServers`): untouched.
- `retiredServerNames` prune (`chat-codex`, `chat-gpt52`): untouched; we do not re-add
  `chat-codex`.
- `dropUserOnly` behavior for Roo/Cline and preserved user-only servers for Kiro/Zoo:
  untouched.

---

## Error handling (concrete, per failure)

| Operation                        | Failure condition                          | Recoverable?                 | Caller sees                                                                     | Logged                                    |
| -------------------------------- | ------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- | ------------------- |
| `docker info` wait loop          | Docker not up within 30s                   | Recoverable                  | script proceeds; `thv run` will likely fail and WARN                            | implicit (next step WARNs)                |
| `thv list` (in `run_if_needed`)  | `thv` missing / errors                     | Recoverable                  | treated as "not running" → attempts `thv rm`+`thv run`                          | no (stderr suppressed, matches reference) |
| `thv rm "$name"`                 | no such instance                           | Recoverable                  | ignored (`2>/dev/null                                                           |                                           | true`)                              | no                  |
| `thv run searxng-enhanced ...`   | image pull fail / port busy / backend down | Recoverable                  | `echo "WARN: failed to start searxng-enhanced" >&2`; script continues, `exit 0` | **yes**, WARN to `toolhive-mcp.log`       |
| secret read `[ -f path ] && cat` | file absent                                | Recoverable                  | var stays empty; (no secret needed for searxng)                                 | no                                        |
| `docker pull` (postActivation)   | offline / registry down                    | Recoverable                  | `                                                                               |                                           | true`; **activation does not fail** | docker's own stderr |
| launchd agent itself             | start script non-zero                      | N/A — script always `exit 0` | agent marks success                                                             | —                                         |

**Design invariant:** the ToolHive agent and its activation hook are _never_ allowed to fail
`darwin-rebuild switch` or crash-loop launchd. Every external call is wrapped; the script
exits 0 unconditionally. This mirrors the resilience discipline already used by
`total-pc-control-patch.nix` ("Any failure logs to stderr and exits 0 so a flaky network or
missing clone never aborts the whole system activation").

## Input validation

The only external inputs are the hard-coded env values passed to the container
(`SEARXNG_ENGINE_API_BASE_URL`, `DESIRED_TIMEZONE`) and the proxy port — all compile-time
constants from the flake, not user input, so no runtime validation is required. The SearXNG
backend URL is trusted (user's own cluster). Secret paths are optional (`[ -f ]` guard):
required=no, type=file, behavior-on-missing=skip with empty value.

## Invariants and ownership

- **"No duplicate server names across native + ToolHive"** — owned by the author editing
  `kiro-local-model-mcp.nix` (Decision 4 policy); enforced partly by review and partly by Nix
  itself (duplicate attrset keys are an eval error).
- **"Flake owns wiring, user owns runtime flags"** — owned by `mkMergeActivation` (unchanged):
  flake wins on `url`/`type`; preserved keys (`autoApprove`/`alwaysAllow`/`disabled`/
  `disabledTools`) let the user's later UI toggles survive.
- **"searxng reachable before it's useful"** — owned at runtime by `thv`/the container, not
  the flake; failures surface as WARN in the log and a non-responsive URL server in editors.
- **"Docker-from-launchd actually works"** — currently **unproven** on this machine (no live
  Docker-backed launchd agent exists). Owned by the manual post-switch verification pass, not
  by any cited precedent.

## Testability

- **Unit / eval:** `nix eval .#darwinConfigurations.stabulous.config.launchd.user.agents."com.celes.toolhive-mcp"`
  confirms the agent exists with the expected `serviceConfig`. `darwin-rebuild build` confirms
  `searxng-enhanced` lands in `mcpConfig.mcpServers` with the right `url`/`type`/`autoApprove`/
  `alwaysAllow`, that no native server was dropped, that the attrset has no duplicate keys, and
  that the closure includes `pkgs.toolhive`.
- **Integration (post-switch, manual/E2E — carries the unverified claims):** after
  `darwin-rebuild switch`, `launchctl list | grep com.celes.toolhive-mcp` shows the agent;
  `thv list` shows `searxng-enhanced` running; `curl -s http://localhost:19104/mcp` responds;
  and **each of the four editor config files is confirmed to contain the `searxng-enhanced` URL
  entry AND to actually load/connect it** (this is the gate for the unverified "clients accept
  a URL entry" assumption). Also confirm auto-approval applies in all four (Kiro/Zoo via
  `autoApprove`, Roo/Cline via `alwaysAllow`). These require the real machine + Docker and
  belong to the manual verification pass, not CI — and they are where the Docker-from-launchd
  runtime behavior is proven for the first time in this flake.
- **Merge behavior for URL servers** is covered by the existing merge's design (it overlays
  whole objects, verified against the jq program). For this change (no merge code change) the
  eval/build checks above are sufficient; if the merge is ever modified, add a `jq` regression
  run against the committed program with a fixture live config asserting a `{ url; type;
autoApprove; alwaysAllow; }` object survives.

## Out of scope

- Porting any server other than `searxng-enhanced` (follow-on list documented above).
- The reference Python `mcp-searxng-enhanced` Nix derivation (container image used instead).
- `thv client register` (Decision 5).
- Reshaping URL entries per editor (`/sse`, per-client `type`). The single entry already
  carries `type = "streamable-http"`, matching the reference searxng transport.
- Colima, postgres, redis, ii-desktop, chat-codex.
- Any change to `mkMergeActivation`, `retiredServerNames`, or the native server set.

---

## Responses to design-review findings

**1 (HIGH) — "URL servers already work" proof is false.** Addressed. Removed the
`omniroute-observability` precedent entirely. Verified by grep that **no `url`, no `type`, and
no `omniroute-observability` exists in any of the four live configs** (the only "omniroute"
matches are `AI_CHAT_KEY = "omniroute-local"` env values). The design now states per-editor URL
acceptance is **unverified** and adds a post-switch verification gate, and the injected entry
includes `type = "streamable-http"` explicitly instead of relying on inference.

**2 (HIGH) — qdrant.nix not imported; no running Docker-backed launchd precedent.** Addressed.
Verified: qdrant.nix is absent from the `flake.nix` module list and referenced nowhere in
`home/`/`hosts/`. The Overview and Decision 1 now call it unimported, cite the actually-imported
agents (`omniroute.nix`, `mlx-server.nix`, et al.) for the agent shape, and state the toolhive
module is the **first running Docker-backed launchd agent** whose Docker interaction must be
validated end-to-end. The `postActivation.text` merge is now grounded in the imported
`clipboard-sync.nix`/`lan-mouse.nix`/`configuration.nix` (`types.lines`), not qdrant.

**3 (MEDIUM) — Roo/Cline won't auto-approve; wrong key.** Addressed with option (b). Verified
Roo and Cline live configs carry neither `autoApprove` nor `alwaysAllow`. The injected entry
now sets **both** `autoApprove` (Kiro/Zoo) and `alwaysAllow` (Roo/Cline/Zoo); since `$f` is the
merge base in all branches, both are written and persist. Documented that Kiro ignoring the
extra `alwaysAllow` is harmless.

**4 (MEDIUM) — "streamable-HTTP default inference" asserted.** Addressed by folding into
finding 1: the "no type required" assertion is removed and `type = "streamable-http"` is set
explicitly. Also confirmed against the reference that its own defaults are
`type = server.transport or "streamable-http"` (Zoo) / `"http"` (VS Code native).

**5 (MEDIUM) — `--transport stdio` vs HTTP-URL contradiction.** Addressed. Decision 3 now
distinguishes the two transport layers (`--transport stdio` = thv↔container; the proxy exposes
**streamable-HTTP** at `/mcp` for the editor). Confirmed against the reference `mcp.nix` that
searxng uses `thvUrl` → `/mcp` (streamable-HTTP), not `thvSseUrl` → `/sse`.

**6 (NIT) — "eleven agents" wrong.** Addressed. Changed to "roughly ten imported launchd user
agents" and enumerated the verified-imported set.

**7 (NIT) — `thv` in systemPackages left optional.** Addressed. Now a definite
`environment.systemPackages = [ pkgs.toolhive ];` in the module (Implementation surface item 5).

**8 (NIT) — postActivation merge safety via dead qdrant analogy.** Addressed. The safety basis
is now the imported `clipboard-sync.nix`/`lan-mouse.nix`/`hosts/stabulous/configuration.nix`
all defining `postActivation.text` (`types.lines`), not qdrant.
