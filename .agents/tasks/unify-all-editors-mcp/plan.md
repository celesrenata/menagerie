# Implementation Plan — Unify all four editors' MCP configs onto the shared flake server set

Goal: Roo and Cline switch from their static, repo-path-keyed snapshots to the SAME flake-defined short-name MCP server set already used by Kiro and Zoo, deployed via the shared `mkMergeActivation` helper. This is a one-time re-key migration (adds `dropUserOnly` to the helper + two new activations) plus removal of two static `home.file` deployments.

Repo to change: `/Users/celes/sources/m5max-darwin-flake` (nix-darwin + home-manager; host attribute `stabulous`).

## Verified facts (grounded in current code / live files)

- `modules/home/kiro-local-model-mcp.nix` defines `mkMergeActivation = { settingsPath, mkdirPath, preservedKeys, preCleanup ? "", retiredNames ? [ ] }`, the full `mcpConfig`/`mcpConfigFile` server set (31 servers incl. `total-pc-control`, `chat-reasoning`/`chat-coding`/`chat-fast`), `retiredServerNames = [ "chat-codex" "chat-gpt52" ]`, and the `kiroMcpConfig` + `zooMcpConfig` activations.
- `modules/home/ai.nix` lines 212–218: the comment plus two static `home.file` deployments for Cline (`saoudrizwan.claude-dev/.../cline_mcp_settings.json` from `secrets/cline_mcp_settings.json`) and Roo (`rooveterinaryinc.roo-cline/.../mcp_settings.json` from `secrets/roo_mcp_settings.json`).
- Live counts: Kiro 31 (no user-only servers), Zoo 32 (one editor-only: `omniroute-observability`; `playwright-mcp.alwaysAllow` set), Roo 27 repo-path keys (e.g. `github.com/21st-dev/magic-mcp`), Cline 27 repo-path keys. Flake server-set size == 31.
- All four live files exist and are plain files (not store symlinks), so the merge branch (not first-deploy) will run for each.

---

- [ ]   1. Add a `dropUserOnly ? false` parameter to `mkMergeActivation` and wire it into the jq merge.
       In `modules/home/kiro-local-model-mcp.nix`, change the helper signature to:
       `mkMergeActivation = { settingsPath, mkdirPath, preservedKeys, preCleanup ? "", retiredNames ? [ ], dropUserOnly ? false }:`
       Extend the helper's doc comment with a `dropUserOnly` entry: when `true`, the merge keeps ONLY servers present in the flake (overlaying preserved flags from matching live servers) and DROPS user-only servers (keys in live but not in flake); `retiredNames` still applies. Default `false` preserves user-only servers (current Kiro/Zoo behavior). Note that the first-deploy branch writes the flake verbatim (which has no user-only servers), so `dropUserOnly` only materially affects the merge branch, but the flag is threaded consistently.
       In the `let` block of the helper, derive the key universe from `dropUserOnly`. Replace the merge jq program's starting set line
       `(($flake | keys) + ($live | keys) | unique)`
       with a Nix-interpolated expression that selects the universe based on the flag. Add to the helper's `let`:
        ```nix
        keyUniverse =
          if dropUserOnly
          then "($flake | keys)"
          else "(($flake | keys) + ($live | keys) | unique)";
        ```
        and in the jq heredoc replace that one line with `${keyUniverse}`. Because when `dropUserOnly` the universe is only flake keys, every `$name` has non-null `$f`, so the `$f == null` (user-only) branch is never taken — user-only servers are dropped. The retired-name `delpaths` and the `$f`/`$l` merge logic are unchanged. Keep the `--argjson retired` and `preservedFlags` wiring exactly as-is.
        Files: `modules/home/kiro-local-model-mcp.nix`
        Verify: `nix-instantiate --parse modules/home/kiro-local-model-mcp.nix` prints the parsed expression with no error (run from repo root `/Users/celes/sources/m5max-darwin-flake`).

- [ ]   2. Confirm Kiro and Zoo activations are unchanged (no `dropUserOnly` passed → defaults to `false`).
       Do NOT edit `kiroMcpConfig` (keeps `preservedKeys = [ "disabled" "autoApprove" "disabledTools" ]`, its `mcp-models.md` `preCleanup`, `dropUserOnly` absent/false) or `zooMcpConfig` (keeps `preservedKeys = [ ... "alwaysAllow" ]`, `dropUserOnly` absent/false). This preserves Zoo's editor-only `omniroute-observability` and `playwright-mcp.alwaysAllow`.
       Files: none (verification-only guard against regressions).
       Verify: covered by step 7's Kiro/Zoo simulation (both must stay functionally unchanged).

- [ ]   3. Add the Roo merge activation using `mkMergeActivation` with `dropUserOnly = true`.
       In `modules/home/kiro-local-model-mcp.nix`, after `zooMcpConfig`, add:
        ```nix
        # Roo Code: adopt the SAME flake server set via the shared merge. Roo's
        # live file currently uses the old repo-path key scheme
        # (github.com/owner/repo) and none of the flake's short names, so a plain
        # merge would PRESERVE those as user-only servers alongside the new
        # short-named ones -> duplicates. dropUserOnly = true keeps only flake
        # servers, performing the one-time re-key cleanly. Preserves Roo UI flags.
        home.activation.rooMcpConfig = mkMergeActivation {
          settingsPath = "$HOME/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json";
          mkdirPath = "$HOME/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings";
          preservedKeys = [ "disabled" "autoApprove" "disabledTools" "alwaysAllow" ];
          retiredNames = retiredServerNames;
          dropUserOnly = true;
        };
        ```
        Files: `modules/home/kiro-local-model-mcp.nix`
        Verify: `nix-instantiate --parse modules/home/kiro-local-model-mcp.nix` → parses with no error.

- [ ]   4. Add the Cline merge activation using `mkMergeActivation` with `dropUserOnly = true`.
       In `modules/home/kiro-local-model-mcp.nix`, after `rooMcpConfig`, add:
        ```nix
        # Cline: same flake server set via the shared merge, same one-time re-key
        # as Roo (live file also uses repo-path keys). dropUserOnly = true drops
        # the old repo-path-keyed servers so no duplicates remain.
        home.activation.clineMcpConfig = mkMergeActivation {
          settingsPath = "$HOME/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json";
          mkdirPath = "$HOME/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings";
          preservedKeys = [ "disabled" "autoApprove" "disabledTools" "alwaysAllow" ];
          retiredNames = retiredServerNames;
          dropUserOnly = true;
        };
        ```
        No `preCleanup` for either Roo or Cline. Both settings paths contain a space ("Application Support"); the helper already double-quotes `settingsPath`/`mkdirPath`, so pass as-is.
        Files: `modules/home/kiro-local-model-mcp.nix`
        Verify: `nix-instantiate --parse modules/home/kiro-local-model-mcp.nix` → parses with no error.

- [ ]   5. Remove the two static `home.file` deployments for Cline and Roo from `ai.nix`.
       In `modules/home/ai.nix`, delete lines 212–218 (the `# --- Cline & Roo MCP settings (generated from live config) ---` comment and both `home.file.".../cline_mcp_settings.json".source = ...` and `home.file.".../mcp_settings.json".source = ...` blocks, including the blank line between them). Leave everything else in `ai.nix` untouched. The `secrets/cline_mcp_settings.json` and `secrets/roo_mcp_settings.json` files may remain on disk (now unreferenced, harmless). Removing these is required so the new activations can own those paths without a `home.file`-vs-activation path conflict.
       Files: `modules/home/ai.nix`
       Verify: `nix-instantiate --parse modules/home/ai.nix` → parses with no error; confirm no remaining references with `grep -n "cline_mcp_settings\|roo_mcp_settings" modules/home/ai.nix` returning nothing.

- [ ]   6. Build the full darwin configuration (catches the path-conflict and evaluates all four activations).
       Files: none.
       Verify: from `/Users/celes/sources/m5max-darwin-flake`, run `nix build --no-link .#darwinConfigurations.stabulous.system` → builds clean with exit 0. A `home.file`-vs-activation conflict on the Roo/Cline paths (if step 5 were incomplete) would fail here.

- [ ]   7. Simulate all FOUR merges with jq against the REAL current live files and record results.
       Do NOT run `darwin-rebuild switch`. Produce the generated flake JSON once, then run the same jq transform the activation uses — for Kiro/Zoo without `dropUserOnly` (full key universe), for Roo/Cline with `dropUserOnly` (flake-keys universe) — against each live file. Write findings to `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/unify-all-editors-mcp/verification.md`.
       Steps to run (from repo root `/Users/celes/sources/m5max-darwin-flake`):
        - Materialize the flake JSON to `/tmp/flake-mcp.json`. The merge jq runs `jq -s` over `${mcpConfigFile} <live>`, so `mcpConfigFile` is just `builtins.toJSON { mcpServers = ...; }`. Produce it directly by evaluating the module's `mcpConfig` string, e.g. build a tiny expression that imports nothing extra:
          `nix eval --raw --impure --expr 'builtins.readFile ((import <nixpkgs> {}).writeText "x" "")'` is NOT it. Use the generated store path instead: the activation already references `${mcpConfigFile}`; obtain it via
          `nix eval --raw .#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.rooMcpConfig.text` and grep the `/nix/store/...-kiro-mcp.json` path it embeds, then `jq . "$that_path" > /tmp/flake-mcp.json`.
          Fallback if that eval path is awkward: Kiro has zero user-only servers and uses `dropUserOnly=false`, so the Kiro merged output's `.mcpServers` key set equals the flake set. Build `/tmp/flake-mcp.json` by running the Kiro merge (below) first and reusing its key set as the authoritative flake size (31). Document the method chosen in verification.md.
        - For each editor, run the activation's jq program (copy it verbatim from the helper) with `--argjson retired '["chat-codex","chat-gpt52"]'` and the appropriate key-universe line — `(($flake | keys) + ($live | keys) | unique)` for Kiro/Zoo, `($flake | keys)` for Roo/Cline — feeding `-s /tmp/flake-mcp.json "<live-file>"`, and capture the merged output to `/tmp/merge-<editor>.json`.
        - Assertions to record in verification.md:
            - Kiro (dropUserOnly=false): merged set == current Kiro (31 servers), `total-pc-control` present, `chat-reasoning`/`chat-coding`/`chat-fast` present, `chat-codex`/`chat-gpt52` absent.
            - Zoo (dropUserOnly=false): `total-pc-control` + three chat servers present; `chat-codex`/`chat-gpt52` absent; editor-only `omniroute-observability` STILL present; `playwright-mcp.alwaysAllow` STILL the 4-entry list. (Count 32: 31 flake + omniroute-observability.)
            - Roo (dropUserOnly=true): merged `mcpServers | length` == flake size (31); NO key matching `github.com/`; `total-pc-control` + three chat servers present; `chat-codex`/`chat-gpt52` absent. Explicitly NOT ~58 (31+27).
            - Cline (dropUserOnly=true): same assertions as Roo (count 31, no `github.com/` keys, no retired names, chat + total-pc-control present).
              Files: `/Users/celes/sources/celesrenata/menagerie/.agents/tasks/unify-all-editors-mcp/verification.md`
              Verify: `verification.md` exists and records all four editors' assertions as PASS; every assertion above holds against the jq-simulated output.

## Notes / assumptions

- Flake server-set size is 31 (confirmed: Kiro live == 31 with zero user-only servers). The task text says "~31"; use 31 as the exact expected count for Kiro/Roo/Cline and 32 for Zoo (31 + `omniroute-observability`).
- If evaluating `mcpConfigFile` to a `/tmp/flake-mcp.json` proves awkward in the sandbox, the implementer may instead use the current Kiro live file as a stand-in for the flake set ONLY for Roo/Cline simulation (valid because Kiro merged == flake set, no user-only servers), but prefer deriving directly from the module to avoid circular reasoning. Document whichever method was used in verification.md.
- Do not touch `chatModelCatalog`, `mcpConfig` server entries, `retiredServerNames`, or Kiro/Zoo activation parameters.
