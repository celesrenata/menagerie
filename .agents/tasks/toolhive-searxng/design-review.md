# Design Review — Adopt ToolHive + route `searxng-enhanced` into all editors

Reviewed document: `.agents/tasks/toolhive-searxng/design.md`
Scope under review: new `modules/darwin/toolhive.nix`, `flake.nix` wiring, and one
`mcpConfig` entry in `modules/home/kiro-local-model-mcp.nix`.

This is a revised design that already folded in a prior review's 8 findings. I reviewed it
fresh and independently re-verified every load-bearing claim against the real flake files, the
four live editor configs, and the reference flake over SSH. The verification results are below.
The design holds up: the previously-raised HIGH/MEDIUM issues are genuinely resolved by
evidence I reproduced, and no new blocking issue was found.

## Verdict: APPROVED (0 HIGH, 0 MEDIUM)

---

## Findings

1. **NIT — "roughly ten imported launchd user agents" undercounts and the enumerated set omits a
   real agent.** (Overview, Decision 1.) The flake imports more launchd-agent-bearing modules
   than the ten enumerated: `deepseek-v4-server.nix` alone declares 7 `launchd.user.agents`
   blocks, `open-webui-tools.nix` declares 2, and `basert/launch-agent.nix` declares
   `life.celestium.basert`. The enumerated list also omits `omniroute-wireguard.nix` (imported,
   though it declares no agent). The design hedges with "roughly," and the two cited
   shape-precedents (`omniroute.nix`, `mlx-server.nix`) are correct and verified, so this does
   not affect the design's soundness.
   CONCRETE FIX (optional): change "roughly ten imported launchd user agents" to "a dozen-plus
   launchd user agents across the imported `modules/darwin/*.nix`" and drop the exact count, or
   note the enumerated list is the _representative_ precedent set, not exhaustive.

2. **NIT — the agent `Label` naming scheme is `com.celes.<name>` for most agents but not
   universal.** (Decision 1 / Implementation surface item 3 proposes
   `com.celes.toolhive-mcp`.) Verified `com.celes.*` is used by omniroute, mlx-server,
   deepseek, local-model-proxy, discord-priority, clipboard-sync, lan-mouse; but `basert` uses
   `life.celestium.basert`. The chosen `com.celes.toolhive-mcp` matches the dominant scheme and
   is fine. No change required; noting only so the implementer picks the `com.celes.*` form
   deliberately (the design already does).

3. **NIT — reference parity note: `thv client register` omission is a real behavioral divergence
   that must be carried into the start script, not just asserted.** (Decision 5.) Verified the
   reference `toolhive.nix` lines 83-84 do call `thv client register kiro` / `thv client
register vscode`. The design's decision to omit them is correct for this flake (it owns the
   config via `mkMergeActivation`), but the implementer must actually delete those two lines
   when porting the start script — they are present in the source being adapted.
   CONCRETE FIX: the start-script port must contain ONLY: PATH setup, defensive `mkdir -p
ai/logs`, the `docker info` wait loop, `run_if_needed()`, guarded secret reads (none for
   searxng), the single `run_if_needed searxng-enhanced …`, and `exit 0`. No `thv client
register` lines.

(There are no HIGH or MEDIUM findings. Per the mechanical gate, the verdict is APPROVED.)

---

## Verified Assumptions (independently reproduced)

- **launchd mechanism & agent shape (Decision 1).** `modules/darwin/omniroute.nix` and
  `modules/darwin/mlx-server.nix` both declare `launchd.user.agents."com.celes.<name>"` with
  `command = "${writeShellScript …}"` and a `serviceConfig` carrying `Label`, `RunAtLoad`,
  `KeepAlive`, `ThrottleInterval = 10`, `StandardOutPath`/`StandardErrorPath`,
  `EnvironmentVariables { HOME; PATH; … }`, `ExitTimeOut = 30`. Both use the
  `{ pkgs, username, ... }:` signature. omniroute uses `RunAtLoad = true` + `KeepAlive = true`;
  mlx-server uses `RunAtLoad = false` + `KeepAlive = false`. The design's chosen combination
  (`RunAtLoad = true`, `KeepAlive = false`) is a valid mix of these verified precedents. No
  home-manager `launchd.agents` and no systemd anywhere. CONFIRMED.
- **`specialArgs` passes `username` (Decision 1).** `flake.nix` sets
  `specialArgs = { inherit inputs username hostname system; }`. CONFIRMED.
- **`ai/logs` creation (Decision 1).** `modules/home/ai.nix` line 251:
  `$DRY_RUN_CMD mkdir -p "$HOME/ai/logs"`. omniroute's script also defensively
  `mkdir -p`s it. CONFIRMED.
- **`qdrant.nix` is NOT imported (Overview, Decision 1).** The file exists under
  `modules/darwin/` but is absent from the `flake.nix` module list and `grep` finds no
  reference in `home/` or `hosts/`. Its PATH idiom
  (`${pkgs.docker}/bin:/Users/${username}/.docker/bin:/usr/local/bin:/usr/bin:/bin`) and
  `docker create … || true` exist as a sketch only. CONFIRMED.
- **First running Docker-backed launchd agent (Decision 1 / Invariants).** The only live module
  touching Docker from a launchd script is `open-webui-tools.nix`
  (`PATH="${pkgs.docker}/bin:/usr/bin:/bin"`, `docker inspect`/`run`/`start`), and it does NOT
  wait for the daemon. So the toolhive agent is indeed the first Docker-backed launchd agent
  that both runs and self-waits for Docker. The design's choice to treat the Docker-from-launchd
  runtime as unproven until the post-switch pass is correct. CONFIRMED.
- **`postActivation.text` merges across imported modules (Decision 1 item 4 / Implementation
  item 4).** `system.activationScripts.postActivation.text` is defined in the imported
  `clipboard-sync.nix` (line 21), `lan-mouse.nix` (line 15), and
  `hosts/stabulous/configuration.nix` (line 24). It is `types.lines` and concatenates. The
  grounding is these imported modules, not qdrant. CONFIRMED.
- **`mkMergeActivation` treats each server as an opaque object (Decision 2 — the crux).** Read
  the jq line-by-line in `kiro-local-model-mcp.nix`. Branches: `$f == null` → keep `$l`;
  `$l == null` → take `$f`; both → `$f` + per-preserved-key overlay from `$l`. First-deploy
  branch `cp`s the generated JSON verbatim. The jq NEVER inspects `command`/`args`, so a
  `{ url; type; autoApprove; alwaysAllow; }` object flows identically to a command object; `$f`
  is the base in every branch where searxng appears. No merge change required. CONFIRMED.
- **No `url`, no `type`, no `omniroute-observability` in any of the four live configs
  (Decision 2).** Grepped all four files: url_count=0 and type_count=0 everywhere;
  omniroute-observability count=0 everywhere. CONFIRMED. (This substantiates that per-editor URL
  acceptance is genuinely unverified and correctly flagged as a post-switch gate.)
- **Approval-key reality (Decision 2 — the Roo/Cline gap).** Kiro live config:
  `autoApprove` present (6), `alwaysAllow` absent. Zoo: `alwaysAllow` present (30),
  `autoApprove` absent. Roo: neither. Cline: neither. This exactly matches the design's claim
  and justifies setting BOTH keys on the single flake entry so Roo/Cline (which key off
  `alwaysAllow`) actually auto-approve. CONFIRMED.
- **Kiro `preservedKeys` excludes `alwaysAllow`; extra key is harmless (Decision 2).** Kiro's
  `mkMergeActivation` call uses `preservedKeys = [ "disabled" "autoApprove" "disabledTools" ]`.
  Because `$f` is the base in all branches, Kiro receives both keys verbatim and simply ignores
  the extra `alwaysAllow`. CONFIRMED.
- **`retiredServerNames = [ "chat-codex" "chat-gpt52" ]` and the prune applies in both branches
  (Decisions 3, 4; Must-not-break).** Confirmed in `kiro-local-model-mcp.nix`; `delpaths` runs
  in the merge branch and retired names are applied so they cannot resurface. Adding searxng
  does not touch this. CONFIRMED.
- **Native servers present in `mcpConfig` (Decision 4).** `context7`, `sequential-thinking`
  (hyphenated), `memory`, `fetch`, `git` are all present as native command entries. The
  reference uses `sequentialthinking` (no hyphen). A ToolHive duplicate would either collide on
  key (eval error) or coexist under a different key (two servers) — the design's no-duplication
  policy is sound. `searxng-enhanced` has no native counterpart. CONFIRMED.
- **Reference searxng flags & port (Decision 3).** reference `toolhive.nix` lines 120-128:
  `--name searxng-enhanced --proxy-port 19104 --transport stdio --network host
--isolate-network=false -e "SEARXNG_ENGINE_API_BASE_URL=http://10.1.1.12:30888/search"
-e "DESIRED_TIMEZONE=America/Los_Angeles" ghcr.io/celesrenata/mcp-searxng-enhanced:latest`.
  Exact match. CONFIRMED.
- **Transport layering: `--transport stdio` (thv↔container) vs streamable-HTTP proxy at
  `/mcp` (Decisions 2, 3, 5).** reference `mcp.nix` line 27 `thvUrl = name:
"http://localhost:${port}/mcp"`, line 28 `thvSseUrl = ".../sse"`; searxng uses `thvUrl`
  (line 78), i.e. `/mcp` = streamable-HTTP, NOT `/sse`. Reference type defaults:
  Zoo `type = server.transport or "streamable-http"` (line 160), VS Code-native
  `type = server.transport or "http"` (line 177). Pinning `type = "streamable-http"` explicitly
  is correct and safe. CONFIRMED.
- **Reference uses seed-if-missing; adopting it would regress (Decision 2 rejected
  alternative).** reference `mcp.nix` lines 199-201 `if [ ! -f … ]; then cp …`. CONFIRMED,
  substantiating the rejection.
- **`run_if_needed` body (Implementation / Error handling).** reference lines 63-71 match the
  design's described `thv list | grep -q "^$name "` → `thv rm … || true` → `thv run "$@" ||
echo "WARN…"`. CONFIRMED.
- **Resilience precedent (Error handling invariant).** `total-pc-control-patch.nix` lines 33,
  43, 46, 49 do "logs to stderr and exits 0 so a flaky network or missing clone never aborts the
  whole system activation." The design's drop of `set -e` + unconditional `exit 0` mirrors it.
  CONFIRMED.
- **`pkgs.toolhive` availability (Technology stack).** `nix eval` reports version `0.43.0` and
  `meta.platforms` includes `aarch64-darwin`. CONFIRMED.
- **`open-webui-tools.nix` position / darwin service modules in `flake.nix`.** The module list
  imports the `./modules/darwin/*.nix` service modules including `./modules/darwin/open-webui-tools.nix`;
  adding `./modules/darwin/toolhive.nix` adjacent to it is consistent with how service modules
  are wired. CONFIRMED (exact line number is cosmetic; placement intent is right).

## Unverified / Wrong Assumptions

- **Per-editor runtime acceptance of a URL-style MCP entry (Decision 2).** NOT verifiable
  statically and correctly NOT asserted by the design. The four live configs contain zero URL
  entries today, so whether Kiro/Zoo/Roo/Cline will _load and connect_ a
  `{ url; type; autoApprove|alwaysAllow }` server is unproven on this machine. The design
  properly demotes this to a post-switch verification gate ("each of the four editor config
  files … actually load/connect it"). No fix needed — this is the right handling; flagged here
  only so the implementation step treats the manual pass as a true gate, not a formality.
- **Docker-from-launchd runtime behavior (Decision 1 / Invariants).** Unproven on this machine
  (no prior running Docker-backed launchd agent). The daemon wait loop, `thv run`, and proxy
  exposure must be validated end-to-end post-switch. The design states this explicitly and does
  not lean on qdrant. No fix needed.
- **searxng backend reachability (`10.1.1.12:30888/search`) (Decision 3).** The design says it
  was probed and is reachable; I did not re-probe. Not blocking — a down backend surfaces as a
  WARN in the log and a non-responsive URL server, per the Error-handling table, and never fails
  activation.

No assumption in the design was found to be WRONG. The three items above are inherently runtime
checks that the design already routes to the manual post-switch pass.

---

## Notes for the gate

The two previously-HIGH items (false "URL servers already work" precedent; qdrant-as-proof) and
the three previously-MEDIUM items (Roo/Cline wrong approval key; asserted type inference;
stdio-vs-HTTP contradiction) are all resolved and independently re-verified above. The remaining
findings are NITs (count wording, Label scheme, register-line deletion reminder) that do not
affect correctness. Verdict: APPROVED.
