# zoo-parallel-fabric — Setup Note

## Branch

- Current branch: **`feat/omniroute-tier-dropdown-feat005`**
- All work operates directly on this currently-checked-out branch. No branch switch, no worktree.

## Task Lifecycle gate — NOT applicable

`src/core/task-persistence/taskLifecycle.ts` is **NOT touched** by any of the three workstreams:

- **Workstream A (condensing API config port / "Lever 2")** touches: `packages/types/src/global-settings.ts`, `packages/types/src/vscode-extension-host.ts`, `src/core/webview/webviewMessageHandler.ts`, `src/core/webview/ClineProvider.ts`, `src/core/task/Task.ts` (3 condensing call sites + a condensing-handler helper), and the SettingsView webview UI. None of these are `taskLifecycle.ts`.
- **Workstream B-i (role/route tier fix)** touches: `src/core/task/parallelWorkerRouting.ts` and OmniRoute settings labels in `webview-ui`.
- **Workstream B-ii (relax auto-reader)** touches: `src/core/task/ParallelTaskReader.ts` and `src/core/tools/ParallelTasksTool.ts`.

Because none of these workstreams mutate task status, delegation, interruption, completion, abandonment, persistence ownership, or scheduler fan-out in `taskLifecycle.ts`, the AGENTS.md "Task Lifecycle Changes" gate (`pnpm lifecycle:model-check` + `pnpm test`) **does not apply**. Confirm this still holds during implementation; if any edit lands in `taskLifecycle.ts`, re-engage that gate.

## Verify commands (from scope report)

- **Typecheck (src):** `pnpm --dir src exec tsc --noEmit`
- **Typecheck (types package):** `pnpm --dir packages/types exec tsc --noEmit`
- **Lint gate (per-file, AGENTS.md):** `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>` — suppression count for the file must not increase.
- **Narrow src tests:** `pnpm --dir src exec vitest run <path>`
- **Webview tests:** `pnpm --dir webview-ui exec vitest run <path>`
