# Shared MCP activation helper deploying one server set to Kiro and Zoo Code

The merge-based activation that keeps Kiro's `mcp.json` in sync with the flake was factored into a single `let`-bound helper, `mkMergeActivation { settingsPath, mkdirPath, preservedKeys, preCleanup ? "" }`, and that same helper now drives a new `home.activation.zooMcpConfig` so Zoo Code derives its MCP server set from the identical `mcpConfigFile`. Kiro keeps its three preserved UI flags and its `mcp-models.md` cleanup; Zoo adds `alwaysAllow` to the preserved set and skips the `mcp-models.md` step. The commit (`3b4d45b`) is scoped to exactly one file. The authoritative task text does not ask for the `retiredNames` prune that plan.md folded in, and the implementer deliberately omitted it (chat-codex/chat-gpt52 are left as user-only), which matches the review scope I was given.

Watch for: nothing blocking. The only deltas from the original Kiro script are cosmetic — the mktemp template was renamed `/tmp/kiro-mcp.XXXXXX` → `/tmp/mcp-merge.XXXXXX`, and the three preserved-flag jq lines are now generated rather than literal (confirmed semantically identical). (confirmed)

**Verdict**: APPROVED

## High-level view

The design collapses two near-identical ~25-line jq merge programs into one parameterized Nix function, which is the right call: duplicating the merge logic across two editors is the main drift risk, and a single helper makes the two real differences (Zoo's extra `alwaysAllow` key, Kiro's `mcp-models.md` cleanup) explicit one-argument deltas. The flake owns server wiring; the live file owns per-server runtime flags and any hand-added servers; the merge takes flake wiring as the base and overlays preserved flags for servers in both.

Kiro's emitted behavior is preserved. Every mutating line that was `$DRY_RUN_CMD`-wrapped before is still wrapped, the `mcp-models.md` removal still runs in the same position (after the `settings=` assignment, before the first-deploy check), the first-deploy verbatim-copy branch is unchanged, and `chmod 644` is applied on both branches. jq is whitespace-insensitive, so generating the preserved-flag lines from a list rather than writing them literally produces an identical program; the implementer independently confirmed byte-identical merge output against the original logic.

Zoo applies the same `mcpConfigFile` to its `mcp_settings.json` under `Application Support`, with the space handled because the helper interpolates the path inside a double-quoted bash assignment. Zoo preserves `disabled`/`autoApprove`/`disabledTools`/`alwaysAllow`, keeps its editor-only servers (`omniroute-observability` via the user-only branch, `playwright-mcp` via the both-sources branch), creates the parent directory, and never references `mcp-models.md`. It is ordered `entryAfter [ "writeBoundary" ]` because the helper itself returns that DAG entry.

The server set, chat catalog, and Roo/Cline (`ai.nix`) are untouched by this commit, and no flake inputs were added. The stale `chat-codex`/`chat-gpt52` entries survive in both live files as a documented residual, consistent with the task forbidding their deletion.

<details>
<summary>Issues (2)</summary>

1. **mktemp template renamed** — informational, non-blocking: the tmp file template changed from `/tmp/kiro-mcp.XXXXXX` to the shared `/tmp/mcp-merge.XXXXXX`. No behavioral effect; both editors now use the same template and could collide only within an impossible same-microsecond race (mktemp guarantees uniqueness anyway). No action required.
2. **Stale chat-codex/chat-gpt52 remain** — informational, by design: the merge keeps user-only servers, so the retired chat servers persist in both live files. Deleting them is a separate user-approved change; not a defect in this diff.

</details>

<details>
<summary>Details</summary>

## Factoring the merge into one helper

The helper takes the editor-specific pieces as arguments — the settings path, the directory to create, the list of preserved flag keys, and an optional pre-cleanup bash fragment — and returns a `lib.hm.dag.entryAfter [ "writeBoundary" ]` activation. The jq merge program, the first-deploy-vs-merge branching, the mktemp/mv/chmod sequence, and the `$DRY_RUN_CMD` wrapping are shared verbatim. This is the correct abstraction boundary: the only things that legitimately differ between Kiro and Zoo are exactly the four parameters, so the merge logic can no longer drift between the two.

The preserved-flag block is built with `lib.concatMapStringsSep` mapping each key `k` to `+ (if $l.${k} != null then { ${k}: $l.${k} } else {} end)`. For Kiro this emits the three lines in the original order (disabled, autoApprove, disabledTools); for Zoo it appends the `alwaysAllow` line. Because jq ignores the surrounding whitespace, a generated block and the original hand-written block compile to the same filter.

## Kiro behavior-preservation

The one risk in a refactor like this is that Kiro's emitted script changes in some way beyond the intended parameterization. Tracing the generated script against the original:

```
$DRY_RUN_CMD mkdir -p "$HOME/.kiro/settings"      # wrapped, same
settings="$HOME/.kiro/settings/mcp.json"          # same
$DRY_RUN_CMD rm -f "$HOME/.kiro/mcp-models.md"    # via preCleanup, wrapped, same position
if [[ ! -f "$settings" ]] || [[ -L "$settings" ]] # first-deploy guard, same
  $DRY_RUN_CMD rm -f / cp ${mcpConfigFile} / chmod 644   # all wrapped, same
else
  tmp="$(mktemp "/tmp/mcp-merge.XXXXXX")"          # template renamed (was kiro-mcp), not wrapped — matches original (mktemp was never wrapped)
  jq -s '...' ${mcpConfigFile} "$settings" > "$tmp"  # not wrapped — matches original
  $DRY_RUN_CMD mv / chmod 644                      # wrapped, same
fi
```

The `rm -f mcp-models.md` landing after the `settings=` assignment matches the original ordering exactly. The jq redirect to `$tmp` and the mktemp call were not `$DRY_RUN_CMD`-wrapped in the original and still aren't, so dry-run semantics are preserved: a dry run writes the scratch file (harmless) but never `mv`s it onto the real target. The implementer's verification ran the original jq program and the refactored one against the same inputs and diffed sorted output — reported `KIRO MERGE IDENTICAL`. The only textual delta is the mktemp template name, which has no behavioral consequence.

## Zoo merge correctness and bash quoting

Zoo's settings path contains a space in `Application Support`. The helper assigns it as `settings="${settingsPath}"`, so after Nix interpolation the bash reads `settings="$HOME/Library/Application Support/Code/User/globalStorage/zoocodeorganization.zoo-code/settings/mcp_settings.json"` — a single double-quoted word, correctly handling the space. Every later use (`[[ -f "$settings" ]]`, `cp ... "$settings"`, the jq input, `mv ... "$settings"`, `chmod 644 "$settings"`) quotes `$settings`, so the space is safe throughout. The `mkdir -p "${mkdirPath}"` is likewise double-quoted.

Zoo's preserved-key list is `disabled`/`autoApprove`/`disabledTools`/`alwaysAllow`, so the always-allow lists on `playwright-mcp` and `omniroute-observability` survive the merge. Server-set outcomes under the merge logic:

- `omniroute-observability` is user-only (not in the flake) → `$f == null` branch keeps it verbatim, including `alwaysAllow`.
- `playwright-mcp` exists in both → takes flake `command`/`args` and overlays preserved flags (`disabled`/`autoApprove`/`alwaysAllow`).
- `total-pc-control`, `chat-reasoning`, `chat-coding`, `chat-fast` are new flake servers absent from the live Zoo file → `$l == null` branch takes flake wiring, which is the whole point of the change.

The parent directory is created with `mkdir -p`, the final file is `chmod 644`, no `mcp-models.md` reference exists (preCleanup defaults to `""`), and the activation is ordered after `writeBoundary` because the helper returns that entry. The implementer's Zoo simulation against the real live file confirmed all of the above.

Zoo's live file is a regular file (not a symlink), so it takes the merge branch rather than the verbatim-copy branch — correct, since a verbatim copy would wipe the user's editor-only servers and flags. The first-deploy branch only fires when the file is missing or still a store symlink.

## Scope and residuals

The commit modifies only `modules/home/kiro-local-model-mcp.nix`; `chatModelCatalog`, `mkChatServer`, `chatServers`, `mcpConfig`, and `mcpConfigFile` are unchanged above the helper. `ai.nix` (Roo/Cline) is not in the commit, and `flake.nix`/`flake.lock` inputs are not touched by this commit (the working-tree churn in those files is unrelated and uncommitted). `chat-codex`/`chat-gpt52` persist as user-only servers in both live files; the task explicitly forbids deleting them, so their survival is correct and documented, not a defect.

## Verification evidence

verification.md records `nix-instantiate --parse` → PARSE_OK, a clean `nix build` of the darwin system, and both merge simulations (Kiro byte-identical to original logic; Zoo gaining the new servers while preserving `alwaysAllow` and editor-only servers). I independently re-ran only the narrow parse spot-check (`PARSE_OK`) and confirmed via git that the commit is scoped to the single file; I did not re-run the build or the full simulations, per instructions.

</details>

<details>
<summary>File map</summary>

- `modules/home/kiro-local-model-mcp.nix` — factored the Kiro merge activation into a shared `mkMergeActivation` helper and added `zooMcpConfig` using the same helper for the Zoo Code settings path.

Full diff: `git -C /Users/celes/sources/m5max-darwin-flake show 3b4d45b -- modules/home/kiro-local-model-mcp.nix`

</details>
