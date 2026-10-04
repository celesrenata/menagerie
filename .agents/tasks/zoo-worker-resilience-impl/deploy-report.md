# Deploy report: Zoo parallel-worker resilience

The new Zoo build is installed in VS Code and copied into the flake. Reload VS Code (Developer: Reload Window) to start using it.

## Commits (branch `feat/omniroute-tier-dropdown-feat005`, on top of base `5cf33f0a9`)

- `af4569b03` fix(zoo): settle turns when tool dispatch throws and coerce object tool args (FEAT-001)
- `f406a6829` fix(zoo): bound stream first-chunk/idle waits and forward abort signals (FEAT-002)
- `a28255745` fix(zoo): fail parallel workers non-interactively with a bounded retry cap (FEAT-003)
- `de6d8a7d1` fix(zoo): nudge repeated tool calls before escalating and no-op unchanged todo lists (FEAT-004, HEAD)

The integration pass needed no code changes, so it has no commit. The branch was not pushed.

## Tests (from verification.md)

- `tsc --noEmit`: passes.
- Full src vitest run: 9706 passed, 28 failed, 39 skipped. All 28 failures also fail on base `5cf33f0a9`, so they are not caused by this work. They are in `extension.spec.ts`, `system-prompt.spec.ts`, `add-custom-instructions.spec.ts`, and `generateSystemPrompt.spec.ts`.
- The 16 changed spec files: 16 files and 485 tests, all passing.
- `pnpm test` (turbo): 12 of 13 tasks pass. The one failure is `zoo-code#test`, from the same 28 failures listed above.
- ESLint on the 30 changed .ts files: passes. No suppression count went up. One went down: `ToolRepetitionDetector.spec.ts` dropped from 3 to 0.
- `pnpm lifecycle:model-check`: passes. This includes all 924 parser-scope interleavings.
- Backend translations: none missing. The only translation gaps are older ones in webview-ui, which this work didn't touch.
- Protected paths are unchanged: `taskLifecycle.ts`, `webview-ui`, `global-settings.ts`, the CHANGELOGs, and `.changeset`.

## Build and deploy

- `pnpm vsix` produced `/Users/celes/sources/celesrenata/menagerie/bin/zoo-code-3.84.4.vsix` (1932 files, 33.01 MB). The version is 3.84.4, as expected.
- `code --install-extension .../bin/zoo-code-3.84.4.vsix --force` succeeded ("Extension 'zoo-code-3.84.4.vsix' was successfully installed").
- The VSIX was copied over `/Users/celes/sources/m5max-darwin-flake/packages/vscode-extensions/zoo-code-3.84.4-omniroute.vsix`. Both files have the same SHA-256 (`3d6d8e2dd04ffb74e07c00638aff5652dfb289929d9dc507bd2ad2bc302b9182`). Nothing was committed in the flake repo.

## Next steps

1. Reload VS Code to pick up the new build.
2. Suggested manual check (V7 in the design): start a long generation on the 5090 reader, abort it from Zoo, and confirm the backend's active-slot count drops. This confirms that aborting from Zoo now actually stops the request on the backend.
