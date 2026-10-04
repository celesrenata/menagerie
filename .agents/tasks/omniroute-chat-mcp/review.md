# Route the three chat MCP servers through OmniRoute; drop the model-sync doc

The chat tier of `kiro-local-model-mcp.nix` no longer talks to OpenAI directly. The `chatModelCatalog` now carries three OmniRoute _routes_ (`auto/best-reasoning`, `auto/best-coding`, `auto/fast`) instead of fixed `gpt-6-*` model ids, and the `mkChatServer` helper points every generated server at the local OmniRoute endpoint (`http://127.0.0.1:20128/v1`) with a non-secret placeholder key. The SOPS read that fetched the OpenAI key at launch is gone, and so is the entire `home.activation.kiroMcpModelsDoc` activation block (plus its `chatModelCatalogJson` feed) that generated a human-readable model reference by cross-checking the live `/v1/models` endpoint. OmniRoute now owns model selection, credentials, and cost, so the flake no longer tracks rates or model ids at all. Watch for: nothing blocking — the diff is tightly scoped and the generated config was inspected post-build (confirmed).

**Verdict**: APPROVED

## High-level view

The design moves the chat servers behind OmniRoute's three routing aliases rather than naming models. This collapses the former flagship/codex/fast catalog (each with input/cached/output rates and a `gpt-6-*` id) into reasoning/coding/fast tiers whose only knobs are a display name, a route, and a description. Cost and model-liveness tracking move out of the flake entirely, which is why the whole reference-doc generator is deleted rather than adapted.

The server wiring loses its SOPS dependency: `AI_CHAT_KEY` is now the literal `omniroute-local` passed via env, the launch command drops `export AI_CHAT_KEY=$(cat /run/secrets/openai_api_key)`, and the base URL moves from `api.openai.com` to the loopback OmniRoute port. Credentials never enter the Nix store and never need to — OmniRoute holds them.

The deletion is clean. The `kiroMcpConfig` jq-merge activation block that owns `mcp.json` is untouched except for one added `rm -f "$HOME/.kiro/mcp-models.md"` line that garbage-collects the now-orphaned doc. All 28 other MCP servers (local-model, filesystem, total-pc-control, dalle-mcp's legitimate OpenAI key read, etc.) are byte-for-byte unchanged.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking concerns. The change matches the specification exactly.

</details>

<details>
<summary>Details</summary>

### Catalog reshaped from priced model ids to OmniRoute routes

The former catalog keyed three tiers by OpenAI model id with full pricing metadata (`inputRate`/`cachedInputRate`/`outputRate`) and `gpt-6-*` names. The new catalog carries `serverName`, `displayName`, `route`, and `description` only. The three routes — `auto/best-reasoning`, `auto/best-coding`, `auto/fast` — are OmniRoute selectors, not model ids, so the mapping from intent (reasoning/coding/fast) to concrete model is deferred to OmniRoute at request time. Dropping the rate fields is correct given OmniRoute owns cost; there is no residual pricing data to drift. The generation mechanism (`mkChatServer` + `listToAttrs (map ... (attrValues ...))`) is preserved, and the result is still merged via `// chatServers`, so the three servers appear in `mcpServers` exactly as before, just repointed.

### SOPS read removed from the launch command

Previously each chat server ran `bash -c "export AI_CHAT_KEY=$(cat /run/secrets/openai_api_key); exec npx -y @pyroprompts/any-chat-completions-mcp"`. The new args are `[ "-c" "exec ${npx} -y @pyroprompts/any-chat-completions-mcp" ]` with `AI_CHAT_KEY = "omniroute-local"` moved into the static `env` block. This is the right security posture for a local trust boundary: the placeholder is non-secret by design (OmniRoute on loopback does not authenticate against this value), so hardcoding it in the store carries no credential-exposure risk, and the real OpenAI key no longer needs to flow through these servers at all. The generated config was grepped post-build: zero `/run/secrets` references remain in any `chat-*` server's args (confirmed). The one surviving `openai_api_key` read in the file belongs to `dalle-mcp`, which is unrelated to this change and correctly left intact (confirmed).

### Reference-doc activation block fully removed

The `home.activation.kiroMcpModelsDoc` block — which fetched `https://api.openai.com/v1/models`, cross-checked each catalog model id, and wrote a Markdown table of models/statuses/rates to `$HOME/.kiro/mcp-models.md` — is deleted in its entirety, along with the `chatModelCatalogJson = toJSON (attrValues chatModelCatalog)` binding that fed it. This is consistent: with routes instead of model ids and no rate data, there is nothing left to document or cross-check, and OmniRoute is the source of truth for which model a route resolves to. The orphaned output file is cleaned up by a single `rm -f "$HOME/.kiro/mcp-models.md"` added to the surviving `kiroMcpConfig` block, so stale docs from a prior activation do not linger. Source grep confirms no residue of `kiroMcpModelsDoc`, `chatModelCatalogJson`, `api.openai.com/v1/models`, `gpt-6`, or any rate field remains (confirmed).

### Merge block and all other servers untouched

The `kiroMcpConfig` jq-merge activation — the one that owns `mcp.json`, takes flake wiring as the base, and overlays user runtime flags (`disabled`/`autoApprove`/`disabledTools`) — is unchanged except for the added cleanup line, which is exactly the allowed modification. The verification evidence lists all 31 generated server names including `total-pc-control` and `local-model`, with the three chat servers now named `chat-reasoning`/`chat-coding`/`chat-fast` and no `chat-flagship`/`chat-codex` remaining (confirmed via the diff and the recorded `jq keys` output).

### Verification evidence

The coder recorded a parse check (`nix-instantiate --parse` → PARSE OK), a clean full darwin system build (`nix build .#darwinConfigurations.stabulous.system`, EXIT=0), post-build inspection of the generated `kiro-mcp.json` confirming the three routes/names/env and zero `/run/secrets` in chat args, and targeted source greps confirming no `gpt-6`/rate/doc residue. The evidence is specific, reproducible, and matches the diff I read line-for-line; no re-run was warranted.

</details>

<details>
<summary>File map</summary>

- `modules/home/kiro-local-model-mcp.nix` — `chatModelCatalog` reshaped from priced `gpt-6-*` model ids to three OmniRoute routes; `mkChatServer` repointed at `http://127.0.0.1:20128/v1` with static `AI_CHAT_KEY=omniroute-local` and no SOPS read; `chatModelCatalogJson` binding and the entire `home.activation.kiroMcpModelsDoc` block removed; one `rm -f` cleanup line added to the preserved `kiroMcpConfig` merge block.

Full diff: `git -C /Users/celes/sources/m5max-darwin-flake diff HEAD~1 -- modules/home/kiro-local-model-mcp.nix`

</details>
