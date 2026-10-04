# Zoo Dispatch Gate — Findings

Read-only investigation. Repo: `/Users/celes/sources/celesrenata/menagerie`, branch `feat/omniroute-tier-dropdown-feat005`. No files modified.

## Summary answer (TL;DR)

**The brief's leading hypothesis — that `spec-orchestrator` is missing a tool GROUP (e.g. `modes`) that gates `parallel_tasks`/`new_task` — is FALSE.** `parallel_tasks` and `new_task` are members of `ALWAYS_AVAILABLE_TOOLS`, so they are injected into every mode's tool set regardless of the mode's `groups` array. The built-in `orchestrator` mode (which dispatches fine) has `groups: ["read"]` — it has no dispatch group either — proving no group is required. Adding a `modes` group to `spec-orchestrator` would change nothing.

**The tool IS being offered to GLM-5.3.** For `spec-orchestrator` with `experiments.parallelTasks=true`, `parallel_tasks` survives every filter in the effective-tool-policy pipeline and is placed in the native `tools` array sent to the OmniRoute endpoint with `tool_choice: "auto"`. So the problem is NOT "tool absent from the toolset."

**Single most likely cause:** the `parallel_tasks` tool schema is sent to the OpenAI-compatible OmniRoute endpoint under OpenAI **strict mode** (`strict: true`), and `convertToolSchemaForOpenAI` (base-provider) rewrites the schema in a way that is internally **contradictory with the tool's own description/rules**: it collapses the nullable fields `todos` and `route` (declared `["string","null"]`) down to a required, non-null `string`, while the description and the system rules explicitly instruct the model to pass `todos: null` / `route: null`. A model told to emit `null` for a field the strict schema now forbids from being null (and marks required) will tend to avoid the call entirely — and strict nested array-of-objects schemas are also the exact shape OpenAI-compatible proxies most often reject or silently refuse to invoke. This is the realistic reason a strong model reads the tool, finds it unsatisfiable as described, and keeps working inline instead.

**Minimal fix is a CODE change, not a mode/config change** (details in §Recommendation).

---

## Evidence (with citations)

### 1. How the native tool list is assembled for an OpenAI-compatible (OmniRoute) provider

Assembly order for the live agentic turn:

- `src/core/task/Task.ts` (main request path, ~line 5035): calls `buildNativeToolsArrayWithRestrictions({ mode, customModes, experiments, apiConfiguration, disabledTools: this.getDisabledTools(...), modelInfo, includeAllToolsWithRestrictions: supportsAllowedFunctionNames })`. `supportsAllowedFunctionNames` is `true` only for Gemini (`src/core/task/Task.ts:5028`), so for OmniRoute (`apiProvider=openai`) it is `false` → the **filtered** tool list is used directly.
- `src/core/task/build-tools.ts:86 buildNativeToolsArrayWithRestrictions` → `getNativeTools(...)` builds the full static list (which includes `parallelTasks`, `src/core/prompts/tools/native-tools/index.ts:60`), then calls `filterNativeToolsForMode(...)` (`build-tools.ts` ~:131).
- `src/core/prompts/tools/filter-tools-for-mode.ts:70 filterNativeToolsForMode` keeps a tool iff `policy.tools.has(resolveToolAlias(toolName))` (~:110), where `policy` comes from `resolveEffectiveToolPolicy(...)`.
- `src/core/prompts/tools/effective-tool-policy.ts:211 resolveEffectiveToolPolicy`:
    - Step 2 (~:245): seeds the allowed set from `getToolsForMode(modeConfig.groups)`.
    - Step 3 (~:249): drops any tool for which `isToolAllowedForMode(...)` is false.
- Final send: `src/api/providers/openai.ts:179` passes `tools: this.convertToolsForOpenAI(metadata?.tools)` with `tool_choice: metadata?.tool_choice` (="auto" normally) to the chat-completions endpoint.

`metadata.tools`/`tool_choice` are populated at `src/core/task/Task.ts` ~:5066–5081.

**`parallel_tasks` is NOT provider-gated and NOT XML-only.** The static native tool array (`native-tools/index.ts`) unconditionally includes `parallelTasks`, and no code removes it for `apiProvider=openai`/`openAiIsOmniRoute`. There is no XML-vs-native toggle in this fork; native tool calling is the path for the OpenAI provider.

### 2. `parallel_tasks` / `new_task` are NOT behind a tool group

- `src/shared/tools.ts:333–342 ALWAYS_AVAILABLE_TOOLS` includes `"new_task"` and `"parallel_tasks"`.
- `src/shared/modes.ts:28 getToolsForMode(...)`: adds each group's tools, then at :39 does `ALWAYS_AVAILABLE_TOOLS.forEach((tool) => tools.add(tool))`. So the always-available set is added **irrespective of `groups`**.
- `src/core/tools/validateToolUse.ts:148`: `parallel_tasks` is gated ONLY by the experiment (`if (resolvedTool === "parallel_tasks" && !experiments?.parallelTasks) return false`). With the experiment on, control falls to :151 `if (ALWAYS_AVAILABLE_TOOLS.includes(tool)) return true` — it never consults the mode's `groups`.
- There IS a `modes` group (`src/shared/tools.ts:327` → `tools: ["switch_mode","new_task","parallel_tasks"], alwaysAvailable: true`), but membership in it is redundant with `ALWAYS_AVAILABLE_TOOLS`; a mode does not need it.

**Comparison that settles it:** the built-in dispatching mode `orchestrator` has `groups: ["read"]` (`packages/types/src/mode.ts:229`) — no `modes`/dispatch group — yet its role text tells it to use `parallel_tasks`/`new_task` (`packages/types/src/mode.ts:231`). `spec-orchestrator` has strictly MORE groups (`['read','edit','mcp','command']`, verified in `~/sources/m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json`). Both receive `parallel_tasks` identically. The group difference the brief suspected does not exist.

### 3. Does native tool-calling for the OmniRoute provider include `parallel_tasks`?

Yes. Trace from §1 shows it reaches `tools` in `openai.ts`. Confirmed `experiments.parallelTasks=true` and `spec-orchestrator` groups in the flake template:

```
globalSettings.experiments = { parallelTasks: true, parallelToolExecution: true, runSlashCommand: true }
spec-orchestrator groups = ['read', ['edit', {fileRegex: ...}], 'mcp', 'command']
```

With the experiment on and spec-orchestrator loaded as a custom mode, `resolveEffectiveToolPolicy` returns a set that contains `parallel_tasks`, and `filterNativeToolsForMode` emits its definition. The reported "56 tools" in the live log is consistent with `parallel_tasks` being present among them.

### 4. Runtime gates that could silently drop `parallel_tasks`

- **Parallel-worker guard (not applicable to the orchestrator):** `src/core/task/Task.ts:240 getDisabledTools` adds `["new_task","parallel_tasks"]` to `disabledTools` only when `this.parallelWorker` is true; mirrored in `src/core/assistant-message/presentAssistantMessage.ts:462–465`. The orchestrator is the root task (`parallelWorker` false), so this does not fire for it.
- **Experiment gate:** `validateToolUse.ts:148` — satisfied (`parallelTasks=true`).
- **disabledTools / modelInfo.excludedTools:** `effective-tool-policy.ts` step 9 (~:300) and step 4 (~:270) would remove it, but only if the user/model lists it. No evidence it is listed; the OmniRoute-Hybrid-Planner profile would have to explicitly exclude it.
- **The strict-schema rewrite (the real suspect):** `src/api/providers/base-provider.ts:30 convertToolsForOpenAI` sets `strict: true` for every non-MCP tool and runs `convertToolSchemaForOpenAI` (`base-provider.ts:66`). That function:
    - forces `result.required = allKeys` for every object schema (`base-provider.ts:~91`) — i.e. ALL properties required, recursively; and
    - collapses nullable unions, `["string","null"] → "string"` (`base-provider.ts:~95`).

    Applied to `parallel_tasks` (`src/core/prompts/tools/native-tools/parallel_tasks.ts`), whose per-task item declares `todos: ["string","null"]` and `route: ["string","null"]` with `required: ["name","mode","message","todos","route"]`, the schema actually sent to OmniRoute says each task MUST include `todos` and `route` as **non-null strings**. But the tool's own `description` and the system rule both instruct the model to pass `todos: null` / `route: null`:
    - `native-tools/parallel_tasks.ts` description: `...,"todos":null}...` and `null inherits the mode's default`.
    - `src/core/prompts/sections/rules.ts:170–173` (the `hasParallelTasks` rule) and the `parallelToolExecution` rule (`rules.ts:176–179`) describe `parallel_tasks` usage.

    The model is thus handed a tool whose strict schema contradicts its instructions (null is required-and-forbidden simultaneously). A strong model that cannot form a schema-valid call it was told to make will decline the tool and proceed inline — exactly the observed behavior. Independently, `strict: true` on a nested `array → object` schema is the shape OpenAI-compatible gateways most frequently reject or refuse to invoke, which would produce the same "never dispatches" symptom without a hard error surfacing to the user.

    Note the handling in `ParallelTasksTool.ts` and the Zod schema (`parallelTaskSpecSchema`, `.strip()`, `todos`/`route` `.nullable().optional()`) are built to ACCEPT `null`/omitted — so the executor expects nullable values that the wire schema now forbids. The mismatch is between the executor's intent and the strict-mode wire rewrite.

### 5. Most likely reason + minimal fix

**Most likely single reason:** The dispatch tool reaches GLM-5.3, but the OpenAI strict-mode schema rewrite (`convertToolSchemaForOpenAI`) makes `parallel_tasks` effectively uncallable-as-described — `todos`/`route` are forced to required non-null strings while the model is instructed to pass `null` — so the model never emits a valid `parallel_tasks` (or `new_task`) call and keeps doing the work inline. This is a **native-tool-calling + OpenAI-compatible-provider + strict-mode** interaction, exactly the gate the brief flagged as "the key gate," but it is a schema-shape problem, not a mode-group problem.

**Precise minimal fix — CODE change (not a mode/group config change):** make the strict-mode schema rewrite preserve optional/nullable semantics for dispatch tools so the wire schema matches what the model is told to send. Options, smallest first:

1. In the `parallel_tasks` tool schema (`src/core/prompts/tools/native-tools/parallel_tasks.ts`), stop relying on nullable fields under strict mode: make `todos` and `route` genuinely optional by REMOVING them from the per-item `required` array (keep `required: ["name","mode","message"]`) rather than typing them as nullable. Under OpenAI strict mode, "optional" must be expressed by omission from `required`, not by a `null` union — and `convertToolSchemaForOpenAI` currently overrides any `required` you set by forcing `required = allKeys`, so this alone is insufficient without change (2).
2. In `src/api/providers/base-provider.ts:convertToolSchemaForOpenAI`, stop blindly forcing `result.required = allKeys`. Preserve the author-declared `required` (and keep nullable unions, or convert them to `type + "null"` the way OpenAI strict mode actually supports, instead of dropping `null`). This aligns the wire schema with the tool description for `parallel_tasks` and `new_task` and removes the contradiction.
3. If OmniRoute/GLM is confirmed to reject `strict: true` on nested array schemas, disable strict mode for the dispatch tools specifically (same mechanism already used for MCP tools at `base-provider.ts:~41`, `isMcp ? strict:false`), gating `parallel_tasks`/`new_task` to `strict: false`.

Recommended: (2) as the correct general fix (it also fixes `new_task`, which has an optional `todos`), with (1) as a belt-and-suspenders schema cleanup. Verify after the change by issuing one orchestrator turn and confirming a `parallel_tasks` tool call is emitted and dispatched.

**What NOT to do:** do not add a `modes` (or any) tool group to `spec-orchestrator` in `omniroute-zoo-profiles.template.json`. §2 proves the group is not the gate; the tool is already offered. That change would be inert.

---

## Appendix — key citations

- `src/shared/tools.ts:327` `modes` group; `:333–342` `ALWAYS_AVAILABLE_TOOLS` (incl. `new_task`, `parallel_tasks`).
- `src/shared/modes.ts:28–42` `getToolsForMode` always adds `ALWAYS_AVAILABLE_TOOLS`.
- `src/core/tools/validateToolUse.ts:148` experiment-only gate for `parallel_tasks`; `:151–153` always-available short-circuit.
- `src/core/prompts/tools/effective-tool-policy.ts:211` policy resolution; step 2 seed from `getToolsForMode`; `PROTOCOL_TOOLS = ["attempt_completion"]` (`:33`) re-adds only `attempt_completion`.
- `src/core/prompts/tools/filter-tools-for-mode.ts:70` keeps tools in `policy.tools`.
- `src/core/task/build-tools.ts:86` assembly; `src/core/prompts/tools/native-tools/index.ts:60` static inclusion of `parallelTasks`.
- `src/core/task/Task.ts:5028` Gemini-only `allowedFunctionNames`; `:5066–5081` tools/tool_choice; `:240` parallel-worker disable.
- `src/api/providers/openai.ts:179` tools sent to OmniRoute; `src/api/providers/base-provider.ts:30` `strict:true`; `:66` schema rewrite forcing `required=allKeys` and dropping `null`.
- `src/core/prompts/tools/native-tools/parallel_tasks.ts` nullable `todos`/`route` + description instructing `null`.
- `packages/types/src/mode.ts:222–231` built-in `orchestrator` with `groups:["read"]` yet dispatches.
- Flake: `~/sources/m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json` — `experiments.parallelTasks=true`, `spec-orchestrator` groups `['read','edit','mcp','command']`.
