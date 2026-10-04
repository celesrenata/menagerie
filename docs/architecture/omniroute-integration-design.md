# Design: OmniRoute as the single owner of routing/tiering/placement

Status: draft · Owner: celes · Base branch: `feat/parallel-tasks-import`
Companion spec: `docs/architecture/parallel-tasks-gpu-routing-spec.md` (this design
supersedes that spec's §2.1–§2.4 and §3 tier/placement direction; §1, §2.5, §2.6
and the parallel-execution subsystem it describes are unchanged).

## Overview

The parallel-tasks import brought a client-side "routing tier" system into
menagerie (`omnirouteTier.ts`, `routingTier.ts`, `RoutingTierSelector.tsx`). It
computes a 1–5 tier, floors/escalates it across parent→child→parallel-worker
handoffs, and attaches an `X-OmniRoute-Tier` header, and it only activates when
the OpenAI base URL hostname literally equals `omniroute.celestium.life`. That
hostname literal appears **twice** in production source — in
`src/core/task/omnirouteTier.ts` and again in the webview
`webview-ui/src/components/chat/ChatView.tsx` (`usesOmniRoute` memo) — plus
several test fixtures; the removal plan (§4) targets both. Both of the client
system's decisions are wrong for the target topology: OmniRoute already owns
tiering (it rewrites `service_tier` server-side and publishes service-tier
variants as model-id suffixes — proven by `src/lib/vscode/serviceTierVariants.ts`
in the OmniRoute repo, though only for Codex/`cx` providers; see §2.2/§6), and the
Mac now reaches OmniRoute only over a WireGuard route (the `omniroute` interface
brought up by `omniroute-wireguard.nix`), with no loopback instance and no fixed
address.

This design makes OmniRoute the single owner of routing, tiering, and
GPU-placement. Menagerie becomes a thin client: it lets the user configure a
Server URL + optional API key, browses the model/route catalog OmniRoute
publishes, lets the user select a model id (tier and reasoning-effort are just
suffix variants of that id), and sends it through. All client-side tier math is
deleted. Everything OmniRoute-related is consolidated into one new "OmniRoute"
settings section that follows the existing settings-section pattern. Parallel
fan-out stays a menagerie concern only insofar as *how many* workers run
concurrently; *which backend/GPU* each lands on is resolved by OmniRoute's
existing combos + admission machinery.

The stack is locked to what the repos already use: menagerie monorepo (pnpm
10.8.1, Node 22.23.1, TypeScript, React webview with `@vscode/webview-ui-toolkit`
+ vscrui, `zod` schemas in `@roo-code/types`); OmniRoute is a Next.js app on
branch `release/v3.8.52`. No new frameworks. The OmniRoute VS Code contract is
the tokenized API at `<serverUrl>/api/v1/vscode/<token>/…`.

## 1. Connection / configuration model (no hardcoded address)

### 1.1 Decision: reuse the OpenAI-compatible provider profile, add OmniRoute opt-in fields

OmniRoute already speaks the OpenAI-compatible surface menagerie's `OpenAiHandler`
targets (`src/api/providers/openai.ts`), and the tokenized VS Code base is an
OpenAI-compatible endpoint. Rather than invent a new provider, an OmniRoute
connection **is** an OpenAI-compatible provider profile whose base URL points at
the tokenized VS Code API. This keeps the request path, streaming, reasoning, and
extra-body handling that already work, and it means "select an OmniRoute model"
reuses the existing model id field (`openAiModelId`).

Two connection-shape options were considered:

- **(A) Global connection in the new tab** — one server URL/key for the whole
  extension, independent of profiles.
- **(B) Per-profile OmniRoute opt-in** — a boolean flag on the provider profile
  plus the tokenized base URL, so different profiles can point at different
  OmniRoute instances or none.

**Chosen: (B), per-profile opt-in, with the new OmniRoute settings section acting
as the editor for the currently-selected profile's OmniRoute fields.** Menagerie's
whole configuration model is profile-scoped (`ProviderSettings`, `ApiConfigManager`,
sticky per-mode profiles). A global connection would fight that model and reintroduce
the same "one true endpoint" assumption we are removing. Per-profile also gives a
clean migration: an existing OmniRoute profile just gains the opt-in flag.

Concretely, extend the OpenAI provider schema
(`packages/types/src/provider-settings/openai.ts`) with:

- `openAiIsOmniRoute?: boolean` — opt-in flag. When true, this profile is treated
  as an OmniRoute connection: the OmniRoute settings UI and the live-catalog
  fetch apply, and the deleted tier logic's former call sites do nothing special.
- Server URL reuses the existing `openAiBaseUrl`. The **user enters the server
  root without any suffix** (mirroring OmniCopilot's documented contract in
  `omniroute/docs/guides/VSCODE-COPILOT.md`: "Server URL — the server root … the
  `/v1` suffix is appended by the extension; do not include it"). Because
  OmniRoute's client surface is the *tokenized* path, the effective base URL is
  derived (see §1.2), not stored, so no `/v1` or token is persisted in
  `settings.json`.
- API key reuses the existing **secret** `openAiApiKey` (already in
  `SECRET_STATE_KEYS`, so it is stored in VS Code SecretStorage / OS keychain,
  never `settings.json`). It is only required when the server sets
  `REQUIRE_API_KEY`; the current flake instance sets it false, so the field stays
  optional. No new secret key is introduced.

`openAiIsOmniRoute` is not secret and is a provider setting, so it needs no
SecretStorage entry; it rides the existing provider-profile persistence.

`isOmniRoute()` becomes: `configuration.apiProvider === openai && configuration.openAiIsOmniRoute === true`. **No hostname, no URL parsing, no address literal anywhere.** This is the direct replacement for the deleted `omniroute.celestium.life` check — and there are **two** production copies of that check to replace, not one: the `omnirouteTier.ts` copy (§4.1) and the identical `usesOmniRoute` memo in `ChatView.tsx` (§4.6). After the removal, a repo-wide grep for `omniroute.celestium.life` must return zero production-source hits (test fixtures in §4.8 are updated to use a placeholder host); §8 adds that grep as an acceptance check.

### 1.2 Tokenized base URL and API-key placement

OmniRoute's VS Code client contract puts the API key in the URL path as a token:
`<serverUrl>/api/v1/vscode/<token>/…` (verified in
`omniroute/src/lib/vscode/tokenizedRequest.ts` → `withPathTokenApiKey`, which also
accepts the key as `x-api-key` / `Authorization: Bearer`). Two placement choices:

- Put the key in the path (`…/vscode/<key>/…`) as OmniRoute's Ollama-style clients do.
- Put the key in the `Authorization` header and use a placeholder/`raw` token in the path.

The OmniRoute tokenized routes are keyed on a `<token>` path segment. The token
segment is honored as the API key when present (`withPathTokenApiKey` sets
`x-api-key`/`authorization` from it only when those headers are *absent*), and
`REQUIRE_API_KEY=false` means any non-empty placeholder authorizes.

**Chosen derivation:** menagerie builds the effective base URL as
`${serverRoot.replace(/\/+$/,"")}/api/v1/vscode/${token}` where
`token = openAiApiKey || "public"`. When a key exists it doubles as the path
token (exactly what OmniRoute's Ollama/VS Code clients do); when none is required,
`"public"` is a harmless placeholder. To avoid the log/proxy leak OmniRoute warns
about (`warnTokenInUrlOnce`), menagerie *also* sends the key as
`Authorization: Bearer <openAiApiKey>` via the existing `OpenAiHandler` header
path, so the key travels in the header even though the path carries the token
segment the route matcher requires.
The route catalog fetch hits `${base}/combos` and surfaces each combo's
`tier/role` id (carried in the combo's `name` field, e.g. `hybrid/code`,
`local/long`) as the selectable chat id. Chat/completions and responses use
the per-model `url` field OmniRoute returns (it already embeds the correct
tokenized sub-path — see `enrichModelForVscode` in
`omniroute/src/app/api/v1/vscode/[token]/models/route.ts`, which sets
`url = ${tokenBaseUrl}/chat/completions#models.ai.azure.com` or
`${tokenBaseUrl}/responses#models.ai.azure.com`). Two points about that shape:

- The `#models.ai.azure.com` **URL fragment is always appended.** Menagerie must
  use the returned `url` **verbatim** — it must not strip the fragment, re-append
  it, or reconstruct the sub-path from a truncated spec. Fragments are not
  transmitted to servers by `fetch`/`axios`, so carrying it verbatim is harmless;
  the only failure mode is a client that reconstructs the path and drops the
  fragment (cosmetic) or double-appends it (broken). §8 adds a catalog-entry test
  asserting the `url` is stored and reused verbatim.
- The sub-path differs per model (`/chat/completions` vs `/responses`), so
  menagerie must respect the per-model `url` rather than hardcoding a sub-path,
  because responses-API models (Codex/GPT-5.x) use `/responses`.

This keeps the address entirely user-derived (server root the user typed +
their key or the `"public"` placeholder), with zero literals in source.

> **Correction (combo prefix vs. suffix variant).** An earlier revision populated
> the selectable catalog from `${base}/models?prefix=alias`, whose entries are
> **bare alias ids** (`code`, `reader`), and relied on the assumption that
> "OmniRoute strips the suffix and applies the effect server-side." That
> assumption holds only for suffix **variants** (reasoning-effort / service-tier)
> layered on a valid combo **base** — it does **not** hold for the `tier/`
> **prefix**. The chat/completions endpoint reads the slash in a `tier/role` id as
> the provider/combo selector; a bare alias has no provider, so the server rejects
> it with "Unable to determine provider for model '<alias>'" rather than
> synthesizing a combo from it. The selectable chat id must therefore be a full
> combo id. The catalog fetch now reads `${base}/combos` so each `entry.id` is a
> full `tier/role` combo id (`hybrid/code`), which is stored verbatim in
> `openAiModelId` and sent verbatim as the chat `model` field.

### 1.3 Reachability

OmniRoute is only reachable over the `omniroute` WireGuard interface
(`m5max-darwin-flake/modules/darwin/omniroute-wireguard.nix` brings that interface
up; its tunnel address is `192.168.133.2/28`, from which the OmniRoute service is
routed). The exact route target (WireGuard tunnel address vs. an in-cluster
service address behind it) is an environment concern outside the extension and is
out of scope for this design. The extension treats an unreachable server exactly
like any other connection failure (§4, §5): the connection check reports
"unreachable", the catalog is empty, and nothing is hardcoded. No menagerie code
assumes WireGuard is up or knows the address/CIDR.

## 2. The new "OmniRoute" settings section

### 2.1 Registration (follows the existing pattern)

Add `"omniroute"` to `sectionNames` (the `SectionName` settings sub-section
registry) in `webview-ui/src/components/settings/SettingsView.tsx` and to the
`sections` array (with a `lucide-react` icon, e.g. `Waypoints` or `Network`). Add
its label to the i18n `settings:sections.omniroute` keys and to the
section-search registry (the existing indexing loop picks it up automatically).

This is the **only** registration needed. Do **not** add `"omniroute"` to the
`WebviewMessage.tab` union in `packages/types/src/vscode-extension-host.ts`
(`tab?: "settings" | "history" | "mcp" | "modes" | "chat" | "marketplace" |
"cloud"`): that field is a *top-level view selector*, a different type from the
settings-section registry, and OmniRoute is a settings sub-section, not a
top-level view. If a top-level deep-link into the OmniRoute sub-section is later
wanted, it is expressed by opening the Settings view and passing
`targetSection: "omniroute"` (the existing settings deep-link mechanism), not by
extending `WebviewMessage.tab`. No `tab`-union change is in scope here.

Create `webview-ui/src/components/settings/OmniRouteSettings.tsx`, mounted in the
`renderTab === "omniroute"` branch inside a `SectionHeader` + `Section`, mirroring
how `providers`/`mcp` render. It receives the same props shape other sections use
(`cachedState` slices + `setCachedStateField` / `setApiConfigurationField`), and
**every input binds to local `cachedState`**, never live `useExtensionState()`,
per the repo AGENTS.md Settings-View rule and the Persisted-Setting Checklist.

### 2.2 Contents

The section has four blocks:

1. **Endpoint setup.**
   - "This profile uses OmniRoute" checkbox → `openAiIsOmniRoute`
     (`setApiConfigurationField`). Gates the rest of the section.
   - Server URL text field → `openAiBaseUrl` (server root, no suffix; placeholder
     shows an example like `https://<omniroute-host>` with no real address).
   - API key password field → `openAiApiKey` (secret). Helper text: "Only needed
     when the server requires it; stored in the OS keychain."
   These reuse the exact controls `OpenAICompatible.tsx` already uses, so the
   secret/masking behavior is unchanged.

2. **Connection check / refresh (live backend integration).**
   - A "Check connection" button and a "Refresh catalog" button.
   - Status line: unknown / connecting / connected (`N models`) / error with the
     server's message. Backed by the message round-trip in §3.

3. **Model / route catalog (browsable, live).**
   - A searchable list of the route (combo) entries OmniRoute returns from
     `${base}/combos`. Each entry's `id` is the full `tier/role` combo id (from the
     combo's `name` field, e.g. `hybrid/code`, `local/long`); it is the id the
     chat/completions endpoint requires.
   - Selecting an entry sets `openAiModelId` to that full combo id (reuse
     `ModelPicker` semantics). The stored id is sent verbatim as the chat `model`
     field.
   - **Correction (do not populate from bare aliases).** The catalog must NOT be
     populated from `${base}/models?prefix=alias`: that endpoint returns bare alias
     ids (`code`, `reader`) in a **different** id namespace, and the chat endpoint
     rejects them with "Unable to determine provider for model '<alias>'". The
     client never parses or synthesizes combo ids — it stores the combo id OmniRoute
     publishes verbatim. Suffix **variants** (reasoning-effort / service-tier,
     below) may still be layered on a valid combo base, where OmniRoute strips the
     suffix server-side; that server-side strip applies only to those suffixes, not
     to the `tier/` prefix.
   - **Which variant axes actually exist (verified against
     `omniroute/src/lib/vscode/serviceTierVariants.ts`):**
     - *Service-tier suffixes* (`…__tier_priority`, `…__tier_flex`, implicit
       `standard`) are **Codex-only** — `supportsVscodeServiceTierVariants()`
       returns true only for `codex`/`cx` providers on the specific models in
       `CODEX_FAST_TIER_DEFAULT_SUPPORTED_MODELS`. `resolveVscodeServiceTierRequest()`
       strips the suffix and sets `service_tier` server-side. The user's local
       Qwen/DeepSeek/GLM GPU models will **not** get tier-suffixed ids.
     - *Reasoning-effort suffixes* (`-high`/`-medium`/`-low`) are the general
       variant axis available to other models (surfaced via
       `supportedReasoningEfforts`/`defaultReasoningEffort` on the catalog entry).
     - GPU spread across the user's three local GPUs is handled by combos +
       admission (§5), **not** by tier suffixes. The removed client "1–5 tier" is
       not re-created here in any form.
   - Non-chat model types are already filtered server-side
     (`isUsableChatModel`); responses-API models are kept and usable.

4. **Custom routes.**
   - A small editor for user-defined route aliases the user wants to pin (e.g. a
     named combo or a specific model id per named "route"). This is stored as a
     new provider-profile field `openAiOmniRouteCustomRoutes?: Array<{ name: string; modelId: string }>`
     (see §6). It is purely a menagerie-side convenience mapping of a friendly
     name → an OmniRoute model id the catalog already advertises; **it performs no
     routing math** — selecting a custom route just sets `openAiModelId` to the
     mapped id. If OmniRoute exposes named combos via its combos endpoint, the
     client uses the tokenized combos route `/api/v1/vscode/<token>/combos`
     (verified). A non-tokenized top-level `/api/v1/combos` route also exists in
     the OmniRoute repo but is not the tokenized VS Code surface and is not used
     here. The catalog block can additionally list combos as selectable ids;
     wiring the combos fetch is optional and behind the same refresh action.

### 2.3 Save flow

All four blocks write to `cachedState.apiConfiguration`. On Save, the existing
`SettingsView.handleSubmit()` already posts
`{ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration }`,
which persists the whole provider profile (including the new
`openAiIsOmniRoute` / `openAiOmniRouteCustomRoutes` fields and the secret
`openAiApiKey`). No new entry in the generic `updateSettings` payload is needed
because these live on the provider profile, not global settings. This satisfies
the "include the setting in the save payload" checklist item via the existing
`upsertApiConfiguration` path.

## 3. Live catalog + connection check (message round-trip)

Reuse the existing model-fetch plumbing rather than inventing a channel.
`webviewMessageHandler.ts` already handles `requestOpenAiModels` by calling
`getOpenAiModels(baseUrl, apiKey, …)` (`src/api/providers/openai.ts`) and posting
back `OpenAiModelsMessageType.openAiModels`. The design adds an OmniRoute-aware
fetch:

- On "Refresh catalog"/"Check connection", the webview posts a message with the
  profile's server root + key (from `cachedState`, not saved state, so an
  unsaved edit can be tested — the existing OpenAI/LiteLLM handlers already
  read `message.values` for exactly this reason).
- The handler derives the tokenized base per §1.2, issues
  `GET ${base}/models?prefix=alias`, filters is done server-side, and returns the
  enriched entries. Note on `prefix`: the `prefix=alias` contract is documented in
  `omniroute/docs/guides/VSCODE-COPILOT.md` for the standard `/v1/models` path,
  but it also works through the **tokenized** base used here — verified
  end-to-end: `omniroute/src/app/api/v1/vscode/[token]/models/route.ts` forwards
  the original request into `getUnifiedModelsResponse(request)`, and
  `catalog.ts:335` reads `new URL(request.url).searchParams.get("prefix")`, so the
  query param propagates. Keep the tokenized base (`…/api/v1/vscode/<token>`); do
  not switch to the guide's `/v1/models` base. Add a new message type
  `omniRouteCatalog` (request +
  response) in `packages/types/src/vscode-extension-host.ts` carrying the typed
  catalog entries and a connection status, OR extend the existing
  `requestOpenAiModels` path to also return the richer fields. **Chosen: a
  dedicated `omniRouteCatalog` message pair**, because the OmniRoute catalog
  entry carries fields (`family`, `toolCalling`, `vision`, reasoning-effort
  metadata, per-model `url`) that the plain `openAiModels` (a `string[]`) does
  not, and overloading the string list would lose them.

The response type is a `zod`-validated array of a new
`omniRouteCatalogEntrySchema` in `@roo-code/types` matching the verified
`enrichModelForVscode` output shape (id, name, url, toolCalling, vision,
maxInputTokens, maxOutputTokens, family, supportedReasoningEfforts,
defaultReasoningEffort, configurationSchema). Unknown/extra fields are stripped,
not rejected, so a newer OmniRoute build does not break the client.

## 4. Removing menagerie's tier math — exact plan and every call site

The following are deleted or reduced to a no-op / pass-through. Each item lists
the file and what replaces it.

### 4.1 `src/core/task/omnirouteTier.ts`
- **Delete** `taskRouting`, `userTaskRouting`, `modelTaskRouting`,
  `childTaskRouting`, `applyTaskRouting`, `withChildRouting`, the
  `X-OmniRoute-Tier` header construction, `USER_SELECTED_ROUTING_REASON`, and the
  `TaskRouting` type.
- Deleting `applyTaskRouting` also removes its `hybrid/`-prefix guard, which today
  **throws** `"Higher routing tiers require a hybrid profile…"` whenever
  `openAiModelId` does not start with `hybrid/` and a tier > 1 is requested. That
  client-side constraint disappears entirely: the user simply selects whatever
  catalog id (including tier-suffixed ids) they want, and OmniRoute — not
  menagerie — decides admissibility. Any docs/tests asserting the throw are
  removed with §4.8.
- **Replace** `isOmniRoute(configuration)` with the flag-based check from §1.1
  (kept, because §2/§6 UI and any diagnostics may want "is this an OmniRoute
  profile?"). It no longer parses URLs. If no remaining consumer needs it after
  the edits below, delete the file entirely; a search shows the only post-edit
  consumers would be the settings UI gate (which reads the flag directly) so the
  file is expected to be **removed**.

### 4.2 `packages/types` — the routing type on history/messages
- In `packages/types/src/history.ts`, the `taskRoutingSchema` object (source of
  the `TaskRouting` type via `NonNullable<HistoryItem["omnirouteRouting"]>`) is
  **removed**, along with **all three** of its uses:
  1. `historyItemSchema.omnirouteRouting` (the persisted task field),
  2. `pendingTaskActionSchema` → `create_subtask` variant's `omnirouteRouting`
     field (threaded through the pending-subtask approval path), and
  3. the `taskRoutingSchema` definition itself.
  Because `omnirouteTier.ts`'s `TaskRouting` derived from
  `NonNullable<HistoryItem["omnirouteRouting"]>`, deleting the field removes the
  type source; any transient reference is deleted with the file (§4.1).
- `TaskExecutionContext.omnirouteRouting` (`src/core/task/providerHandoff.ts`
  line 4) is **removed**.
- Migration for already-persisted history that still carries `omnirouteRouting`
  is in §7 (tolerate-and-ignore, do not reject).
- The `setOmniRouteTier` message case in
  `packages/types/src/vscode-extension-host.ts` action union (≈line 478) and the
  `routingTier?: number` field (≈line 654) are **removed**.

### 4.3 `src/core/task/Task.ts`
- Remove the `omnirouteRouting` field (declared ≈line 383), the
  `initialOmniRouteRouting?: TaskRouting` option on `TaskOptions` (≈line 222) and
  its destructuring (≈line 585), its constructor initialization block
  (`this.omnirouteRouting = handoffExecutionContext?.omnirouteRouting ??
  historyItem?.omnirouteRouting ?? initialOmniRouteRouting ??
  (isOmniRoute(initialConfiguration) ? taskRouting(1) : undefined)` at ≈lines
  640–645) and the `this.apiConfiguration = applyTaskRouting(initialConfiguration,
  …)` that follows it, the `historyItem.omnirouteRouting = this.omnirouteRouting` persistence
  line (≈line 1457), the `applyTaskRouting(newApiConfiguration, …)` call and the
  `USER_SELECTED_ROUTING_REASON`/`userTier` recompute block inside
  `updateApiConfiguration` (≈lines 1871–1892), the whole `setOmniRouteTier`
  method, and the `omnirouteRouting: action.omnirouteRouting` threading in the
  pending-subtask resume path (≈line 2705). `updateApiConfiguration` becomes a
  plain `this.apiConfiguration = newApiConfiguration; this.api =
  buildApiHandler(...)`.

### 4.3a `src/core/webview/ClineProvider.ts`
The task-init paths in `ClineProvider` thread routing too (missed if only
`Task.ts` is edited):
- The `createTask` options type carries `initialOmniRouteRouting?: TaskRouting`
  (≈line 3439). **Remove** it (paired with the webviewMessageHandler removal in
  §4.7a that stops passing it).
- `initClineWithTask`/`initNewTask` signatures carry `omnirouteRouting?:
  HistoryItem["omnirouteRouting"]` (≈lines 3871, 3884). **Remove** both
  parameters.
- The body computes routing from
  `params.omnirouteRouting?.tier`/`.reason`/`parent.omnirouteRouting` (≈lines
  3925–3927). **Remove** that computation; the child inherits the parent
  profile's `openAiModelId` unchanged (plus the optional per-worker `route`
  pass-through from §5 where applicable).

### 4.4 Tools and tool schemas
- `src/core/tools/SwitchModeTool.ts`: remove `routing_tier` param, the two
  `modelTaskRouting`/`setOmniRouteTier` branches, and the "Selected OmniRoute
  tier" tool result. Mode switch becomes tier-free.
- `src/core/tools/NewTaskTool.ts`: remove `routing_tier`/`routing_reason` params
  and the `childTaskRouting` call; stop threading `omnirouteRouting` into the
  pending action and `initNewTask`.
- `src/core/tools/ParallelTasksTool.ts`: remove `routing_tier`/`routing_reason`
  from `parallelTaskSpecSchema` and add the optional `route?: string | null`
  field (§5.2, validated non-empty ≤200 chars). For the transition release, also
  change `parallelTaskSpecSchema` from `.strict()` to `.strip()` so a stray
  legacy `routing_tier`/`routing_reason` is dropped rather than rejected (§7);
  restore `.strict()` in a later release. **Approval summary — one concrete
  choice, no "may/optionally".** The current fragment is
  ``${spec.name} (${spec.mode}, tier ${Math.max(spec.routing_tier ?? 1, task.omnirouteRouting?.tier ?? 1)})``
  (the `.map(...)` at ≈line 67). It becomes **`${spec.name} (${spec.mode})`, and
  when `spec.route` is set, append `spec.route` verbatim** (e.g.
  `${spec.name} (${spec.mode}, ${spec.route})`). The summary does **not** show the
  role-defaulted or parent-fallback id: `roleDefault(spec.mode)` / `parent
  .openAiModelId` resolution happens later in `runParallelTasks.ts` (§4.5/§5.2)
  and is **not in scope** where the tool assembles the approval string, so only
  the in-scope `spec.route` (when present) is shown. No new plumbing is threaded
  up into the tool for the summary.
- `src/shared/tools.ts`: remove `routing_tier`/`routing_reason` from the
  `new_task`, `parallel_tasks`, and `switch_mode` tool arg types.
- Native tool JSON schemas
  (`src/core/prompts/tools/native-tools/new_task.ts`, `parallel_tasks.ts`,
  `switch_mode.ts`) and the shared `routingTier.ts`: **delete `routingTier.ts`**
  and remove `routing_tier`/`routing_reason` from each schema's `properties` and
  `required` arrays. Update the prose in `switch_mode.ts`'s description that
  currently instructs the model to "set routing_tier".

### 4.5 Parallel execution
- `src/core/task/runParallelTasks.ts`: remove the `withChildRouting` import and
  call. Resolve each worker's context with plain
  `getTaskHandoffContext(parent, spec.mode, true)`, then apply the §5.2 per-worker
  model resolution — set `context.apiConfiguration.openAiModelId =
  spec.route ?? roleDefault(spec.mode) ?? parent.openAiModelId` (a pure id
  pass-through; no tier math). Remove `routingTier` from `ParallelTaskResult`
  (the `omnirouteRouting?.tier` read that populated it is gone with §4.3).
- `src/core/task/ParallelTaskReader.ts` / `ParallelTaskPool.ts`: unaffected
  (they never referenced tiers).
- `parallelToolExecution` (native concurrent reads, no model call) is **unaffected**
  by any of this — it makes no model selection (§5.1).

### 4.6 UI (chat webview)
The tier UI is not confined to one component; the substantive wiring lives in
`ChatView.tsx` and `ChatTextArea.tsx`. All of the following is removed.

- `webview-ui/src/components/chat/RoutingTierSelector.tsx`: **delete the
  component.** Its function (choosing "how hard to try") is now served by
  selecting a model id / tier-suffixed id in the OmniRoute catalog (§2.2). Its
  test `__tests__/RoutingTierSelector.spec.tsx` is deleted with it (§4.8).
- `webview-ui/src/components/chat/ChatView.tsx`: remove
  - the `newTaskRoutingTier`/`setNewTaskRoutingTier` state (≈line 131) and the
    `useEffect` that resets it on `task?.ts` (≈lines 133–135);
  - the entire `usesOmniRoute` memo (≈lines 135–143) — this is the **second
    hardcoded `omniroute.celestium.life` literal** (≈line 138); it is deleted
    outright, not replaced with a flag read (the chat input no longer needs an
    "is this OmniRoute?" gate once the tier selector is gone);
  - `allowsHigherRoutingTiers` (the `hybrid/` guard, ≈line 143);
  - `routingTier` from the `newTask` postMessage payload (≈line 705) and
    `newTaskRoutingTier`/`usesOmniRoute` from that callback's dependency array
    (≈lines 747–748);
  - the `routingTier`/`onRoutingTierChange`/`routingTierDisabled`/
    `allowHigherRoutingTiers` props passed to `<ChatTextArea>` (≈lines
    1908–1914), including the `currentTaskItem?.omnirouteRouting?.tier` read and
    the `setOmniRouteTier` postMessage on tier change.
- `webview-ui/src/components/chat/ChatTextArea.tsx`: remove
  - the import of `RoutingTierSelector` (≈line 30);
  - the four props `routingTier?`, `onRoutingTierChange?`, `routingTierDisabled?`,
    `allowHigherRoutingTiers?` from the props type (≈lines 49–52) and their
    destructuring (≈lines 79–82);
  - the `<RoutingTierSelector>` render block (≈lines 1347–1355).
- i18n: remove the `chat:routingTier.*` keys.

(Repurposing `RoutingTierSelector` as a thin model-variant picker is explicitly
out of scope; default is deletion.)

### 4.7 Diagnostics / board
- `src/activate/taskBoard.ts`: remove **all** routing references, not just the
  field declaration:
  - the `routing?: HistoryItem["omnirouteRouting"]` row field (≈line 13) and its
    population `routing: task.omnirouteRouting` (≈line 38);
  - the `tier` const (≈line 104, `const tier = row.routing ? \`Tier …\` :
    "No tier requested"`), which feeds the **"Requested capability"** detail card
    (≈line 137) — note the card's actual label is "Requested capability", not
    "Requested tier";
  - the **"Requested tier:"** tree-item tooltip rows (≈lines 188–189);
  - the `· T${row.routing.tier}` fragment in the tree-item description (≈line
    214).
  All `row.routing` reads (the const at ≈104, the "Requested capability" card at
  ≈137, the "Requested tier:" tooltip at ≈188–189, and the description fragment
  at ≈214) are removed; the board simply stops surfacing a tier and nothing
  replaces it.

### 4.7a `src/core/webview/webviewMessageHandler.ts` (tier-setting handler)
Separate from the new catalog handler (§3), the handler currently has two tier
call sites to remove:
- In the task-creation message case (≈line 705), `createTask(...)` is passed an
  options object with `initialOmniRouteRouting: message.routingTier === undefined
  ? undefined : userTaskRouting(message.routingTier)`. **Remove** the
  `initialOmniRouteRouting` option (and the `provider.createTask` option type
  that declares it) and the `message.routingTier` read.
- The entire `case "setOmniRouteTier":` block (≈lines 720–732), which calls
  `userTaskRouting(message.routingTier ?? 1)` then `task.setOmniRouteTier(...)`,
  is **deleted** — the action is removed from the message union (§4.2) and the
  method is removed from `Task.ts` (§4.3).

### 4.8 Tests
Nine existing suites reference the removed logic (confirmed by search) across the
`src/` and `webview-ui/` packages; all must be updated or deleted so the build
stays green:

Extension-host (`src/`):
- **Delete** `src/core/task/__tests__/omnirouteTier.spec.ts` (the unit is gone);
  it also hardcodes `omniroute.celestium.life` (line 14), removed with the file.
- Update `src/core/tools/__tests__/switchModeTool.spec.ts` and
  `newTaskTool.spec.ts`: drop `routing_tier`/`routing_reason` assertions,
  `modelTaskRouting`/`childTaskRouting`/`setOmniRouteTier` mocks, and any
  hybrid-guard throw expectation.
- Update `src/core/task/__tests__/Task.spec.ts`: remove `X-OmniRoute-Tier`
  header assertions and `omnirouteRouting`/`setOmniRouteTier` expectations, and
  change the fixture `openAiBaseUrl` (line ≈979) off the
  `omniroute.celestium.life` literal to a neutral placeholder host.
- Update `src/core/task/__tests__/Task.pending-action.spec.ts`: drop the
  `omnirouteRouting` field from the pending-action fixtures/assertions.
- Update `src/core/webview/__tests__/webviewMessageHandler.spec.ts`: remove
  `routingTier`/`userTaskRouting`/`setOmniRouteTier` cases; add the new
  `omniRouteCatalog` handler cases (§3, §8).

Webview (`webview-ui/`):
- **Delete** `webview-ui/src/components/chat/__tests__/RoutingTierSelector.spec.tsx`
  (component deleted, §4.6).
- Update `webview-ui/src/components/chat/__tests__/ChatView.spec.tsx`: remove the
  `routingTier`/`onRoutingTierChange` mock props, the `select-tier-4` button and
  the `routingTier: 4` `newTask` assertion (≈lines 236–267, ≈445), and change the
  fixture `openAiBaseUrl` (≈line 432) off the `omniroute.celestium.life` literal
  to a neutral placeholder host.
- Update `webview-ui/src/components/chat/__tests__/ChatTextArea.spec.tsx`: drop
  the `onRoutingTierChange` prop from the render (≈line 95); the `<ChatTextArea>`
  no longer accepts the four `routingTier*` props.

- Add the new coverage in §8.

## 5. Parallel fan-out ↔ OmniRoute placement boundary

**OmniRoute owns placement.** The OmniRoute repo confirms it: the tokenized
combos endpoint `/api/v1/vscode/<token>/combos` exists (verified; a non-tokenized
top-level `/api/v1/combos` route also exists but is not the surface used here),
and OmniRoute exposes chat-admission knobs `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT`
and `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS`. Their exact deployed values are **not**
verified from any inspected config — the OmniRoute CHANGELOG states
`OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` is **unset (heavy-in-flight uncapped) by
default**, and the specific `=4`/`=30000` values are not present in the local
`~/sources/kube/omniroute` tree; if a concrete cap is desired it must be read
from and set in the k8s manifest at
`ssh://celes@192.168.42.254:sources/kube/omniroute` (an OmniRoute-side/ops task,
not a menagerie change). What matters for this boundary is only the *ownership*:
when N parallel workers each open a chat/completions request against an OmniRoute
model/combo, OmniRoute's admission + combo strategy is what spreads them across
the GPUs (or queues them). Menagerie's job is only to *emit* N concurrent
requests, which the imported `ParallelTaskPool` (3 permits) already does.

Therefore menagerie's parallel subsystem keeps: the worktrees, the pool, the
wait/collect logic. It loses: any per-worker tier/placement computation.

### 5.1 Two distinct parallel subsystems — keep them separate

These are separate in the code (verified) and must not be conflated:

- **`parallelToolExecution`** (`src/shared/experiments.ts` →
  `"parallelToolExecution"`) runs concurrent **native** tool reads (filesystem
  ops), which make **no** model call. Model selection does not apply to it and it
  is **unaffected** by anything in this section.
- **`parallelTasks`** (`ParallelTasksTool.ts`) fans out full agent **workers**,
  each of which **does** call a model. This is the only place per-worker model
  selection belongs.

### 5.2 Per-worker model selection: role-aware, with explicit override

The user's requirement is that within one `parallel_tasks` batch, cheap
read/search/exploration workers run on a **fast small** OmniRoute model in
parallel, while heavy reasoning/editing workers use the **large** model. The
mechanism is a per-worker model-id pass-through resolved in three tiers of
precedence; menagerie never does tier/GPU math, it only chooses which
OmniRoute-published id to send.

**What replaces `routing_tier`/`routing_reason` on the `parallel_tasks` spec:**
an optional per-worker `route?: string | null` on `parallelTaskSpecSchema`
(`ParallelTasksTool.ts`). Note the enabling fact (verified): the spec **already**
carries a per-worker `mode` field, and a `project-reader` mode already exists
(`addSharedDocumentReader(...)`), so a worker's *role* is already expressible per
worker via `mode`; the missing piece added here is a mapping from role → an
OmniRoute model id.

**Resolution order for a worker's effective `openAiModelId`** (implemented in
`runParallelTasks.ts` when it builds each worker's handoff context):

    spec.route ?? roleDefault(spec.mode) ?? parent.openAiModelId

1. **`spec.route`** — an explicit per-worker override naming a catalog id or a
   custom-route name (§2.2). Highest precedence.
2. **`roleDefault(spec.mode)`** — when `route` is unset, derive the id from the
   worker's role via a **configurable** reader→fast / reasoner→large mapping (see
   §5.3). A worker is treated as a *reader* when its `mode` is `project-reader`
   or any mode the mapping flags read-only; every other mode is a *reasoner*.
3. **`parent.openAiModelId`** — final fallback (and what `roleDefault` returns
   when the corresponding mapping field is unset), so behavior is unchanged for
   users who configure nothing.

This is a pure id pass-through: `runParallelTasks.ts` sets that worker's child
`apiConfiguration.openAiModelId = resolvedId` on the `TaskExecutionContext`
returned by `getTaskHandoffContext` (replacing the deleted `withChildRouting`
call, §4.5) and does nothing else. GPU placement still resolves inside OmniRoute.

**Validation of `route`:** optional; if present, a non-empty string ≤200 chars.
An unknown id is **not** rejected client-side (OmniRoute returns the authoritative
error on the chat call, surfaced as that worker's failure). Invalid type/length
fails the existing `parallelTaskSpecSchema` `zod` parse, which the tool already
surfaces via `onMalformedCall`.

### 5.3 Where the reader/reasoner default mapping lives (config)

The default mapping is **two new OmniRoute-profile fields**, edited in the ONE
OmniRoute settings tab (§2, criterion c) — not in a separate place, not global
settings. Added to the OpenAI provider schema
(`packages/types/src/provider-settings/openai.ts`):

- `openAiOmniRouteReaderRouteId?: string` — the fast/small catalog id used for
  reader-role workers when they set no explicit `route`. Unset ⇒ readers fall
  back to `parent.openAiModelId`.
- `openAiOmniRouteReasonerRouteId?: string` — the large catalog id used for
  reasoner-role (default) workers when they set no explicit `route`. Unset ⇒
  reasoners fall back to `parent.openAiModelId`.

Both fields are optional, non-secret provider settings; they ride the same
provider-profile persistence as §1.1's fields and are run through the
Persisted-Setting Checklist in §9. In `OmniRouteSettings.tsx` they are two catalog
pickers (reusing the §2.2 catalog list) in a "Parallel worker defaults" block,
bound to `cachedState` like every other control. `roleDefault(mode)` is a small
pure helper (unit-testable) that reads these two fields plus the read-only-mode
set; it lives beside the parallel-worker code (e.g. in `runParallelTasks.ts` or a
small sibling module) and is passed the resolved profile.

Because both defaults fall back to the parent model, the user's stated goal
("fast small model for reads, big model for reasoning, in parallel") is delivered
once they set the two ids in the OmniRoute tab, while doing nothing keeps today's
single-model behavior.

### 5.4 No client placement module

This means **no menagerie-side GPU scheduling module** is built (the companion
spec's §2.2/§3 `placement` module is explicitly *not* implemented): placement is
OmniRoute's responsibility, and building a second placement authority in
menagerie would violate the single-owner goal. Everything menagerie does is pick
an OmniRoute-published id per worker; OmniRoute admits and places it.

## 6. Is any OmniRoute-side change needed?

**No.** The verified contract already provides everything:

- Tier ownership: `serviceTierVariants.ts` + the models route already publish
  tier-suffixed ids and rewrite `service_tier` server-side.
- Catalog: `models/route.ts` (`enrichModelForVscode`) already emits the fields
  the new catalog UI needs, filters non-chat models, and keeps responses-API
  models.
- Auth: `withPathTokenApiKey` already accepts the key by header or path token,
  with `REQUIRE_API_KEY` gating.
- GPU spread for parallel workers: combos (`/api/v1/vscode/<token>/combos`) +
  the `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` / `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS`
  admission knobs already handle it. **Caveat:** heavy-in-flight is uncapped by
  default (per the OmniRoute CHANGELOG); enforcing a specific concurrency cap is a
  deployment/ops setting on the k8s manifest, not a code change in either repo.

So this design makes **zero changes to the OmniRoute repo** and creates no new
branch there. Two conditional, out-of-scope follow-ups may surface at deploy time,
neither of which is a menagerie code change: (1) if a concrete heavy-in-flight cap
is wanted, set `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` in the k8s manifest at
`ssh://celes@192.168.42.254:sources/kube/omniroute`; (2) if GPU spread proves
inadequate under real multi-worker load (workers serialize on one GPU despite
distinct requests), the minimal fix would be an OmniRoute-side combo/strategy
tweak on a new branch in `/Users/celes/sources/celesrenata/omniroute`, done only
after measurement. Menagerie stays unchanged in either case because it only
selects ids.

## 7. Migration

Existing users are on a profile whose `openAiBaseUrl` pointed at a hardcoded
OmniRoute host and whose tasks may carry a persisted `omnirouteRouting` tier.

- **Provider profile:** on load, if a profile's `openAiBaseUrl` host was the old
  literal, the extension cannot and should not auto-guess the new WireGuard
  endpoint (no hardcoded address). Instead, a one-time settings migration sets
  `openAiIsOmniRoute = true` for any OpenAI profile that previously had the
  `X-OmniRoute-Tier` header present in `openAiHeaders`, and strips that header.
  The user then re-enters the Server URL in the new OmniRoute section. This is a
  pure `ProviderSettings` transform run where menagerie already migrates provider
  settings; it adds no address.
- **Persisted history:** `HistoryItem.omnirouteRouting` becomes an ignored/unknown
  field. `zod` history parsing must not reject it — use `.passthrough()` / drop
  it in a history migration so old task files still load. No behavior depends on
  the old value.
- **Tool call args in flight:** removed schema fields mean the model may still
  emit `routing_tier`/`routing_reason` for a short while, and the two tool
  subsystems need **different** transition mechanisms because they parse args
  differently:
  - **`parallel_tasks` (Zod-parsed).** `parallelTaskSpecSchema` and
    `parallelTasksSchema` in `ParallelTasksTool.ts` are declared `.strict()`
    today, and `.strict()` **rejects** unknown keys (it throws) rather than
    dropping them — so it is the wrong mode for tolerate-and-ignore. For the
    transition release, change **`parallelTaskSpecSchema` from `.strict()` to
    `.strip()`**. `.strip()` is the only `ZodObject` mode that accepts an unknown
    key and silently drops it (`.strict()` throws, `.passthrough()` keeps it), so
    a stray `routing_tier`/`routing_reason` on a worker spec is parsed away with
    no downstream typing effect (the fields are not in the schema, so they never
    reach the tool). Leave `parallelTasksSchema` (the wrapper) as-is; only the
    per-worker spec is where a stray key can appear. In a **later release**,
    restore `.strict()` on `parallelTaskSpecSchema` to reject the (by then
    long-gone) legacy keys again.
  - **`new_task` / `switch_mode` (hand-read params).** These do **not** run a Zod
    `.parse()` over the tool args; they read named params off a plain typed
    object. A field they do not read is inherently ignored, so the tolerate step
    is simply **not reading `routing_tier`/`routing_reason`** — no schema change
    is needed or possible here. Removing the reads (§4.4) *is* the migration.
  - The §8 unit test that "the transitional parse ignores a stray `routing_tier`"
    is pinned to this: it asserts a `parallel_tasks` spec carrying a stray
    `routing_tier` **parses successfully with the key dropped** (`.strip()`
    behavior), and that `new_task`/`switch_mode` calls carrying the stray keys
    succeed with those values unread.

## 8. Testing

Lowest-layer-first, per the repo test-placement guidance:

- **Package-local unit (`packages/types`, `src/core`):**
  - `isOmniRoute` returns true iff `apiProvider === openai && openAiIsOmniRoute`,
    with no URL parsing; false for arbitrary hosts.
  - Tokenized base-URL derivation (§1.2): trims trailing slashes, appends
    `/api/v1/vscode/${token}`, uses the key as token when present and `"public"`
    otherwise; never emits the old literal.
  - `omniRouteCatalogEntrySchema` parses a real `enrichModelForVscode` sample
    (copy a fixture from the OmniRoute route output shape), keeps responses-API
    entries, tolerates extra fields, and preserves the per-model `url` **verbatim**
    including its `#models.ai.azure.com` fragment (assert the stored/used url
    equals the returned url exactly — no strip, no re-append).
  - Tool schemas for `new_task`/`parallel_tasks`/`switch_mode` no longer require
    `routing_tier`. Pin the transitional behavior (§7): a `parallel_tasks` spec
    carrying a stray `routing_tier`/`routing_reason` **parses successfully with
    the key dropped** (asserting `parallelTaskSpecSchema` is `.strip()`, not
    `.strict()`, during the transition — a `.strict()` schema would throw here);
    `new_task`/`switch_mode` calls carrying the stray keys succeed with those
    values simply unread. The `parallel_tasks` spec accepts an optional `route`
    (non-empty ≤200 chars) and rejects an over-long/empty-string `route`.
  - `runParallelTasks` resolves contexts without any routing call and resolves
    each worker's `openAiModelId` as `spec.route ?? roleDefault(spec.mode) ??
    parent.openAiModelId`. Cover all three tiers: explicit `route` wins;
    `route` unset + reader mode (`project-reader`) → `openAiOmniRouteReaderRouteId`;
    `route` unset + reasoner mode → `openAiOmniRouteReasonerRouteId`; both mapping
    fields unset → parent model unchanged. Assert `parallelToolExecution` is
    unaffected (no model resolution for native reads).
  - `roleDefault(mode)` helper: reader modes map to the reader id, everything else
    to the reasoner id, and unset mapping fields yield `undefined` (so the caller
    falls back to the parent model).
  - No production source contains the `omniroute.celestium.life` literal: a
    grep-based assertion (repo-wide, excluding fixtures already migrated in §4.8)
    returns zero hits. This backs acceptance criterion (a).
- **Persistence / round-trip:** the new provider fields (`openAiIsOmniRoute`,
  `openAiOmniRouteCustomRoutes`, `openAiOmniRouteReaderRouteId`,
  `openAiOmniRouteReasonerRouteId`) survive `upsertApiConfiguration` →
  `getState`/`getStateToPostToWebview`; the secret `openAiApiKey` continues to go
  through SecretStorage; history containing a legacy `omnirouteRouting` still
  loads. Include both the OmniRoute-on and OmniRoute-off cases (and both set and
  unset reader/reasoner ids) so a default omission cannot hide a broken round
  trip.
- **webview-ui (`*.test.tsx`):** `OmniRouteSettings` binds inputs to
  `cachedState` (not live state) and marks the form dirty on edit; the catalog
  list renders entries from a mocked `omniRouteCatalog` response and selecting
  one sets `openAiModelId`; the "Parallel worker defaults" pickers set
  `openAiOmniRouteReaderRouteId` / `openAiOmniRouteReasonerRouteId` on
  `cachedState`; the connection-check button posts the expected message with the
  unsaved server URL/key from `cachedState`. A single `*.visual.tsx` snapshot of
  the section's connected + error states (theme tokens) per the webview
  AGENTS.md. Also update the chat suites per §4.8 (`ChatView.spec.tsx`,
  `ChatTextArea.spec.tsx`, delete `RoutingTierSelector.spec.tsx`).
- **Migration unit:** a profile with an `X-OmniRoute-Tier` header migrates to
  `openAiIsOmniRoute = true` with the header stripped and no address invented.
- **E2E (`apps/vscode-e2e`):** none required for this change — every behavior is
  provable at the unit/webview layer. (The companion spec's optional
  "3 requests → 3 GPUs" E2E is explicitly deferred and, per §6, is an OmniRoute
  concern, not a menagerie assertion.)

## 9. Persisted-Setting Checklist (per repo AGENTS.md)

For the new provider-profile fields `openAiIsOmniRoute`,
`openAiOmniRouteCustomRoutes`, `openAiOmniRouteReaderRouteId`, and
`openAiOmniRouteReasonerRouteId` (and the reuse of `openAiApiKey`):

- [x] Defined in `packages/types/src/provider-settings/openai.ts` with `zod`
  optionality (`openAiIsOmniRoute: z.boolean().optional()`;
  `openAiOmniRouteCustomRoutes: z.array(...).optional()`;
  `openAiOmniRouteReaderRouteId: z.string().optional()`;
  `openAiOmniRouteReasonerRouteId: z.string().optional()`). `openAiApiKey` already
  in `SECRET_STATE_KEYS`; no new secret added. All four new fields are non-secret
  provider settings.
- [x] Webview reads them via `apiConfiguration` (part of `ExtensionState`); the
  new `omniRouteCatalog` message pair added to
  `packages/types/src/vscode-extension-host.ts`.
- [x] `OmniRouteSettings` initializes and reads from local `cachedState`
  (`setApiConfigurationField`), not live `useExtensionState()`.
- [x] All four fields included in the save payload via the existing
  `upsertApiConfiguration` post in `handleSubmit()` (provider-profile path, not
  `updateSettings`).
- [x] `webviewMessageHandler` handles the new `omniRouteCatalog` request
  (fetch + normalize) and persists profile edits through the existing
  `upsertApiConfiguration` → `ContextProxy` path; the secret continues via
  SecretStorage.
- [x] `ClineProvider.getState()` and `getStateToPostToWebview()` already surface
  the whole `apiConfiguration`; confirm the new fields ride along in both the
  destructuring and the returned object (add them if the profile is projected
  field-by-field anywhere).
- [x] Runtime consumers: `isOmniRoute` (flag read), the catalog fetch, and
  `roleDefault(mode)` in the parallel path which reads
  `openAiOmniRouteReaderRouteId`/`openAiOmniRouteReasonerRouteId` (§5.2/§5.3), all
  with the same default semantics — absent flag = not OmniRoute; absent
  reader/reasoner id = fall back to the parent `openAiModelId` (single-model
  behavior unchanged).
- [x] Import/export: the fields ride the provider-settings schema and round-trip;
  the secret `openAiApiKey` keeps its existing export handling (excluded/handled
  as a secret exactly as today).
- [x] Focused tests per §8 covering UI binding/save, persistence/normalization,
  the value returned by `getStateToPostToWebview()`, and both on/off cases.
- [x] Run the narrowest Vitest suites from `webview-ui` and from the package
  dirs declaring Vitest.

## 10. Files touched (summary)

Menagerie:
- `packages/types/src/provider-settings/openai.ts` — add `openAiIsOmniRoute`,
  `openAiOmniRouteCustomRoutes`, `openAiOmniRouteReaderRouteId`,
  `openAiOmniRouteReasonerRouteId`.
- `packages/types/src/vscode-extension-host.ts` — remove `setOmniRouteTier`
  action + `routingTier`; add `omniRouteCatalog` messages. (No `WebviewMessage.tab`
  change — the OmniRoute settings section is a `SectionName`, not a top-level tab;
  see §2.1/Finding 9.)
- `packages/types/src/history.ts` — remove `taskRoutingSchema` and its three
  uses (`historyItemSchema.omnirouteRouting`, the `create_subtask`
  pending-action `omnirouteRouting`, the schema itself); tolerate legacy
  `omnirouteRouting` on load per §7.
- `src/core/task/omnirouteTier.ts` — reduce to flag `isOmniRoute` then likely
  delete.
- `src/core/task/Task.ts`, `providerHandoff.ts` — remove routing
  state/threading.
- `src/core/task/runParallelTasks.ts` — remove `withChildRouting`; resolve each
  worker's `openAiModelId` as `spec.route ?? roleDefault(spec.mode) ??
  parent.openAiModelId`; drop `routingTier` from `ParallelTaskResult`; add the
  `roleDefault` helper (here or a small sibling module).
- `src/core/tools/{SwitchModeTool,NewTaskTool}.ts`, `src/shared/tools.ts`,
  `src/core/prompts/tools/native-tools/*` — remove tier params/schemas; delete
  `routingTier.ts`.
- `src/core/tools/ParallelTasksTool.ts` — remove `routing_tier`/`routing_reason`
  from `parallelTaskSpecSchema`, add optional `route`, update the approval
  summary fragment.
- `src/activate/taskBoard.ts` — drop all `routing` references (field, tooltip,
  detail row, description fragment).
- `src/core/webview/webviewMessageHandler.ts` — remove the `userTaskRouting`
  call sites and the `setOmniRouteTier` case; add `omniRouteCatalog` handling.
- `src/core/webview/ClineProvider.ts` — remove the `initialOmniRouteRouting`
  createTask option and the `omnirouteRouting` params + routing computation from
  `initClineWithTask`/`initNewTask`; confirm the new provider fields ride along
  in `getState`/`getStateToPostToWebview` projection.
- `webview-ui/src/components/settings/SettingsView.tsx` — register `omniroute`
  section (SectionName only; no `WebviewMessage.tab` change); new
  `OmniRouteSettings.tsx` (endpoint, connection check, catalog, custom routes,
  and the reader/reasoner "Parallel worker defaults" pickers).
- `webview-ui/src/components/chat/ChatView.tsx` — remove tier state, the
  `usesOmniRoute` memo (second `omniroute.celestium.life` literal),
  `allowsHigherRoutingTiers`, the `routingTier`/`setOmniRouteTier` postMessages,
  and the `omnirouteRouting?.tier` read.
- `webview-ui/src/components/chat/ChatTextArea.tsx` — remove the four
  `routingTier*` props and the `<RoutingTierSelector>` render.
- `webview-ui/src/components/chat/RoutingTierSelector.tsx` — delete.
- i18n `settings:sections.omniroute`, remove `chat:routingTier.*`.
- Tests per §8; delete `omnirouteTier.spec.ts` and
  `RoutingTierSelector.spec.tsx`; update `ChatView.spec.tsx`,
  `ChatTextArea.spec.tsx`, and the migrated `omniroute.celestium.life` fixtures.

OmniRoute: **no changes** (§6).

## 11. Responses to design review findings

Review: `.agents/tasks/omniroute-integration/design-review.md`
(`design-review.json`), verdict CHANGES_REQUESTED — 3 HIGH, 4 MEDIUM, 3 NIT. All
resolved by the revisions above; each response verified against source.

- **Finding 1 (HIGH) — `ChatView.tsx`/`ChatTextArea.tsx` tier wiring missing:**
  ADDRESSED. §4.6 rewritten from a single-component note into a full chat-webview
  inventory: `ChatView.tsx` (`newTaskRoutingTier` state + reset effect,
  `usesOmniRoute` memo, `allowsHigherRoutingTiers`, the `newTask`/`setOmniRouteTier`
  postMessage payloads and dependency array, the `omnirouteRouting?.tier` read),
  `ChatTextArea.tsx` (four `routingTier*` props + import + `<RoutingTierSelector>`
  render), and deletion of `RoutingTierSelector.tsx`. §4.8 adds
  `ChatView.spec.tsx`, `ChatTextArea.spec.tsx`, and (delete)
  `RoutingTierSelector.spec.tsx`. §10 lists all three source files. Line numbers
  confirmed by grep.

- **Finding 2 (HIGH) — criterion (a) only partly satisfied (second literal):**
  ADDRESSED. Confirmed by repo-wide grep that `omniroute.celestium.life` has
  exactly two production hits (`omnirouteTier.ts:29`, `ChatView.tsx:138`) plus
  fixtures. §1.1 and the Overview now state both production copies are removed;
  §4.6 removes the `ChatView.tsx` copy; §4.8 migrates the fixtures
  (`Task.spec.ts`, `ChatView.spec.tsx`, `omnirouteTier.spec.ts` deleted with its
  file); §8 adds a "zero occurrences remain (grep-verified)" acceptance test.

- **Finding 3 (MEDIUM) — admission values stated as fact:** ADDRESSED. §5 and §6
  downgraded to "OmniRoute exposes `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` /
  `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS` (heavy-in-flight uncapped by default)"; the
  specific `=4`/`=30000` numbers are dropped and setting a concrete cap is called
  out as a k8s-manifest ops task, not a code change. The single-owner conclusion
  is unchanged.

- **Finding 4 (MEDIUM) — per-model `url` missing `#models.ai.azure.com`:**
  ADDRESSED. §1.2 quotes the real value including the always-appended
  `#models.ai.azure.com` fragment, requires verbatim use (no strip/re-append),
  notes fragments are not transmitted by fetch/axios, and §8 adds a catalog-entry
  test asserting verbatim url use.

- **Finding 5 (MEDIUM) — `prefix=alias` only proven for `/v1/models`:** ADDRESSED.
  §3 adds the end-to-end note: the tokenized `models/route.ts` forwards the
  request into `getUnifiedModelsResponse`, and `catalog.ts:335` reads
  `searchParams.get("prefix")`, so `prefix` propagates through the tokenized base;
  the design keeps the tokenized base, not the guide's `/v1/models` base.

- **Finding 6 (MEDIUM) — tier-suffix semantics over-generalized:** ADDRESSED. The
  Overview drops the "publishes tier as model-id suffixes" generalization; §2.2
  now states service-tier suffixes (`__tier_priority`/`__tier_flex`) are
  Codex-only, reasoning-effort suffixes (`-high`/`-medium`/`-low`) are the general
  axis, and local-GPU spread comes from combos/admission, not tier suffixes.

- **Finding 7 (NIT) — nonexistent `/api/v1/combos/[token]`:** ADDRESSED. §2.2, §5,
  and §6 now reference only the verified `/api/v1/vscode/<token>/combos` and
  explicitly note the top-level path does not exist.

- **Finding 8 (NIT) — "k8s ClusterIP range" wording:** ADDRESSED. §1.3 and the
  Overview now say "reached over the `omniroute` WireGuard interface"
  (tunnel address `192.168.133.2/28`) and mark the exact route target out of
  scope.

- **Finding 9 (NIT) — SectionName vs `WebviewMessage.tab` conflation:** ADDRESSED.
  §2.1 clarifies only `sectionNames`/`SectionName` (+ automatic i18n/search
  registry) needs the entry; `WebviewMessage.tab` is explicitly not touched, and
  deep-linking (if ever needed) uses `targetSection: "omniroute"`. §10 updated to
  match.

- **Finding 10 (HIGH) — role-based per-worker model selection unspecified:**
  ADDRESSED. §5 restructured into §5.1–§5.4: §5.1 separates `parallelToolExecution`
  (native reads, no model) from `parallelTasks` (agent workers that call models);
  §5.2 defines the resolution order `spec.route ?? roleDefault(spec.mode) ??
  parent.openAiModelId` (pure id pass-through, OmniRoute owns placement); §5.3
  adds the two new OmniRoute-profile fields `openAiOmniRouteReaderRouteId` /
  `openAiOmniRouteReasonerRouteId`, edited in the ONE OmniRoute tab as
  "Parallel worker defaults" pickers, with reader = `project-reader`/read-only
  modes and reasoner = everything else, both falling back to the parent model. §4.4
  adds `route` to the tool schema and appends the in-scope `spec.route` (only) to
  the approval summary; §4.5
  updates `runParallelTasks.ts`; §8 adds three-tier resolution + `roleDefault`
  coverage and asserts `parallelToolExecution` is unaffected; §9 runs both new
  fields through the Persisted-Setting Checklist; §10 lists every touched file.

### Responses to revision-2 review findings

Review (revision 2): `.agents/tasks/omniroute-integration/design-review.md`
(`design-review.json`), verdict CHANGES_REQUESTED — 0 HIGH, 2 MEDIUM, 2 NIT. All
resolved by the revisions above; each response verified against source.

- **Finding 1 (MEDIUM) — tool-arg migration mechanism unspecified / conflicts with
  `.strict()`:** ADDRESSED. §7 now specifies the mechanism per subsystem: for the
  Zod-parsed `parallel_tasks`, change `parallelTaskSpecSchema` from `.strict()` to
  `.strip()` for the transition release (the only `ZodObject` mode that accepts an
  unknown key and drops it), leaving `parallelTasksSchema` unchanged, and restore
  `.strict()` in a later release; for the hand-read `new_task`/`switch_mode`,
  simply not reading `routing_tier`/`routing_reason` is the tolerate step and no
  schema change applies. §4.4 repeats the `.strict()` → `.strip()` transition step
  for `parallelTaskSpecSchema`, and §8 pins the transitional test to `.strip()`
  behavior (stray key parses-and-drops, not rejected) with the hand-read tools
  succeeding with the keys unread.

- **Finding 2 (MEDIUM) — approval-summary output ambiguous ("may/optionally") and
  resolved id out of scope:** ADDRESSED. §4.4 now makes one concrete choice with
  no "may/optionally": the summary becomes `${spec.name} (${spec.mode})` and, when
  `spec.route` is set, appends `spec.route` verbatim (that value is in scope in
  `ParallelTasksTool.ts`); it explicitly does **not** show the role-defaulted or
  parent-fallback id, because `roleDefault`/`parent.openAiModelId` resolution
  happens later in `runParallelTasks.ts` and would require new plumbing that is
  out of scope. §5.2/§11's summary reference is aligned to the in-scope
  `spec.route` only.

- **Finding 3 (NIT) — imprecise negative combos-path claim:** ADDRESSED. §2.2 and
  §5 are reworded to the positive verified fact: the client uses the tokenized
  `/api/v1/vscode/<token>/combos`, and a non-tokenized top-level `/api/v1/combos`
  route also exists but is not the surface used here. The "there is no
  `/api/v1/combos/<token>`" phrasing is dropped.

- **Finding 4 (NIT) — §4.7 mislabeled taskBoard string:** ADDRESSED. §4.7 now
  names both surfaces precisely: the `tier` const (≈104) feeds the **"Requested
  capability"** card (≈137), and the **"Requested tier:"** tree tooltip rows are
  at (≈188–189); all `row.routing` reads (≈104, ≈137, ≈188–189, ≈214) are removed.
