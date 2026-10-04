# Review summary — zoo-parallel-fabric

**Verdict: APPROVED** (0 blocking findings, 2 NITs)

Full semantic review: `.agents/tasks/zoo-parallel-fabric/2026-10-02-190029-review.md`.

## What was checked

Scoped to the three workstream commits (`git diff fa00ee99c..HEAD`): B-i (FEAT-001), B-ii (FEAT-002), A (FEAT-003). The prior `omniroute-integration` tier-dropdown commits also live on this branch but are out of scope.

### B-i — reader/reasoner tier labeling + test hardening (PASS)

- `READER_MODES` logic unchanged; `project-research` is **not** added (confirmed) — it correctly falls through to the reasoner/27B field.
- Tier mapping asserted in `parallelWorkerRouting.spec.ts`: project-reader→reader(9B), project-research→reasoner(27B), code→reasoner(27B), unset→parent fallback, and `READER_MODES.has("project-research") === false`.
- Only doc comments + four en/settings.json label strings changed.

### B-ii — auto-reader trigger relaxation (PASS)

- Trigger relaxed to `>=2` workers, mixed modes allowed, `>=1` referencing a shared doc.
- `specs.length >= 4` early-return is the sole cap guard; `parallelTasksSchema` (min 2/max 4) parses before the append. 4-cap-no-append edge is tested.
- Auto-reader stays `project-reader`, read-only, excerpt-only, with the no-`read_file` instruction intact. Tests cover 2-worker, mixed-mode, single-referencer, and the cap edge.

### A — condensingApiConfigId port (PASS)

- `enhancementApiConfigId` clone fidelity: schema, ExtensionState Pick, all three ClineProvider round-trip sites (bare pass-through, no `?? ""` in getState).
- Default-unset == `this.api` is **byte-identical** (identity-asserted via `toBe(task.api)` in the handler unit suite).
- SettingsView control binds to **cachedState** (not live `useExtensionState()`), no postMessage on change; included in `handleSubmit` payload as `condensingApiConfigId ?? ""`. Revert-on-discard test proves the buffer.
- Single caching rule in `getCondensingApiHandler`: only the built handler is cached keyed by config id; own-model path always returns live `this.api` (never cached); re-resolve on id change. Membership guard precedes `getProfile` (which throws on missing id). try/catch logs per-call and falls back.
- Full round trip tested: persistence (set + clear), getState/getStateToPostToWebview (set + unset), import (not stripped).

## Gates

- No `.changeset` and no CHANGELOG edits (confirmed).
- `src/eslint-suppressions.json` unchanged — counts not increased (the `--prune-suppressions` run only rewrites whitespace; reverted).
- `taskLifecycle.ts` untouched — lifecycle gate N/A.
- `tsc --noEmit` clean for packages/types, src, webview-ui.
- All FEAT-named vitest suites pass locally (core 39, webview 322, webview-ui settings 64).

## Findings (both NIT, non-blocking)

1. **Bundled prior task** — the omniroute-integration tier-dropdown commits ride ahead of these three on the branch; out of scope.
2. **`attemptApiRequest` threading untested** — third condensing site is wired identically to the two tested sites and covered by tsc; a third threading assertion would complete symmetry.
