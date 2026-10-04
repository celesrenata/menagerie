---
name: zoo-monorepo-conventions
description: Conventions that apply only when working inside the Menagerie/Zoo/Roo Code monorepo itself (src/ and webview-ui/ vitest layout, safeWriteJson, i18n locales, CLI TUI debugging, changesets, evals). Load only if the workspace contains src/core/ and webview-ui/.
modeSlugs: []
---
# Menagerie monorepo only
- Tests: run vitest from the package directory: `cd src && npx vitest run <path>` or `cd webview-ui && npx vitest run <path>`. Never run it from the repo root.
- JSON file writes in extension code use `safeWriteJson` from `src/utils/safeWriteJson.ts` (atomic; it creates parent dirs). Tests are exempt.
- UI strings go through i18n: `src/i18n/locales/*` and `webview-ui/src/i18n/locales/*`. Add the English key first, then translate every locale (see the Translate mode).
- CLI debugging: `console.log` breaks the TUI, so append to `/tmp/roo-cli-debug.log` and read it after the user reproduces the issue.
- Respect `src/eslint-suppressions.json`. Do not prune suppressions as a side effect.
- Releases and changesets follow `legacy-roo-monorepo/commands/release.md` and `cli-release.md` in this package.
