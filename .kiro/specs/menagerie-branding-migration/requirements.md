# Requirements Document

## Introduction

This feature (FEAT-005 of the Menagerie Autonomous Operations Lift) completes the user-visible
Menagerie rebrand and establishes `menagerie.png` as the canonical visual identity for the
extension. The UI display name is already Menagerie, but the codebase still carries Zoo/Roo
terminology in author/package metadata, repository and homepage links, keywords, command titles,
settings descriptions, task-surface labels, and some assets (for example the activity bar still
uses `icon.svg` rather than a menagerie-derived icon).

The scope is deliberately narrow. It covers only user-visible branding and the canonical asset
source. The central constraint is that the rebrand MUST NOT destroy user state. Persisted
identifiers that would break settings, global storage, command compatibility, persisted profiles,
task histories, or VS Code extension install/upgrade continuity are a Compatibility Boundary and
are retained as-is during this lift. New, user-facing language says "Menagerie"; the internal
`zoo-code.*` identifiers, extension `name`, and `publisher` are preserved. A later migration MAY
introduce `menagerie.*` aliases with `zoo-code.*` retained as compatibility aliases; that alias
migration is out of scope here.

This spec explicitly excludes the observatory, loop detection, tiers, semantic retrieval,
reasoning budgets, parallelism, and GPU scheduling, which are covered by separate specs.

## Glossary

- **Menagerie_Extension**: The VS Code extension defined by `src/package.json`, the subject of all requirements in this document.
- **Canonical_Brand_Asset**: The authoritative source image for the Menagerie visual identity, `menagerie.png` at the repository root (mirrored at `src/assets/icons/menagerie.png`), from which derived extension assets are produced.
- **Asset_Pipeline**: A build or helper script that generates or synchronizes derived extension assets (extension icon, activity bar icon, sidebar header, welcome screen, task surfaces, and marketplace/package metadata images) from the Canonical_Brand_Asset.
- **User_Visible_String**: Any text or image rendered to a user in the extension UI (command titles in the palette, settings descriptions, activity bar, sidebar header, welcome screen, task-surface labels) or in published package metadata (displayName, description, author, repository, homepage, keywords, marketplace images).
- **Compatibility_Boundary**: A Persisted_Identifier or Extension_Identity field whose change would break settings, global storage, command compatibility, persisted profiles, task histories, or VS Code install/upgrade continuity. Fields on a Compatibility_Boundary are retained unchanged by this feature.
- **Persisted_Identifier**: A stable string key that persists user state or wiring across sessions, such as `zoo-code.*` command IDs, the `zoo-code-ActivityBar` views container id, global storage keys, and persisted profile keys.
- **Extension_Identity**: The VS Code marketplace identity fields `name` ("zoo-code") and `publisher` ("ZooCodeOrganization") that determine install and upgrade continuity.
- **NLS_Bundle**: The localization bundle and i18n JSON that resolve `%key%` references used in `src/package.json` and other user-facing text into displayed strings.
- **Command_Title**: The user-visible label of a command as shown in the VS Code command palette and menus, distinct from the command ID (a Persisted_Identifier).
- **Prohibited_Branding**: The user-visible brand strings "Zoo Code" and "Roo Code" (and the standalone brand words "Zoo" and "Roo" used as product branding) that MUST NOT appear in rendered user-facing UI or package metadata after this feature.

## Requirements

### Requirement 1: Canonical Brand Asset

**User Story:** As a maintainer, I want `menagerie.png` to be the single canonical brand source, so that every derived extension asset stays consistent with one authoritative image.

#### Acceptance Criteria

1. THE Menagerie_Extension SHALL treat the repository root `menagerie.png` as the Canonical_Brand_Asset.
2. WHERE an Asset_Pipeline is provided, THE Asset_Pipeline SHALL generate or synchronize the derived extension assets (extension icon, activity bar icon, sidebar header, welcome screen, task surfaces, and marketplace/package metadata images) from the Canonical_Brand_Asset.
3. WHEN the Asset_Pipeline runs, THE Asset_Pipeline SHALL produce the activity bar icon referenced by the `zoo-code-ActivityBar` views container from the Canonical_Brand_Asset rather than from an unrelated source image.
4. THE Menagerie_Extension SHALL reference a menagerie-derived image for the extension `icon` field in `src/package.json`.

### Requirement 2: Naming Policy for New User-Visible Language

**User Story:** As a user, I want all Menagerie-facing language to say "Menagerie", so that the product identity is consistent wherever text is shown to me.

#### Acceptance Criteria

1. THE Menagerie_Extension SHALL present every new User_Visible_String using the brand term "Menagerie".
2. WHEN a new User_Visible_String names the product, THE Menagerie_Extension SHALL use "Menagerie" and SHALL NOT use the Prohibited_Branding.
3. WHERE a surface displays a task activity label (for example the task board activity label currently rendered as "Zoo ·"), THE Menagerie_Extension SHALL render the Menagerie brand prefix "Menagerie ·".
4. THE Menagerie_Extension SHALL present Command_Title values and settings descriptions shown to users using "Menagerie".

### Requirement 3: Compatibility Boundary and State Preservation

**User Story:** As an existing user, I want my settings, profiles, task histories, and installed extension to keep working across the rebrand, so that upgrading does not reset or break my state.

#### Acceptance Criteria

1. THE Menagerie_Extension SHALL retain the Extension_Identity fields `name` ("zoo-code") and `publisher` ("ZooCodeOrganization") unchanged.
2. THE Menagerie_Extension SHALL retain existing Persisted_Identifier values, including `zoo-code.*` command IDs, the `zoo-code-ActivityBar` views container id, global storage keys, and persisted profile keys.
3. WHERE new code does not sit on a Compatibility_Boundary, THE Menagerie_Extension SHALL use Menagerie terminology for internal identifiers introduced by that new code.
4. WHEN this feature is applied, THE Menagerie_Extension SHALL preserve existing settings, global storage, persisted profiles, and task histories without data loss.
5. THE Menagerie_Extension SHALL NOT introduce `menagerie.*` command-ID aliases as part of this feature.

### Requirement 4: Package Metadata Update

**User Story:** As a user browsing the marketplace or repository, I want package metadata to describe Menagerie and this repository, so that stale upstream Zoo Code references do not misrepresent the product.

#### Acceptance Criteria

1. THE Menagerie_Extension SHALL set the package `author` name to describe Menagerie rather than "Zoo Code".
2. THE Menagerie_Extension SHALL set the package `repository` url and `homepage` to the current Menagerie repository and site rather than `https://github.com/Zoo-Code-Org/Zoo-Code` and `https://zoocode.dev`.
3. THE Menagerie_Extension SHALL update the package `keywords` to remove "zoo code" and "zoocode" and to describe Menagerie.
4. THE Menagerie_Extension SHALL resolve the `displayName` and `description` NLS_Bundle keys to text that describes Menagerie.
5. WHERE a metadata field is an Extension_Identity field (`name`, `publisher`), THE Menagerie_Extension SHALL retain that field unchanged in accordance with Requirement 3.

### Requirement 5: User-Visible String Sweep

**User Story:** As a user, I want Menagerie branding across the icon, activity bar, sidebar header, welcome screen, task surfaces, and metadata, so that the experience reads as one product.

#### Acceptance Criteria

1. THE Menagerie_Extension SHALL render the extension icon, activity bar icon, sidebar header, welcome screen, and task surfaces using Menagerie branding.
2. THE Menagerie_Extension SHALL present every Command_Title shown in the command palette as "Menagerie" branded text.
3. THE Menagerie_Extension SHALL present every settings description shown to users as "Menagerie" branded text.
4. WHEN a User_Visible_String is resolved through the NLS_Bundle, THE Menagerie_Extension SHALL resolve it to Menagerie-branded text.

### Requirement 6: No Unintended Visible Zoo/Roo Branding

**User Story:** As a maintainer verifying the rebrand, I want a testable guarantee that no stray Zoo Code or Roo Code branding is shown, so that I can confirm the sweep is complete.

#### Acceptance Criteria

1. WHEN rendered user-facing UI is searched for Prohibited_Branding, THE Menagerie_Extension SHALL yield no unintended occurrences of "Zoo Code" or "Roo Code".
2. WHEN published package metadata is searched for Prohibited_Branding, THE Menagerie_Extension SHALL yield no unintended occurrences of "Zoo Code" or "Roo Code".
3. WHERE a string containing the token "zoo-code" is a retained Persisted_Identifier or Extension_Identity field on a Compatibility_Boundary, THE Menagerie_Extension SHALL treat that occurrence as permitted and exclude it from the Prohibited_Branding acceptance check.
