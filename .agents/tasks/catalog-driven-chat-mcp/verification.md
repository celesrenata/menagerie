# Verification — catalog-driven chat MCP + upstream model-sync doc

All commands run from `/Users/celes/sources/m5max-darwin-flake` unless noted. No `darwin-rebuild switch` was run; only parse/eval/build-level (non-destructive) checks.

## 1. Parse check

```
$ nix-instantiate --parse modules/home/kiro-local-model-mcp.nix >/dev/null && echo "PARSE OK"
PARSE OK
```

## 2. Catalog renders three chat servers (isolated eval of the catalog + mkChatServer logic)

```
$ nix eval --impure --json --expr '<catalog + mkChatServer + listToAttrs>'
{
  "chat-codex":    { "model": "gpt-6.1-sol", "name": "GPT-6.1-Sol" },
  "chat-fast":     { "model": "gpt-6-luna",  "name": "GPT-6-Luna" },
  "chat-flagship": { "model": "gpt-6-astra", "name": "GPT-6-Astra" }
}
```

## 3. Full darwin configuration builds (non-destructive, no switch)

```
$ nix build --no-link .#darwinConfigurations.stabulous.system
these 5 derivations will be built:
  /nix/store/jah3zpwyay6qfr4dvqs64v2nwvnf9p0g-kiro-mcp.json.drv
  /nix/store/x013dh5ja0n285dllwajslvnnq15a3w4-activation-script.drv
  /nix/store/bbwcnwf9bs8xgasz4vxmfa41k18z928d-home-manager-generation.drv
  /nix/store/b3kqz7wi65974cf9c61il71zw6c00zbk-activation-celes.drv
  /nix/store/pwyi07ccq6qcg025aa0z3ljpfwv1a569-darwin-system-26.11.4cff07d.drv
<built, EXIT=0>
```

## 4. Rendered kiro-mcp.json — three catalog servers present, none dropped

Built the referenced `kiro-mcp.json` derivation and inspected with jq:

```
$ out=$(nix-store --realise /nix/store/jah3zpwyay6qfr4dvqs64v2nwvnf9p0g-kiro-mcp.json.drv | tail -1)
  # out = /nix/store/kp8fd5cmv32f6ih2n5h4khginf22qmxj-kiro-mcp.json

$ jq -r '.mcpServers|keys[]' "$out" | tr '\n' ' '
aws-diagram-mcp aws-documentation aws-iac-mcp browser-tools-mcp chart-mcp chat-codex chat-fast chat-flagship comfyui-mcp context7 dalle-mcp fetch filesystem git iterm-mcp kubernetes-mcp local-model lsp-mcp-nix magic-mcp markdownify-mcp memory nixos obsidian-mcp ollama-mcp playwright-mcp postman sequential-thinking sleep-mcp total-pc-control webresearch-mcp wolframalpha-mcp

$ jq -r '.mcpServers|to_entries[]|select(.key|startswith("chat-"))|"\(.key): \(.value.env.AI_CHAT_NAME) / \(.value.env.AI_CHAT_MODEL)"' "$out"
chat-codex: GPT-6.1-Sol / gpt-6.1-sol
chat-fast: GPT-6-Luna / gpt-6-luna
chat-flagship: GPT-6-Astra / gpt-6-astra

$ jq '.mcpServers|keys|length' "$out"
31                      # was 29 (27 non-chat + 2 chat); now 28 non-chat + 3 chat

$ jq '.mcpServers|has("chat-gpt52")|not' "$out"
true                    # old chat-gpt52 dropped

$ jq -e '.mcpServers|has("chat-flagship") and has("chat-codex") and has("chat-fast")' "$out"
true                    # three catalog servers present

$ jq -e '.mcpServers|has("total-pc-control") and has("local-model") and has("comfyui-mcp") and has("filesystem") and has("wolframalpha-mcp") and has("sequential-thinking")' "$out"
true                    # untouched servers preserved
```

Confirms requirement 3: models are `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, and
`AI_CHAT_NAME` values are `GPT-6-Astra` / `GPT-6.1-Sol` / `GPT-6-Luna`.

## 5. Activation doc catalog injection (real module via flake)

```
$ nix eval --raw .#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.kiroMcpModelsDoc.data | head
catalog_json='[{"cachedInputRate":"$0.10",...,"serverName":"chat-codex"},{...,"serverName":"chat-fast"},{...,"serverName":"chat-flagship"}]'
secret="/run/secrets/openai_api_key"
dest="$HOME/.kiro/mcp-models.md"
generated="$(/nix/store/...-coreutils-9.11/bin/date)"
```

The catalog JSON is injected from Nix (`builtins.toJSON (builtins.attrValues chatModelCatalog)`),
parsed in-script with jq, so the doc stays in sync with the catalog.

## 6. Doc-generation jq logic — status + slug derivation (both paths)

Upstream available (astra live, sol has shutdown_date, luna absent):

```
| chat-codex    | chat-with-gpt-6-1-sol | gpt-6.1-sol | RETIRING (2026-01-01) | $2.00  | $0.10 | $10.00 | ... |
| chat-fast     | chat-with-gpt-6-luna  | gpt-6-luna  | MISSING               | $0.10  | $0.01 | $0.50  | ... |
| chat-flagship | chat-with-gpt-6-astra | gpt-6-astra | live                  | $10.00 | $1.00 | $50.00 | ... |
```

Upstream unavailable:

```
| chat-codex    | chat-with-gpt-6-1-sol | gpt-6.1-sol | upstream check unavailable | ... |
| chat-fast     | chat-with-gpt-6-luna  | gpt-6-luna  | upstream check unavailable | ... |
| chat-flagship | chat-with-gpt-6-astra | gpt-6-astra | upstream check unavailable | ... |
```

Slug derivation matches tool-name reality: `GPT-6-Astra -> chat-with-gpt-6-astra`,
`GPT-6.1-Sol -> chat-with-gpt-6-1-sol`, `GPT-6-Luna -> chat-with-gpt-6-luna`.

## 7. Full activation block resilience smoke test (no readable key)

Ran the complete block body against a scratch `$HOME` with an unreadable secret path:

- stderr: `kiroMcpModelsDoc: ... not readable; skipping upstream check ..., writing catalog-only doc.`
- block exit: 0 (never fails activation)
- `$HOME/.kiro/mcp-models.md` written (chmod 644), containing the header,
  the "upstream check unavailable" note, and all three tiers with tool names and rates.

Scratch home cleaned up afterward.

## Notes

- `nix build ... --no-link` and all evals are non-destructive. No `switch`/activation run on the live system.
- Step 8 host-side runtime checks (SOPS-active status rendering) are deferred to the user's next real `darwin-rebuild`.
