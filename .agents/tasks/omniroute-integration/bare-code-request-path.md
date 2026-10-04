# Root cause: bare `code` sent to OmniRoute instead of `hybrid/code`

Branch: `feat/parallel-tasks-import` (HEAD `1ea74fefe`)
Repo: `/Users/celes/sources/celesrenata/menagerie`
Mode: read-only investigation. No code was modified.

## Summary answer (read this first)

There is **no second, unguarded prefix-stripping site on the request path.** The
OpenAI-compatible request path transmits `openAiModelId` **verbatim** as the chat
`model` field — it never strips a `tier/` prefix. The confirmed `cleanModelId`
strip site (`ProviderSettingsManager.ts:397`) is display-only and already guarded
for OmniRoute, as the brief states.

The bug is one layer earlier: **the value stored in `openAiModelId` is already the
bare id (`code`), because the OmniRoute catalog is fetched with `prefix=alias` and
the webview stores the catalog entry's `id` verbatim.** Under `prefix=alias`,
OmniRoute advertises _alias_ ids (bare role names such as `code`, `reader`,
`research`) — **not** the `tier/role` combo ids (`hybrid/code`, `local/code`) that
the chat/completions endpoint actually requires. So:

1. User opens the OmniRoute catalog → it lists alias ids like `code`.
2. User clicks one → `OmniRouteSettings.tsx` sets `openAiModelId = entry.id` = `"code"` (bare).
3. The value is saved verbatim and later sent verbatim by `OpenAiHandler`.
4. OmniRoute's chat endpoint rejects `code`: _"Unable to determine provider for model 'code'."_

The working curl (`local/long`, `ds4-glm53`) succeeds precisely because it uses a
full combo id, which is a **different id namespace** from the catalog's alias ids.

Recommended fix (details in the last section): make the model id that reaches the
chat request a full combo/route id, not a bare alias — either by storing a combo
id when a catalog alias is selected, or by fetching combos (not aliases) for the
selectable list. Do **not** add another strip/guard on the handler; the handler is
already correct.

## Evidence — the request path is clean (no strip)

### `buildApiHandler` passes the model id straight through

`src/api/index.ts:163-188` — the OpenAI case simply does
`return new OpenAiHandler(options)`, where `options` is the profile spread
(`const { apiProvider, ...options } = configuration`). `openAiModelId` is passed
untouched.

### `OpenAiHandler` sends `openAiModelId` verbatim as `model`

`src/api/providers/openai.ts`:

- `createMessage` (streaming): `const modelId = this.options.openAiModelId ?? ""`
  (line ~92), then `model: modelId` in the request body (line ~162 streaming,
  line ~228 non-streaming). No `.split`, `.pop`, `.replace`, or basename call.
- `getModel()` (line ~294): `const id = this.options.openAiModelId ?? ""` →
  returns `{ id, ... }`. No shortening.
- `completePrompt` (line ~317): `model: model.id` where `model = this.getModel()`.
  This is the path that produced message #11's `OpenAI completion error: 400`
  (the `${this.providerName} completion error:` wrapper is unique to
  `completePrompt`; it is reached via `src/utils/single-completion-handler.ts:28`
  for one-shot calls like enhance-prompt / context condense).

A grep of `src/api/**` for `.pop()`, `.split('/')`, `.replace(/.*\//`,
`lastIndexOf("/")` finds only unrelated message-caching / SSE-buffer code — none
touch the model id. There is no basename-style helper on the request path.

### The confirmed strip site is display-only and already guarded (brief confirmed)

`src/core/config/ProviderSettingsManager.ts`:

- `cleanModelId(modelId, isOmniRoute?)` (lines 389-400) returns `modelId` verbatim
  when `isOmniRoute` is true; otherwise `modelId.split("/").pop()` (line 397).
- Its only caller is `listConfig()` (line 415), which builds the
  `ProviderSettingsEntry[]` **display metadata** for the profile dropdown. It does
  not build any outbound request. HEAD commit `1ea74fefe`
  ("fix(omniroute): preserve full route id in config metadata") added this guard —
  the "wrong layer" fix the brief describes. Confirmed: the bug persists because
  the request body never read from this path.

### The parallel-worker route path does NOT strip either

`src/core/task/parallelWorkerRouting.ts` — `resolveWorkerModelId(route, mode,
workerProfile, parentModelId)` is a pure pass-through: `route ?? roleDefault(mode,
profile) ?? parentModelId`. No tier/GPU math, no slash manipulation.
`src/core/task/runParallelTasks.ts:45` assigns the result straight to
`context.apiConfiguration.openAiModelId`. If the parent's `openAiModelId` is bare
`code`, every worker inherits bare `code` — the fan-out _propagates_ the bad id
but does not _create_ it.

## Evidence — the bare id originates at catalog selection (`prefix=alias`)

### The catalog fetch requests aliases, not combos

`src/api/providers/omniroute.ts` `fetchOmniRouteCatalog()`:

```
axios.get(`${base}/models`, { headers, params: { prefix: "alias" } })
```

Entries are parsed through `omniRouteCatalogEntrySchema`
(`packages/types/src/providers/openai.ts:22`), whose `id` is a plain
`z.string()` carried verbatim.

### The design doc states aliases are bare and the server strips, not the client

`docs/architecture/omniroute-integration-design.md` §1.2 and §2.2 block 3:

- Catalog fetch "hits `${base}/models?prefix=alias`."
- "Selecting an entry sets `openAiModelId`" and "The list surfaces whatever suffix
  variants OmniRoute emits **as ordinary selectable ids** — the client never
  parses or synthesizes them; OmniRoute strips the suffix and applies the effect
  server-side." (Content paraphrased from the design doc for compliance.)

The design's model is that the client stores the catalog id as-is and OmniRoute
resolves it. That holds only if the catalog id namespace matches the
chat-endpoint id namespace. The live symptom proves it does **not**: the chat
endpoint needs the `tier/role` combo (`hybrid/code`), but `prefix=alias` returns
the bare role (`code`). The slash in a combo id is meaningful (`tier/role`), and
the chat endpoint reads it as the provider/combo selector; a bare `code` has no
provider, hence "Unable to determine provider for model 'code'."

### The webview stores the catalog id verbatim

`webview-ui/src/components/settings/OmniRouteSettings.tsx` (catalog list, ~line
214):

```
onClick={() => setApiConfigurationField("openAiModelId", entry.id)}
```

`entry.id` is the alias id (`code`). Custom routes behave the same: block 4 stores
`{ name, modelId }` and selecting one just sets `openAiModelId` to that `modelId`
(design §2.2 block 4) — correct only if the user typed a full combo id.

### No other code assigns a bare `openAiModelId`

Grep of `src/**` for `openAiModelId =` / `openAiModelId:` outside tests finds only:
the parallel-worker assignment (pass-through, above) and the sibling provider
subclasses (moonshot/mimo/deepseek/kimi-code) that set their own fixed model ids —
none relevant to OmniRoute.

## Full call chain (saved profile → request body `model`)

```
OmniRoute catalog list (prefix=alias) → entry.id = "code"  (BARE — origin of bug)
  └─ OmniRouteSettings.tsx: setApiConfigurationField("openAiModelId", entry.id)
       └─ Save → ProviderSettingsManager stores apiConfig.openAiModelId = "code"
            └─ getModelId(apiConfig) → "code"  (OpenAI provider returns openAiModelId)
                 ├─ listConfig(): cleanModelId("code", true) → "code"  [display only; guard is a no-op here since already bare]
                 └─ buildApiHandler(config) → new OpenAiHandler(options)   [options.openAiModelId = "code"]
                      └─ createMessage / completePrompt: model: this.options.openAiModelId  → "code"
                           └─ OmniRoute chat/completions → 400 "Unable to determine provider for model 'code'"
```

The id is correct nowhere upstream — it was bare from the moment of catalog
selection. There is no point between "profile load" and "HTTP send" that strips a
prefix; the prefix was never present on this value.

## Note on message #10 (GLM-5.3 / "hybrid planner mode" / reader)

Message #10 ("menagerie still using glm53 in hybrid planner mode rather than using
a reader") is the parallel-worker role-default path, not the strip bug.
`parallelWorkerRouting.ts` `roleDefault(mode, profile)` returns
`openAiOmniRouteReaderRouteId` only for modes in `READER_MODES` (just
`"project-reader"`); every other mode gets `openAiOmniRouteReasonerRouteId`, else
the parent id. If reader routing is not taking effect, check that (a) the worker's
mode is actually `project-reader`, and (b) `openAiOmniRouteReaderRouteId` is set on
the profile. This is a separate configuration/routing question from the bare-`code`
request-path bug and is noted only to disambiguate the two reports.

## Existing test coverage of the request-path model id for OmniRoute

**None.** No test asserts that an OmniRoute profile's full route id reaches the
HTTP `model` field.

- `src/api/providers/__tests__/openai.spec.ts` exercises temperature, reasoning
  effort, max tokens, extra body — never asserts the `model` field value for an
  OmniRoute/`tier/role` id.
- `src/api/providers/__tests__/omniroute.spec.ts` covers `isOmniRoute`,
  `omniRouteTokenizedBaseUrl`, and catalog-schema parsing with example ids like
  `qwen3-27b` / `gpt-5.5-codex` — never a `tier/role` combo, never the request body.
- `src/core/config/__tests__/ProviderSettingsManager.spec.ts:458` ("preserves the
  full route id for OmniRoute profiles") covers only `listConfig()` display
  metadata — the already-guarded display layer, not the request body.
- `src/core/task/__tests__/Task.spec.ts:980` uses `openAiModelId: "qwen3-27b"`
  (no slash) and only asserts no `X-OmniRoute-Tier` header — nothing about the
  outbound model id.

A regression test should assert that, given an OmniRoute profile with
`openAiModelId = "hybrid/code"`, the `model` field in the
`client.chat.completions.create` call equals `"hybrid/code"` (and that selecting a
catalog entry yields a combo id, per the fix chosen below).

## Recommended fix (minimal, keeps the full route id on the request path)

The handler is already correct — **do not** add another guard or strip there. Fix
the id namespace at selection/storage so a full combo/route id is what gets saved
and sent.

Preferred (makes selection produce a valid chat id):

- Change the catalog so selectable chat ids are **combos** (`tier/role`), not bare
  aliases. Two viable approaches:
    - **A. Fetch combos instead of (or in addition to) aliases.** OmniRoute exposes
      a tokenized combos route `/api/v1/vscode/<token>/combos` (design §2.2 block 4,
      §5 — "verified"). Populate the selectable catalog from combos so `entry.id` is
      `hybrid/code` etc., and store that verbatim. This is the smallest change that
      makes the stored id valid for chat and matches the working curl's namespace.
    - **B. Prefix the alias with the chosen tier at selection time.** If the UI lets
      the user pick a tier (`hybrid` / `local`), store
      `openAiModelId = `${tier}/${entry.id}``instead of`entry.id`. Keep the
handler untouched. This requires a tier selector in `OmniRouteSettings.tsx`.

Interim mitigation (no code change): users can enter the full combo id as a
**custom route** (`openAiOmniRouteCustomRoutes`) — e.g. name "code" → modelId
`hybrid/code` — and select that, since custom routes are stored verbatim. This
confirms the diagnosis and unblocks use while the catalog fix lands.

Whichever is chosen, add the request-path regression test described above so a
future change cannot silently reintroduce a bare id. Note the design doc's
assumption ("OmniRoute strips the suffix server-side") is only true for
suffix _variants_ (effort/service-tier) layered on a valid combo base — it does
not hold for the `tier/` _prefix_, which the chat endpoint requires and does not
synthesize from a bare alias. The doc should be corrected to reflect that the
chat `model` must be a combo id.
