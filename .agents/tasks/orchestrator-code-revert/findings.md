# Orchestrator reverts to OmniRoute-Hybrid-Code — Root Cause & Fix

## Summary answer (read this first)

The revert is **not** caused by a restored-task sticky profile, by `modeApiConfigs`
being dropped on import, or by any extension code writing the autoImport file. It is a
**data defect in the Nix flake template** combined with the **documented import contract**:

1. The committed template
   `menagerie-flake/modules/menagerie/zoo/omniroute-zoo-profiles.template.json` has
   `providerProfiles.currentApiConfigName = "OmniRoute-Hybrid-Code"`. The per-mode map in
   the same file is correct (`modeApiConfigs.orchestrator = "omni-hybrid-planner"`), but
   the **top-level active-profile field is Code**.

2. The Home-Manager activation `home.activation.zooOmniRouteImport` in
   `menagerie-flake/modules/menagerie/editors.nix` (lines ~286–304) **overwrites**
   `$HOME/.config/zoo-code/omniroute-zoo-profiles.json` from that template on **every**
   `darwin-rebuild`/activation (it only patches `openAiApiKey`; the rest, including
   `currentApiConfigName`, is copied verbatim). This is the "launch-timestamp revert to
   Code" seen on the live Mac — it is a Nix activation write, not an extension write.
   This matches the user's conclusion ("it's in nix, if it keeps swapping back").

3. On the next VS Code launch, `autoImportSettings` → `importSettingsFromPath` reads that
   file and **honors the file's top-level `currentApiConfigName` (Code)** as the active
   profile, writing Code into the encrypted secret `roo_cline_config_api_config` and into
   `contextProxy`. The `modeApiConfigs.orchestrator → planner` mapping is imported and
   stored correctly, but **it is never consulted on launch** because nothing calls
   `handleModeSwitch("orchestrator")` during activation — so it cannot override the
   active-config field. The UI pill reads `currentApiConfigName` from `getState()` and
   shows **OmniRoute-Hybrid-Code**.

**The single minimal fix:** change `providerProfiles.currentApiConfigName` from
`"OmniRoute-Hybrid-Code"` to `"OmniRoute-Hybrid-Planner"` in the flake template
`menagerie-flake/modules/menagerie/zoo/omniroute-zoo-profiles.template.json` (and the
mirror `m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json`), then
re-run `darwin-rebuild`. No extension source change is required or appropriate.

> Scope note: the authoritative fix lives in the Nix flake repos, which are **outside**
> this repo (`/Users/celes/sources/menagerie-flake`, `/Users/celes/sources/m5max-darwin-flake`).
> Per the read-only constraint, nothing was modified. An optional defense-in-depth
> extension hardening is described at the end, but it is not the primary fix.

---

## Live-state evidence (observed on the Mac, read-only)

- VS Code setting (`~/Library/Application Support/Code/User/settings.json:248`):
  `"zoo-code.autoImportSettingsPath": "/Users/celes/.config/zoo-code/omniroute-zoo-profiles.json"`.
- `/Users/celes/.config/zoo-code/omniroute-zoo-profiles.json` is a **regular file**
  (not a symlink), `-rw-------`, mtime `Oct 7 15:30`. Current contents:
  - `providerProfiles.currentApiConfigName = "OmniRoute-Hybrid-Code"`
  - `providerProfiles.modeApiConfigs.orchestrator = "omni-hybrid-planner"`
  - i.e. exactly the contradiction described: the mode map says planner, the active-config
    field says Code.
- The flake's *other* path `~/.config/Code/User/omniroute-zoo-profiles.json` **does not
  exist** on this macOS install (VS Code uses `~/Library/Application Support/Code/User`),
  confirming that path is a red herring for this bug.

## The writer of the autoImport file (answers brief question 4)

No file under `src/` writes `.config/zoo-code/omniroute-zoo-profiles.json` or uses
`autoImportSettingsPath` as a write target. Exhaustive searches:

- `grep` for `omniroute-zoo-profiles` / `.config/zoo-code` across `src/` → only locale
  description strings and task-doc prose; **zero code writers**.
- `exportSettings` (`src/core/config/importExport.ts`) is the only settings writer, and it
  is invoked **only** from a user-triggered Save dialog
  (`src/core/webview/webviewMessageHandler.ts`, `exportSettings` case) and writes to the
  user-chosen URI, never to the autoImport path. There is no `setInterval`/periodic
  export, no `fs.watch` re-export, and no auto-export of the live secret to that path.

The actual writer is the Nix activation script:

- `menagerie-flake/modules/menagerie/editors.nix` ~L286–304:
  ```nix
  home.activation.zooOmniRouteImport =
    lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      template=${./zoo/omniroute-zoo-profiles.template.json}
      ...
      dest="$HOME/.config/zoo-code/omniroute-zoo-profiles.json"
      ...
      jq --arg key "$key" '.providerProfiles.apiConfigs |= with_entries(
         .value.openAiApiKey = (if .value.openAiApiKey == "__OMNIROUTE_API_KEY__" then $key else .value.openAiApiKey end)
       )' "$template" > "$tmp"
      mv "$tmp" "$dest"
      chmod 600 "$dest"
    '';
  ```
  It copies the template verbatim (only substituting the API key) to the autoImport path
  on every activation. Both committed templates currently contain
  `currentApiConfigName = "OmniRoute-Hybrid-Code"` and `modeApiConfigs.orchestrator =
  "omni-hybrid-planner"` — exactly matching the live file. So "manual edit reverted at a
  launch timestamp" = the next `darwin-rebuild`/activation re-materialized the template.

## Ordered activation timeline (answers brief question 1)

VS Code extension `activate()` in `src/extension.ts`:

1. `migrateSettings(context, outputChannel)` — `src/extension.ts:137`. (Unrelated to
   `currentApiConfigName`; it migrates legacy global settings. Not a writer of the
   orchestrator config.)
2. `const contextProxy = await ContextProxy.getInstance(context)` — `src/extension.ts:181`.
3. `const provider = new ClineProvider(...)` — `src/extension.ts:224`. The
   `ProviderSettingsManager` constructor fires `this.initialize().catch(...)`
   **without await** (`src/core/config/ProviderSettingsManager.ts:84`). `initialize()`
   serializes via `lock()`; the `modeApiConfigs` seeding at
   `ProviderSettingsManager.ts:117–124` runs **only `if (!providerProfiles.modeApiConfigs)`**
   — the imported/stored profiles already have `modeApiConfigs`, so this seeding does
   **not** fire and is **not** the culprit (excludes brief candidate 2c).
4. `await autoImportSettings(outputChannel, { providerSettingsManager, contextProxy, ... })`
   — `src/extension.ts:271`. This runs on **every** activation (no "already-imported"
   guard in `src/utils/autoImportSettings.ts`) and performs the full import described below.
5. `registerWebviewViewProvider(...)` — later. When the view resolves,
   `resolveWebviewView` (`ClineProvider.ts:1251`) calls `removeClineFromStack()` for a
   fresh session — i.e. **no task is auto-reopened on launch** (see question 3).
6. Webview sends `webviewDidLaunch` (`webviewMessageHandler.ts:590`): the handler calls
   `provider.postStateToWebview()` and reconciles the config list, but **never calls
   `handleModeSwitch`**. The pill's `currentApiConfigName` therefore comes straight from
   `getState()`/the secret — whatever import wrote in step 4.

There is **no** auto-export/writeback of the live secret to the autoImport file anywhere
in the timeline.

## What import actually persists (answers brief question 2)

`importSettingsFromPath` — `src/core/config/importExport.ts:131`:

- It builds `validApiConfigs` keyed by config name, then selects the active config name
  (`importExport.ts:187–205`):
  ```ts
  let currentApiConfigName = rawProviderProfiles.currentApiConfigName
  ...
  if (!validApiConfigs[currentApiConfigName]) { /* fall back */ }
  ```
  Because `OmniRoute-Hybrid-Code` **is** a valid profile in the file, the branch is not
  taken and `currentApiConfigName` stays **Code** (the file's top-level value).
- It merges `modeApiConfigs` correctly (`importExport.ts:214–217`):
  ```ts
  modeApiConfigs: { ...previousProviderProfiles.modeApiConfigs, ...rawProviderProfiles.modeApiConfigs }
  ```
  so `orchestrator → omni-hybrid-planner` **is** imported and stored. (Excludes brief
  candidate 2a's "import drops/overrides modeApiConfigs".)
- It then **persists Code as the active profile**:
  ```ts
  await providerSettingsManager.import(providerProfiles)          // importExport.ts:231
  await contextProxy.setValue("currentApiConfigName", currentProviderName)  // :238
  await contextProxy.setProviderSettings(currentProvider)        // :243
  ```
  `ProviderSettingsManager.import()` is a whole-object replace:
  `return await this.lock(() => this.store(providerProfiles))`
  (`ProviderSettingsManager.ts` `import()`), and `store()` writes the encrypted secret
  `roo_cline_config_<SCOPE>api_config`. So after import the secret's
  `currentApiConfigName = OmniRoute-Hybrid-Code` and the mirrored plaintext globalStorage
  value is Code too.

**Who wrote Code back after import? Nobody re-writes it — import itself sets Code,**
because it faithfully honors the file's top-level `currentApiConfigName`. The planner
mode-mapping is stored but inert at launch, since nothing triggers an orchestrator
mode-switch that would consult `modeApiConfigs.orchestrator` and call
`activateProviderProfile` for the planner id.

## Restored-task path (answers brief question 3)

Excluded as the launch-time cause. `resolveWebviewView` (`ClineProvider.ts:1297–1301`)
calls `removeClineFromStack()` when starting a fresh session, so **no previous task is
auto-reopened on launch**. The sticky-profile restore in
`createTaskWithHistoryItemUnlocked` (`ClineProvider.ts:1384`), which would call
`activateProviderProfile({ name: historyItem.apiConfigName })`
(`ClineProvider.ts:1472–1479`) and thereby write that profile into the secret via
`activateProviderProfileUnlocked` → `providerSettingsManager.activateProfile`
(`ClineProvider.ts:2178`, `ProviderSettingsManager.ts activateProfile`), only runs when
the user **manually reopens** a task. It can produce a Code override *after* the user
reopens a Code-tagged orchestrator task, but it is **not** what makes the pill show Code
on every fresh launch. The fresh-launch Code value comes entirely from autoImport honoring
the file's `currentApiConfigName`.

(If, after the primary fix, you still see Code when reopening an *old* orchestrator task
whose `historyItem.apiConfigName` was saved as Code, that is this sticky-profile path and
is expected: the task pins its own saved profile. New orchestrator tasks created after the
fix will inherit planner.)

## The exact step that sets Code and why it wins

`importExport.ts:238` `await contextProxy.setValue("currentApiConfigName", currentProviderName)`
with `currentProviderName === "OmniRoute-Hybrid-Code"`, plus the matching secret write in
`providerSettingsManager.import()` at `importExport.ts:231`. It wins over the planner
mode-mapping because the launch path renders the **active** `currentApiConfigName`
directly and never performs an orchestrator mode-switch that would resolve
`modeApiConfigs.orchestrator`.

## The single precise minimal fix

Primary (durable, correct layer — Nix, matching the user's directive "get it right in nix"):

- File: `menagerie-flake/modules/menagerie/zoo/omniroute-zoo-profiles.template.json`
- Change class: **data value edit**, one field.
- Change: `providerProfiles.currentApiConfigName`
  `"OmniRoute-Hybrid-Code"` → `"OmniRoute-Hybrid-Planner"`.
- Apply the identical one-line change to the mirror template
  `m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json`.
- Then `darwin-rebuild switch` (re-materializes the file) and relaunch VS Code so
  autoImport imports planner as the active profile.

Why this is minimal and safe:
- `OmniRoute-Hybrid-Planner` already exists in `apiConfigs` (id `omni-hybrid-planner`,
  model `hybrid/planner`), so the import's validity check passes and no fallback fires.
- `modeApiConfigs` is already correct for every mode; this touches only the single
  top-level active-profile default. Other modes still resolve their own saved profiles on
  mode-switch; sticky task profiles for non-orchestrator work are unaffected; import is
  unaffected.

Optional defense-in-depth (NOT required; needs a product decision, so left unimplemented):
If you want the *mode mapping* to be the source of truth so the top-level
`currentApiConfigName` can never again contradict it, the clean hook is to invoke an
orchestrator mode-restore after autoImport — e.g. after `autoImportSettings` in
`src/extension.ts:271`, resolve the stored `mode` and call
`provider.handleModeSwitch(mode)` so `modeApiConfigs[mode]` drives the active profile.
That is a behavioral change (it would make the mode map override the imported
`currentApiConfigName` on every launch) and should only be done deliberately; the
one-line template fix fully resolves the reported bug without it.

## Not determinable from source (stated explicitly)

- The exact `darwin-rebuild` invocation history / activation timestamps were not inspected
  beyond the live file mtime; the causal link rests on (a) the activation script copying
  the template to the autoImport path and (b) the template's `currentApiConfigName=Code`.
- Whether any out-of-band tool other than the two flakes also writes the template/file was
  not exhaustively audited outside `/Users/celes/sources/menagerie*`; within those repos
  the `zooOmniRouteImport` activation is the writer.
