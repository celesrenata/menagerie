# Verification — Uzu managed backend (static only, no rebuild, no live ports)

Worktree: `/Users/celes/sources/m5max-darwin-flake/.worktrees/uzu-managed-backend`
Branch: `uzu-managed-backend`. The user runs `darwin-rebuild` separately.

## Commands run and results

1. **Parse the new nix module**
   `nix-instantiate --parse modules/darwin/uzu-server.nix`
   → exit 0, parsed with no syntax error. **PASS**

2. **Flake eval of the darwin launchd agent list** (confirms the new module
   imports cleanly into the host config with no eval errors). Files were
   `git add`ed first because flakes only see tracked files.
   `nix eval --impure .#darwinConfigurations.stabulous.config.launchd.user.agents --apply builtins.attrNames`
   → evaluated with no errors; output list includes `"com.celes.uzu-server"`
   alongside the existing agents (mlx-qwen-server, glm53-dwarfstar-server, etc.).
   **PASS**
   (`nix flake check` was not run as the primary gate; the targeted agent-list
   eval is the lower-cost, direct confirmation the module imports and the agent
   is defined. The eval exercises the full module merge for the darwin config.)

   Spot check: `nix eval --impure --raw '...agents."com.celes.uzu-server".serviceConfig.Label'`
   → `com.celes.uzu-server`. **PASS**

3. **models.json valid JSON with the new backend**
   `python3 -m json.tool packages/local-model-proxy/models.json`
   → exit 0, valid JSON.
   `grep -c "qwen38-uzu" packages/local-model-proxy/models.json` → 1. **PASS**

4. **OmniRoute template valid JSON after the ladder prose edit**
   `python3 -m json.tool modules/home/zoo/omniroute-zoo-profiles.template.json`
   → exit 0, still valid JSON. **PASS**

5. **custom_modes.yaml still valid YAML after the ladder prose edit**
   PyYAML is not available in the environment (`ModuleNotFoundError: yaml`), so
   validated with `yq-go` instead:
   `nix shell nixpkgs#yq-go -c yq eval '.customModes[0].slug' modules/home/zoo/custom_modes.yaml`
   → `spec-orchestrator` (file parses as valid YAML).
   `yq eval '.customModes[0].customInstructions' ... | grep "M5 Max (Uzu Qwen3.8-27B-S"`
   → found (the edited worker-ladder sentence is present in the parsed value).
   **PASS**

6. **GLM mastermind clause left intact in both zoo files**
   `grep -c "lightweight mastermind"` → 1 in template.json, 1 in custom_modes.yaml.
   `grep -c "tier 1 is GLM only"` → 1 in template.json, 1 in custom_modes.yaml.
   The mastermind sentence was not touched; only the worker-ladder sentence
   ("...on the 5090, 4070 Ti Super, or M5 Max when eligible") was edited to name
   the Uzu lane. **PASS**

7. **docs/local-inference.md contains the key facts**
   `python3 -c "... 'qwen3.8-27b-uzu' in t and '8073' in t and 'enable_thinking' in t"`
   → `docs ok`. **PASS**

8. **model_proxy.py passthrough confirmation (no edit needed)**
   `grep -n "data=body_bytes" model_proxy.py` → all four POST handlers forward
   the raw request body verbatim (`body_bytes = await request.read()` →
   `data=body_bytes`), parsing JSON only for `model`/`stream` routing. A
   top-level `enable_thinking` field therefore reaches Uzu unmodified with no
   proxy change. **CONFIRMED — no change required.**

## Scope notes (deliberate, per plan)

- `packages/local-model-proxy/models.json.new` left untouched: it is a stale,
  non-mirror set (`ds4`/`evocua`), not kept in sync with the live `models.json`
  (`qwen38-mlx`/`glm53`/`deepseek-v41-uncensored`/`qwen35-reader-262k`).
- The authoritative numeric OmniRoute lane ladder (1=5090, 2=4070 Ti Super,
  3=M5 Max Uzu, 4=second-5090, 5+=free/low-cost; GLM removed from the worker
  ladder) lives server-side in OmniRoute, not in this flake worktree
  (`scripts/configure-omniroute.sh` does not exist here). This change updated the
  in-worktree worker-ladder prose to name the Uzu lane and left GLM's mastermind
  clause intact; the numeric lane reassignment must be applied in the OmniRoute
  fabric as a separate change.
