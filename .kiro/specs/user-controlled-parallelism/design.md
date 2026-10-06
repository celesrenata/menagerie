# Design Document

## Overview

This feature (FEAT-011) adds a user-facing **parallelism appetite** control to the chat composer, beside the existing OmniRoute cost-tier selector (`OmniRouteTierDropdown`). The control expresses how aggressively Menagerie *may* fan a request out — a **ceiling**, not a GPU count, worker count, or target. The appetite selected when the user presses Enter rides on the submitted request envelope using the same atomic, request-scoped mechanism the tier field uses, so the per-request value never depends on asynchronous settings persistence and cannot lose a race with it.

Three dimensions are **orthogonal**: tier (cost/route ceiling, owned by `immediate-tier-semantics`), parallelism (breadth/concurrency ceiling, this spec), and reasoning effort (cognitive depth per worker, owned by `mastermind-execution-metadata`). Changing one leaves the other two untouched.

This spec defines:

- The composer `Parallelism_Control` and its five modes.
- `ParallelismMode = "conservative" | "balanced" | "auto" | "aggressive" | "max"`, the user-visible labels, and the persisted internal values.
- The `Default_Policy_Table` mapping each mode to recommended ceilings, and a pure `resolveParallelismPolicy(mode)` function.
- Auto-as-default and ceiling-not-target (no-filler) semantics.
- The request-scoped atomic capture of `parallelism?` on the shared request envelope.
- The persisted default global setting and schema, plus the optional `SettingsView` mirror.

The resolved numeric ceilings are **handed to** the `BoundedElasticScheduler` defined by `elastic-parallel-execution`. This spec does **not** enforce them.

### Scope

In scope: the composer-local parallelism state, the `parallelism` envelope field on `newTask` / `messageResponse` `askResponse`, the `ParallelismMode` enum and persisted default, the `Default_Policy_Table` and `resolveParallelismPolicy`, the three-way orthogonality, and the hand-off of resolved ceilings.

Out of scope (separate specs): scheduler internals, execution DAG, reader swarms, speculation, work stealing, inference leasing, parallelism metrics, numeric ceiling **enforcement** (all `elastic-parallel-execution`); redefinition of `omniRouteTier` / `requestTier` (`immediate-tier-semantics`); reasoning budgets (`mastermind-execution-metadata`); GPU scheduling.

### Verified codebase grounding

| Element | Location | Current behavior this design builds on |
| --- | --- | --- |
| `OmniRouteTierDropdown` | `webview-ui/src/components/chat/OmniRouteTierDropdown.tsx` | Popover selector beside the composer controls; renders only for an OmniRoute profile. The parallelism control sits beside it. |
| Composer-local + envelope pattern | `.kiro/specs/immediate-tier-semantics/design.md` | Composer holds synchronous local state; label derives from local state, not the live echo; the dropdown MAY persist async as a separate action; the submit path attaches the local value to the envelope. |
| `ChatView` submit | `webview-ui/src/components/chat/ChatView.tsx` | Posts `{ type: "newTask", text, images }` for the first message and `{ type: "askResponse", askResponse: "messageResponse", text, images }` for subsequent ones. The parallelism value rides on these exactly like `requestTier`. |
| Request envelope | `packages/types/src/vscode-extension-host.ts` (`WebviewMessage`) | `{ text, omniRouteTier?: 1..5, parallelism?: ParallelismMode }`. This spec ADDS only the `parallelism` field to the `newTask` + `messageResponse` `askResponse` message types. It does not redefine `omniRouteTier`/`requestTier`. |
| Global settings | `packages/types/src/global-settings.ts` | Shared Zod schemas and default constants (e.g. `omniRouteTierSchema`). The `ParallelismMode` schema + default `"auto"` are added here. |
| `ExtensionState` | `packages/types/src/vscode-extension-host.ts` | `Pick<GlobalSettings, ...>` carrying settings to the webview (includes `omniRouteTier`). The parallelism default is added here if the webview needs it. |
| Persistence | `ContextProxy` / `ClineProvider.getState()` / `getStateToPostToWebview()` | Generic settings persist via `contextProxy.setValue()` and round-trip to the webview. The `SettingsView` cached-state rule (AGENTS.md) governs any mirror. |
| `BoundedElasticScheduler` | `elastic-parallel-execution` spec | Consumes a `User_Parallelism_Policy` (the resolved ceilings) and enforces them. This spec hands the policy over. |

## Architecture

```mermaid
flowchart TD
    subgraph Webview
        PC[Parallelism_Control<br/>beside OmniRouteTierDropdown]
        LS[Composer-local ParallelismMode state<br/>updated synchronously on select]
        TIER[selectedOmniRouteTier<br/>immediate-tier-semantics]
        REASON[reasoning effort<br/>mastermind-execution-metadata]
        CV[ChatView submit]
        PC -->|select, synchronous| LS
        LS -->|label from local state| PC
        LS -->|at Enter, synchronous read| CV
        TIER --> CV
    end

    CV -->|newTask / messageResponse askResponse<br/>{ text, images, omniRouteTier?, parallelism? }| HOST

    subgraph Host
        H[webviewMessageHandler]
        RP[resolveParallelismPolicy mode -> ParallelismPolicy<br/>Default_Policy_Table]
        CP[ContextProxy<br/>persisted default parallelismMode]
        SCHED[BoundedElasticScheduler<br/>elastic-parallel-execution]
        H -->|effective mode = envelope ?? saved default ?? auto| RP
        RP -->|User_Parallelism_Policy ceilings| SCHED
        CP -. default only .-> H
    end

    subgraph Concurrency boundaries
        GLM[Mastermind GLM<br/>what CAN execute: ExecutionPlan intent]
        MEN[Menagerie<br/>what is ALLOWED: apply user ceiling]
        OR[OmniRoute fabric<br/>what can PHYSICALLY execute]
    end

    RP --> MEN
    GLM --> MEN
    MEN --> OR
```

### Request flow

1. The `Parallelism_Control` renders in the composer beside `OmniRouteTierDropdown`. It holds `selectedParallelismMode` in **synchronous composer-local state** (initialized from the persisted default, falling back to `"auto"`). Selecting a mode updates this state inside the same event handler; the displayed label derives from local state, not from a live echo. The control MAY post `updateSettings({ parallelismMode })` asynchronously as a *separate* action so the saved default stays in sync, but the UI and the per-request value never depend on that round trip. This is the same pattern `immediate-tier-semantics` defines, and it is explicitly how the async-settings race is kept out.
2. At submit time, `ChatView` reads `selectedParallelismMode` **synchronously** and attaches it as `parallelism` on the `newTask` message (first message) or the `messageResponse` `askResponse` message (subsequent messages). When the local state is unset/undefined, the field is omitted.
3. On the host, the effective mode for the request is `envelope.parallelism ?? savedDefault ?? "auto"`, normalized so any non-member value falls back to `"auto"`. The host calls `resolveParallelismPolicy(effectiveMode)` to produce the numeric ceilings.
4. Menagerie applies those ceilings to the mastermind's `ExecutionPlan_Intent` to decide what is **allowed** to execute concurrently, then hands the resolved `User_Parallelism_Policy` to the `BoundedElasticScheduler`. OmniRoute decides what can **physically** execute. This spec supplies the ceilings; it does not enforce them.

### Three concurrency responsibilities (clean boundaries)

- **Mastermind (GLM)** — expresses what *can* execute concurrently: an `ExecutionPlan` of tasks, parallel groups, and dependencies (`ExecutionPlan_Intent`), independent of physical capacity.
- **Menagerie** — decides what is *allowed* to execute concurrently by applying the user's `Parallelism_Ceiling` to the intent. The ceiling is an upper bound; useful decomposition smaller than the ceiling runs below it, and no filler is manufactured.
- **OmniRoute** — decides what can *physically* execute concurrently right now (inference admission and serving topology), independent of appetite and intent.

### Orthogonality

Tier, parallelism, and reasoning each live in their own state:

- Tier: `selectedOmniRouteTier` / `requestTier` (`immediate-tier-semantics`).
- Parallelism: `selectedParallelismMode` / `parallelism` (this spec).
- Reasoning: owned by `mastermind-execution-metadata`.

Each submit handler reads all three and attaches them independently. Changing one control mutates only its own state; the other two are untouched. A single request may combine Tier `$$$$`, MAXIMUM CHAOS, and high reasoning, permitting a decomposition that mixes per-worker reasoning levels — subject to the parallelism ceiling.

### Compatibility

The change is additive and backward compatible. The `parallelism` envelope field and the `parallelismMode` global setting are both optional additions. `omniRouteTier` persistence, the OmniRoute-profile discriminator, the existing composer behavior, and reasoning effort are unchanged. A request with no `parallelism` field and no saved default resolves to `"auto"` — the sensible default breadth — and never manufactures filler, including under MAXIMUM CHAOS.

## Components and Interfaces

### `Parallelism_Control` (webview)

A Popover selector mirroring `OmniRouteTierDropdown`, rendered beside it in the composer toolbar.

- Holds composer-local `selectedParallelismMode: ParallelismMode | undefined`.
- Offers exactly **five** options with labels Conservative, Balanced, Auto, Aggressive, MAXIMUM CHAOS.
- Selecting MAXIMUM CHAOS sets local state to the internal value `"max"`.
- The trigger label derives from local state (the appetite label, e.g. `⚡ Auto`), never from a live echo, and never presents a GPU or worker count.
- When no selection has been made, it presents Auto as active.
- On select it MAY post `updateSettings({ parallelismMode })` asynchronously (separate action) to update the saved default; the UI label and the per-request value do not await this.

```ts
interface ParallelismControlProps {
  selectedParallelismMode: ParallelismMode | undefined
  onSelect: (mode: ParallelismMode) => void   // synchronous composer-local update
  disabled?: boolean
  triggerClassName?: string
}

/** User-visible label for each mode. The persisted value is the enum key, never this string. */
const PARALLELISM_MODE_LABELS: Record<ParallelismMode, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  auto: "Auto",
  aggressive: "Aggressive",
  max: "MAXIMUM CHAOS",
}
```

### `ChatView` submit wiring (webview)

At submit time, `ChatView` reads `selectedParallelismMode` synchronously and attaches it to the outbound message, alongside the existing `requestTier` and reasoning wiring:

```ts
// First message
vscode.postMessage({
  type: "newTask",
  text,
  images,
  ...(selectedParallelismMode ? { parallelism: selectedParallelismMode } : {}),
})

// Subsequent message
vscode.postMessage({
  type: "askResponse",
  askResponse: "messageResponse",
  text,
  images,
  ...(selectedParallelismMode ? { parallelism: selectedParallelismMode } : {}),
})
```

The field is omitted when the local state is unset. Changing the control after submit does not touch the already-sent payload.

### Host resolution (`webviewMessageHandler` + policy resolver)

```ts
/** Normalize any input to a valid ParallelismMode, defaulting unknown/invalid to "auto". */
function normalizeParallelismMode(value: unknown): ParallelismMode

/** Effective mode for a request: envelope value wins, then saved default, then "auto". */
function resolveEffectiveParallelismMode(
  envelope: ParallelismMode | undefined,
  savedDefault: ParallelismMode | undefined,
): ParallelismMode

/** Pure mapping from mode to the resolved numeric ceilings handed to the scheduler. */
function resolveParallelismPolicy(mode: ParallelismMode): ParallelismPolicy
```

The handler computes `resolveEffectiveParallelismMode(envelope.parallelism, saved)` (both normalized), calls `resolveParallelismPolicy(...)`, and supplies the resulting `ParallelismPolicy` to the `BoundedElasticScheduler` as its `User_Parallelism_Policy`. Enforcement is the scheduler's responsibility (`elastic-parallel-execution`).

The handler also persists the parallelism default via `contextProxy.setValue("parallelismMode", mode)` when an `updateSettings` payload carries one (generic setting path).

### Optional `SettingsView` mirror

If a settings mirror of the default is added, per AGENTS.md it binds the control to local `cachedState`, includes `parallelismMode` in the `updateSettings` payload sent by `handleSubmit()` on Save, and round-trips the value via `getStateToPostToWebview()`. The per-request value is **never** derived from `cachedState` — only from composer-local state — so the mirror cannot reintroduce a race.

## Data Models

### `ParallelismMode`

```ts
export const PARALLELISM_MODES = ["conservative", "balanced", "auto", "aggressive", "max"] as const
export type ParallelismMode = (typeof PARALLELISM_MODES)[number]

export const DEFAULT_PARALLELISM_MODE: ParallelismMode = "auto"

// packages/types/src/global-settings.ts
export const parallelismModeSchema = z.enum(PARALLELISM_MODES)
// in the global settings schema:
//   parallelismMode: parallelismModeSchema.optional()   // default "auto" when unset
```

### `ParallelismPolicy` (resolved ceilings)

A ceiling may be a fixed number, `"dynamic"` (mastermind-controlled, e.g. Auto's runnable/swarm), or `"saturate"` (sized to saturate useful capacity, MAXIMUM CHAOS reader swarm). These enumerated non-numeric values let the policy encode the `Default_Policy_Table` exactly while remaining a total function.

```ts
type Ceiling = number | "dynamic" | "saturate"

export interface ParallelismPolicy {
  maxLive: number           // max live workers
  maxRunnable: Ceiling      // max runnable at once
  readerSwarm: Ceiling      // reader swarm size
  speculation: "disabled" | "limited" | "enabled" | "mastermind-controlled"
  workStealing: boolean
  dynamicFanOut: boolean
}
```

### `Default_Policy_Table`

```ts
export const DEFAULT_PARALLELISM_POLICY_TABLE: Record<ParallelismMode, ParallelismPolicy> = {
  conservative: { maxLive: 3,  maxRunnable: 2,          readerSwarm: 2,          speculation: "disabled",             workStealing: false, dynamicFanOut: false },
  balanced:     { maxLive: 6,  maxRunnable: 4,          readerSwarm: 4,          speculation: "limited",              workStealing: true,  dynamicFanOut: false },
  auto:         { maxLive: 12, maxRunnable: "dynamic",  readerSwarm: "dynamic",  speculation: "mastermind-controlled", workStealing: true,  dynamicFanOut: true  },
  aggressive:   { maxLive: 10, maxRunnable: 8,          readerSwarm: 4,          speculation: "enabled",              workStealing: true,  dynamicFanOut: true  },
  max:          { maxLive: 12, maxRunnable: 12,         readerSwarm: "saturate", speculation: "enabled",              workStealing: true,  dynamicFanOut: true  },
}

export function resolveParallelismPolicy(mode: ParallelismMode): ParallelismPolicy {
  return DEFAULT_PARALLELISM_POLICY_TABLE[mode]
}
```

Notes on the table (from Requirement 3): Conservative `maxLive 3 / runnable 2 / swarm 2`, speculation and work stealing off. Balanced `6 / 4 / 4`, speculation limited, work stealing on. Auto `maxLive 12`, runnable and swarm dynamic, speculation mastermind-controlled, work stealing on. Aggressive `10 / 8`, swarm at least 4, speculation on, work stealing on. MAXIMUM CHAOS (`"max"`) `12 / 12`, swarm sized to saturate useful capacity, speculation on, dynamic fan-out on, work stealing on. Values MAY be tuned later; each mode always maps to exactly one entry.

### Request envelope field (shared)

```ts
// packages/types/src/vscode-extension-host.ts — added to newTask + messageResponse askResponse
// { text, images?, omniRouteTier?: 1|2|3|4|5, parallelism?: ParallelismMode }
parallelism?: ParallelismMode
```

Owned fields recap: `omniRouteTier`/`requestTier` belong to `immediate-tier-semantics`; this spec adds only `parallelism`.

### Composer-local state

```ts
// in ChatView composer scope
const [selectedParallelismMode, setSelectedParallelismMode] = React.useState<ParallelismMode | undefined>(
  savedDefaultParallelismMode, // from ExtensionState; undefined => Auto presented
)
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Policy resolution totality

*For any* value `x` (including non-members of the enum), `resolveParallelismPolicy(normalizeParallelismMode(x))` returns exactly the `Default_Policy_Table` entry for the normalized mode; each of the five modes maps to its exact ceilings; selecting MAXIMUM CHAOS yields the mode persisted as `"max"`; and any value that is not a member of `ParallelismMode` normalizes to `"auto"`. The resolver is total and never returns an undefined or label-derived policy.

**Validates: Requirements 2.1, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 4.1, 9.1**

### Property 2: Request-scoped atomic capture

*For any* mode held in composer-local state at the moment the user presses Enter, that exact mode rides on the submitted request as the `parallelism` field — on the `newTask` message for a first message and on the `messageResponse` `askResponse` message for a subsequent one — read synchronously at submit time and never derived from asynchronous settings persistence or `cachedState`; when the local state is unset the field is omitted; and any later change to the control leaves the already-submitted request's `parallelism` field unchanged.

**Validates: Requirements 1.5, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.5**

### Property 3: Orthogonality of the three dimensions

*For any* initial combination of tier, parallelism mode, and reasoning effort, changing the parallelism mode leaves the selected tier and reasoning effort unchanged, and changing the tier leaves the selected parallelism mode and reasoning effort unchanged.

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 4: Ceiling, not target (no filler)

*For any* parallelism mode and *any* useful decomposition of size `u`, the number of workers allowed by the resolved policy is `min(u, ceiling)` and is never padded above `u` to consume capacity; when the ceiling exceeds `u` the system runs below the ceiling, and no mode — including MAXIMUM CHAOS — ever creates filler workers.

**Validates: Requirements 4.4, 5.1, 5.2, 5.3, 5.4, 5.6, 8.2**

### Property 5: Auto dynamic scaling by useful decomposition

*For any* request under Auto mode, the number of logical workers created equals the size of the mastermind's useful decomposition, bounded by the physically admissible capacity, so that identical decompositions of size `u` yield `u` workers (bounded) and no inference slot is filled unless the worker performs useful work.

**Validates: Requirements 4.3, 4.4, 4.5, 4.6**

### Property 6: Scheduler hand-off equality

*For any* request, the `User_Parallelism_Policy` supplied to the `BoundedElasticScheduler` equals `resolveParallelismPolicy(resolveEffectiveParallelismMode(envelope.parallelism, savedDefault))`, so the ceilings handed off are exactly those the effective mode resolves to.

**Validates: Requirements 3.6, 8.5**

## Error Handling

- **Unknown / malformed persisted or received mode** — `normalizeParallelismMode` treats any non-member value (including `undefined`, numbers, or arbitrary strings) as unset and returns `"auto"`. No throw; the request proceeds with the default appetite (Requirement 2.5).
- **Envelope omits `parallelism`** — resolution falls through to the saved default, then to `"auto"`. Omission is the normal unset case, not an error (Requirement 6.7).
- **Async persistence failure of the saved default** — the per-request value is unaffected because it is captured from composer-local state at submit time; a failed `updateSettings` round trip degrades only the remembered default, never the submitted request (Requirements 6.5, 9.5).
- **Non-OmniRoute / unrelated profile** — the parallelism control and field are additive and provider-agnostic at the envelope level; resolution always yields a valid policy, and absence of the field never breaks existing `omniRouteTier` behavior (Requirement 9.6).
- **Scheduler rejects or clamps a ceiling** — out of scope here; this spec hands over a valid, fully-resolved policy and relies on the `BoundedElasticScheduler` for enforcement decisions (Requirement 8.5).

## Testing Strategy

Property-based testing applies to the **pure resolution logic** (mode → ceilings, normalization totality, effective-mode resolution, ceiling-not-target arithmetic). The composer UI wiring, label rendering, option count, settings round-trip, and backward-compat are verified with example-based webview tests, per the webview-ui AGENTS.md guidance. Scheduler **enforcement** of the ceilings is covered by `elastic-parallel-execution`, not here; no e2e is required for this feature.

### Unit and fast-check property tests (`src` / `packages/types`)

Use **fast-check** (minimum 100 iterations per property test). Each property test is tagged with a comment referencing the design property.

- **Policy resolution totality (Property 1)** — fast-check over arbitrary strings/values: `resolveParallelismPolicy(normalizeParallelismMode(x))` deep-equals the `Default_Policy_Table` entry for the normalized mode; the five modes resolve to their exact ceilings; non-members normalize to `"auto"`; MAXIMUM CHAOS resolves via `"max"`. Example assertions pin the concrete table values and the schema default `"auto"`.
  - `// Feature: user-controlled-parallelism, Property 1: resolveParallelismPolicy over normalize(x) is total and returns the exact Default_Policy_Table entry; MAXIMUM CHAOS => "max"; invalid => "auto"`
- **Ceiling, not target (Property 4)** — fast-check over `(mode, u)`: allowed worker count `= min(u, ceiling(mode))` and is never `> u`; across all modes including `"max"`, no filler is produced; when `ceiling > u` the result is `u` (below the ceiling). Example: `u = 2` under `"max"` yields exactly 2.
  - `// Feature: user-controlled-parallelism, Property 4: resolved policy is an upper bound; worker count = min(useful, ceiling); no filler for any mode`
- **Auto dynamic scaling (Property 5)** — fast-check over useful decomposition size `u` and route capacity `c`: Auto worker count `= min(u, c)`, equals `u` when `u <= c`, and never exceeds useful work. Examples: 2 independent investigations → 2 workers; 4 readers + 1 reasoner + 1 verifier → 6 workers.
  - `// Feature: user-controlled-parallelism, Property 5: Auto worker count tracks useful decomposition bounded by route capacity`
- **Scheduler hand-off equality (Property 6)** — fast-check over `(envelope, savedDefault)` (both arbitrary, including invalid): the policy supplied to the scheduler equals `resolveParallelismPolicy(resolveEffectiveParallelismMode(...))`, with precedence envelope → saved → `"auto"`.
  - `// Feature: user-controlled-parallelism, Property 6: supplied policy == resolveParallelismPolicy(effective mode)`
- **Orthogonality (Property 3)** — fast-check over `(tier, parallelism, reasoning)`: applying a parallelism change leaves tier and reasoning equal; applying a tier change leaves parallelism and reasoning equal.
  - `// Feature: user-controlled-parallelism, Property 3: changing one dimension leaves the other two unchanged`
- **Schema / wiring unit tests** — `parallelismModeSchema` default is `"auto"` and accepts exactly the five members; `ExtensionState` includes `parallelismMode`; the handler persists via `contextProxy.setValue` (mocked); envelope construction has the shape `{ text, images?, omniRouteTier?, parallelism? }`.

### Webview JSDOM tests (`webview-ui/src/**/__tests__`, Vitest + `@testing-library`)

- **Request-scoped atomic capture (Property 2)** — select a mode, then submit synchronously; assert the outbound `newTask` carries `parallelism` equal to the just-selected value **without awaiting any persistence**; repeat for the `messageResponse` `askResponse` branch; the race-is-gone test selects a new mode and submits in the same tick, asserting the new value is sent even though `updateSettings` has not resolved; omit-when-unset test asserts no `parallelism` field when local state is undefined; post-submit mutation test changes the control after submit and asserts the captured payload is unchanged.
- **Composer control rendering** — the control renders beside `OmniRouteTierDropdown`; exactly five options; labels Conservative/Balanced/Auto/Aggressive/MAXIMUM CHAOS; selecting MAXIMUM CHAOS yields local value `"max"`; the trigger label derives from local state and shows an appetite label (not a GPU/worker count); unset presents Auto as active (Requirements 1.1–1.4, 2.2, 2.3, 4.2).
- **SettingsView mirror (optional)** — if added, the control binds to `cachedState`, Save includes `parallelismMode` in `updateSettings`, and `getStateToPostToWebview()` round-trips the value; a dedicated test asserts the per-request value does not depend on `cachedState` (Requirement 9.4, 9.5).
- **Backward compatibility** — regression tests assert `omniRouteTier` behavior and the existing composer are unaffected by adding the parallelism control (Requirement 9.6).

### Documented boundaries (not tested here)

Requirements framed as external-layer behavior — Auto's live mastermind/OmniRoute decisions (4.3 behavior), OmniRoute serving topology (7.5), mastermind intent and physical admission (8.1, 8.3), the responsibility assignment (8.4), and numeric ceiling enforcement (8.5) — are architectural boundaries. Their enforcement is proven in `elastic-parallel-execution` and the OmniRoute fabric; this spec verifies only the resolution and hand-off.
