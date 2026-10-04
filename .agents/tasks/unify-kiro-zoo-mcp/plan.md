# Implementation Plan: Unify Kiro + Zoo Code MCP server set

## Goal

Make Kiro and Zoo Code both derive their MCP server set from the single flake-defined
`mcpConfigFile` in `modules/home/kiro-local-model-mcp.nix`, each applied with the same
merge-based activation. Zoo must pick up `total-pc-control` and the OmniRoute chat servers
(`chat-reasoning`/`chat-coding`/`chat-fast`) while preserving its editor-only servers
(`playwright-mcp` — note: already in the flake too — `omniroute-observability`) and all per-server
UI flags (`disabled`/`autoApprove`/`disabledTools`/`alwaysAllow`).

ADDITIONAL REQUIREMENT (folded in): the shared merge must also PRUNE retired/renamed server names
from BOTH editors so they self-clean on rebuild. The retired list for now is
`["chat-codex", "chat-gpt52"]` — stale orphans left when the chat servers were renamed to
`chat-reasoning`/`chat-coding`/`chat-fast`; they point at raw OpenAI (gpt-5.5/gpt-5.2). The prune must
delete these keys even though they exist in the live files as user-only servers. Implement it as a
`retiredNames` parameter of the shared helper (passed to jq as an `--argjson` array) so future renames
just append to the list. NOTE: `chat-codex` is the retired server, NOT the new `chat-coding` server —
deleting `chat-codex` is correct.

Kiro's behavior must stay behavior-identical EXCEPT for this one intentional new prune (which also
removes `chat-codex`/`chat-gpt52` from Kiro's `mcp.json`). The refactor itself must not otherwise change
Kiro's emitted script; the only intended textual delta is the added `retiredNames` wiring and the prune
step, applied identically to both editors.

## Context discovered during exploration (ground truth)

- Target file: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`.
  Signature is `{ pkgs, lib, ... }:`. Imported from `home/celes.nix` (line 9); that is part of
  `darwinConfigurations.stabulous` in `flake.nix` (host attribute `stabulous`,
  system `aarch64-darwin`).
- The file already defines `chatModelCatalog`, `mkChatServer`, `chatServers`,
  `mcpConfig = builtins.toJSON { mcpServers = { ... } // chatServers; }`, and
  `mcpConfigFile = pkgs.writeText "kiro-mcp.json" mcpConfig`. It defines ONE activation,
  `home.activation.kiroMcpConfig`, ordered `lib.hm.dag.entryAfter [ "writeBoundary" ]`.
- Kiro activation behavior (must be preserved exactly):
    1. `mkdir -p "$HOME/.kiro/settings"`
    2. `rm -f "$HOME/.kiro/mcp-models.md"` (Kiro-specific cleanup)
    3. First deploy (file missing OR a symlink): `rm -f` then `cp ${mcpConfigFile}` then `chmod 644`.
    4. Else: jq `-s` merge of `${mcpConfigFile}` (index 0, "$flake") over the live file
     (index 1, "$live"); union of keys; user-only servers kept as-is; new flake servers
       taken verbatim; servers in both get flake wiring plus preserved live flags
       `disabled`, `autoApprove`, `disabledTools`; write to a `mktemp` tmp then `mv` then `chmod 644`.
       (The NEW behavior adds a final prune of `retiredNames` after this merge — see below.)
    5. Every mutating line is wrapped with `$DRY_RUN_CMD`.
- Live Kiro file (`$HOME/.kiro/settings/mcp.json`) also currently contains `chat-codex`/`chat-gpt52`
  as user-only servers (confirm during impl); the new prune will remove them on next rebuild.
- Zoo path (verified present, hand-edited, 9968 bytes, regular file not symlink):
  `/Users/celes/Library/Application Support/Code/User/globalStorage/zoocodeorganization.zoo-code/settings/mcp_settings.json`.
  Shape `{"mcpServers": {...}}` with SHORT names. Zoo-only servers that MUST survive the merge:
  `playwright-mcp` (also in flake, so it will take flake wiring + preserved flags),
  `omniroute-observability` (flags: `alwaysAllow`). Also present in the live file:
  `chat-codex` and `chat-gpt52` (stale, flags: `disabled`,`autoApprove`) — these are the RETIRED
  names and MUST be PRUNED by the merge, not kept, even though they are user-only (not in the flake).
  Many servers carry `disabled`; several carry `autoApprove`/`disabledTools`;
  `playwright-mcp` and `omniroute-observability` carry `alwaysAllow`. Zoo does NOT currently get
  `total-pc-control` or the three `chat-*` OmniRoute servers — the whole point of this change.
- Roo/Cline (`modules/home/ai.nix`) use full `github.com/owner/repo` keys and are OUT OF SCOPE.
- Tooling present: `nix`, `nix-instantiate`, `jq` all on PATH. `nix-instantiate --parse` on the
  target file succeeds today.
- IMPORTANT (verified): the module uses `lib.hm.dag.entryAfter`, so you CANNOT import it standalone
  with a plain `<nixpkgs>` `lib` stub — `lib.hm` is only populated inside home-manager. The reliable
  way to read a generated activation script is through the full flake:
  `nix eval --raw '.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.<name>.data'`.
  This path is confirmed working for `kiroMcpConfig` today (it prints the full bash script incl. the
  `jq -s` program, the store path of `kiro-mcp.json`, and the `rm -f .../mcp-models.md` line).
- The Zoo path contains a space ("Application Support") — must be double-quoted everywhere in bash.

## Design decision: factor a shared `mkMergeActivation` helper

Factor the merge into ONE reusable Nix `let`-bound function `mkMergeActivation` used for both
editors, rather than copy-pasting the ~25-line jq program. Rationale: duplicating the jq program
across two activations is the main correctness risk (drift between Kiro and Zoo merge logic); a
single parameterized helper eliminates that and makes both the `alwaysAllow` difference and the shared
retired-prune one-line parameters. The helper is parameterized so Kiro's emitted script differs from
today's ONLY by the intentional retired-prune wiring (see the Kiro behavior guarantee below).

Helper signature (conceptual):
`mkMergeActivation { settingsPath, mkdirPath, preservedKeys, retiredNames, preCleanup ? "" }`
returns the activation script string. Where:

- `settingsPath` — absolute path string to the editor's mcp settings JSON (unquoted; the helper
  quotes it in bash).
- `mkdirPath` — directory to `mkdir -p` before touching the file.
- `preservedKeys` — Nix list of flag names to carry over from live→merged for servers present in both
  (Kiro: `[ "disabled" "autoApprove" "disabledTools" ]`; Zoo: same plus `"alwaysAllow"`).
- `retiredNames` — Nix list of server names to delete from the final merged set regardless of source.
  SAME value for both editors: `[ "chat-codex" "chat-gpt52" ]`. Define it ONCE as a `let`-bound
  constant (e.g. `retiredServerNames`) and pass it to both calls so future renames edit one list.
  Passed into jq via `--argjson retired '<json-array>'` (render the Nix list with
  `builtins.toJSON retiredNames`).
- `preCleanup` — extra bash lines emitted after `mkdir -p`, before the first-deploy check
  (Kiro: the `rm -f "$HOME/.kiro/mcp-models.md"` line; Zoo: `""`).

The jq preserved-flags block is generated from `preservedKeys` by mapping each key `k` to
`+ (if $l.<k> != null then { <k>: $l.<k> } else {} end)` and concatenating. For Kiro this must
produce exactly the three existing lines in the same order (`disabled`, `autoApprove`,
`disabledTools`). The `mcpConfigFile` reference, `mktemp` pattern, union-of-keys logic,
`$DRY_RUN_CMD` wrapping, and `chmod 644` are identical to the current Kiro activation and shared
verbatim by the helper.

Prune step (NEW, applied to BOTH editors): after the merged `mcpServers` object is computed exactly
as today, remove every key present in `$retired`. Order of operations in jq: build the merged set
(flake wins on wiring, preserve user flags incl. `alwaysAllow` for Zoo, keep genuinely user-only
servers), THEN `del(.mcpServers[$retired[]])` (or equivalent `| .mcpServers |= with_entries(select(.key as $k | ($retired | index($k)) | not))`).
Also pass `--argjson retired` into the FIRST-DEPLOY branch is unnecessary (the generated flake file
never contains retired names), so the prune only needs to run in the merge branch; keep first-deploy
as a verbatim `cp` of `${mcpConfigFile}`.

Behavior guarantee for Kiro (revised from byte-for-byte): the ONLY intended change to Kiro's emitted
script is (a) the `--argjson retired '["chat-codex","chat-gpt52"]'` argument and (b) the trailing
prune expression in the jq program. Everything else — mkdir, mcp-models.md rm, first-deploy copy,
preserved-flag block, mktemp/mv/chmod, `$DRY_RUN_CMD` wrapping — must be textually identical to today.
Verify by diffing the before/after activation scripts (step 3): the diff must contain ONLY the retired
argjson arg and the prune expression, nothing else.

## Steps

- [ ]   1. Capture a baseline of the current generated Kiro activation script for later byte-for-byte comparison.
       Evaluate the current `kiroMcpConfig.data` script string through the FULL FLAKE (standalone import
       fails — see the IMPORTANT note above) and save it to the artifact dir.
       Files: none modified (read-only capture into artifact root).
       Verify: from `/Users/celes/sources/m5max-darwin-flake`, run
       `nix --extra-experimental-features 'nix-command flakes' eval --raw '.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.kiroMcpConfig.data' > /Users/celes/sources/celesrenata/menagerie/.agents/tasks/unify-kiro-zoo-mcp/kiro-activation.before.txt`
       and confirm the file is non-empty and contains the `jq -s` program and the `rm -f "$HOME/.kiro/mcp-models.md"` line.
       (Confirmed working today. If `.data` ever differs, inspect with
       `nix eval --json '.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.kiroMcpConfig'`
       and capture whichever field holds the script text.)

- [ ]   2. In `kiro-local-model-mcp.nix`, add a `let`-bound `retiredServerNames = [ "chat-codex" "chat-gpt52" ]`
       constant and the `mkMergeActivation` helper, then rewrite `home.activation.kiroMcpConfig` to call it
       with Kiro's parameters (`settingsPath = "$HOME/.kiro/settings/mcp.json"`, `mkdirPath = ".kiro/settings"`,
       `preservedKeys = [ "disabled" "autoApprove" "disabledTools" ]`, `retiredNames = retiredServerNames`,
       `preCleanup` = the `rm -f "$HOME/.kiro/mcp-models.md"` line). The helper's jq must apply the retired
       prune after the merge (see Prune step above). Keep `entryAfter [ "writeBoundary" ]`.
       Do NOT change `chatModelCatalog`, `mkChatServer`, `chatServers`, `mcpConfig`, or `mcpConfigFile`.
       Delegate the Nix helper code generation to the local model per the multi-model workflow, then review.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
       Verify: `nix-instantiate --parse /Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix >/dev/null && echo PARSE_OK` — expect `PARSE_OK`.

- [ ]   3. Confirm the refactor changed ONLY the intended retired-prune wiring in Kiro's script.
       Files: none modified.
       Verify: re-run the step-1 eval (same full-flake attr path) into `kiro-activation.after.txt`, then
       `diff /Users/celes/sources/celesrenata/menagerie/.agents/tasks/unify-kiro-zoo-mcp/kiro-activation.before.txt /Users/celes/sources/celesrenata/menagerie/.agents/tasks/unify-kiro-zoo-mcp/kiro-activation.after.txt`
       — the ONLY differences must be (a) the added `--argjson retired '["chat-codex","chat-gpt52"]'`
       argument to jq and (b) the trailing prune expression. mkdir, the `mcp-models.md` rm, the
       first-deploy copy, the preserved-flag block, mktemp/mv/chmod, and `$DRY_RUN_CMD` wrapping must be
       unchanged. If any other line differs, adjust the helper until only the prune wiring remains in the
       diff; do not proceed until that holds.

- [ ]   4. Add `home.activation.zooMcpConfig` (ordered `lib.hm.dag.entryAfter [ "writeBoundary" ]`) that
       calls `mkMergeActivation` with Zoo's parameters: settings path
       `$HOME/Library/Application Support/Code/User/globalStorage/zoocodeorganization.zoo-code/settings/mcp_settings.json`,
       `mkdirPath` = the parent `.../settings` dir, `preservedKeys = [ "disabled" "autoApprove" "disabledTools" "alwaysAllow" ]`,
       `retiredNames = retiredServerNames` (the SAME constant used for Kiro),
       `preCleanup = ""` (no mcp-models.md touch). The space in "Application Support" must be inside the
       double-quoted bash path. Uses the same `${mcpConfigFile}`, first-deploy-copy-else-jq-merge,
       `$DRY_RUN_CMD`, and `chmod 644` as Kiro.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
       Verify: `nix-instantiate --parse <file> >/dev/null && echo PARSE_OK` — expect `PARSE_OK`.

- [ ]   5. Inspect the generated Zoo activation script and confirm its content.
       Files: none modified.
       Verify: `nix eval --raw '.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.zooMcpConfig.data'`
       (same full-flake attr path as step 1, with `zooMcpConfig`) and confirm the
       output: (a) quotes the Zoo path including the "Application Support" space correctly,
       (b) `mkdir -p` targets the Zoo settings dir, (c) the jq preserved-flags block includes all four
       keys `disabled`, `autoApprove`, `disabledTools`, `alwaysAllow`, (d) contains NO reference to
       `mcp-models.md`, (e) includes `--argjson retired '["chat-codex","chat-gpt52"]'` and the trailing
       prune expression, (f) wraps mutating lines with `$DRY_RUN_CMD` and ends with `chmod 644`.

- [ ]   6. Full flake evaluation / build to prove the module composes into the darwin system.
       Files: none modified.
       Verify (dry build, no activation):
       `cd /Users/celes/sources/m5max-darwin-flake && nix --extra-experimental-features 'nix-command flakes' build --dry-run '.#darwinConfigurations.stabulous.system' 2>&1 | tail -20`
       — expect no eval errors. (If `--dry-run` still fetches too much, fall back to
       `nix eval '.#darwinConfigurations.stabulous.system.drvPath'` which forces full module evaluation
       and will surface any Nix error in the new activations.)

- [ ]   7. Simulate the Zoo merge against the REAL current Zoo file in a throwaway HOME (non-destructive).
       Rationale: `mcpConfig`/`mcpConfigFile` are `let`-bound and not exported, so the faithful test is to
       run the generated activation script itself (captured via the step-5 eval) with `DRY_RUN_CMD=` empty
       against a copied live file in a scratch HOME. This exercises the exact store path, jq program,
       preserved-flag block, and retired prune the real activation will use.
       Files: none in the flake; operates on a temp copy only.
       Verify:
        1. Capture the Zoo script: `nix eval --raw '.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.zooMcpConfig.data' > /tmp/zoo-activation.sh`.
        2. `TESTHOME=$(mktemp -d); DEST="$TESTHOME/Library/Application Support/Code/User/globalStorage/zoocodeorganization.zoo-code/settings"; mkdir -p "$DEST"; cp "/Users/celes/Library/Application Support/Code/User/globalStorage/zoocodeorganization.zoo-code/settings/mcp_settings.json" "$DEST/mcp_settings.json"`.
        3. Run it: `( export HOME="$TESTHOME" DRY_RUN_CMD=""; bash /tmp/zoo-activation.sh )`.
        4. Assert on `"$DEST/mcp_settings.json"` with jq/python:
            - PRESENT: `total-pc-control`, `chat-reasoning`, `chat-coding`, `chat-fast`.
            - `omniroute-observability` PRESENT and still has `alwaysAllow`.
            - `playwright-mcp` has flake `command`/`args` AND retains `disabled`/`autoApprove`/`alwaysAllow`.
            - Spot-check: `git` retains `disabled`/`autoApprove`; `aws-diagram-mcp` retains `disabledTools`.
            - ABSENT (pruned): `chat-codex` and `chat-gpt52` must NOT appear in the output.
              Expected: all assertions pass; `rm -rf "$TESTHOME"` at the end.

- [ ]   8. Simulate the Kiro merge the same way in a throwaway HOME to confirm the only behavior change is
       the retired prune (new chat/total-pc-control already present for Kiro today).
       Files: none in the flake.
       Verify: `TESTHOME=$(mktemp -d); mkdir -p "$TESTHOME/.kiro/settings"; cp "/Users/celes/.kiro/settings/mcp.json" "$TESTHOME/.kiro/settings/mcp.json"`,
       capture the Kiro script via the step-1/3 eval into `/tmp/kiro-activation.sh`, then
       `( export HOME="$TESTHOME" DRY_RUN_CMD=""; bash /tmp/kiro-activation.sh )`.
       Assert on `"$TESTHOME/.kiro/settings/mcp.json"`:
        - all flake servers present; existing `disabled`/`autoApprove`/`disabledTools` flags preserved;
        - ABSENT (pruned): `chat-codex` and `chat-gpt52` (both confirmed present in the live Kiro file);
        - `$TESTHOME/.kiro/mcp-models.md` does NOT exist afterward.
          Clean up `rm -rf "$TESTHOME"`. Expect all assertions pass.

- [ ]   9. (Deployment — only on explicit user go-ahead, performed by the user or a later step)
       Apply the configuration for real.
       Files: none.
       Verify: `cd /Users/celes/sources/m5max-darwin-flake && ./nixos-rebuild.sh` (which runs
       `nix run nix-darwin -- switch --flake .#stabulous --show-trace`). After switch, confirm the live
       Zoo file now contains `total-pc-control` + `chat-reasoning`/`chat-coding`/`chat-fast`, still
       contains `omniroute-observability` with `alwaysAllow`, and NO LONGER contains `chat-codex`/`chat-gpt52`.
       Confirm Kiro's `mcp.json` is unchanged in substance EXCEPT that `chat-codex`/`chat-gpt52` are now
       gone. This step mutates the real environment; do not run it without the user's explicit confirmation.

## Notes, assumptions, and gaps

- Verified fact (not assumption): the activation script text is reachable via
  `.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.<name>.data`
  through the full flake. Standalone import with a plain nixpkgs `lib` stub does NOT work because the
  module calls `lib.hm.dag.entryAfter` and `lib.hm` only exists inside home-manager. All capture/diff
  verification (steps 1,3,5) uses the full-flake attr path.
- The retired-names prune uses the SAME `retiredServerNames = [ "chat-codex" "chat-gpt52" ]` constant
  for both editors, passed to jq via `--argjson retired "$(builtins.toJSON ...)"`. Both the live Kiro
  file and the live Zoo file currently contain these two stale servers (verified), so both will be
  cleaned on the next rebuild. Future renames: append to `retiredServerNames` only.
- The prune runs ONLY in the merge branch; the first-deploy branch is a verbatim copy of
  `${mcpConfigFile}`, which never contains retired names, so no prune is needed there.
- Per repo `.gitignore`, no new ignored artifacts are introduced. The change is confined to
  `modules/home/kiro-local-model-mcp.nix`. Roo/Cline (`ai.nix`) are untouched.
- Per the global multi-model rule, generate the Nix helper and the new activation block via the local
  model (`deepseek`) and review/adjust for byte-for-byte Kiro parity; the orchestrator writes the final
  file with the edit tools.
- CHANGELOG/changeset rules from workspace AGENTS.md are about the open workspace (menagerie), not the
  flake repo; no changelog edits are expected here regardless.
