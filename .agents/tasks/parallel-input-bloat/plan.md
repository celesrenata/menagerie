# Parallel-Worker Input Bloat — Implementation Plan

Derived from the APPROVED design at `.agents/tasks/parallel-input-bloat/design.md`
(reviewer verdict `design-review.json`). This plan sequences the work; it does not
re-decide the architecture. Repo root: `/Users/celes/sources/celesrenata/menagerie`.

Build/test facts discovered during exploration:
- Monorepo (pnpm@10.8.1, Node 22). Each package runs `vitest run`.
- `src/` suite: run from `src/` with `pnpm exec vitest run <path>`.
- `packages/types/` suite: run from `packages/types/` with `pnpm exec vitest run <path>`; type-check `pnpm exec tsc --noEmit`.
- `webview-ui/` suite: run from `webview-ui/` with `pnpm exec vitest run <path>`.
- Per `AGENTS.md`: after editing a file run
  `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>`
  (and the analogous `--dir packages/types` / `--dir webview-ui`) and confirm the
  suppression count did NOT increase. No `.changeset`/`CHANGELOG` edits. No `as any`,
  no floating promises.

Hard constraints carried forward (NFR-1): do NOT modify
`src/api/providers/utils/timeout-config.ts`, `src/core/task/routeCapacityMap.ts`/the
scheduler, the 64k reader result cap, 1800s timeouts, or
`src/core/task-persistence/taskLifecycle.ts` and the lifecycle witnesses.

Note on line citations: the design cites `ReadFileTool.ts` line numbers (e.g. the
batched `effectiveLimit` assignment the review corrected from `:115` to `:117`).
These may have drifted; anchor edits to the named code constructs
(`defaultBatchLimit`/`effectiveLimit`, `validateAccess` gate, `entry.limit ??
DEFAULT_LINE_LIMIT`), not to literal line numbers.

---

- [ ] 1. Create the shared denylist predicate module `src/services/glob/readDenylist.ts`.
      Export `ReadDenylistConfig` (`vendoredDirs`/`rootDirs`/`files`/`globs`), the pure
      `isDeniedRead(relPath, config, opts?)` with the five-step match semantics (knownTarget
      short-circuit → anywhere-segment `vendoredDirs` → first-segment `rootDirs` with `out-*`
      prefix → basename `files` → `ignore`-compiled `globs`, returning the matched `field:entry`
      as `category`), `extractKnownTargetPaths(message)` (path-literal grammar: contains `/`,
      has an extension incl. compound `.d.ts`, bare/quoted/backticked, strip `:line[:col]`,
      reject `..`), and `mergeReadDenylist` (per-field replace-over-default; explicit `[]`
      clears a field). Reuse the existing `ignore` library. Pure, no I/O (NFR-3).
      Files: src/services/glob/readDenylist.ts
      Verify: file compiles as part of step 2's test run; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 services/glob/readDenylist.ts` shows no count increase.

- [ ] 2. Add the shared schema, defaults, and type-union wiring in `packages/types`.
      In `global-settings.ts`: add `parallelReadDenylistSchema`, the shared `DEFAULT_READ_DENYLIST`
      constant, `DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES = 600_000`, and `BUDGET_TIGHTENED_LINE_LIMIT = 500`;
      add `parallelReadDenylist: parallelReadDenylistSchema.optional()` to `globalSettingsSchema`
      (`GLOBAL_SETTINGS_KEYS` is derived via `.keyof().options`, so no array hand-edit). In
      `vscode-extension-host.ts` add `"parallelReadDenylist"` to the `ExtensionState` key union
      (next to `parallelCapacityMap`). Follow the `parallelCapacityMap` precedent for optionality.
      Files: packages/types/src/global-settings.ts, packages/types/src/vscode-extension-host.ts
      Verify: from `packages/types/` run `pnpm exec tsc --noEmit` (passes) and `pnpm exec vitest run` for the schema file (step 3's tests).

- [ ] 3. Add unit tests for the predicate, parser, and schema round-trip/merge.
      In `src/services/glob/__tests__/readDenylist.spec.ts`: the full `isDeniedRead` truth table
      (DENIED: `node_modules/@types/react/index.d.ts`, `typescript/lib/lib.dom.d.ts`,
      `package-lock.json`, `app.min.js`, root `dist/bundle.js`, root `out/x.js`,
      `target/dependency/foo.jar`; ALLOWED: `src/core/task/Task.ts`, `src/types/global.d.ts`,
      `docs/x.md`, `packages/pkg/index.ts`, `src/features/build/pipeline.ts`,
      `services/deps/client.ts`, `fixtures/sample.map`, nested `webview-ui/out/README.md`), plus
      Known_Target override and cleared-category override rows; `extractKnownTargetPaths` cases
      (bare `.d.ts`, backtick-quoted, `path:line` stripped, `..` rejected). In
      `packages/types/src/__tests__/` add the schema set/empty/unset round-trip and per-field
      replace-merge (omit = inherit; `[]` = clear). This proves AC-6, AC-8, and the junk-excluded /
      source-included contract.
      Files: src/services/glob/__tests__/readDenylist.spec.ts, packages/types/src/__tests__/parallelReadDenylist.spec.ts
      Verify: `pnpm --dir src exec vitest run services/glob/__tests__/readDenylist.spec.ts` and `pnpm --dir packages/types exec vitest run src/__tests__/parallelReadDenylist.spec.ts` — all pass.

- [ ] 4. Wire `Task` with Known_Target tracking and read-input byte accounting.
      In `src/core/task/Task.ts` add `knownTargetPaths: Set<string>` seeded solely from
      `extractKnownTargetPaths(spec.message)` with `isKnownTargetPath(relPath)` (normalized
      compare), and a per-worker `readInputBytesConsumed` counter (worker-local field). These
      are read/updated by `ReadFileTool` in step 5; `runParallelTasks.ts` stays unchanged except
      the budget flows through existing provider state (no dispatch-time transcript assembly).
      Files: src/core/task/Task.ts
      Verify: `pnpm --dir src exec vitest run` for the Task suite passes; `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/Task.ts` no count increase.

- [ ] 5. Enforce the denylist and per-worker read budget in `ReadFileTool`.
      In `src/core/tools/ReadFileTool.ts`: immediately after the existing
      `rooIgnoreController?.validateAccess` gate (new-format and legacy paths), add an
      `isDeniedRead(relPath, effectiveConfig, { knownTarget: task.isKnownTargetPath(relPath) })`
      check; on deny mark the result `blocked` with the one-line notice naming the category and
      set `didToolFailInCurrentTurn` as the rooIgnore flow does. Increment
      `task.readInputBytesConsumed` by returned `nativeContent` byte length. When the budget is
      crossed and `limit`/`entry.limit` is undefined, clamp the default to
      `min(computedDefault, BUDGET_TIGHTENED_LINE_LIMIT)` in all three paths — batched
      `effectiveLimit` (the `limit ?? defaultBatchLimit` assignment), slice `entry.limit ??
      DEFAULT_LINE_LIMIT`, and the governing indentation `entry.limit ?? DEFAULT_LINE_LIMIT`
      passed to `readWithIndentation` — never raising the limit (monotonic). Add the tightened
      notice; honor explicit `limit`/`offset`/`lineRanges` unchanged. Read the effective config
      via `task.providerRef.deref()?.getState()` (already called here).
      Files: src/core/tools/ReadFileTool.ts
      Verify: `pnpm --dir src exec vitest run core/tools/__tests__` (ReadFileTool suite) passes; eslint prune check no count increase.

- [ ] 6. Route the reader-swarm document pick through the predicate.
      In `src/core/task/ParallelTaskReader.ts` `addSharedDocumentReader`, filter each candidate
      `relativePath` through `isDeniedRead(relativePath, config)` before the `fs.stat`/excerpt
      step, skipping denied paths (one source of truth; AC-7). Preserve the 48 KiB / 10k-char
      bounds (NFR-4).
      Files: src/core/task/ParallelTaskReader.ts
      Verify: `pnpm --dir src exec vitest run` for the ParallelTaskReader suite passes; eslint prune check no count increase.

- [ ] 7. Add integration tests for the runtime enforcement.
      In `src/core/tools/__tests__/`: `ReadFileTool` denies a vendored path (blocked + notice)
      and allows a first-party source read; after crossing the budget a default read is tightened
      to `BUDGET_TIGHTENED_LINE_LIMIT` (incl. the batched-read clamp, AC-9a) and an explicit
      `limit` read is honored (AC-9); the worker logs denied-bytes / ingested-bytes (AC-10). In
      `src/core/task/__tests__/` assert `addSharedDocumentReader` skips a denied candidate.
      Prefer `src/test-utils` helpers; keep payloads inline where they explain the behavior.
      Files: src/core/tools/__tests__/readFileTool.denylist.spec.ts, src/core/task/__tests__/parallelTaskReader.denylist.spec.ts
      Verify: `pnpm --dir src exec vitest run core/tools/__tests__/readFileTool.denylist.spec.ts core/task/__tests__/parallelTaskReader.denylist.spec.ts` — all pass.

- [ ] 8. Complete the persisted-setting storage-to-webview round trip in the extension host.
      In `src/core/webview/ClineProvider.ts`: return `parallelReadDenylist` from `getState()`
      with unset→merge-over-default semantics, add a `getEffectiveReadDenylist()` helper using
      `mergeReadDenylist`, and add `parallelReadDenylist` to BOTH the destructuring and the
      returned object of `getStateToPostToWebview()`. In
      `src/core/webview/webviewMessageHandler.ts` persist via the generic
      `contextProxy.setValue()` path (schema-validated, no special normalization).
      Files: src/core/webview/ClineProvider.ts, src/core/webview/webviewMessageHandler.ts
      Verify: `pnpm --dir src exec vitest run` for the ClineProvider/webviewMessageHandler suites passes; a test asserts `getStateToPostToWebview()` returns the saved value (both default and cleared-category cases). Eslint prune check no count increase.

- [ ] 9. Add the `cachedState`-bound exclusions control in SettingsView.
      Add an advanced "Parallel read exclusions" editor that reads and writes LOCAL `cachedState`
      (NOT live `useExtensionState()`), per the Settings View Pattern, and include
      `parallelReadDenylist` in the `updateSettings` payload from `handleSubmit()`. Follow the
      existing advanced-setting control pattern in the SettingsView tree.
      Files: webview-ui/src/components/settings/ (the SettingsView control + its section)
      Verify: `pnpm --dir webview-ui exec vitest run` for the new SettingsView test passes; eslint prune check (`--dir webview-ui`) no count increase.

- [ ] 10. Add the webview-ui binding/save test.
      Assert the control binds to `cachedState` and the Save handler emits
      `parallelReadDenylist` in the `updateSettings` payload (both set and cleared-category).
      Files: webview-ui/src/components/settings/__tests__/ (SettingsView denylist test)
      Verify: `pnpm --dir webview-ui exec vitest run <that test>` passes.

- [ ] 11. Full verification + measurability check.
      Run the touched suites across all three packages and type-check. Confirm the per-worker
      denied-bytes / ingested-bytes log line is emitted (FR-6/AC-10). Run the eslint prune check
      on every edited file and confirm no suppression-count increase. Do NOT edit
      `.changeset`/`CHANGELOG`.
      Files: (none — verification only)
      Verify: from `src/`, `packages/types/`, and `webview-ui/` run `pnpm exec vitest run` for the touched suites and `pnpm --dir packages/types exec tsc --noEmit`; all green.
