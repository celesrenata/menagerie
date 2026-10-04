# Implementation Plan: Catalog-driven chat MCP servers + upstream model-sync reference doc

Single-file focused change to `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`, plus a reference doc generated at Home Manager activation to `$HOME/.kiro/mcp-models.md`. Does not decompose into separable features; the implement-and-review loop implements it directly.

## Grounding facts (verified by reading the repo)

- Target file: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`. It is imported by `home/celes.nix:9` into `darwinConfigurations.stabulous` (flake.nix: `hostname = "stabulous"`, `system = "aarch64-darwin"`).
- The file has `npx` and `uvx` let-bindings at the top, builds `mcpConfig = builtins.toJSON { mcpServers = { ... }; }`, writes `mcpConfigFile = pkgs.writeText "kiro-mcp.json" mcpConfig`, and merges it into `$HOME/.kiro/settings/mcp.json` in `home.activation.kiroMcpConfig` (a jq `-s` merge, keyed off `lib.hm.dag.entryAfter [ "writeBoundary" ]`). **This jq-merge logic must NOT be changed** — the three new chat servers simply flow through it.
- Current chat servers to REPLACE (two of them): `chat-gpt52` (AI_CHAT_NAME "GPT-5.2", model gpt-5.2) and `chat-codex` (AI_CHAT_NAME "GPT-5.2-Codex", model gpt-5.2-codex). All other servers (local-model, filesystem, sequential-thinking, context7, nixos, git, fetch, memory, postman, lsp-mcp-nix, browser-tools-mcp, playwright-mcp, aws-documentation, magic-mcp, markdownify-mcp, obsidian-mcp, ollama-mcp, webresearch-mcp, aws-iac-mcp, aws-diagram-mcp, sleep-mcp, iterm-mcp, total-pc-control, dalle-mcp, kubernetes-mcp, chart-mcp, wolframalpha-mcp, comfyui-mcp) stay EXACTLY as-is.
- Chat server shape (bash wrapper reading SOPS key): `command = "${pkgs.bash}/bin/bash"; args = [ "-c" "export AI_CHAT_KEY=$(cat /run/secrets/openai_api_key); exec ${npx} -y @pyroprompts/any-chat-completions-mcp" ]; env = { AI_CHAT_NAME = <displayName>; AI_CHAT_MODEL = <model>; AI_CHAT_BASE_URL = "https://api.openai.com/v1"; AI_CHAT_TIMEOUT = "300000"; };`
- The any-chat MCP exposes one tool per server named `chat-with-<slug(AI_CHAT_NAME)>`. Slug = lowercase, every run of non-alphanumeric chars → single dash. So:
    - "GPT-6-Astra" → `gpt-6-astra` → tool `chat-with-gpt-6-astra`
    - "GPT-6.1-Sol" → `gpt-6-1-sol` → tool `chat-with-gpt-6-1-sol`
    - "GPT-6-Luna" → `gpt-6-luna` → tool `chat-with-gpt-6-luna`
- Skip-guard reference style (SOPS secret may be unreadable before SOPS activates): see `home.activation.zooOmniRouteImport` in `/Users/celes/sources/m5max-darwin-flake/modules/home/omniroute-editors.nix` — uses `if [[ -r "$secret" ]]; then ... else echo "...: not readable; skipping (SOPS not yet activated)." >&2 fi`. Mirror that style.
- `pkgs.jq`, `pkgs.bash`, `pkgs.coreutils` are already used in the file/sibling modules. `pkgs.curl` is NOT yet referenced; use `${pkgs.curl}/bin/curl` as an activation-time absolute path (no `home.packages` change needed). No new flake inputs.
- The README's `.#m5max` rebuild example is stale; the real attribute is `.#stabulous` (= `darwinConfigurations.stabulous`). Use that in verification.

---

## Plan

- [ ]   1. Add the `chatModelCatalog` attrset to the `let` block.
       In `kiro-local-model-mcp.nix`, after the `uvx` let-binding and before `mcpConfig = ...`, add a multi-line attrset with exactly three tiers. Each tier value has fields `serverName`, `displayName`, `model`, `description`, `inputRate`, `cachedInputRate`, `outputRate`:
        - `flagship = { serverName = "chat-flagship"; displayName = "GPT-6-Astra"; model = "gpt-6-astra"; description = "Flagship, hardest reasoning / architecture / last-resort escalation."; inputRate = "$10.00"; cachedInputRate = "$1.00"; outputRate = "$50.00"; };`
        - `codex = { serverName = "chat-codex"; displayName = "GPT-6.1-Sol"; model = "gpt-6.1-sol"; description = "Default workhorse: coding, implementation, debugging, hard problems. Near-Astra quality at ~1/5 the price."; inputRate = "$2.00"; cachedInputRate = "$0.10"; outputRate = "$10.00"; };`
        - `fast = { serverName = "chat-fast"; displayName = "GPT-6-Luna"; model = "gpt-6-luna"; description = "Cheap/fast tier: quick second opinions, high-volume, simple tasks."; inputRate = "$0.10"; cachedInputRate = "$0.01"; outputRate = "$0.50"; };`
          Files: `/Users/celes/sources/m5max-darwin-flake/modules/home/kiro-local-model-mcp.nix`
          Verify: `nix eval ~/sources/m5max-darwin-flake#darwinConfigurations.stabulous.config.system.build.toplevel.drvPath` — evaluation succeeds (no Nix syntax/type error). (Covered more fully by step 6; this step just must not break evaluation.)

- [ ]   2. Add a `mkChatServer` helper and a generated `chatServers` attrset in the `let` block.
       After `chatModelCatalog`, add a function that turns one catalog tier into an mcpServers `{ name; value; }` pair, then build the full attrset by mapping over the catalog's values:
        ```
        mkChatServer = t: {
          name = t.serverName;
          value = {
            command = "${pkgs.bash}/bin/bash";
            args = [ "-c" "export AI_CHAT_KEY=$(cat /run/secrets/openai_api_key); exec ${npx} -y @pyroprompts/any-chat-completions-mcp" ];
            env = {
              AI_CHAT_NAME = t.displayName;
              AI_CHAT_MODEL = t.model;
              AI_CHAT_BASE_URL = "https://api.openai.com/v1";
              AI_CHAT_TIMEOUT = "300000";
            };
          };
        };
        chatServers = builtins.listToAttrs (map mkChatServer (builtins.attrValues chatModelCatalog));
        ```
        Do NOT hand-write three near-identical server blocks.
        Files: same file.
        Verify: part of step 6 full build; evaluation must still succeed.

- [ ]   3. Remove the two hardcoded chat servers and merge `chatServers` into `mcpServers`.
       In the `mcpServers = { ... }` attrset inside `mcpConfig`, delete the `chat-gpt52 = { ... };` and `chat-codex = { ... };` lines. Merge the generated servers into the set using the `//` operator so the three catalog servers (`chat-flagship`, `chat-codex`, `chat-fast`) are added. Simplest form: change `mcpServers = { <all other servers> };` to `mcpServers = { <all other servers> } // chatServers;` (keep every other server untouched). Note `chat-codex` reappears via the catalog (model now `gpt-6.1-sol`), which is intended.
       Files: same file.
       Verify: `nix eval --json ~/sources/m5max-darwin-flake#darwinConfigurations.stabulous.config.home-manager... ` is awkward; instead verify via step 6 and step 7 (inspect the rendered JSON). Expected: `mcpServers` has exactly the three chat servers `chat-flagship`, `chat-codex`, `chat-fast` and no `chat-gpt52`, and all 27 non-chat servers remain.

- [ ]   4. Add the `home.activation.kiroMcpModelsDoc` activation block (model-sync + reference doc).
       Add a NEW activation entry (sibling to `kiroMcpConfig`, do not modify `kiroMcpConfig`) ordered with `lib.hm.dag.entryAfter [ "writeBoundary" ]`. Inject the catalog as JSON from Nix via `builtins.toJSON (builtins.attrValues chatModelCatalog)` into the script, and parse it with `${pkgs.jq}/bin/jq` so the doc stays in sync with the catalog. Structure:
        1. **Skip guard** (mirror `zooOmniRouteImport` style): read key from `/run/secrets/openai_api_key` only `if [[ -r "$secret" ]]`; if not readable, set a flag so the doc is written from catalog data alone with an "upstream check unavailable" note (do NOT abort/skip entirely — the doc must still be produced; print a skip notice to stderr like the reference). Strip CR/LF from the key with `${pkgs.coreutils}/bin/tr -d '\r\n'`.
        2. **Curl call** (resilient): `models_json="$(${pkgs.curl}/bin/curl -s -H "Authorization: Bearer $key" https://api.openai.com/v1/models || true)"`. Never let a curl failure fail activation. Validate it is usable: if empty, not valid JSON (`echo "$models_json" | ${pkgs.jq}/bin/jq -e . >/dev/null 2>&1` fails), or contains an `.error` object, treat upstream as unavailable (set the same fallback flag + note).
        3. **Slug derivation in jq** so the tool name matches reality: `slug = (displayName | ascii_downcase | gsub("[^a-z0-9]+"; "-"))`. Use this to compute each tool name `"chat-with-" + slug`. (Edge: if a slug could start/end with a dash it still matches the MCP's behavior; the three given names do not, so no trimming needed — but a trailing/leading dash trim via `gsub("^-+|-+$"; "")` is a safe optional addition.)
        4. **Cross-check** each catalog `model` id against the live response using jq: build a lookup from `models_json.data[]` keyed by `.id`. For each catalog model mark status:
            - `live` if the id is present and `.shutdown_date` is null/absent,
            - `RETIRING` with the date if the matching entry has a non-null `.shutdown_date`,
            - `MISSING` if the id is not found in the response.
              When upstream is unavailable, mark every model `upstream check unavailable`.
        5. **Doc generation**: write `$HOME/.kiro/mcp-models.md` (`mkdir -p "$HOME/.kiro"`, `chmod 644`). Include a header noting it is auto-generated on rebuild and the date (`${pkgs.coreutils}/bin/date`). For each tier list: serverName, MCP tool name (`chat-with-<slug>`), model id, status (live/MISSING/RETIRING+date, or "upstream check unavailable"), description, and the three rates (input / cached input / output). Prefer a Markdown table or a per-tier section. Build the body with jq from the injected catalog JSON joined to the status lookup, then write via a temp file + `mv` (atomic), e.g. `tmp="$(mktemp /tmp/kiro-mcp-models.XXXXXX)"; ... > "$tmp"; $DRY_RUN_CMD mv "$tmp" "$HOME/.kiro/mcp-models.md"; $DRY_RUN_CMD chmod 644 "$HOME/.kiro/mcp-models.md"`.
        6. **Resilience**: the whole block must never fail activation on curl error / error JSON / missing key — in all those cases degrade to the catalog-only doc with the "upstream check unavailable" note. Avoid `set -e` traps; guard each external call with `|| true` and jq `-e` validation.
           Files: same file.
           Verify: step 6 (build eval) + step 8 (runtime activation smoke test).

- [ ]   5. Keep formatting consistent with the file's existing style.
       One server per line in the `mcpServers` set is fine; the `chatModelCatalog`, `mkChatServer`, and the new activation script are multi-line. Do not reorder or reflow the untouched servers or the `kiroMcpConfig` block.
       Files: same file.
       Verify: `git -C ~/sources/m5max-darwin-flake diff --stat modules/home/kiro-local-model-mcp.nix` — only this one file changed; diff is confined to the catalog/let additions, the two removed chat servers, the `// chatServers` merge, and the new activation block.

- [ ]   6. Build-verify the whole darwin configuration evaluates and builds.
       Confirms the Nix is valid end to end (catalog, map, merge, activation script interpolation).
       Files: none (verification only).
       Verify: `nix build ~/sources/m5max-darwin-flake#darwinConfigurations.stabulous.system --no-link 2>&1 | tail -20` — build succeeds with no evaluation errors. (Equivalent: `nix build ~/sources/m5max-darwin-flake#.default --no-link`.) This is non-destructive (no `switch`, no activation run).

- [ ]   7. Inspect the rendered `kiro-mcp.json` to confirm the three catalog servers are present and correct.
       Render the generated `mcpConfigFile` from Nix and check the chat entries.
       Files: none (verification only).
       Verify: run
       `nix eval --raw ~/sources/m5max-darwin-flake#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.kiroMcpConfig.data 2>/dev/null | grep -c chat-` is fragile; instead build the writeText file: `cfg=$(nix build --no-link --print-out-paths ~/sources/m5max-darwin-flake#... )` is awkward. Simplest reliable check — evaluate the JSON directly:
       `nix eval --json ~/sources/m5max-darwin-flake#darwinConfigurations.stabulous.config.system.build.toplevel >/dev/null` to confirm eval, then confirm server set by inspecting the file after a dry activation in step 8. Expected after step 8: `jq -r '.mcpServers | keys[]' ~/.kiro/settings/mcp.json | grep '^chat-'` prints exactly `chat-codex`, `chat-fast`, `chat-flagship` and no `chat-gpt52`.

- [ ]   8. Runtime smoke test of the activation (optional but recommended; requires a rebuild/activation on the host).
       After a `darwin-rebuild switch --flake ~/sources/m5max-darwin-flake#stabulous` (or activation of the built generation), confirm the doc and merged config land. If SOPS is active and the key is readable, the doc shows live/MISSING/RETIRING statuses; otherwise it shows the "upstream check unavailable" note. This step is a host-side check and may be run by the user if the sandbox cannot switch.
       Files: none (verification only).
       Verify:
        - `test -f ~/.kiro/mcp-models.md && stat -f '%Lp' ~/.kiro/mcp-models.md` → file exists, mode `644`.
        - `grep -E 'chat-with-gpt-6-astra|chat-with-gpt-6-1-sol|chat-with-gpt-6-luna' ~/.kiro/mcp-models.md` → all three tool names present.
        - `grep -E '\$10\.00|\$2\.00|\$0\.10' ~/.kiro/mcp-models.md` → rates rendered.
        - `jq -e '.mcpServers | has("chat-flagship") and has("chat-codex") and has("chat-fast") and (has("chat-gpt52") | not)' ~/.kiro/settings/mcp.json` → `true`.
        - `jq -e '.mcpServers | has("total-pc-control") and has("local-model")' ~/.kiro/settings/mcp.json` → `true` (untouched servers preserved).
        - Negative-path resilience: temporarily simulate no key (e.g. point the guard at an unreadable path in a scratch copy, or run with the secret absent) and confirm activation still succeeds and the doc contains the "upstream check unavailable" note. Clean up any scratch files afterward.

## Notes / assumptions

- The task says "exactly these three tiers" and lists them; the catalog uses tier keys `flagship`/`codex`/`fast`. `builtins.attrValues` iterates in Nix's lexicographic key order (codex, fast, flagship) — order is irrelevant since servers are keyed by `serverName` and the doc lists all three.
- `chat-codex` is intentionally reused as a serverName in the new catalog (now mapped to `gpt-6.1-sol`), replacing the old `chat-codex` (gpt-5.2-codex). The old `chat-gpt52` is dropped entirely. The jq-merge in `kiroMcpConfig` will preserve any user `disabled`/`autoApprove`/`disabledTools` flags previously set on `chat-codex`, and will add `chat-flagship`/`chat-fast` fresh.
- `pkgs.curl` is used only as an activation-time absolute path (`${pkgs.curl}/bin/curl`); it does not need to be added to `home.packages`.
- Verification commands use `.#stabulous` (the real host attribute), not the stale `.#m5max` from the README. `nix build ... --no-link` is non-destructive; the `switch`/runtime checks in step 8 are host-side and may be deferred to the user if the environment cannot activate.
