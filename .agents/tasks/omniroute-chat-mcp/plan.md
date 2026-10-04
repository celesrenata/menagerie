# Implementation Plan — Re-point chat MCP servers at OmniRoute; remove model-sync doc

Single-file change to `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`.
This repo is NOT the open workspace — it is `/Users/celes/sources/m5max-darwin-flake` (nix-darwin + home-manager; darwin host attribute `stabulous`). HEAD is `b887ebf`, the commit this change supersedes.

Design decisions (made here, grounded in the two files read):

- Keep the generated/mapped server approach (`chatModelCatalog` → `mkChatServer` → `listToAttrs (map ...)` → `// chatServers`), because the task requires preserving that structure and it keeps the three tiers in one source of truth.
- Follow `modules/home/omniroute-editors.nix` conventions exactly: base URL `http://127.0.0.1:20128/v1`, non-secret placeholder key `omniroute-local`. OmniRoute owns credentials/routing/cost, so no SOPS read and no OpenAI endpoint remain in the chat servers.
- Drop the rate fields and the entire `kiroMcpModelsDoc` activation plus its only consumer, the `chatModelCatalogJson` binding — all three become meaningless once OmniRoute auto-selects models. Add the `rm -f` cleanup of the stale doc to the existing `kiroMcpConfig` activation since it is a trivial, safe one-liner.
- Verify by pure Nix evaluation/build of the darwin system (`nix build .#darwinConfigurations.stabulous.system`), which exercises the module without running activation. This is the project's real build gate; activation side effects are not needed to prove the Nix is correct.

- [ ]   1. Rewrite the `chatModelCatalog` let-binding to carry OmniRoute routes instead of OpenAI model ids, dropping all rate fields.
       Replace the three tiers (`flagship`/`codex`/`fast` with `model` + `inputRate`/`cachedInputRate`/`outputRate`) with exactly:
       `reasoning = { serverName = "chat-reasoning"; displayName = "Reasoning"; route = "auto/best-reasoning"; description = "Hard reasoning, architecture, escalation."; };`
       `coding = { serverName = "chat-coding"; displayName = "Coding"; route = "auto/best-coding"; description = "Coding, implementation, debugging."; };`
       `fast = { serverName = "chat-fast"; displayName = "Fast"; route = "auto/fast"; description = "Quick second opinions, high-volume, simple tasks."; };`
       Update the catalog comment above it: remove the mention of rates and the `$HOME/.kiro/mcp-models.md` reference doc; describe it as the source for the three OmniRoute-routed chat servers.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
       Verify: deferred to step 5 (whole-file eval). File must still parse.

- [ ]   2. Rewrite `mkChatServer` to target OmniRoute with the placeholder key passed via env, not SOPS.
       New `value`:
        - `command = "${pkgs.bash}/bin/bash";`
        - `args = [ "-c" "exec ${npx} -y @pyroprompts/any-chat-completions-mcp" ];` (remove the `export AI_CHAT_KEY=$(cat /run/secrets/openai_api_key); ` prefix).
        - `env = { AI_CHAT_KEY = "omniroute-local"; AI_CHAT_NAME = t.displayName; AI_CHAT_MODEL = t.route; AI_CHAT_BASE_URL = "http://127.0.0.1:20128/v1"; AI_CHAT_TIMEOUT = "300000"; };`
          Update the `mkChatServer` comment: drop the "key read from SOPS at launch time" note; state the non-secret `omniroute-local` placeholder key is passed via env and OmniRoute owns routing/credentials.
          Keep `chatServers = builtins.listToAttrs (map mkChatServer (builtins.attrValues chatModelCatalog));` unchanged. Keep `// chatServers` in `mcpConfig` unchanged.
          Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
          Verify: deferred to step 5.

- [ ]   3. Delete the now-unused `chatModelCatalogJson` let-binding (and its comment).
       Remove the `chatModelCatalogJson = builtins.toJSON (builtins.attrValues chatModelCatalog);` line plus the 2-line comment above it. It is referenced only by the `kiroMcpModelsDoc` block removed in step 4; no other binding uses `.inputRate`/`.cachedInputRate`/`.outputRate`/`.model`, so nothing else breaks.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
       Verify: deferred to step 5. (Confirm no remaining reference: `grep -n "chatModelCatalogJson\|inputRate\|outputRate" modules/home/kiro-local-model-mcp.nix` returns nothing.)

- [ ]   4. Delete the entire `home.activation.kiroMcpModelsDoc` block and its leading comment.
       Remove the full attribute from the comment line "# Generate a human-readable reference doc..." through the closing `'';` of that activation. Leave the `kiroMcpConfig` activation above it fully intact. After removal, the module's attrset body should contain only `home.file."ai/mcp/..."`, `home.activation.kiroMcpConfig`, and the surrounding braces.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
       Verify: deferred to step 5. (Confirm removal: `grep -n "kiroMcpModelsDoc\|mcp-models.md\|v1/models" modules/home/kiro-local-model-mcp.nix` returns only the cleanup line added in step 5, if any.)

- [ ]   5. Add a safe cleanup of the stale doc to the existing `kiroMcpConfig` activation.
       Inside `home.activation.kiroMcpConfig`, after the `settings=...` line (before the first-deploy `if`), add one line: `$DRY_RUN_CMD rm -f "$HOME/.kiro/mcp-models.md"`. Do not otherwise modify the jq-merge block.
       Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
       Verify: whole-file evaluation (next step).

- [ ]   6. Verify the module evaluates and builds as part of the darwin system.
       Files: none (verification only).
       Verify: from `/Users/celes/sources/m5max-darwin-flake`, run `nix build .#darwinConfigurations.stabulous.system --no-link` and confirm it completes without evaluation errors. Then confirm the three OmniRoute chat servers are present and correct in the generated config by evaluating the attr: `nix eval --json '.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation' 2>/dev/null` is not reliable across setups — instead assert on the built store output. Minimal expectation: the build succeeds (proves Nix is well-formed, catalog maps cleanly, no dangling `chatModelCatalogJson`/`kiroMcpModelsDoc` references, `// chatServers` still type-checks). If `nix build` of the full system is too slow or blocked, fall back to `nix eval --raw '.#darwinConfigurations.stabulous.system.drvPath'` to force module evaluation; a successful eval with no error proves the module is sound.

- [ ]   7. Confirm all non-chat servers are byte-for-byte preserved and no OpenAI/SOPS/rate residue remains in the chat path.
       Files: none (verification only).
       Verify: `git -C /Users/celes/sources/m5max-darwin-flake diff -- modules/home/kiro-local-model-mcp.nix` — the diff must touch ONLY the `chatModelCatalog` block, the `mkChatServer` helper, the removed `chatModelCatalogJson` binding, the removed `kiroMcpModelsDoc` activation, and the single `rm -f` cleanup line. The `mcpServers` entries for local-model, filesystem, sequential-thinking, context7, nixos, git, fetch, memory, postman, lsp-mcp-nix, browser-tools-mcp, playwright-mcp, aws-documentation, magic-mcp, markdownify-mcp, obsidian-mcp, ollama-mcp, webresearch-mcp, aws-iac-mcp, aws-diagram-mcp, sleep-mcp, iterm-mcp, total-pc-control, dalle-mcp, kubernetes-mcp, chart-mcp, wolframalpha-mcp, comfyui-mcp must be unchanged. Also confirm `grep -n "api.openai.com\|openai_api_key\|gpt-6" modules/home/kiro-local-model-mcp.nix` returns only the unrelated `dalle-mcp` line (which legitimately uses `openai_api_key` and `api.openai.com` is not referenced there) — i.e. the chat servers no longer reference OpenAI; the only remaining `openai_api_key` is dalle-mcp's `export OPENAI_API_KEY=$(cat /run/secrets/openai_api_key)`.

Notes / assumptions:

- `AI_CHAT_KEY` is set to the placeholder `omniroute-local` (OmniRoute ignores/accepts it); the SOPS read is removed from the chat bash wrapper only. `dalle-mcp`, `postman`, and `magic-mcp` keep their own SOPS reads untouched.
- The any-chat MCP exposes one tool per server named `chat-with-<slug>` where slug lowercases `AI_CHAT_NAME` and collapses non-alphanumeric runs to a single dash: `chat-with-reasoning`, `chat-with-coding`, `chat-with-fast`.
- Changesets/CHANGELOG rules from the workspace AGENTS.md do not apply — that guidance targets a different repo; this change is in the darwin flake. No changeset/CHANGELOG files are touched.
