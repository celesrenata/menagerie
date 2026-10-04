# Verification Evidence: ToolHive + searxng-enhanced on nix-darwin

Target repo: `/Users/celes/sources/m5max-darwin-flake` (host attr
`darwinConfigurations.stabulous`, `aarch64-darwin`).

All checks are NON-destructive. No `darwin-rebuild switch`, no `thv run`, no
container starts were performed.

Files created/changed in this task:

- `modules/darwin/toolhive.nix` (new)
- `flake.nix` (wired `./modules/darwin/toolhive.nix` into the darwin module list)
- `modules/home/kiro-local-model-mcp.nix` (added the `searxng-enhanced` URL server entry)

---

## 0. Pre-flight: `pkgs.toolhive` resolves for aarch64-darwin

Command:

```
nix eval --impure --expr 'let pkgs = import <nixpkgs> { system = "aarch64-darwin"; }; in { v = pkgs.toolhive.version or "none"; plat = pkgs.toolhive.meta.platforms or []; }'
```

Output (abridged):

```
{ plat = [ "aarch64-darwin" "x86_64-linux" ... ]; v = "0.43.0"; }
```

`toolhive` is `0.43.0` and `meta.platforms` includes `aarch64-darwin`.

---

## 1. `nix-instantiate --parse` on every new/changed .nix file -> OK

Command:

```
cd /Users/celes/sources/m5max-darwin-flake && for f in modules/darwin/toolhive.nix flake.nix modules/home/kiro-local-model-mcp.nix; do echo "=== $f ==="; nix-instantiate --parse "$f" >/dev/null 2>&1 && echo PARSE_OK || echo PARSE_FAIL; done
```

Output:

```
=== modules/darwin/toolhive.nix ===
PARSE_OK
=== flake.nix ===
PARSE_OK
=== modules/home/kiro-local-model-mcp.nix ===
PARSE_OK
```

---

## 2. Full darwin system builds clean (no switch)

Flakes only see git-tracked files; the new module was made visible with
`git add -N modules/darwin/toolhive.nix` (intent-to-add; does NOT stage content
for commit).

Command:

```
cd /Users/celes/sources/m5max-darwin-flake && nix build --no-link .#darwinConfigurations.stabulous.system
```

Output (abridged — the relevant derivations and the fetched toolhive package):

```
these 11 derivations will be built:
  ...
  /nix/store/8izh8vr5m2ggk487qnxmw3ckxsm7ys2k-toolhive-mcp-start.drv
  /nix/store/1m20y3qiwnrwvkbdixvid3kk0rj8by4g-com.celes.toolhive-mcp.plist.drv
  /nix/store/6r7ahwq3zw21nagjf9n6fp1gf1p2mf5z-kiro-mcp.json.drv
  ...
  /nix/store/c7nblh285y4xzx0plgx1j8qc3ap2jma3-darwin-system-26.11.4cff07d.drv
this path will be fetched (55.0 MiB download, 203.3 MiB unpacked):
  /nix/store/x71y8vjwdrd9zwl4lcaha7h8jg0qkm2g-toolhive-0.43.0
copying path '/nix/store/x71y8vjwdrd9zwl4lcaha7h8jg0qkm2g-toolhive-0.43.0' from 'https://cache.nixos.org'...
building '/nix/store/c7nblh285y4xzx0plgx1j8qc3ap2jma3-darwin-system-26.11.4cff07d.drv'...
```

Result path:

```
/nix/store/3pbh2wyndisl959sb3xfajr6fxg7c6bv-darwin-system-26.11.4cff07d
```

The clean build proves: `pkgs.toolhive` resolves and is in the closure, the
launchd agent + start script evaluate, the `mcpConfig` attrset has no
duplicate-key eval error, and the overlay evaluates.

### 2a. launchd agent evaluates with the expected Label

Command:

```
nix eval --json '.#darwinConfigurations.stabulous.config.launchd.user.agents."com.celes.toolhive-mcp".serviceConfig.Label'
```

Output:

```
"com.celes.toolhive-mcp"
```

### 2b. `thv` binary runs (`--help` only; no servers launched)

Command:

```
/nix/store/x71y8vjwdrd9zwl4lcaha7h8jg0qkm2g-toolhive-0.43.0/bin/thv --help | head
```

Output (abridged):

```
ToolHive (thv) is a lightweight, secure, and fast manager for MCP ... servers.
...
Available Commands:
  ...
  client      Manage MCP clients
```

---

## 3. jq-simulate the generated mcpConfig and the 4 editor merge outputs

The generated config store path (from the kiroMcpConfig activation `data`):

```
nix eval --raw '.#darwinConfigurations.stabulous.config.home-manager.users.celes.home.activation.kiroMcpConfig.data' | grep -o '/nix/store/[a-z0-9]*-kiro-mcp.json'
-> /nix/store/68389vsg7bbqwr7472av9qvgc7ca0cwa-kiro-mcp.json
```

### 3a. Generated config direct inspection

Command:

```
jq '.mcpServers["searxng-enhanced"]' /nix/store/68389vsg7bbqwr7472av9qvgc7ca0cwa-kiro-mcp.json
jq '.mcpServers | length' <gen>
jq '{chat_reasoning:..., chat_coding:..., chat_fast:..., total_pc:..., chat_codex:..., chat_gpt52:...}' <gen>
```

Output:

```
{
  "alwaysAllow": [ "search_web", "get_website", "get_current_datetime" ],
  "autoApprove": [ "search_web", "get_website", "get_current_datetime" ],
  "type": "streamable-http",
  "url": "http://localhost:19104/mcp"
}
server count: 32
{ "chat_reasoning": true, "chat_coding": true, "chat_fast": true,
  "total_pc": true, "chat_codex": false, "chat_gpt52": false }
```

Generated config has 32 servers (31 pre-existing + 1 searxng), the searxng entry
is url-style with both approval keys, all three OmniRoute chat servers and
total-pc-control are present, and neither retired name is present.

### 3b. Four-editor merge simulation (live files, output to /tmp only)

The simulation script `/tmp/mcp-merge-sim.sh` replicates the module's exact jq
merge program per editor (opaque-object merge, `$flake` as base, each editor's
`preservedKeys`, `dropUserOnly` for Roo/Cline, `delpaths` for
`retiredServerNames=["chat-codex","chat-gpt52"]`) against the LIVE config files,
writing merged results to `/tmp/mcp-sim-out/` — the live files are never touched.

Live file state before simulation (all real files, NOT symlinks -> merge branch):

```
/Users/celes/.kiro/settings/mcp.json                                           31 servers
.../zoocodeorganization.zoo-code/settings/mcp_settings.json                    31 servers
.../rooveterinaryinc.roo-cline/settings/mcp_settings.json                      31 servers
.../saoudrizwan.claude-dev/settings/cline_mcp_settings.json                    31 servers
```

Command:

```
bash /tmp/mcp-merge-sim.sh
```

Output:

```
=== kiro (dropUserOnly=false) ===
PASS (a) searxng url-style: url=http://localhost:19104/mcp type=streamable-http
PASS (b) approvals: autoApprove=[...] alwaysAllow=[...]
PASS (c) no retired servers
PASS (d) chat-reasoning/coding/fast + total-pc-control present
    counts: merged=32 flake=32 live=31 searxng_key_count=1
PASS (e) union count == live+1 (32), searxng once
=== zoo (dropUserOnly=false) ===
PASS (a) ... PASS (b) ... PASS (c) ... PASS (d) ...
    counts: merged=32 flake=32 live=31 searxng_key_count=1
PASS (e) union count == live+1 (32), searxng once
=== roo (dropUserOnly=true) ===
PASS (a) ... PASS (b) ... PASS (c) ... PASS (d) ...
    counts: merged=32 flake=32 live=31 searxng_key_count=1
PASS (e) dropUserOnly count == flake count (32), searxng once
=== cline (dropUserOnly=true) ===
PASS (a) ... PASS (b) ... PASS (c) ... PASS (d) ...
    counts: merged=32 flake=32 live=31 searxng_key_count=1
PASS (e) dropUserOnly count == flake count (32), searxng once
=== generated config direct checks ===
PASS generated searxng url-style

ALL PASS
```

Interpretation per assertion (all four editors + generated config):

- (a) `searxng-enhanced` present and url-style (`url=http://localhost:19104/mcp`,
  `type=streamable-http`).
- (b) carries both `autoApprove` and `alwaysAllow` equal to
  `["search_web","get_website","get_current_datetime"]`.
- (c) no `chat-codex`, no `chat-gpt52`.
- (d) `chat-reasoning`, `chat-coding`, `chat-fast`, `total-pc-control` all still present.
- (e) no duplicate servers: Kiro/Zoo (union) = live+1 = 32; Roo/Cline
  (dropUserOnly) = flake count = 32; `searxng-enhanced` appears exactly once in
  every merged output.

---

## Invariants confirmed NOT broken

- 4-editor unification (`mkMergeActivation` + the four `home.activation.*McpConfig`
  calls): unchanged; only a single server key was added to the shared `mcpConfig`.
- `total-pc-control` native/patched server: present in all four merges (assertion d).
- OmniRoute chat servers `chat-reasoning` / `chat-coding` / `chat-fast`: present
  in all four merges (assertion d).
- `retiredServerNames = ["chat-codex" "chat-gpt52"]` prune: unchanged; neither
  name appears anywhere (assertion c). Not reintroduced.
- No duplicate of a natively-provided server (context7 / sequential-thinking):
  searxng-enhanced has no native counterpart; attrset keys are unique (a duplicate
  would be a Nix eval error, which did not occur — the build in step 2 succeeded).

---

## Not run (per task constraints)

- No `darwin-rebuild switch`.
- No `thv run` / no container starts (only `thv --help`).
- Live editor config files were read for counts but never modified; all merge
  outputs went to `/tmp/mcp-sim-out/`.
