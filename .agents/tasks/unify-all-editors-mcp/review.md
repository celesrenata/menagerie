# Unify Roo and Cline onto the shared flake MCP server set

The change teaches the existing `mkMergeActivation` helper in `modules/home/kiro-local-model-mcp.nix` a new `dropUserOnly` flag and uses it to bring two more editors (Roo Code, Cline) onto the same flake-defined MCP server set that Kiro and Zoo already share. When `dropUserOnly` is true the merge keeps only servers the flake defines (overlaying preserved UI flags from matching live entries) and drops user-only servers; when false it keeps the prior union-of-both behavior. Roo and Cline opt in to `true` so their old repo-path key scheme (`github.com/owner/repo`) is replaced cleanly instead of lingering as duplicate user-only entries. To let the two new activations own the Roo/Cline settings paths, the commit removes the two static `home.file` deployments from `modules/home/ai.nix`.

Watch for: nothing blocking. The `dropUserOnly` jq construct is correct, Kiro/Zoo behavior is untouched, and the two `home.file` removals are the only `ai.nix` change in this commit (confirmed). The `secrets/{cline,roo}_mcp_settings.json` snapshots remain on disk but unreferenced — a harmless loose end, not a defect (likely).

**Verdict**: APPROVED

## High-level view

The `dropUserOnly` flag changes exactly one thing in the merge: the starting key universe. False (the default, used by Kiro and Zoo) starts from `($flake|keys) + ($live|keys) | unique`, preserving user-only servers. True (Roo, Cline) starts from `($flake|keys)` alone, so any live-only server simply never enters the result. The rest of the pipeline — flake-wins wiring, preserved-flag overlay, and `retiredNames` deletion — is shared verbatim, so the two modes differ only by which keys they iterate.

Kiro and Zoo are provably unchanged: the commit does not touch their activation blocks, the shared server set, the chat catalog, or `retiredServerNames`. Both omit `dropUserOnly`, so they take the `false` default and keep the old union behavior. Zoo therefore still carries its editor-only servers and its `playwright-mcp.alwaysAllow` list, as the verification confirms.

The Roo and Cline activations are structurally identical to Zoo's: same `preservedKeys` (adding `alwaysAllow`), `retiredNames = retiredServerNames`, correct globalStorage settings paths (`rooveterinaryinc.roo-cline/.../mcp_settings.json` and `saoudrizwan.claude-dev/.../cline_mcp_settings.json`) with matching `mkdirPath`, and they add `dropUserOnly = true`. Paths contain a space and are handled by the helper's existing double-quoting.

The `ai.nix` edit is a pure deletion of the two static settings deployments that the activations now own, avoiding a `home.file`-vs-activation path conflict. No `.changeset` or `CHANGELOG` edits are present.

<details>
<summary>Issues (1)</summary>

1. **Unreferenced secrets snapshots** — `secrets/cline_mcp_settings.json` and `secrets/roo_mcp_settings.json` are no longer read by any module after the `ai.nix` removal. Non-blocking; consider removing them in a follow-up to avoid confusion. (possible)

</details>

<details>
<summary>Details</summary>

### `dropUserOnly` threads through the key universe, not the pipeline

The flag is implemented as a Nix-level selection of a single jq sub-expression bound to `keyUniverse`:

```nix
keyUniverse =
  if dropUserOnly
  then "($flake | keys)"
  else "(($flake | keys) + ($live | keys) | unique)";
```

This string is interpolated into the jq program at the point that previously hard-coded the union. The task description suggested `--argjson` as one possible threading mechanism ("e.g. --argjson"); inlining a jq expression is an equally valid approach here because `$flake` and `$live` are already bound earlier in the same pipeline (`(.[0].mcpServers) as $flake | (.[1].mcpServers // {}) as $live`), so the interpolated expression resolves them in scope. The server-name set in the true case is built from `($flake | keys)` only, exactly as required.

The downstream `map` is unchanged. In the `dropUserOnly=true` case every `$name` originates from the flake, so `$f = $flake[$name]` is never null; a flake server absent from live takes flake wiring, and one present in both takes flake wiring plus the preserved-flag overlay (`disabled`/`autoApprove`/`disabledTools`/`alwaysAllow` for Roo/Cline). User-only servers never appear because their keys are not in the universe. `delpaths([ $retired[] | [ . ] ])` still runs, so `retiredNames` applies in both modes.

I validated the true-case program against a synthetic fixture: given flake `{a,b}` and live `{a (with disabled+alwaysAllow), github.com/foo/bar, chat-codex}`, the output was exactly `{a (flake wiring + disabled + alwaysAllow), b}` — the user-only `github.com/foo/bar` dropped and the overlay preserved. The jq exited 0, confirming the interpolated program is syntactically well-formed. This matches the verification's recorded Roo/Cline results (count 31, no `github.com/` keys).

### Kiro and Zoo are untouched

The commit's diff for this file adds the flag plumbing and the two new activation blocks; it does not modify the Kiro or Zoo activations, `retiredServerNames` (`[ "chat-codex" "chat-gpt52" ]`), the chat catalog, or the shared server set (grep for those definitions in the commit returns nothing). Both Kiro and Zoo omit `dropUserOnly`, so they resolve to the `false` default and the union key universe. Kiro keeps `preservedKeys = disabled/autoApprove/disabledTools`, its `mcp-models.md` preCleanup, and union behavior; Zoo adds `alwaysAllow` and keeps union behavior, so its user-only `omniroute-observability` and `playwright-mcp` (with its 4-element `alwaysAllow`) survive. The verification's Kiro "IDENTICAL KEY SETS" and Zoo count-32 results corroborate this.

### Roo and Cline activations

Both new activations mirror Zoo's shape with `dropUserOnly = true` added. Roo targets `.../globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`; Cline targets `.../globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`. Each `mkdirPath` is the parent `settings` directory of its `settingsPath`. `preservedKeys` includes `alwaysAllow` for both, and `retiredNames = retiredServerNames`. The paths contain `Application Support` (a space); the helper assigns `settings="${settingsPath}"` and references it double-quoted throughout, so the space is handled without extra escaping. These are first-rebuild clean re-keys: the existing symlink/old-key file triggers either the `[[ -L ]]` first-deploy branch or the merge branch, both of which converge on the 31-server flake set per the verification.

### `ai.nix` scope

The commit removes exactly the two `home.file` entries that deployed `cline_mcp_settings.json` and `roo mcp_settings.json`, and nothing else in `ai.nix` (the surrounding Continue/OpenHands config is untouched by this commit). Unrelated `ai.nix` edits visible in the working tree (package list churn, `mcp-servers.programs` tweaks) are uncommitted and outside this commit's scope, so they are not part of this change. No `.changeset` or `CHANGELOG` files are added or modified.

</details>

<details>
<summary>File map</summary>

- `modules/home/kiro-local-model-mcp.nix` — add `dropUserOnly` param + `keyUniverse` selection to `mkMergeActivation`; add `rooMcpConfig` and `clineMcpConfig` activations (dropUserOnly=true).
- `modules/home/ai.nix` — remove the two static `home.file` deployments for Cline/Roo MCP settings.

Full change: `git -C /Users/celes/sources/m5max-darwin-flake show 39e9f27`

</details>
