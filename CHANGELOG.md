# Menagerie Changelog

## [3.84.5]

The first release under the Menagerie name.

- 🦁 **Menagerie identity:** ships as `celesrenata.menagerie` and imports your Zoo Code task history and settings on first start.
- ⚡ **Background subtasks:** `parallel_tasks` can run in the background, so the top-level model keeps working. Results arrive on its next turn, and the new `background_tasks` tool checks status, steers a running worker, cancels or waits.
- 🔁 **Audit and send back:** workers that edit files are checked by a read-only reader. Rejected work goes back for up to two rework rounds, then escalates. Work that never passes ends as failed.
- ❓ **Fewer interruptions:** before a question reaches you, Menagerie checks earlier answers, your original request and the project docs. A fast reader then tries to answer from them with citations, followed by a deeper reader.
- 🧩 **OmniRoute Skill Hub:** turn each hub skill on, off or auto. Manual choices always win, and auto fills the remaining slots with matches for the current task.
- 🔇 **No analytics:** the telemetry prompt and the PostHog clients are gone, and the release notes are Menagerie's own.

### Minor Changes

- Raise the parallel fan-out cap from 4 to 12 and size lane slots for local inference
- Task Board: summaries, expandable details, stable tooltips, resilient tabs, and pause, resume, restart and cancel
- Recover Task Board tasks after a reload, and cap every webview message post
- Route cost tiers to `pool/tierN/<role>` OmniRoute model overrides
- Remember answered questions and check project docs before asking
- Spec workflows: import and approve spec revisions, verify strict batches in a patch sandbox, and persist spec status
- Granite bounded analysis on completed reader results, behind the Granite workflow setting
- Recycle the webview document after a wake from sleep
- Distinct YOLO and parallelism toolbar icons
- Nix: the home-manager module copies the extension in as a real directory, recopies when the build changes, and removes legacy Zoo Code installs

### Patch Changes

- Fix the audit verifier when no read-only `project-reader` mode exists: the audit is skipped with a warning instead of failing every worker
- Explain Skill Hub 403 responses accurately (missing `read:catalog` scope, or a hub without scoped-key support)
- Hide the signed-out Zoo Code sign-in badge from the chat toolbar
- Scale the activity bar icon to fill the icon frame
- Stop the task-restore read race, spurious source-map 404s and a blank webview
- Keep the panel from going gray after sleep

## Earlier releases

Menagerie forked from Zoo Code 3.84.0. For 3.84.0 and earlier, see the
[Zoo Code changelog](https://github.com/Zoo-Code-Org/Zoo-Code/blob/main/CHANGELOG.md).
