# Verification: Unify Kiro + Zoo Code MCP server set

Target file: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`

## Summary of change

- Factored the merge-based activation into one reusable Nix helper
  `mkMergeActivation { settingsPath, mkdirPath, preservedKeys, preCleanup ? "" }`.
- `home.activation.kiroMcpConfig` now calls the helper with Kiro's parameters
  (preservedKeys = disabled/autoApprove/disabledTools, preCleanup = the
  `rm -f "$HOME/.kiro/mcp-models.md"` line). Behavior-identical to before.
- Added `home.activation.zooMcpConfig` (ordered `lib.hm.dag.entryAfter [ "writeBoundary" ]`)
  calling the SAME helper for the Zoo path
  `$HOME/Library/Application Support/Code/User/globalStorage/zoocodeorganization.zoo-code/settings/mcp_settings.json`,
  with preservedKeys = disabled/autoApprove/disabledTools/**alwaysAllow** and no mcp-models.md touch.
- Single source of truth (`mcpConfig`/`mcpConfigFile`) unchanged. Server set, chat catalog
  unchanged. Roo/Cline (`ai.nix`) untouched. No new flake inputs.

## Deviation from plan.md (intentional, per authoritative task text)

plan.md folded in a `retiredServerNames` prune to delete stale `chat-codex`/`chat-gpt52`
from both editors. The authoritative task instruction explicitly says:
"do NOT delete them in this task" and lists deleting those entries as a user-visible
behavior change requiring confirmation. Per the precedence rule (verbatim task text wins over
the plan), the prune was NOT implemented. The stale entries remain as user-only servers and
are documented below as a known residual.

## Commands and output

### 1. Parse

```
$ nix-instantiate --parse modules/home/kiro-local-model-mcp.nix >/dev/null && echo PARSE_OK
PARSE_OK
```

### 2. Full system build (no activation, no switch)

```
$ nix build --no-link '.#darwinConfigurations.stabulous.system'
these 4 derivations will be built:
  .../activation-script.drv
  .../home-manager-generation.drv
  .../activation-celes.drv
  .../darwin-system-26.11.4cff07d.drv
... built clean (exit 0)
```

### Generated activation scripts (captured via full-flake eval)

- `kiro-activation.after.txt`: mkdir `$HOME/.kiro/settings`, `rm -f "$HOME/.kiro/mcp-models.md"`,
  first-deploy copy, 3 preserved keys, mktemp/mv/chmod 644, all mutating lines `$DRY_RUN_CMD`-wrapped.
- `zoo-activation.txt`: mkdir Zoo settings dir (space in "Application Support" correctly quoted),
  NO mcp-models.md reference, first-deploy copy of the SAME store path, 4 preserved keys
  (disabled/autoApprove/disabledTools/alwaysAllow), mktemp/mv/chmod 644, `$DRY_RUN_CMD`-wrapped.
  Both reference the identical `mcpConfigFile` store path, proving the shared server set.

### 3a. Kiro merge simulation (scratch HOME, DRY_RUN_CMD="", real live file copied in)

```
total-pc-control: PRESENT
chat-reasoning: PRESENT
chat-coding: PRESENT
chat-fast: PRESENT
sequential-thinking.autoApprove: ["sequentialthinking"]   (preserved)
webresearch-mcp.disabled: false                            (preserved)
chat-codex present: true    (user-only, retained — known residual)
chat-gpt52 present: true    (user-only, retained — known residual)
mcp-models.md after run: ABSENT (good)
server count: 33
```

### 3a-bis. Kiro behavior-preservation proof

Ran the ORIGINAL (pre-refactor) Kiro jq program against the same flake JSON + live Kiro file,
sorted both outputs, and diffed against the refactored merge result:

```
KIRO MERGE IDENTICAL to original logic ✓
```

### 3b. Zoo merge simulation (scratch HOME, DRY_RUN_CMD="", real live Zoo file copied in)

```
total-pc-control: PRESENT   (NEW)
chat-reasoning:   PRESENT   (NEW)
chat-coding:      PRESENT   (NEW)
chat-fast:        PRESENT   (NEW)
omniroute-observability present + alwaysAllow array: YES   (Zoo-only, preserved)
playwright-mcp: command=node, flake args, disabled=false, autoApprove(10), alwaysAllow(4)  (flake wiring + preserved flags)
context7.disabled: false            (preserved)
sequential-thinking.autoApprove: ["sequentialthinking"]  (preserved)
git: disabled=true, autoApprove(3)  (preserved)
chat-codex present: true   (user-only, retained — known residual; flake renamed, not deleted)
chat-gpt52 present: true   (user-only, retained — known residual)
server count: 34
```

## Known residual

`chat-codex` and `chat-gpt52` are stale (the flake renamed the chat servers to
`chat-reasoning`/`chat-coding`/`chat-fast`). They remain as user-only servers in BOTH live files
because the merge keeps user-only servers and this task explicitly forbids deleting them.
Removing them is a separate, user-approved change.

## Assumptions

- The Zoo settings path and extension id (`zoocodeorganization.zoo-code`) match the live file verified on disk.
- Zoo's always-allow UI flag key is `alwaysAllow` (confirmed on `playwright-mcp` and
  `omniroute-observability` in the live Zoo file).
- First-deploy branch copies the flake file verbatim (never contains stale names), matching Kiro.
