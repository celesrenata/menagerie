# Verification — Unify all four editors' MCP configs onto the shared flake server set

All commands were run from `/Users/celes/sources/m5max-darwin-flake`. No
`darwin-rebuild switch` was performed; the live merges were simulated with the
same jq transform the activation uses. The flake server-set size is **31**.

## 1. Parse both modules

```
$ nix-instantiate --parse modules/home/kiro-local-model-mcp.nix >/dev/null && echo OK
KIRO-MCP PARSE OK
$ nix-instantiate --parse modules/home/ai.nix >/dev/null && echo OK
AI PARSE OK
$ grep -n "cline_mcp_settings\|roo_mcp_settings" modules/home/ai.nix; echo exit=$?
exit=1          # no remaining references to the removed home.file deployments
```

Both files parse OK. The two static `home.file` deployments were removed from
`ai.nix`. The `secrets/cline_mcp_settings.json` and `secrets/roo_mcp_settings.json`
snapshots remain on disk but are now **unreferenced**.

## 2. Full darwin build (catches any home.file-vs-activation path conflict)

```
$ nix build --no-link .#darwinConfigurations.stabulous.system
these 6 derivations will be built:
  .../home-manager-files.drv
  .../hm-putter.json.drv
  .../activation-script.drv
  .../home-manager-generation.drv
  .../activation-celes.drv
  .../darwin-system-26.11.4cff07d.drv
...
BUILD_EXIT=0
```

Builds clean (exit 0). No path conflict between a `home.file` and the new
Roo/Cline activations — the removal in `ai.nix` cleared the way.

## 3. Materialize the flake JSON

Derived directly from the module via the Roo activation's embedded store path
(no circular reasoning / no Kiro stand-in needed):

```
$ nix eval --raw .#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.rooMcpConfig.data \
    | grep -oE '/nix/store/[a-z0-9]+-kiro-mcp.json' | head -1
/nix/store/lh5lq3gjjg22rn8sjpygwga1mmhxbzyd-kiro-mcp.json
$ jq . <that path> > /tmp/flake-mcp.json
$ jq '.mcpServers|keys|length' /tmp/flake-mcp.json
31
```

(The activation entry's text lives under `.data`, not `.text`.)

## Live file state (pre-merge)

```
FILE     servers=31  ~/.kiro/settings/mcp.json
FILE     servers=32  .../zoocodeorganization.zoo-code/settings/mcp_settings.json
SYMLINK  servers=27  .../rooveterinaryinc.roo-cline/settings/mcp_settings.json
SYMLINK  servers=27  .../saoudrizwan.claude-dev/settings/cline_mcp_settings.json
```

Note: Roo and Cline live files are currently **symlinks** into the old
`home-manager-files` store path (the deployments being removed). The symlink
targets were dereferenced and fed to the merge jq so the merge branch itself is
exercised with `dropUserOnly=true`. (On the next real rebuild the helper's
first-deploy branch — `[[ -L "$settings" ]]` — would also fire for the symlink
and write the flake verbatim; both paths yield the same 31-server flake set.)

## 4. Simulate all four merges

jq programs copied verbatim from the helper, differing only in the key-universe
line and the preserved-flag lines:

- Kiro: `(($flake|keys)+($live|keys)|unique)`, flags `disabled/autoApprove/disabledTools`.
- Zoo: same universe, flags `+ alwaysAllow`.
- Roo & Cline: `($flake|keys)` (dropUserOnly), flags `+ alwaysAllow`.

All run with `--argjson retired '["chat-codex","chat-gpt52"]'` over
`-s /tmp/flake-mcp.json <live-file>`.

```
kiro count: 31
zoo count: 32
roo count: 31
cline count: 31
```

### Kiro (dropUserOnly=false) — must stay UNCHANGED

```
count==31:                 PASS
total-pc-control present:  PASS
chat-reasoning present:    PASS
chat-coding present:       PASS
chat-fast present:         PASS
chat-codex absent:         PASS
chat-gpt52 absent:         PASS

diff of merged key set vs current Kiro live key set: IDENTICAL KEY SETS
```

### Zoo (dropUserOnly=false) — must stay UNCHANGED, keep editor-only servers

```
count==32:                        PASS   (31 flake + omniroute-observability)
total-pc-control present:         PASS
3 chat servers present:           PASS
chat-codex absent:                PASS
chat-gpt52 absent:                PASS
omniroute-observability present:  PASS   (editor-only, preserved)
playwright-mcp.alwaysAllow:       PASS   (len = 4, preserved)
```

### Roo (dropUserOnly=true) — one-time clean re-key

```
count==31:                 PASS   (NOT 58 = 31+27)
no github.com/ keys:       PASS   (old repo-path scheme fully gone, no duplicates)
total-pc-control present:  PASS
3 chat servers present:    PASS
iterm-mcp present:         PASS
context7 present:          PASS
chat-codex absent:         PASS
chat-gpt52 absent:         PASS

roo live count:   27   (old repo-path keys, e.g. github.com/21st-dev/magic-mcp)
roo merged count: 31   (NOT 58)
```

Merged Roo server-name list (short flake names only):

```
aws-diagram-mcp aws-documentation aws-iac-mcp browser-tools-mcp chart-mcp
chat-coding chat-fast chat-reasoning comfyui-mcp context7 dalle-mcp fetch
filesystem git iterm-mcp kubernetes-mcp local-model lsp-mcp-nix magic-mcp
markdownify-mcp memory nixos obsidian-mcp ollama-mcp playwright-mcp postman
sequential-thinking sleep-mcp total-pc-control webresearch-mcp wolframalpha-mcp
```

### Cline (dropUserOnly=true) — one-time clean re-key

```
count==31:                 PASS   (NOT 58)
no github.com/ keys:       PASS
total-pc-control present:  PASS
3 chat servers present:    PASS
iterm-mcp present:         PASS
context7 present:          PASS
chat-codex absent:         PASS
chat-gpt52 absent:         PASS
```

## Summary

| Editor | dropUserOnly | Count | total-pc-control + 3 chat | retired absent | github.com keys                                                | Result              |
| ------ | ------------ | ----- | ------------------------- | -------------- | -------------------------------------------------------------- | ------------------- |
| Kiro   | false        | 31    | yes                       | yes            | n/a                                                            | PASS (unchanged)    |
| Zoo    | false        | 32    | yes                       | yes            | n/a; keeps omniroute-observability + playwright alwaysAllow(4) | PASS (unchanged)    |
| Roo    | true         | 31    | yes                       | yes            | none                                                           | PASS (clean re-key) |
| Cline  | true         | 31    | yes                       | yes            | none                                                           | PASS (clean re-key) |

All assertions PASS. Kiro/Zoo behavior is preserved; Roo/Cline are cleanly
re-keyed onto the shared flake server set with no duplicate repo-path keys.
