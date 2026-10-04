# Implementation Plan — zoo-parallel-fabric

Three workstreams on ONE branch (`feat/omniroute-tier-dropdown-feat005`, per setup.md — no branch switch, no worktree). The three parts are independent (no ordering dependency) but ship together. Build order per scope.md: **B-i → B-ii → A**.

Global gates (AGENTS.md), applied per item that touches the relevant package:

- Types typecheck: `pnpm --dir packages/types exec tsc --noEmit`
- src typecheck: `pnpm --dir src exec tsc --noEmit`
- Lint-suppression gate, run after editing EACH file: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>` — the per-file suppression count must NOT increase.
- Narrow vitest: `pnpm --dir src exec vitest run <path>`; webview: `pnpm --dir webview-ui exec vitest run <path>`.
- Do **NOT** create `.changeset` files. Do **NOT** edit `CHANGELOG.md` or `src/CHANGELOG.md`.
- Task Lifecycle gate does **NOT** apply — no workstream touches `src/core/task-persistence/taskLifecycle.ts` (confirm during impl).

---

## Workstream B-i — role/route tier alignment (labeling + test-hardening, NOT a logic change)

VERIFIED against `src/core/task/parallelWorkerRouting.ts`: `READER_MODES = {project-reader}` (`:10`) + `roleDefault` reader-vs-reasoner split (`:22-24`) + `resolveWorkerModelId` precedence (`:32-39`) ALREADY yields the intended mapping under the confirmed two-field model (`openAiOmniRouteReaderRouteId` = LOW/9B reader, `openAiOmniRouteReasonerRouteId` = HIGH/27B reader shared by code workers AND project-research). So project-reader → reader(9B), project-research → reasoner(27B), code → reasoner(27B) is **already correct**. B-i is therefore a labeling/clarity + test-hardening change. Do **NOT** add project-research to `READER_MODES` (that would send it to the 9B field, the opposite of intent). Do **NOT** manufacture a logic change.

- [ ]   1. Clarify the OmniRoute parallel-worker-defaults labels/hints so each of the two route fields reads clearly: reader field = low reader (9B), reasoner field = high reader (27B) shared by coder + research.
       Edit the four label strings in `webview-ui/src/i18n/locales/en/settings.json` under `omniroute`: `readerRoute` → "Low reader model id (9B)", `readerPlaceholder` → clarify "project-reader low-tier reader workers", `reasonerRoute` → "High reader model id (27B) — coder + research", `reasonerPlaceholder` → clarify "shared by code workers and project-research". Keys and the `OmniRouteSettings.tsx` `t(...)` call sites (`:243,246,251,254`) are unchanged — labels only.
       Files: `webview-ui/src/i18n/locales/en/settings.json`
       Verify: `pnpm --dir webview-ui exec vitest run src/components/settings/__tests__/OmniRouteSettings` (if a suite exists for it) — renders without missing-key errors; otherwise `pnpm --dir webview-ui exec tsc --noEmit` passes. Confirm no other `en/*.json` key references these strings via `grep`.

- [ ]   2. Harden `parallelWorkerRouting.spec.ts` to lock the confirmed mapping as explicit regression assertions, documenting the two-field→three-tier intent in a comment.
       Add/adjust assertions: `project-reader` → reader route (9B field), `project-research` → reasoner route (27B field), `code` → reasoner route (27B field), and unset route fields → parent-model fallback (unchanged). Keep the existing `READER_MODES.has("project-reader") === true` assertion; add `READER_MODES.has("project-research") === false` to pin that project-research is intentionally NOT a reader-field member.
       Files: `src/core/task/__tests__/parallelWorkerRouting.spec.ts`
       Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/parallelWorkerRouting.spec.ts` — all pass. Then `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/__tests__/parallelWorkerRouting.spec.ts` — count not increased.

- [ ]   3. (Only if a code comment improves clarity) Expand the `READER_MODES`/`roleDefault` doc comments in `parallelWorkerRouting.ts` to state the confirmed field→tier mapping explicitly (reader field = low/9B; reasoner field = high/27B, shared by code + project-research). No code/logic change.
       Files: `src/core/task/parallelWorkerRouting.ts`
       Verify: `pnpm --dir src exec tsc --noEmit` passes; `pnpm --dir src exec vitest run src/core/task/__tests__/parallelWorkerRouting.spec.ts` still green; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/parallelWorkerRouting.ts` — count not increased.

---

## Workstream B-ii — relax `addSharedDocumentReader` auto-reader

Keep the sound parts: auto-reader stays read-only, excerpt-only, explicitly forbidden from calling `read_file` (message at `ParallelTaskReader.ts:88-96`). SHARED_DOCUMENT regex (`:5`) and AUTO_READER_NAME (`:11`) unchanged.

- [ ]   4. Broaden the trigger in `addSharedDocumentReader` (`ParallelTaskReader.ts:51`): fire when `specs.length >= 2` AND at least one spec references a shared doc; allow mixed (non-`code`) worker modes; and ALWAYS guard `specs.length < 4` so the appended reader never pushes past the 4-cap (`parallelTasksSchema.max(4)` would throw). Relax the `count < 2` shared-doc requirement to "at least one worker references the doc" (count >= 1) while preserving the sort-by-count selection so the most-shared doc still wins. Keep realpath/escape/size guards and the excerpt/no-read_file message intact. Update the hardcoded "Three sibling Code workers" preamble to be worker-count/mode agnostic (e.g. "N sibling workers").
       Files: `src/core/task/ParallelTaskReader.ts`
       Verify: `pnpm --dir src exec tsc --noEmit`; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/ParallelTaskReader.ts` — count not increased.

- [ ]   5. Extend `ParallelTaskReader.spec.ts` for the broadened trigger: (a) 2 code workers sharing a doc → reader added (length 3); (b) mixed-mode shape (e.g. one `code` + one `project-research`) sharing a doc → reader added; (c) single worker referencing a doc with another worker not referencing → fires when >=2 workers and >=1 references; (d) **4-cap edge**: 4 workers already present → NO reader appended, result length stays 4 (assert never exceeds 4); (e) existing read-only/no-`read_file`/escape-path cases still pass. Update the `workers()` helper usage for variable counts/modes.
       Files: `src/core/task/__tests__/ParallelTaskReader.spec.ts`
       Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/ParallelTaskReader.spec.ts` — all pass; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/__tests__/ParallelTaskReader.spec.ts` — count not increased.

- [ ]   6. Confirm `ParallelTasksTool.ts` still enforces the cap post-reader-append and add a cap-edge assertion to `ParallelTasksTool.spec.ts`. The tool calls `addSharedDocumentReader(requestedTasks, ...)` then `parallelTasksSchema.parse` already ran on `requestedTasks` (`.min(2).max(4)`); the appended reader is NOT re-validated by the schema, so the `specs.length < 4` guard in item 4 is the only thing preventing a 5th worker. Add a schema test asserting 5 workers rejected (already present) and a note/test that the reader-append path respects the cap. No `ParallelTasksTool.ts` logic change expected unless verification reveals the appended reader can exceed 4.
       Files: `src/core/tools/__tests__/ParallelTasksTool.spec.ts` (and `src/core/tools/ParallelTasksTool.ts` only if a cap gap is found)
       Verify: `pnpm --dir src exec vitest run src/core/tools/__tests__/ParallelTasksTool.spec.ts` — all pass; lint gate on any edited file — count not increased.

---

## Workstream A — condensing API configuration port (`condensingApiConfigId`)

Implement per the APPROVED design (`design.md`). Default `undefined`/`""` == use `this.api` (byte-identical to today).

- [ ]   7. Add the schema field + ExtensionState entry.
       In `packages/types/src/global-settings.ts` add `condensingApiConfigId: z.string().optional()` immediately after `enhancementApiConfigId` (`:271`). In `packages/types/src/vscode-extension-host.ts` add `| "condensingApiConfigId"` to the `ExtensionState` `Pick<GlobalSettings, ...>` union beside `enhancementApiConfigId` (`:320`). Do **NOT** add it to the `WebviewMessage.type` union (no dedicated message — batched save only, per design §1/§2).
       Files: `packages/types/src/global-settings.ts`, `packages/types/src/vscode-extension-host.ts`
       Verify: `pnpm --dir packages/types exec tsc --noEmit` passes.

- [ ]   8. Round-trip `condensingApiConfigId` through `ClineProvider` at all three `enhancementApiConfigId` locations: add to the `getStateToPostToWebview()` destructuring (`:2649`), to the object it returns (`:2824`, shorthand), and to the object returned by `getState()` as `condensingApiConfigId: stateValues.condensingApiConfigId` (`:3061`). Bare pass-through, no `?? ""` default (keep `undefined` canonical).
       Files: `src/core/webview/ClineProvider.ts`
       Verify: `pnpm --dir src exec vitest run src/core/webview/__tests__/ClineProvider.spec.ts`; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/webview/ClineProvider.ts` — count not increased.

- [ ]   9. Add persistence coverage proving the generic `updateSettings` path stores the value (no new handler case — design §2). Add a test to `webviewMessageHandler.spec.ts`: send `updateSettings` with `condensingApiConfigId` and assert `contextProxy.setValue("condensingApiConfigId", <value>)` + `postStateToWebview` ran.
       Files: `src/core/webview/__tests__/webviewMessageHandler.spec.ts`
       Verify: `pnpm --dir src exec vitest run src/core/webview/__tests__/webviewMessageHandler.spec.ts`; lint gate on the edited test — count not increased.

- [ ]   10. Add `Task.getCondensingApiHandler()` (private async) + the two cache fields (`condensingApiHandler?: ApiHandler`, `condensingApiHandlerConfigId?: string`) per design §4. Resolution: read `provider.getState()` for `condensingApiConfigId` + `listApiConfigMeta`; unset/empty/dead-provider/not-in-meta/no-`apiProvider`/thrown → return live `this.api` (never cache it); valid → `buildApiHandler(providerSettings)` cached keyed by config id. Single caching rule: if `currentId === this.condensingApiHandlerConfigId` reuse prior decision; else re-resolve. Guard the missing-id case against `getProfile`'s throw (`ProviderSettingsManager.ts:480`) via the `listApiConfigMeta` membership check; wrap `getProfile`/`buildApiHandler` in a defensive `try/catch` that `provider.log(...)`s per-call and falls back to `this.api`. `buildApiHandler` already imported (`Task.ts:64`); `providerSettingsManager` is `public readonly` on `ClineProvider` (`:354`), reached via `this.providerRef.deref()`.
        Files: `src/core/task/Task.ts`
        Verify: `pnpm --dir src exec tsc --noEmit`; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 src/core/task/Task.ts` — count not increased.

- [ ]   11. Add a unit test for `getCondensingApiHandler()` covering design §7 cases (a)–(f): unset → `this.api` (identity); id absent from meta → `this.api` and `getProfile` NOT called; valid → built handler (assert `buildApiHandler` called with resolved settings, result ≠ `this.api`); no `apiProvider` → `this.api`; `getProfile` throws → `this.api` + logged; mid-task change (id A caches, id B rebuilds, unset → `this.api`). Mock provider, `getState`, `providerSettingsManager.getProfile`, `buildApiHandler`.
        Files: `src/core/task/__tests__/` (new or existing Task condensing-handler spec)
        Verify: `pnpm --dir src exec vitest run src/core/task/__tests__/<new-spec>`; lint gate — count not increased.

- [ ]   12. Thread the resolved handler into the three condensing call sites, resolving per-invocation (not at construction): `condenseContext()` → `summarizeConversation({ ... })` (`Task.ts:~2011`), `handleContextWindowExceededError()` → `manageContext({ ... })` (`:~4575`), `attemptApiRequest()` → `manageContext({ ... })` (`:~4834`). At each: `const condensingApiHandler = await this.getCondensingApiHandler()` then pass `apiHandler: condensingApiHandler`. No signature change to `manageContext`/`summarizeConversation` (both already accept `apiHandler`).
        Files: `src/core/task/Task.ts`
        Verify: `pnpm --dir src exec vitest run src/core/condense src/core/context-management src/core/task/__tests__` — existing condensing tests pass; add a three-site threading assertion (handler returned by `getCondensingApiHandler()` is passed as `apiHandler` at each site; equals `this.api` when unset, built handler when set). Lint gate on `Task.ts` — count not increased.

- [ ]   13. Add the `cachedState`-bound condensing profile picker to the webview (design §6). In `webview-ui/src/context/ExtensionStateContext.tsx` add `condensingApiConfigId?: string` to the context type + default `condensingApiConfigId: ""` (mirror `enhancementApiConfigId` at `:110,:228`). In `ContextManagementSettings.tsx` add `"condensingApiConfigId"` to the `SetCachedStateField<...>` key union (`:48-51`), add the field as a prop, and render a `Select`/`SelectItem` picker (pattern from `PromptsSettings.tsx:166-190`) listing `listApiConfigMeta` with a `"-"` = "use current configuration" option mapping to `""`; annotate the `.map` callback param as `{ id: string; name?: string }` to avoid implicit-any. Bind to the destructured `cachedState` value; `onValueChange` → `setCachedStateField("condensingApiConfigId", value === "-" ? "" : value)`. MUST NOT `postMessage` on change or read live `useExtensionState()`. In `SettingsView.tsx` pass the field/prop down to `ContextManagementSettings` and add `condensingApiConfigId: condensingApiConfigId ?? ""` to the `updatedSettings` object in `handleSubmit()` (`:390` block).
        Files: `webview-ui/src/context/ExtensionStateContext.tsx`, `webview-ui/src/components/settings/ContextManagementSettings.tsx`, `webview-ui/src/components/settings/SettingsView.tsx`
        Verify: `pnpm --dir webview-ui exec tsc --noEmit`.

- [ ]   14. Add webview tests (design §7 case 6): (a) set — in `ContextManagementSettings.spec.tsx` select a profile, assert `setCachedStateField("condensingApiConfigId", <id>)`; in `SettingsView.spec.tsx` drive + Save, assert `updateSettings` payload `updatedSettings.condensingApiConfigId === <id>`. (b) unset — `"-"` maps to `""`, Save carries `condensingApiConfigId: ""`. (c) cachedState binding/revert-on-discard — mirror `SettingsView.unsaved-changes.spec.tsx:736-762`: live value `""`, select a profile, assert NO `postMessage` on change, Done → discard, assert picker reverts to live `""` and no `updateSettings` carried the discarded id.
        Files: `webview-ui/src/components/settings/__tests__/ContextManagementSettings.spec.tsx`, `.../SettingsView.spec.tsx`, `.../SettingsView.unsaved-changes.spec.tsx`
        Verify: `pnpm --dir webview-ui exec vitest run src/components/settings/__tests__/ContextManagementSettings.spec.tsx src/components/settings/__tests__/SettingsView.spec.tsx src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx` — all pass.

- [ ]   15. Add an import/export round-trip assertion (design §7 case 5). `condensingApiConfigId` is a plain string in `globalSettingsSchema`, not in `globalSettingsExportSchema.omit({...})` (`ContextProxy.ts:35`), so it round-trips for free via `importSettingsFromPath`'s `setValues` (`importExport.ts:231`). Add a test to the import/export suite asserting export includes it and import restores it (not stripped). No production change.
        Files: `src/core/config/__tests__/importExport.spec.ts` (or the suite that owns import/export)
        Verify: `pnpm --dir src exec vitest run <importExport spec path>`; lint gate on the edited test — count not increased.

---

## Final integration verification (whole-task)

- [ ]   16. Run the full gates across all touched packages and confirm no suppression counts increased.
        Verify: `pnpm --dir packages/types exec tsc --noEmit` && `pnpm --dir src exec tsc --noEmit` && `pnpm --dir webview-ui exec tsc --noEmit`; re-run each touched area's narrow vitest suites (B-i routing, B-ii reader+tool, A condense/context-management/task/webview/ClineProvider/importExport, and the webview SettingsView suites); run the per-file lint-suppression gate on every edited `src/` file and confirm counts did not increase. Confirm NO `.changeset` file was created and `CHANGELOG.md`/`src/CHANGELOG.md` were not edited.

## Assumptions / gaps

- Exact `ClineProvider.ts`, `Task.ts`, `global-settings.ts` line numbers may drift slightly from the cited positions; locate by the `enhancementApiConfigId` anchor rather than the literal line.
- Whether a dedicated `OmniRouteSettings` vitest suite exists is unconfirmed; item 1 falls back to a typecheck + grep verification if none exists.
- Item 6 assumes `ParallelTasksTool.ts` needs no logic change; if verification shows the appended reader can exceed the 4-cap, add the guard there as well (item 4's `specs.length < 4` guard should already prevent this).
