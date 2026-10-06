# Implementation Plan: Immediate Tier Semantics (FEAT-003)

## Overview

This plan implements immediate, atomic OmniRoute cost-tier application and the mastermind worker tier ceiling, bottom-up and test-first. We start with the additive `requestTier` message-type field, then build the two pure host functions (`resolveRequestTier`, `clampWorkerTier`) with property tests, wire them into the host (`webviewMessageHandler` for `newTask` / `askResponse`, `ClineProvider` for the worker ceiling), then refactor the webview (`OmniRouteTierDropdown` controlled, `ChatView` composer-local state and submit-time capture), and finish with the focused "race is gone" webview test and preservation of existing suites.

The change is additive and backward compatible: `omniRouteTier` persistence, the OmniRoute-profile header discriminator, and `withOmniRouteTier`'s invalid-tier / non-OmniRoute behavior are unchanged. Each pure function and header-mapping path is validated by `fast-check` property tests (min. 100 iterations); UI behavior and the race regression are validated by webview-ui JSDOM tests.

## Tasks

- [x] 1. Add additive `requestTier` field to the request envelope message types
  - [x] 1.1 Add optional `requestTier?: number` to `WebviewMessage` in `packages/types/src/vscode-extension-host.ts`
    - Add the field as an optional integer carried on the `newTask` and `messageResponse` `askResponse` messages; document that it is captured at submit time, is an integer 1-5, and that out-of-range / non-integer values are treated as absent by the host (`resolveRequestTier`). Reuse the `omniRouteTierSchema` (1-5) semantics for its intended range; keep the field optional and additive so older webview/host builds that omit it still interoperate (missing → saved-tier fallback).
    - _Requirements: 2.1, 2.2, 2.4, 6.4_

- [x] 2. Implement the pure host resolution and clamp functions
  - [x] 2.1 Implement `resolveRequestTier(envelopeTier, savedTier)` in `src/api/providers/omniroute.ts`
    - Pure, total function with precedence envelope → saved → `undefined` (OmniRoute default). Validate each candidate with the existing `omniRouteTierSchema` so any value that is not an integer 1-5 (including 0, 6, negatives, fractions, `NaN`, `undefined`) is treated as absent. Never throw; never mutate persisted state. Co-locate with the existing tier helpers.
    - _Requirements: 3.1, 3.2, 3.3, 2.5, 6.4_

  - [x] 2.2 Implement `clampWorkerTier(requestedTier, ceilingTier)` in `src/api/providers/omniroute.ts`
    - Pure clamp with min semantics: `undefined` ceiling passes the requested tier through (may be `undefined`); `undefined` requested with a defined ceiling returns the ceiling; otherwise `min(requested, ceiling)`. When a ceiling is defined, the result never exceeds it. Never throw.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x]* 2.3 Write property test for `resolveRequestTier` precedence and totality
    - **Property 2: Resolution precedence is a total function (envelope → saved → default)**
    - **Validates: Requirements 3.1, 3.2, 3.3, 4.3, 6.4**
    - Use `fast-check` (min. 100 iterations) generating arbitrary `(envelopeTier, savedTier)` across valid tiers, out-of-range integers, floats, `NaN`, and `undefined`; assert the precedence rule, totality, and no-throw. Place in `src/api/providers/__tests__/resolveRequestTier.spec.ts`. Tag: `// Feature: immediate-tier-semantics, Property 2: ...`.

  - [x]* 2.4 Write property test for `resolveRequestTier` invalid-envelope normalization
    - **Property 5: Invalid envelope tier is treated as absent**
    - **Validates: Requirements 2.4, 2.5**
    - Use `fast-check` (min. 100 iterations) generating arbitrary non-1..5 envelope values (0, 6, negatives, fractions, `NaN`, `undefined`); assert the envelope tier is ignored and resolution falls to the saved tier (if valid) or `undefined`. Place in `src/api/providers/__tests__/resolveRequestTier.spec.ts`. Tag: `// Feature: immediate-tier-semantics, Property 5: ...`.

  - [x]* 2.5 Write property test for `clampWorkerTier` min semantics
    - **Property 4: Worker tier is clamped to the ceiling (min semantics)**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - Use `fast-check` (min. 100 iterations) generating arbitrary `(requestedTier, ceilingTier)` including `undefined` on each side; assert pass-through on `undefined` ceiling, ceiling return on `undefined` requested, `min` otherwise, and the never-exceeds-ceiling invariant when a ceiling is defined. Place in `src/api/providers/__tests__/clampWorkerTier.spec.ts`. Tag: `// Feature: immediate-tier-semantics, Property 4: ...`.

  - [x]* 2.6 Write property test for header emission via `withOmniRouteTier` / `omniRouteRequestHeaders`
    - **Property 3: Header emission respects the OmniRoute discriminator and the resolved tier**
    - **Validates: Requirements 3.4, 3.5, 6.2, 6.3, 6.5**
    - Use `fast-check` (min. 100 iterations) generating arbitrary resolved tiers and profiles (OmniRoute via `apiProvider: "openai"` + `openAiIsOmniRoute: true`, vs non-OmniRoute); apply the tier via `withOmniRouteTier` and read `omniRouteRequestHeaders`; assert `{ "X-OmniRoute-Tier": String(tier) }` appears exactly for OmniRoute + integer tier 1-5 and never for non-OmniRoute or unset/out-of-range tiers. Extend `src/api/providers/__tests__/omniroute.spec.ts` without altering existing cases. Tag: `// Feature: immediate-tier-semantics, Property 3: ...`.

  - [x]* 2.7 Write unit tests for `resolveRequestTier` and `clampWorkerTier` concrete cases
    - `resolveRequestTier`: envelope 3 / saved 1 → 3; no envelope / saved 2 → 2; neither → `undefined`. `clampWorkerTier`: ceiling assignment equals resolved tier (Req 5.1), below-ceiling preserved, above-ceiling clamped. Place alongside the respective spec files.
    - _Requirements: 3.1, 3.2, 3.3, 5.1, 5.2, 5.3_

- [x] 3. Checkpoint - pure functions and their tests
  - Ensure all tests pass, ask the user if questions arise. Run the narrowest `src` Vitest suites (`resolveRequestTier.spec.ts`, `clampWorkerTier.spec.ts`, `omniroute.spec.ts`) and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` on edited files.

- [x] 4. Wire resolution into the host message handlers
  - [x] 4.1 Apply `resolveRequestTier` in the `newTask` case of `src/core/webview/webviewMessageHandler.ts`
    - Before `provider.createTask(...)`, read the Saved_Tier via `provider.contextProxy.getValue("omniRouteTier")`, compute `resolveRequestTier(message.requestTier, savedTier)`, and apply the resolved tier to the request's `apiConfiguration` via the existing `withOmniRouteTier`. Treat the resolved tier as a per-request override: do NOT write it back to `ContextProxy`. Leave header emission to the existing `withOmniRouteTier` → `omniRouteRequestHeaders` path.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 6.4_

  - [x] 4.2 Apply `resolveRequestTier` in the `messageResponse` `askResponse` case of `src/core/webview/webviewMessageHandler.ts`
    - For the `messageResponse` askResponse, perform the same saved-tier read and `resolveRequestTier(message.requestTier, savedTier)`, applying the resolved tier to the current task's active `apiConfiguration` for the follow-up request via `withOmniRouteTier`, without writing back to `ContextProxy`. Leave button-click askResponses unaffected.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 6.4_

  - [x]* 4.3 Write unit tests for host resolution wiring in `webviewMessageHandler`
    - Assert `newTask` and `messageResponse` `askResponse` resolve the tier and apply it to the request `apiConfiguration` via `withOmniRouteTier`, that the envelope tier overrides a stale saved tier, that a missing/invalid `requestTier` falls back to the saved tier, and that `ContextProxy` is never written. Place in the handler's `src` `__tests__` directory.
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.3, 6.4_

- [x] 5. Wire the mastermind worker tier ceiling in `ClineProvider`
  - [x] 5.1 Apply `clampWorkerTier` at the parallel-worker / handoff tier point in `src/core/webview/ClineProvider.ts`
    - At the existing parallel-worker/handoff `apiConfiguration` application point (today `withLiveOmniRouteTier` reads the live global tier), use the execution's resolved `requestTier` as the Tier_Ceiling: for each worker, apply `clampWorkerTier(requestedWorkerTier, ceiling)` before `withOmniRouteTier`. When the ceiling is `undefined`, preserve today's behavior (no ceiling, OmniRoute default). Keep model/provider/GPU placement delegated to OmniRoute; constrain only the tier header.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 5.2 Write unit tests for the worker ceiling wiring in `ClineProvider`
    - Assert a worker tier below the ceiling passes through, a worker tier above the ceiling is clamped to the ceiling, and an `undefined` ceiling imposes no limit. Place in the `ClineProvider` `__tests__` directory alongside existing provider tests.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 6. Checkpoint - host wiring
  - Ensure all tests pass, ask the user if questions arise. Run the narrowest `src` Vitest suites for `webviewMessageHandler` and `ClineProvider`, then `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` on edited files.

- [x] 7. Refactor the composer to capture the tier synchronously at submit time
  - [x] 7.1 Make `OmniRouteTierDropdown` a controlled component in `webview-ui/src/components/chat/OmniRouteTierDropdown.tsx`
    - Add `selectedTier: number | undefined` and `onSelectTier: (tier: number | undefined) => void` props. `handleSelect(tier)` calls `onSelectTier(tier)` synchronously AND still posts `updateSettings({ omniRouteTier: tier })` as a separate async action; selecting Default calls `onSelectTier(undefined)`. Derive the displayed label from `selectedTier`, not from `omniRouteTier` in `useExtensionState()`. Keep the OmniRoute-profile render guard (`isOmniRouteProfile`) unchanged. This control is in the chat toolbar, not `SettingsView`, so the `SettingsView` `cachedState` rule does not apply; the composer-local state is the buffer and the async `updateSettings` is the deliberate immediate-save flow.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 7.2 Add composer-local tier state and submit-time capture in `webview-ui/src/components/chat/ChatView.tsx`
    - Add `const [selectedOmniRouteTier, setSelectedOmniRouteTier] = React.useState<number | undefined>(undefined)`, seeded on first mount from the saved `omniRouteTier` so the control reflects the persisted default; after mount local state is authoritative (no echo dependence). Render `OmniRouteTierDropdown` with `selectedTier={selectedOmniRouteTier}` and `onSelectTier={setSelectedOmniRouteTier}`. At both submit sites, read `selectedOmniRouteTier` synchronously and attach `requestTier` only when it is a valid 1-5 integer (`...(requestTier ? { requestTier } : {})`): on the first message's `newTask` and on the subsequent `messageResponse` `askResponse`.
    - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.2, 4.4_

  - [x]* 7.3 Write webview-ui tests for the controlled dropdown and async-persist separation
    - **Property 1 (partial): controlled label and separate async persist**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
    - JSDOM render `OmniRouteTierDropdown` as controlled; select each tier and Default and assert the label follows `selectedTier` even when a conflicting live `omniRouteTier` is supplied via context; with mocked `vscode.postMessage`, assert selecting posts `updateSettings({ omniRouteTier })` as a separate action and the label update does not depend on any host echo; assert the control renders for an OmniRoute profile and is `null` otherwise. Place in `webview-ui/src/components/chat/__tests__/`.

  - [x]* 7.4 Write webview-ui tests for submit-time capture
    - **Property 1 (partial): submit-time capture attaches/omits requestTier**
    - **Validates: Requirements 2.1, 2.2, 2.3, 4.2**
    - JSDOM render `ChatView` with mocked `postMessage`; select a tier then submit the first message → assert `newTask.requestTier`; with an ongoing task → assert `messageResponse` `askResponse.requestTier`; with no selection → assert `requestTier` is omitted. Place in `webview-ui/src/components/chat/__tests__/`.

- [x] 8. Add the focused "race is gone" webview regression test
  - [x]* 8.1 Write the race-regression test parametrized over tiers 1-5
    - **Property 1: Submit-time capture is atomic (no stale tier, no echo)**
    - **Validates: Requirements 4.1, 4.4**
    - JSDOM render `ChatView`; for each tier in {1,2,3,4,5}, select the tier and submit immediately with NO intervening host → webview state message (no echo); assert the submitted `newTask` / `messageResponse` payload carries the selected tier. Place in `webview-ui/src/components/chat/__tests__/`.

- [x] 9. Preserve existing behavior (backward compatibility)
  - [x]* 9.1 Confirm and extend existing host suites remain green
    - Confirm `src/api/providers/__tests__/omniroute.spec.ts` (`withOmniRouteTier` do-not-mutate, drop-invalid, non-OmniRoute strip) and the `ClineProvider` round-trip tests (`ClineProvider.spec.ts`, `ClineProvider.taskHistory.spec.ts`, `ClineProvider.apiHandlerRebuild.spec.ts`) still pass unchanged. Add a focused case asserting that a request with no `requestTier` and a saved tier on an OmniRoute profile emits the same `X-OmniRoute-Tier` header as before this feature.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 10. Final checkpoint - full verification
  - Ensure all tests pass, ask the user if questions arise. Run the narrowest relevant Vitest suites from both owning packages (`src` for pure logic and host wiring; `webview-ui` for component/state tests) and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` on all edited `src` files; confirm no suppression counts increased.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP, but Properties 1-5 and backward-compat tests are strongly recommended before merge.
- Each task references specific granular requirements for traceability; property-test tasks additionally reference the design property they validate.
- Sequencing is test-first and bottom-up: message-type field → pure functions (+ property tests) → host wiring → worker ceiling → webview refactor + submit-time capture → race regression → preserve existing suites.
- Property tests use `fast-check` at min. 100 iterations and are tagged `// Feature: immediate-tier-semantics, Property N: ...` per `AGENTS.md` / `webview-ui/AGENTS.md`.
- Same-file writers are separated into different waves (e.g. `2.1` and `2.2` both touch `omniroute.ts`; `4.1` and `4.2` both touch `webviewMessageHandler.ts`; `7.1`/`7.2` touch different webview files). Tests that share a spec file (`2.3`/`2.4` share `resolveRequestTier.spec.ts`) are placed in different waves to avoid write conflicts.
- No e2e tests: all behavior is covered at the `src` (pure logic / host wiring) and `webview-ui` (component/state) layers; the design deliberately avoids a real extension-host persistence-timing boundary.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.6"] },
    { "id": 3, "tasks": ["2.4", "2.5", "2.7"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "5.1"] },
    { "id": 6, "tasks": ["4.3", "5.2", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3"] },
    { "id": 8, "tasks": ["7.4"] },
    { "id": 9, "tasks": ["8.1", "9.1"] }
  ]
}
```
