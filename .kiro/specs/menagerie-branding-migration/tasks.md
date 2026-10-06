# Implementation Plan: Menagerie Branding Migration

## Overview

This plan completes the user-visible Menagerie rebrand while retaining every
Compatibility_Boundary identifier byte-for-byte. The implementation language is TypeScript with
package-local Vitest tests run from `src/`, matching the existing extension codebase.

The work is sequenced incrementally so each step builds on the previous one and ends wired into the
acceptance scan:

1. Build the Branding_Surface inventory + carve-out allowlist + derived-asset manifest data (the
   declarative backbone everything else reads).
2. Edit package metadata (`src/package.json`) and the NLS bundle (`src/package.nls.json`).
3. Edit task-surface labels (`src/activate/taskBoard.ts`).
4. Sweep the remaining user-visible strings driven by the inventory.
5. Build the asset pipeline script, the DerivedAsset manifest wiring, and repoint the activity bar
   icon at a menagerie-derived asset (container id unchanged).
6. Build the acceptance scan test plus inventory/manifest/retention property-style tests.

Per `AGENTS.md`: no `.changeset` files and no `CHANGELOG` edits are produced. After editing a file,
run the narrowest relevant Vitest suite and
`pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>` and confirm the
suppression count did not increase.

## Tasks

- [x] 1. Establish the branding data backbone
  - [x] 1.1 Create the Branding_Surface inventory and derived-asset manifest module
    - Add `src/branding/inventory.ts` exporting the `BrandingSurfaceKind` union, the
      `BrandingSurface` interface, and a typed `brandingSurfaces: readonly BrandingSurface[]`
      array enumerating every brand-bearing surface: `src/package.json#author.name`,
      `#repository.url`, `#homepage`, `#keywords`, each edited `src/package.nls.json` key
      (`extension.displayName`, `extension.description`, `settings.enableCodeActions.description`,
      `settings.customStoragePath.description`, `settings.autoImportSettingsPath.description`,
      `settings.workspace.rootResolution.description`), the three `src/activate/taskBoard.ts` labels,
      the extension icon, and the activity bar icon. Each entry records `location`, `kind`,
      `currentValue`, `targetValue`, and `isCompatibilityBoundary`.
    - Export `DerivedAsset` interface and a typed `derivedAssets: readonly DerivedAsset[]` manifest
      whose entries all set `source` to `"menagerie.png"` and declare a `target` and `surface`
      (`extension-icon` → `src/assets/icons/menagerie.png`, `activity-bar` → the repointed container
      icon path).
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 1.2, 1.3_
    - _Properties: 1, 4_

  - [x] 1.2 Create the carve-out allowlist module
    - Add `src/branding/carveOut.ts` exporting the `CarveOutEntry` interface
      (`token`, `reason: "extension-identity" | "persisted-identifier"`, `location`) and a typed
      `carveOutAllowlist: readonly CarveOutEntry[]` containing only genuine Compatibility_Boundary
      tokens: `zoo-code` (name), `ZooCodeOrganization` (publisher), `zoo-code-ActivityBar`
      (container id), the `zoo-code.*` command/view IDs
      (`zoo-code.SidebarProvider`, `zoo-code.taskBoard`, `zoo-code.taskBoardTaskDetails`), and the
      `.roomodes` / `.roo/` config-path tokens.
    - Export the Prohibited_Branding token patterns (`"Zoo Code"`, `"Roo Code"`, standalone
      product `Zoo`/`Roo`) as a shared constant so the scan and tests use one source of truth.
    - _Requirements: 3.1, 3.2, 6.3_
    - _Properties: 2, 3_

- [x] 2. Checkpoint - inventory compiles and is consistent
  - Ensure the new modules type-check and all tests pass, ask the user if questions arise.

- [x] 3. Update package metadata and NLS bundle
  - [x] 3.1 Edit `src/package.json` metadata fields
    - Set `author.name` to `"Menagerie"`; set `repository.url` to
      `https://github.com/celesrenata/menagerie`; set `homepage` to the Menagerie URL; remove
      `"zoo code"` and `"zoocode"` from `keywords` and add `"menagerie"`.
    - Retain unchanged: `name` (`"zoo-code"`), `publisher` (`"ZooCodeOrganization"`), the
      `zoo-code-ActivityBar` container id, all `zoo-code.*` command IDs, and the existing
      menagerie-derived `icon` field.
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 3.1, 3.2_
    - _Properties: 1, 2_

  - [x] 3.2 Resolve NLS strings in `src/package.nls.json` to Menagerie wording
    - Confirm `extension.displayName` is `"Menagerie"`; ensure `extension.description` describes
      Menagerie with no Prohibited_Branding; rewrite `settings.enableCodeActions.description`,
      `settings.customStoragePath.description` (neutral/Menagerie example path),
      `settings.autoImportSettingsPath.description` (Menagerie wording + example), and
      `settings.workspace.rootResolution.description` (`"How Zoo resolves…"` →
      `"How Menagerie resolves…"`).
    - Leave the `.roomodes` / `.roo/mcp.json` / `.roo/rules/` config-path tokens unchanged.
    - _Requirements: 4.4, 5.3, 5.4, 2.4_
    - _Properties: 1_

  - [ ]* 3.3 Write unit tests for package metadata edits
    - Assert `author.name === "Menagerie"`, `repository.url` and `homepage` are the Menagerie URLs,
      and `keywords` excludes `"zoo code"`/`"zoocode"` and includes `"menagerie"`.
    - _Requirements: 4.1, 4.2, 4.3_
    - _Properties: 1_

  - [ ]* 3.4 Write unit tests for NLS Menagerie wording
    - Assert each edited `package.nls.json` key resolves to Menagerie text containing no
      Prohibited_Branding, and that `displayName === "Menagerie"`.
    - _Requirements: 4.4, 5.3, 5.4_
    - _Properties: 1_

- [x] 4. Update task-surface labels in `src/activate/taskBoard.ts`
  - [x] 4.1 Rewrite the task board labels
    - In `getActivityLabel()`, change the `ask` and `say` prefixes from `` `Zoo · …` `` to
      `` `Menagerie · …` ``; change the task details panel title from `` `Zoo Task · …` `` to
      `` `Menagerie Task · …` ``; change the checklist empty-state hint
      `"ask Zoo to use update_todo_list"` to `"ask Menagerie to use update_todo_list"`.
    - Retain unchanged: the view type `"zoo-code.taskBoardTaskDetails"` and the view ids
      `"zoo-code.SidebarProvider"` / `"zoo-code.taskBoard"`; keep the `update_todo_list` tool name.
    - _Requirements: 2.3, 2.1, 2.2, 3.2_
    - _Properties: 1, 2_

  - [ ]* 4.2 Write unit tests for task-surface labels
    - Assert `getActivityLabel()` returns `"Menagerie · …"` for `ask` and `say` messages (and
      `"You"` for user feedback), the panel title uses `"Menagerie Task · …"`, and the checklist
      hint reads `"ask Menagerie to use update_todo_list"`.
    - _Requirements: 2.3_
    - _Properties: 1_

- [x] 5. Checkpoint - metadata, NLS, and labels rebranded
  - Ensure all tests pass and the edited files' eslint suppression counts did not increase, ask the
    user if questions arise.

- [x] 6. Sweep remaining user-visible strings
  - [x] 6.1 Run the inventory-driven user-visible string sweep and rewrite remainders
    - Case-insensitively search `src/package.json`, `src/package.nls.json`, and user-facing strings
      in `src/**/*.ts` for `zoo`, `roo`, `zoocode`, `zoo code`, `roo code`; exclude any match that
      is a carve-out allowlist token (command IDs, container id, view type/ids, `name`, `publisher`,
      `.roo*` config paths); rewrite every remaining User_Visible_String to Menagerie wording and
      add any newly found surface to `src/branding/inventory.ts`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 2.1, 2.2_
    - _Properties: 1_

- [x] 7. Asset pipeline and activity bar icon
  - [x] 7.1 Implement the asset-derivation script
    - Add `scripts/branding/derive-assets.ts` (invoked manually or via a package script, not from
      extension runtime) exporting `deriveAssets(canonicalPath, manifest)` that reads the canonical
      `menagerie.png`, keeps `src/assets/icons/menagerie.png` in sync, and writes each
      `manifest.target` from the canonical source. Fail fast with a clear path-naming error if the
      canonical asset is missing/unreadable (keep last-good assets); write to a temp file then atomic
      rename, reporting any failing target and exiting non-zero on write failure.
    - _Requirements: 1.1, 1.2, 5.1_
    - _Properties: 4_

  - [x] 7.2 Repoint the `zoo-code-ActivityBar` container icon
    - In `src/package.json`, change the container `icon` value from `assets/icons/icon.svg` to a
      menagerie-derived asset (PNG sized for the activity bar, or an SVG wrapper tracing the
      menagerie mark — a derived output of the pipeline). Change only the `icon` value; keep the
      container id `zoo-code-ActivityBar` and add the activity bar entry to the derived-asset
      manifest in `src/branding/inventory.ts`.
    - _Requirements: 1.3, 1.4, 5.1, 3.2_
    - _Properties: 4, 2_

  - [ ]* 7.3 Write unit tests for the asset pipeline and icon wiring
    - Assert `menagerie.png` exists at the repository root (canonical smoke), `package.json.icon`
      references `assets/icons/menagerie.png`, and the activity bar container `icon` references a
      menagerie-derived asset while the container id stays `zoo-code-ActivityBar`.
    - _Requirements: 1.1, 1.4, 1.3_
    - _Properties: 4_

- [x] 8. Guards: acceptance scan and property-style assertions
  - [x] 8.1 Implement the acceptance scan test with carve-out validation
    - Add `src/branding/__tests__/acceptanceScan.test.ts` that scans rendered user-facing strings
      (NLS entries, command titles, settings descriptions, code-constructed labels) and published
      package metadata for Prohibited_Branding, asserting every match is a carve-out allowlist
      member; print offending `location`, matched token, and surrounding text on failure. Also
      validate the allowlist: assert every `carveOutAllowlist` entry is a substantiated
      Compatibility_Boundary token so the carve-out cannot mask a real leak.
    - Where generated inputs exercise the classifier, use `fast-check` with ≥100 iterations and tag
      the property `// Feature: menagerie-branding-migration, Property 3: …`.
    - _Requirements: 6.1, 6.2, 6.3_
    - _Properties: 3_

  - [ ]* 8.2 Write the user-visible surface property test (Property 1)
    - Iterate `brandingSurfaces`; for every entry with `isCompatibilityBoundary === false`, assert
      the resolved value equals `targetValue` and matches no Prohibited_Branding pattern. Implement
      as a single `fast-check` property (≥100 iters) tagged
      `// Feature: menagerie-branding-migration, Property 1: …`.
    - _Requirements: 2.1, 2.2, 2.4, 4.4, 5.1, 5.2, 5.3, 5.4_
    - _Properties: 1_

  - [ ]* 8.3 Write the boundary-retention property test (Property 2)
    - Iterate the Compatibility_Boundary entries and assert each current value equals the recorded
      baseline byte-for-byte: `name === "zoo-code"`, `publisher === "ZooCodeOrganization"`, the
      container id is `"zoo-code-ActivityBar"`, every command id begins with `"zoo-code."`, and
      **no** command id begins with `"menagerie."`.
    - _Requirements: 3.1, 3.2, 3.4, 4.5, 3.5_
    - _Properties: 2_

  - [ ]* 8.4 Write the asset-provenance property test (Property 4)
    - Iterate `derivedAssets` and assert every `source` is `"menagerie.png"` and every `target` is a
      declared derived output path, including the activity bar icon the container points at. Note in
      a comment that icon *pixel* rendering is confirmed by a brief manual check, not auto-verified.
    - _Requirements: 1.2, 1.3, 1.4, 5.1_
    - _Properties: 4_

  - [ ]* 8.5 Write the persisted-state-keys property test (Property 5)
    - Assert the set of persisted-state identifiers (storage keys, profile keys, task-history keys,
      view/command IDs) equals the baseline set — no identifier renamed.
    - _Requirements: 3.2, 3.4_
    - _Properties: 5_

- [x] 9. Final checkpoint - full rebrand verified
  - Ensure all tests pass, run the narrowest Vitest suites and
    `eslint --prune-suppressions` on every edited file, and confirm no suppression count increased;
    ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; all other
  sub-tasks are core implementation and must be implemented.
- Each task references specific requirement sub-clauses and the design correctness properties it
  advances for traceability.
- Property tests use `fast-check` with ≥100 iterations only where generated inputs apply; each is
  tagged `// Feature: menagerie-branding-migration, Property N: …`. Example/edge cases live in the
  unit tests. Icon pixel rendering is manual-only; no heavy e2e is added.
- Per `AGENTS.md`: do not create `.changeset` files or edit `CHANGELOG.md`; after editing a file run
  the narrowest Vitest suite from `src/` and
  `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>`.
- Same-file writers are sequenced into different waves: the `src/package.json` metadata edit (3.1),
  the activity bar icon repoint (7.2), and the retention tests (8.3) do not run in the same wave; the
  inventory module (1.1) is written before the sweep (6.1) that appends to it.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["3.1", "3.2", "4.1"] },
    { "id": 2, "tasks": ["3.3", "3.4", "4.2", "6.1", "7.1"] },
    { "id": 3, "tasks": ["7.2"] },
    { "id": 4, "tasks": ["7.3", "8.1", "8.2", "8.3", "8.4", "8.5"] }
  ]
}
```
