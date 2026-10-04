# Zoo (Roo Code fork) — Scoping: using a 3-GPU + many-model fabric for parallel work

**Mode:** read-only scoping. No files changed. Repo `/Users/celes/sources/celesrenata/menagerie`.
Prior ground-truth investigation read first: `.agents/tasks/zoo-reader-offload/findings.md` (file:line citations reused and re-verified below).

---

## Summary answer (read this first)

Two levers, independent of each other, buildable in parallel or separately:

- **Workstream A — Condensing API configuration port ("Lever 2").** Add a `condensingApiConfigId` setting and build a separate `ApiHandler` for the three condensing call sites so summarization/condensing runs on a chosen reader model instead of the orchestrator's GLM. **This fork already contains a near-identical feature — `enhancementApiConfigId` — that does exactly this round trip** (`src/core/webview/messageEnhancer.ts:51-55`: look up id in `listApiConfigMeta`, `providerSettingsManager.getProfile({ id })`, build handler). That reference implementation collapses the risk. **Effort ≈ 2.5–4 dev-days. Success ≈ 85–90%.** It moves condensing/folded-file summarization OFF GLM; it does **NOT** move individual inline `read_file` calls off GLM (architectural — confirmed again below).

- **Workstream B — Make parallel dispatch actually happen and spread across GPUs.** The **good news, verified in code: workers already run concurrently.** `runParallelTasks` dispatches with `Promise.all` through `parallelTaskPool = new ParallelTaskPool(4)` (`src/core/task/ParallelTaskPool.ts:52`), so up to 4 workers run at once — the Zoo side does NOT serialize them, and OmniRoute's fill-then-overflow across 5090→4070ti→GLM will light up the GPUs in parallel. The real gap is **how often dispatch happens** (LLM must call `parallel_tasks`) and the **role/route split** (`project-research` is currently a reasoner, not a reader; `READER_MODES = {project-reader}` only). Broadening automatic reader dispatch and fixing the role tiers reduce dependence on LLM goodwill. **Effort ≈ 3–6 dev-days depending on how far auto-dispatch is pushed. Success: high (90%) for the config/role fixes; medium (60–70%) for a robust automatic fan-out that doesn't regress existing behavior.**

**Build order recommendation:** Do **B's low-risk sub-parts first** (role/route tier alignment + relax `addSharedDocumentReader`), because they are small, immediately make the existing concurrency useful, and directly answer the user's "project-research should be a high reader" request. Then do **A** (the structural win that gets condensing off GLM globally without any LLM decision). They are independent — can be one combined effort or two workflows; I recommend **two features in one workflow, B-first.**

---

## Evidence (verified this session, with symbols)

### Concurrency model — workers DO run in parallel (answers B.3)

- `runParallelTasks` maps specs through `Promise.all(specs.map(...))` and each worker body runs inside `parallelTaskPool.run(signal, async () => {...})` (`src/core/task/runParallelTasks.ts` — the `const results = await Promise.all(` block).
- `ParallelTaskPool` is a real semaphore with `capacity` admitted concurrently: `drain()` admits while `active < capacity`; the module exports `new ParallelTaskPool(4)` (`src/core/task/ParallelTaskPool.ts:1-52`, capacity literal at `:52`).
- Each worker gets its own cloned git worktree (`createParallelWorkspace`) and its own `Task` runtime (`provider.createParallelTaskRuntime`), and its model id is resolved per-worker via `resolveWorkerModelId(...)` (`runParallelTasks.ts`, the `contexts = await Promise.all(...)` block). **Conclusion: concurrency is genuine; nothing on the Zoo side serializes the 4 workers.** The cap is 4, not 3 — fine for 3 GPUs.
- Caveat for GPU spread: real parallel GPU use requires the dispatched workers to resolve to _different_ OmniRoute routes. Today reader workers → `openAiOmniRouteReaderRouteId`, everything else → `openAiOmniRouteReasonerRouteId` (`parallelWorkerRouting.ts:22-24`). If every worker is `code`, they all share the reasoner route and OmniRoute's maxConcurrent=1 per connection serializes them at the fabric. So the **role/route split (B.1/B.5) is what actually lets 3 GPUs light up**, not the Zoo concurrency (which is already there).

### Dispatch is LLM-gated (answers B.4)

- `parallel_tasks` only runs when the orchestrator model emits the tool call; it requires the `parallelTasks` experiment and forbids nested dispatch (`src/core/tools/ParallelTasksTool.ts:48,51` region: `state.experiments?.parallelTasks` guard, `task.parallelWorker` guard).
- The ONE automatic reader is `addSharedDocumentReader` (`src/core/task/ParallelTaskReader.ts:46`), fired from `ParallelTasksTool.ts` right before dispatch. Its trigger is rigid: `specs.length !== 3 || specs.some(mode !== "code")` returns early (`ParallelTaskReader.ts:51`), and it needs ≥2 of the 3 code workers to reference the same `docs|specs|contracts/*` doc (`SHARED_DOCUMENT` regex at `:5`, `count < 2` continue). The added worker is `project-reader`, handed a bounded excerpt and explicitly told **not** to `read_file` (the generated `message` string, `:88-96`). It's an idle-GPU filler, not a general read-offload.

### Role/route tiers (answers B.1/B.5 and user message #7)

- `READER_MODES = new Set(["project-reader"])` (`parallelWorkerRouting.ts:10`). `project-research` is therefore treated as a **reasoner** and routes to `openAiOmniRouteReasonerRouteId`.
- There are exactly **two** route-id fields on the OmniRoute profile: `openAiOmniRouteReaderRouteId` and `openAiOmniRouteReasonerRouteId` (`packages/types/src/provider-settings/openai.ts:103,106`). **There is no third "high reader" field.** The user's design is three tiers — glm (mastermind/parent), qwen27b (high reader = coder/research reader), qwen9b (low reader). The current two-field model does not express "low reader vs high reader" directly; it expresses "reader vs reasoner." See options below.

### Inline reads cannot be offloaded (confirms A's non-goal, re-verified)

- Read tools return via `callbacks.pushToolResult` into the issuing task's own `userMessageContent`; `ToolCallbacks` carries no model handle (`src/core/tools/BaseTool.ts:9-14`). Result lands in `this.api`'s context next turn. No indirection exists. (Prior findings Q1, re-confirmed.)

### Condensing call sites all use `this.api` (A's targets, re-verified)

- `Task.condenseContext()` → `summarizeConversation({ ..., apiHandler: this.api })` at `src/core/task/Task.ts:~2007-2012`.
- `Task.handleContextWindowExceededError()` → `manageContext({ ..., apiHandler: this.api })` at `src/core/task/Task.ts:~4567-4575`.
- `Task.attemptApiRequest()` → `manageContext({ ..., apiHandler: this.api })` at `src/core/task/Task.ts:~4826-4834`.
- `manageContext` forwards `apiHandler` straight into `summarizeConversation` (`src/core/context-management/index.ts`, the `summarizeConversation({ messages, apiHandler, ... })` call). `summarizeConversation` takes `apiHandler` as a param and calls `apiHandler.createMessage(...)` (`src/core/condense/index.ts:302+`). **So threading a different handler in is a param change at 3 sites + plumbing, not a rewrite.**

### Reference implementation that de-risks A

- `enhancementApiConfigId` is a fully-wired "pick a different profile for a subtask" setting: schema in `global-settings.ts`, in `ExtensionState` (`packages/types/src/vscode-extension-host.ts:321`), persisted in `webviewMessageHandler.ts:2104-2107`, round-tripped in `ClineProvider.getState()`/`getStateToPostToWebview()` (`ClineProvider.ts:2649,2824,3061`), and consumed by building a handler from `providerSettingsManager.getProfile({ id })` (`src/core/webview/messageEnhancer.ts:51-55`). **`condensingApiConfigId` is a near-clone of this entire path.**

### Build/test commands (from `src/package.json`)

- Types: `pnpm --dir src exec tsc --noEmit` (or `pnpm --dir src check-types`).
- Lint (AGENTS.md gate): `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>`.
- Narrow tests: `pnpm --dir src exec vitest run <path>` (configs exist: `test:core`, etc.).
- webview-ui tests run from `webview-ui/`. Lifecycle changes also require `pnpm lifecycle:model-check` + `pnpm test` (AGENTS.md "Task Lifecycle Changes") — **neither workstream touches `taskLifecycle.ts`, so that gate does not apply** (confirm during impl).

---

## WORKSTREAM A — Condensing API configuration port

### (1) Ordered implementation plan

1. **Type + schema.** Add `condensingApiConfigId: z.string().optional()` to `globalSettingsSchema` (`packages/types/src/global-settings.ts`), modeled on `enhancementApiConfigId`. Add it to the `ExtensionState` `Pick<...>` list (`packages/types/src/vscode-extension-host.ts`, beside `enhancementApiConfigId` at `:321`).
    - _Verify:_ `pnpm --dir packages/types exec tsc --noEmit` passes.
2. **Persistence handler.** Add a `case "condensingApiConfigId"` to `webviewMessageHandler.ts` mirroring the `enhancementApiConfigId` case (`:2104-2107`): `updateGlobalState("condensingApiConfigId", message.text)` + `postStateToWebview()`. Add the message type if the webview sends a dedicated message (check `WebviewMessage` union); otherwise fold into the generic `updateSettings` path.
    - _Verify:_ `pnpm --dir src exec vitest run src/core/webview/__tests__/webviewMessageHandler.spec.ts`.
3. **getState round trip.** Add `condensingApiConfigId` to both the destructuring and the returned object in `ClineProvider.getState()` and to `getStateToPostToWebview()` (same three locations `enhancementApiConfigId` appears: `ClineProvider.ts:2649, 2824, 3061`). Default `undefined` = "use the task's own model" (preserves current behavior).
    - _Verify:_ `pnpm --dir src exec vitest run src/core/webview/__tests__/ClineProvider.spec.ts`.
4. **Build the condensing handler.** In `Task`, add a helper (e.g. `getCondensingApiHandler()`) that, when `condensingApiConfigId` is set and present in `listApiConfigMeta`, calls `providerSettingsManager.getProfile({ id })` and `buildApiHandler(settings)` (both already imported in Task.ts: `buildApiHandler` at `Task.ts:65`); otherwise returns `this.api`. Cache it per task; rebuild when config changes (mirror `enhancementApiConfigId` fallback-to-current logic in `messageEnhancer.ts:51-55`).
    - _Note:_ the provider ref is reachable from Task via `this.providerRef.deref()`. Confirm `providerSettingsManager` is accessible that way (it's `public` on ClineProvider: `ClineProvider.ts:354`).
    - _Verify:_ new unit test for the helper (handler built from the chosen profile; falls back to `this.api` when unset/missing).
5. **Thread into the 3 call sites.** Replace `apiHandler: this.api` with the resolved condensing handler at `Task.ts:~2012` (`condenseContext`), and pass it through `manageContext` at `Task.ts:~4575` and `~4834`. `manageContext`/`summarizeConversation` already accept `apiHandler` — no signature change needed there.
    - _Verify:_ `pnpm --dir src exec vitest run src/core/condense src/core/context-management src/core/task/__tests__` — existing condensing tests still pass; add a test asserting the chosen handler (not `this.api`) is used when configured.
6. **SettingsView UI (AGENTS.md cachedState rules).** Add a profile-picker control (reuse the `enhancementApiConfigId` picker component/pattern in the webview Prompts/Settings area). Bind to local `cachedState`, update `cachedState` on change, include `condensingApiConfigId` in the `updateSettings` payload in `handleSubmit()`. Follow the **full persisted-setting checklist** in AGENTS.md.
    - _Verify:_ `pnpm --dir webview-ui exec vitest run` on the SettingsView test; assert the control reads from `cachedState` and is included in the save payload (both set and unset cases, per AGENTS.md checklist).
7. **Import/export round-trip.** Since it's a plain id (not a secret), confirm it falls out of the existing `globalSettingsSchema` export/import for free; add a round-trip test only if the export path filters fields.
    - _Verify:_ existing settings import/export test suite.

### (2) Effort: **2.5–4 dev-days.** The `enhancementApiConfigId` clone removes design risk; most time is the SettingsView wiring + the full persisted-setting checklist tests AGENTS.md mandates, plus the 3-site threading and its tests.

### (3) Success probability: **85–90%.** Main risks: (a) SettingsView cachedState race if the checklist is shortcut (AGENTS.md explicitly warns); (b) the condensing handler must be rebuilt when the user switches the config mid-task — stale handler is the likeliest bug; (c) `summarizeConversation`'s `summaryMetadata` strips tools — confirm the chosen reader model accepts a tools-less `createMessage` (it already must, since GLM does). Low integration risk because the handler is a drop-in `ApiHandler`.

### (4) Achieves / does NOT achieve.

- **Achieves:** condensing + folded-file-context summarization (the heaviest read-adjacent model work) runs on a chosen reader model globally, with zero LLM decision required. Directly relieves GLM of the repeated summarize passes.
- **Does NOT:** move individual inline `read_file`/`list_files`/`search_files` results off GLM — those are architecturally bound to the issuing task's `this.api` (`BaseTool.ts:9-14`). No config can change that.

### (5) Regression risk: **Low.** Default `undefined` ⇒ `this.api` ⇒ byte-identical to today. The only new runtime branch is "config set and valid." Existing single-model behavior and existing parallelism are untouched (parallel workers each build their own `this.api`; condensing inside a worker would use the worker's own condensing config resolution — confirm workers read the same global setting, which is desirable).

---

## WORKSTREAM B — Make parallel task + parallel read dispatch actually happen and spread across GPUs

### (1) Ordered implementation plan (small → larger)

**B-i. Fix the role/route tiers (user message #7). Small, high-value.**

- Decide the tier model. The user wants: glm = parent/mastermind; qwen27b = high reader (coder/research reader); qwen9b = low reader. The code has only `readerRouteId` + `reasonerRouteId`. Two viable mappings:
    - **Option 1 (recommended, minimal): map user tiers onto existing fields.** `openAiOmniRouteReaderRouteId` = qwen9b (low reader), `openAiOmniRouteReasonerRouteId` = qwen27b (high reader). Then add `project-research` (and `visual-debug`, `auditor` per #7) to a HIGH tier and `project-reader` stays LOW. Problem: `code` workers would then also route to qwen27b (reasoner) — which the user _does_ want for coders ("qwen27b == coder/research reader"). This fits message #7 cleanly.
    - **Option 2 (cleaner, more work): generalize to a configurable mode→route map.** Replace the hardcoded `READER_MODES` set + two fields with a small map `{ "project-reader": lowRouteId, "project-research": highRouteId, "code": highRouteId, ... }` plus parent fallback. More faithful to "many models, 3 tiers," but requires a new settings shape + its own full persisted-setting checklist.
- **Recommendation: Option 1 first** (edit `READER_MODES` membership + document which field maps to which model), ship it, then consider Option 2 only if the two-field model proves too coarse. Option 1 is a 1-line `READER_MODES` change plus settings documentation; it immediately makes `project-research` route differently from `project-reader`.
    - Files: `src/core/task/parallelWorkerRouting.ts` (`READER_MODES`), and the OmniRoute settings tab labels in webview-ui (clarify which field = which tier).
    - _Verify:_ `pnpm --dir src exec vitest run src/core/task/__tests__/parallelWorkerRouting.spec.ts` — update the existing role tests (they currently assert only `project-reader` is a reader).
    - **Caveat the user must decide:** with only two route fields, you cannot simultaneously have (project-reader→9B) AND (project-research→27B) AND (code→27B) AND (reasoner-fallback→something-else) unless 27B is the single reasoner route. Message #7 is consistent with "27B = the one reasoner route, 9B = the one reader route," so Option 1 works. Flag this explicitly in the PR.

**B-ii. Relax `addSharedDocumentReader` so auto-readers fire more often. Medium.**

- Current trigger (`ParallelTaskReader.ts:51`) requires exactly 3 workers, all `code`, ≥2 sharing a doc. Broaden to: fire when there are ≥2 workers and at least one references a shared doc, up to the 4-worker cap, and allow the mix to include non-`code` workers. Keep the read-only, excerpt-only, no-`read_file` contract (that part is sound).
    - Files: `src/core/task/ParallelTaskReader.ts` (relax guards), `src/core/tools/ParallelTasksTool.ts` (it already respects the 2–4 `parallelTasksSchema.min(2).max(4)` cap, so the added reader must not push past 4 — add a `specs.length < 4` guard).
    - _Verify:_ `pnpm --dir src exec vitest run src/core/task/__tests__/ParallelTaskReader.spec.ts src/core/tools/__tests__/ParallelTasksTool.spec.ts` — extend cases for 2-worker and mixed-mode shapes; assert the 4-cap is never exceeded.

**B-iii. (Optional, larger) Add a structural "fan out reads to a reader worker" path.**

- The honest truth: there is **no code path** that auto-dispatches a reader for a plain investigation turn; dispatch requires the orchestrator LLM to call `parallel_tasks`. A structural fix would need a new trigger — e.g. when the orchestrator issues N inline reads in a turn above a threshold, synthesize a `project-reader` worker — but this is invasive (touches the agent loop in `Task.recursivelyMakeClineRequests`/tool dispatch) and risks changing behavior unpredictably.
    - **Recommendation: do NOT build B-iii in the first pass.** It's the highest-risk, lowest-certainty lever. Prefer the prompt/mode lever (below) + B-i/B-ii, which make the _existing_ dispatch useful and better-routed.

**B-iv. Prompt/mode lever (cheap, complementary — flagged, not the structural focus).**

- The orchestrator-not-dispatching problem is **partly** a prompt issue: the `parallel_tasks` tool description and `rules.ts` already nudge delegation (`src/core/prompts/tools/native-tools/parallel_tasks.ts:8`, `src/core/prompts/sections/rules.ts:170-173`). Strengthening the `spec-orchestrator`/`orchestrator` mode content (in `src/assets/marketplace/modes.yml`) to delegate reading-heavy investigation would help, but it depends on model discipline — exactly what the user is frustrated by. Treat as a cheap add-on, not the fix.

### (2) Effort.

- B-i (role tiers): **0.5–1 dev-day** (incl. test updates + settings-label clarity).
- B-ii (relax auto-reader): **1–2 dev-days** (guards + tests + the 4-cap edge).
- B-iii (structural auto-fan-out): **3–5 dev-days** and architecturally risky — **recommend deferring.**
- B-iv (prompt/mode): **0.5 dev-day.**
- **Realistic first-pass B (i+ii+iv): 2–3.5 dev-days.**

### (3) Success probability.

- B-i: **90%+** (tiny, well-tested surface).
- B-ii: **75–85%** (edge cases around the 4-cap and mixed modes; existing tests give a safety net).
- B-iii: **55–65%** (invasive, could regress the agent loop) — the reason to defer.
- Overall first-pass B (i+ii+iv): **~85%.**

### (4) Achieves / does NOT achieve.

- **Achieves:** `project-research` (and chosen modes) route to the intended model tier; auto-reader fires in more realistic fan-out shapes; the already-concurrent pool (cap 4) finally spreads across GPUs because workers resolve to different routes. 3 GPUs light up whenever ≥2 differently-routed workers are dispatched.
- **Does NOT:** force the orchestrator to dispatch on every reading-heavy turn (that's B-iii / prompt discipline). Does NOT change that inline parent reads stay on GLM (same architectural limit as A's non-goal).

### (5) Regression risk.

- B-i: **Low-moderate.** Changing `READER_MODES`/field semantics alters which model existing dispatched workers use. Existing single-model behavior (unset route fields ⇒ parent model) is preserved. Risk is a mis-mapped tier sending `code` workers to a 9B — mitigated by the explicit field-mapping decision + tests.
- B-ii: **Moderate.** Broadening the auto-reader trigger means it fires in more cases; the 4-cap guard is essential or `parallelTasksSchema.max(4)` throws. Covered by extending existing specs.
- B-iii: **High** (why it's deferred).
- Existing concurrency is untouched by i/ii/iv — the pool and `Promise.all` dispatch are unchanged.

---

## Interaction / ordering between A and B

- **Independent.** A touches condensing/settings/Task condensing sites; B touches parallel routing/auto-reader. No shared files except that both add settings (different ones) and both must follow the AGENTS.md persisted-setting checklist. No ordering dependency; neither blocks the other.
- **Can be one combined effort or two workflows.** Recommend **one workflow, two features, B-first** — B-i/B-ii are small and immediately make the existing (already-concurrent) machinery useful and correctly tiered, which is the user's loudest pain ("3 GPUs, many models, we're dying"). A is the bigger structural win but is a background improvement (condensing) the user won't "see light up GPUs."

## Final recommendation — fastest path to 3 GPUs doing parallel work, least risk

1. **First: Workstream B-i (role/route tier fix).** ~0.5–1 day, 90% success, directly implements the user's message #7 tier design and makes the existing `ParallelTaskPool(4)` concurrency actually spread across 5090/4070ti/GLM. This is the single highest ratio of "GPUs light up" to effort/risk. Decide the two-field→three-tier mapping (Option 1) and flag the constraint in the PR.
2. **Then: Workstream B-ii (relax auto-reader).** ~1–2 days, makes a reader worker fire in more fan-out shapes so the 3rd GPU isn't idle.
3. **In parallel or next: Workstream A (condensing config port).** ~2.5–4 days, 85–90%, moves the heavy condensing/summarize load off GLM globally with no LLM decision. Low regression risk (default = today's behavior).
4. **Defer B-iii** (structural auto-fan-out of inline reads) — highest risk, lowest certainty; revisit only if B-i/ii + A don't relieve the pressure.
5. **Do NOT expect** any of this to move individual inline `read_file` calls off GLM — that is architectural (`BaseTool.ts:9-14`); the only mitigation is delegation (dispatched workers) which B improves.

**Crisp answers to the user's three questions:**

- _How much work each?_ A ≈ 2.5–4 dev-days; B first-pass (i+ii+iv) ≈ 2–3.5 dev-days (B-iii, deferred, +3–5).
- _Chances of success for parallelism?_ High — concurrency already works (`ParallelTaskPool(4)` + `Promise.all`); the win is routing workers to different models (B-i, 90%).
- _Things still working when done?_ Low regression risk for A (default-off = identical behavior) and B-i; moderate for B-ii (guard the 4-cap); high for the deferred B-iii.

---

## Citation index

- `src/core/task/ParallelTaskPool.ts:1-52` — real semaphore; `new ParallelTaskPool(4)` at `:52`.
- `src/core/task/runParallelTasks.ts` — `Promise.all(specs.map(...))` dispatch; per-worker `resolveWorkerModelId`; `parallelTaskPool.run(...)`.
- `src/core/task/parallelWorkerRouting.ts:10,22-24,32-39` — `READER_MODES = {project-reader}`, `roleDefault`, `resolveWorkerModelId`.
- `src/core/task/ParallelTaskReader.ts:5,11,46,51,88-96` — narrow auto-reader trigger + excerpt-only, no-`read_file` message.
- `src/core/tools/ParallelTasksTool.ts:48,51` — experiment gate, nested-dispatch guard, `addSharedDocumentReader` call, 2–4 cap.
- `src/core/tools/BaseTool.ts:9-14` — `ToolCallbacks` carry no model handle (inline reads bound to `this.api`).
- `src/core/task/Task.ts:65` (`buildApiHandler` import), `~2007-2012`, `~4567-4575`, `~4826-4834` — condensing call sites, all `apiHandler: this.api`.
- `src/core/context-management/index.ts` (`manageContext` → `summarizeConversation`), `src/core/condense/index.ts:302+` — `apiHandler` is a param already.
- `src/core/webview/messageEnhancer.ts:51-55` — reference impl: `getProfile({ id })` + build handler from `enhancementApiConfigId`.
- `packages/types/src/global-settings.ts` (`customCondensingPrompt`), `packages/types/src/vscode-extension-host.ts:321` (`enhancementApiConfigId` in `ExtensionState`).
- `src/core/webview/ClineProvider.ts:2649,2824,3061` (`enhancementApiConfigId` round trip), `:354` (`providerSettingsManager` public), `:1796,3425` (`getProfile`).
- `src/core/webview/webviewMessageHandler.ts:2104-2107` — `enhancementApiConfigId` persistence case.
- `packages/types/src/provider-settings/openai.ts:103,106` — `openAiOmniRouteReaderRouteId` / `openAiOmniRouteReasonerRouteId` (only two route fields; no third "high reader" field).
- `src/assets/marketplace/modes.yml:3425+` — `project-research` custom mode (reasoner today).
- No `condensingApiConfigId` anywhere in `src/**` or vendored `node_modules/.pnpm/node_modules/zoo-code` — fork lacks the feature (confirmed).

Content was rephrased for compliance where external documentation was referenced.
