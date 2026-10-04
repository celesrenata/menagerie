# Verification — Re-point chat MCP servers at OmniRoute; remove model-sync doc

Target file: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
Repo: `/Users/celes/sources/m5max-darwin-flake` (darwin host attribute `stabulous`), base HEAD `b887ebf`.
All commands run from `/Users/celes/sources/m5max-darwin-flake`. No `darwin-rebuild switch` run (non-destructive only).

## 1. Parse check

```
$ nix-instantiate --parse modules/home/kiro-local-model-mcp.nix >/dev/null && echo "PARSE OK"
PARSE OK
```

## 2. Full darwin system build (clean)

```
$ nix build --no-link '.#darwinConfigurations.stabulous.system'
these 5 derivations will be built:
  /nix/store/m1bc9k4nh1wxzzrq37d0rcvr8vnhwway-kiro-mcp.json.drv
  /nix/store/yh4lqx54z4bwn7ddjxrhz970k0i6pir5-activation-script.drv
  /nix/store/v66w98ii56xjzysz7lgffnky3bsc1bsp-home-manager-generation.drv
  /nix/store/c8rvzjyni88kiqcfyd27fn96bdzgg0iz-activation-celes.drv
  /nix/store/nayw43f17x6g5k7ssr01icar7sfs7vam-darwin-system-26.11.4cff07d.drv
building '/nix/store/m1bc9k4nh1wxzzrq37d0rcvr8vnhwway-kiro-mcp.json.drv'...
building '/nix/store/yh4lqx54z4bwn7ddjxrhz970k0i6pir5-activation-script.drv'...
building '/nix/store/v66w98ii56xjzysz7lgffnky3bsc1bsp-home-manager-generation.drv'...
building '/nix/store/c8rvzjyni88kiqcfyd27fn96bdzgg0iz-activation-celes.drv'...
building '/nix/store/nayw43f17x6g5k7ssr01icar7sfs7vam-darwin-system-26.11.4cff07d.drv'...
EXIT=0
```

Build completed with no evaluation errors.

## 3. Inspect generated kiro-mcp.json

Generated store output: `/nix/store/lh5lq3gjjg22rn8sjpygwga1mmhxbzyd-kiro-mcp.json`

```
$ jq '.mcpServers | with_entries(select(.key|startswith("chat-")))' <kiro-mcp.json>
```

Result (abridged, env shown per server):

- `chat-reasoning`: `AI_CHAT_MODEL=auto/best-reasoning`, `AI_CHAT_NAME=Reasoning`
- `chat-coding`: `AI_CHAT_MODEL=auto/best-coding`, `AI_CHAT_NAME=Coding`
- `chat-fast`: `AI_CHAT_MODEL=auto/fast`, `AI_CHAT_NAME=Fast`

All three share:

- `AI_CHAT_BASE_URL=http://127.0.0.1:20128/v1`
- `AI_CHAT_KEY=omniroute-local`
- `AI_CHAT_TIMEOUT=300000`
- `args = [ "-c", "exec <npx> -y @pyroprompts/any-chat-completions-mcp" ]` (no SOPS cat)

Count of `/run/secrets` references in chat-server args:

```
$ jq -r '.mcpServers | to_entries[] | select(.key|startswith("chat-")) | .value.args[]' <kiro-mcp.json> | grep -c "run/secrets"
0
```

All server names present (31 total):

```
$ jq -r '.mcpServers | keys[]' <kiro-mcp.json> | tr '\n' ' '
aws-diagram-mcp aws-documentation aws-iac-mcp browser-tools-mcp chart-mcp chat-coding chat-fast chat-reasoning comfyui-mcp context7 dalle-mcp fetch filesystem git iterm-mcp kubernetes-mcp local-model lsp-mcp-nix magic-mcp markdownify-mcp memory nixos obsidian-mcp ollama-mcp playwright-mcp postman sequential-thinking sleep-mcp total-pc-control webresearch-mcp wolframalpha-mcp
```

`total-pc-control` and `local-model` both present; no `chat-flagship`/`chat-codex` remain.

## 4. Residue grep in source file

```
$ grep -n "mcp-models.md\|api.openai.com/v1/models\|chatModelCatalogJson\|kiroMcpModelsDoc\|gpt-6\|inputRate\|outputRate" modules/home/kiro-local-model-mcp.nix
94:    $DRY_RUN_CMD rm -f "$HOME/.kiro/mcp-models.md"
```

Only match is the intended cleanup `rm -f` line. No `api.openai.com/v1/models`, no `gpt-6-*`, no rate fields, no `chatModelCatalogJson`, no `kiroMcpModelsDoc`.

OpenAI/SOPS references remaining (all pre-existing, untouched, non-chat):

```
$ grep -n "openai_api_key\|/run/secrets" modules/home/kiro-local-model-mcp.nix
52: postman  -> /run/secrets/postman_api_key
57: magic-mcp -> /run/secrets/magic_mcp_api_key
67: dalle-mcp -> /run/secrets/openai_api_key
```

The only `openai_api_key` reference is `dalle-mcp`, as expected per plan step 7.

## 5. Diff scope

`git -C /Users/celes/sources/m5max-darwin-flake diff` touches ONLY:

- the `chatModelCatalog` let-binding (+comment)
- the `mkChatServer` helper (+comment)
- the removed `chatModelCatalogJson` binding (+comment)
- the removed `home.activation.kiroMcpModelsDoc` block (+comment)
- the single `rm -f "$HOME/.kiro/mcp-models.md"` cleanup line in `kiroMcpConfig`

All other `mcpServers` entries unchanged; `kiroMcpConfig` jq-merge block otherwise intact.
