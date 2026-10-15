# Implementation Plan: OmniRoute Fleet Topology

## Overview

This plan builds the Fleet_Topology_System in three places, bottom-up and test-first: a new `packages/fleet` toolkit in the menagerie monorepo (the inventory parser/printer/validator, Route_Compiler, Reconciler, Fleet_Observer, Arrangement_Evaluator, and a `fleetctl` CLI), small additive changes in the Menagerie extension/webview client, and small additive changes in the OmniRoute fork. The toolkit is the only writer to OmniRoute, and only in apply/rollback mode with per-invocation operator confirmation; every other path is read-only.

Work proceeds so each layer rests on tested foundations: the shared Zod vocabulary and the parser/printer/validator land first, then the pure Route_Compiler, then the Reconciler against an in-memory OmniRoute fake, then the Fleet_Observer and Arrangement_Evaluator over a body-free metrics copy, then the `fleetctl` CLI, then the Menagerie_Client reads, and finally the additive OmniRoute changes that the observer and client depend on. Pure components (parser, printer, validator, compiler, estimate replay) perform no I/O and are unit- and property-testable; the Reconciler and Observer take their OmniRoute access through an injected client interface so they are tested against a fake.

The 11 correctness properties in `design.md` are implemented as `fast-check` property tests at the package-local layer, each tagged `// Feature: omniroute-fleet-topology, Property N: ...` with ≥100 iterations. The design-time prototype `.agents/tasks/omniroute-fleet-topology/arrangement-replay.py` and the body-free baseline extract `baseline-attempts-20261007-20261014.jsonl.gz` are the oracles for the compiler/capacity/metric properties and the Arrangement_Evaluator; the TypeScript ports are checked against them.

New toolkit code lives under `packages/fleet/src/` with tests in `packages/fleet/src/__tests__/`; shared schemas live in `packages/types/src/fleet/` so the Menagerie_Client imports the same vocabulary. Menagerie client code extends existing modules (`src/api/providers/omniroute.ts`, `src/api/providers/openai.ts`, `src/core/task/routeCapacityMap.ts`, `src/core/webview/webviewMessageHandler.ts`, `webview-ui/src/components/settings/OmniRouteSettings.tsx`). OmniRoute changes branch off `release/v3.8.52` and are additive.

After editing any Menagerie `src` file, run the narrowest Vitest suite and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>`; suppression counts must not increase (AGENTS.md). For `packages/fleet` and `packages/types`, run that package's Vitest and `turbo check-types`. New settings follow the SettingsView `cachedState`/`getStateToPostToWebview` round-trip rules. Prefer typed APIs over `as any`. Do not create `.changeset` files or edit `CHANGELOG.md`. Strictly read-only against live OmniRoute until an explicit confirmed apply; never print or store a management key.

## Tasks

- [x] 1. Scaffold `packages/fleet` and the shared Fleet_Inventory schema
  - [x] 1.1 Create the `packages/fleet` workspace package
    - Add `packages/fleet/package.json` (name `@roo-code/fleet`, type module, Node 22 engines) with deps `kdljs`, `commander`, `better-sqlite3`, `@roo-code/types`, and devDeps `vitest` 4.1.11, `fast-check` 3.23.2, matching the versions already pinned elsewhere in the monorepo.
    - Add `tsconfig.json` extending `@roo-code/config-typescript`, a `vitest.config.ts`, and `src/index.ts` barrel. Wire the package into `turbo` so `turbo check-types`/`turbo test` pick it up.
    - Verify with `pnpm install` and `pnpm --filter @roo-code/fleet exec tsc --noEmit`.
    - _Requirements: 1.9_

  - [x] 1.2 Define the Fleet_Inventory Zod schema in `packages/types/src/fleet/inventory.ts`
    - Implement `spendClass`, `deviceSchema`, `endpointSchema`, `residencyGroupSchema`, `modelOfferingSchema`, `cloudTargetSchema`, `laneSchema`, `instanceSchema`, `diagnosticSchema`, `alertDestinationSchema`, and the top-level `fleetInventorySchema` exactly as in design §1, including the bounds (slots/ceiling 1-64, context 1-16,777,216, ranks 1-1000, tags ≤32, spill tiers ≤8, maxQueueMs 0-120000, backupRetention 1-1000) and the `capabilityLanes` enum of the four Capability_Lanes.
    - Export the `improvementObjectiveId` enum (the nine ids from Requirement 20.6) and an `improvementObjectiveOrder` array type.
    - Re-export the schema from `packages/types/src/index.ts` and mirror the import into `packages/fleet`.
    - Run `pnpm --filter @roo-code/types exec tsc --noEmit`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.13, 1.14, 1.15, 1.16, 3.1_

- [x] 2. Inventory parser, printer, and validator
  - [x] 2.1 Implement the Inventory_Parser (`packages/fleet/src/inventory/parser.ts`)
    - Parse a KDL document into a loose `ParsedDocument` that retains every declared field, including fields the validator will reject (Requirement 2.1).
    - On a syntax error return a `ParseError` with 1-based line and column and the unexpected/missing element kind, carrying no field value (Requirement 2.2).
    - _Requirements: 2.1, 2.2_

  - [x] 2.2 Implement the Inventory_Printer (`packages/fleet/src/inventory/printer.ts`)
    - Format a typed `FleetInventory` back to KDL; produce byte-identical output for equal models (Requirement 2.3) and a document the parser accepts (Requirement 2.4 round-trip).
    - _Requirements: 2.3, 2.4_

  - [x] 2.3 Implement the Inventory_Validator (`packages/fleet/src/inventory/validator.ts`)
    - Run every check in one pass and return `{ok:true, model}` or a non-empty `violations[]` with field paths and no secret values (Requirements 2.5-2.11, 2.10 single-run totality).
    - Cover: unresolved references and model-device binding (2.5); numeric ranges (2.6); per-device allocation sum ≤ ceiling and per-offering slot bound (2.7); duplicate model ids per endpoint+device, duplicate identifiers, duplicate route names (2.8); inline credential / tokenized-segment rejection reported without the value (2.9, using the Requirement 22.5 definition); missing-required-field, Performance_Rank-count ≠ slot-count, and unknown field (2.11).
    - Add the capability-lane and route-name rules: lane fields complete and in range and no device/endpoint/model id named in capability tags or spill tiers (3.1, 3.2, 3.7); the eight baseline names each declared in exactly one lane (3.3, 3.8); each Capability_Lane mapped to exactly one lane (3.4, 3.8); embeddings and rerank lanes present (3.5); route-name charset/length/uniqueness/retired-successor rules (4.8); diagnostic pinned to a declared device (12.7); exactly one `primary` instance and no slots allocated to a `retired` instance (10.2); improvement-objective order complete, unique, known (20.8).
    - Withhold a rejected inventory from all downstream components (Requirement 2.12).
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 4.8, 10.2, 12.7, 20.8_

  - [x] 2.4 Property tests for parser/printer/validator
    - Create `packages/fleet/src/__tests__/inventory.properties.spec.ts` with a `fast-check` arbitrary that generates valid `FleetInventory` models.
    - **Property 1: Inventory round-trip** — `parse(print(m))` equals `m`, including ordered-field order. **Property 2: Printer stability** — equal models print byte-identically. **Property 3: Validator totality** — `validate` returns ok or a non-empty violation list and never throws on a parsed document. Tag each `// Feature: omniroute-fleet-topology, Property N: ...`, ≥100 runs.
    - Add example-based validator tests: one per rejection rule in 2.5-2.11, 3.x, 4.8, 10.2, 12.7, 20.8, asserting the field path and that no secret value appears in output.
    - Run `pnpm --filter @roo-code/fleet exec vitest run src/__tests__/inventory.properties.spec.ts`.
    - _Requirements: 2.3, 2.4, 2.10_
    - _Properties: 1, 2, 3_

- [x] 3. Route_Compiler
  - [x] 3.1 Target identity and eligibility (`packages/fleet/src/compile/targets.ts`)
    - Implement `targetId` for a Slot (`t:<device>:<endpoint>:<modelId>:<slotIndex>`) and a Cloud_Target (`c:<provider>:<modelId>`), derived only from identity (Requirement 5.3).
    - Implement lane eligibility: exact case-sensitive capability-tag match and context ≥ lane minimum for Slots and Cloud_Targets; exclude Cloud_Targets above the lane max-spend (Requirements 6.1, 6.2, 6.9, 6.11).
    - _Requirements: 5.3, 6.1, 6.2, 6.9, 6.11_

  - [x] 3.2 Ordering, spill tiers, and internal-pool dedup (`packages/fleet/src/compile/order.ts`)
    - Fill-first local order by ascending Performance_Rank, ties by Target_Identifier; the additional 5090 slot sits at its own worse rank (Requirement 6.4).
    - Build each Cloud_Spill_Tier from exactly the eligible Cloud_Targets of that Spend_Class; place tiers after all local Slots in ascending Spend_Class order; report excluded Cloud_Targets; a free tier fails closed within itself (Requirements 6.5, 6.6, 6.7).
    - Dedup Internal_Pools by (ordered target-id list, dispatch-affecting config); name them `pool/<sha1-12>`; emit only pools reachable from a Public_Route (Requirements 5.4, 5.5).
    - _Requirements: 5.4, 5.5, 6.4, 6.5, 6.6, 6.7_

  - [x] 3.3 Capacity, concurrency, and tier ceiling (`packages/fleet/src/compile/capacity.ts`)
    - Derive each local connection `maxConcurrent` and each local target `concurrencyPerModel` from slot counts and the instance Device_Allocation; bound per-instance concurrency on a Model_Offering to min(slots, Device_Allocation) and per Device to the Device_Allocation (Requirements 7.1, 7.2, 7.3, 7.4).
    - List every local provider in the hard-concurrency-providers Routing_Setting so a saturated local target skips to the next ordered target (Requirements 7.5, 7.6).
    - Set `tierRouting.maximumTier` and preserve the `X-OmniRoute-Tier` ceiling mapping (1 local, 2 +free, 3 +low-budget, 4/5/absent = all) on every Public_Route (Requirements 6.8, 7).
    - _Requirements: 6.8, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 3.4 Assemble Desired_Route_State and published metadata (`packages/fleet/src/compile/compiler.ts`)
    - Implement `compile(model, revision)` producing one `DesiredRouteState` per Managed_Instance (none for `retired`), each with combos, Routing_Settings, and `PublishedRouteMetadata`; byte-identical on repeat (Requirement 5.1, 5.2).
    - Emit combos in the live schema shape (`name`, `strategy:"priority"`, `models[]`, `config` with only live-snapshot keys plus `fleetRevision`, `context_length`, `isHidden`), stripping the three dead config keys; emit one Public_Route per lane with aliases, retired-name aliases, and diagnostics (Requirements 4.1, 4.3, 4.5, 4.6, 5.6, 5.10).
    - Publish per-route kind, context window (= lane minimum), RouteCapacity (distinct local Slots on the primary, each device capped at its Device_Allocation), the Capability_Lane→Public_Route map, and per-residency swap latency; derive per-model context overrides and combo context length only from offering/lane context (Requirements 4.11, 13.1, 13.9, 14.1, 14.2, 14.3).
    - For a `secondary` instance, compile the primary's route-name set from the same lanes (Requirement 10.3).
    - Fail compilation (no partial output) with every offender named when a lane has no eligible target on an instance, a parse/validate rejection occurred, or a compiled target is below the lane minimum (Requirements 5.7, 5.9, 11.4-interaction, 13.6); mark the revision uncommitted when the document is dirty (Requirement 5.10); emit no self-referential combo (Requirement 5.11).
    - _Requirements: 4.1, 4.3, 4.5, 4.6, 4.11, 5.1, 5.2, 5.6, 5.7, 5.9, 5.10, 5.11, 10.3, 13.1, 13.6, 13.9, 14.1, 14.2, 14.3_

  - [x] 3.5 Property tests for the compiler
    - Create `packages/fleet/src/__tests__/compiler.properties.spec.ts`.
    - **Property 4: Compiler determinism** — `compile(m,rev)` twice is byte-identical, independent of injected clock/locale/env/secret and of any live-state argument. **Property 5: Target-identifier stability** — changing a Slot's rank/context/tags/lane membership leaves its Target_Identifier unchanged and distinct Slots never collide. **Property 6: Internal-pool dedup and reachability** — no two emitted pools share identical (targets, config); every emitted pool is reachable from a Public_Route. **Property 7: Capacity bound** — per-instance Model_Offering concurrency ≤ min(slots, Device_Allocation) and per-Device ≤ Device_Allocation for all compiled states. ≥100 runs each, tagged.
    - Add an example test compiling a fixture inventory that models today's fleet and asserting the eight baseline Public_Route names, the hard-concurrency Routing_Setting contents, and that the dead OpenRouter-free and 5090-reader targets are absent.
    - Run `pnpm --filter @roo-code/fleet exec vitest run src/__tests__/compiler.properties.spec.ts`.
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 7.2, 7.3_
    - _Properties: 4, 5, 6, 7_

- [x] 4. OmniRoute management client and in-memory fake
  - [x] 4.1 Define the management-API client interface and HTTP implementation (`packages/fleet/src/omniroute/client.ts`)
    - Define `OmniRouteClient` with read methods (`listCombos`, `listConnections`, `getAdvertisedModels`, `getContextOverrides`, `getComboTrace`, `readCallLogs`) and write methods (`createCombo`, `updateCombo`, `deleteCombo`, `patchConnection`, `patchContextOverrides`, `syncModels`), each resolving the management bearer from an injected secret resolver (never logged).
    - Implement the HTTP client against the verified routes (`GET/POST /api/combos`, `PUT/DELETE /api/combos/{id}`, `GET /api/providers`, `PUT/PATCH /api/providers/{id}`, `GET/PATCH/DELETE /api/model-capability-overrides`, `GET /api/providers/{id}/models`, `POST /api/providers/{id}/sync-models`, `GET /api/usage/call-logs`, `GET /api/usage/combo-trace/{id}`). Redact tokenized path segments and secret values from all errors (Requirement 22.4, 22.5).
    - _Requirements: 22.3, 22.4, 22.5_

  - [x] 4.2 Build the in-memory OmniRoute fake (`packages/fleet/src/omniroute/fake.ts`, test util)
    - Implement `OmniRouteClient` over in-memory maps of combos/connections/overrides with per-object readback, so apply/readback/rollback/idempotence can be tested without a live server; include a scripted-failure mode (write error, readback mismatch, timeout) for the error paths.
    - _Requirements: 9.5, 9.6_

- [x] 5. Reconciler: drift detection
  - [x] 5.1 Implement drift detection (`packages/fleet/src/reconcile/drift.ts`)
    - Compare Desired_Route_State to Live_Route_State per Managed_Instance, matching by name, classifying `missing`/`extra`/`unmanaged`/`changed` using the `fleetRevision` provenance key, ignoring OmniRoute-owned bookkeeping fields and the provenance key in the value comparison (Requirements 8.1, 8.2).
    - Include connections, Routing_Settings, synced catalogs, and published metadata; exact case-sensitive model-id checks reporting `undeclared`/`missing`/`stale`; exposed-context mismatch as `changed` (Requirements 8.5, 8.6, 8.7, 8.8).
    - Read-only only; a 3×10 s failed read marks the target `unverified` and the run continues; emit machine + human reports with `complete`/`incomplete`/`failed` (Requirements 8.3, 8.9, 8.10, 8.12).
    - Read `retired` instances with an empty Desired_Route_State so every combo/connection touching a declared device or reusing a declared route name is reported as drift (Requirements 10.4, 10.6).
    - Report an off-inventory concurrency/rate/wait override on a connection as drift (Requirement 7.7).
    - _Requirements: 7.7, 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.12, 10.4, 10.6_

  - [x] 5.2 Implement the scheduled drift run and alert write (`packages/fleet/src/reconcile/schedule.ts`)
    - Run against the latest committed revision on a ≤24 h interval; write the human summary to the Alert_Destination when the outcome is not `complete` or any difference exists; a parse/validate/compile failure ends the run as `failed` (Requirements 8.4, 8.11, 8.13, 8.12).
    - _Requirements: 8.4, 8.11, 8.12, 8.13_

- [x] 6. Reconciler: plan, apply, backup, rollback
  - [x] 6.1 Change_Plan builder and connection-id resolution (`packages/fleet/src/reconcile/plan.ts`)
    - Produce an ordered Change_Plan (combo creates before refs added, deletes after refs removed) listing object id, operation, and complete before/after values, credential-free (Requirements 9.1, 9.2).
    - Resolve each endpoint to its live connection id from `GET /api/providers` at plan time; a missing connection for a declared-active endpoint is a plan error naming the endpoint.
    - Default to dry-run (no writes) when apply/rollback mode or confirmation is absent (Requirement 9.1).
    - _Requirements: 9.1, 9.2_

  - [x] 6.2 Apply with backup, readback, and restore-on-failure (`packages/fleet/src/reconcile/apply.ts`)
    - Enforce the guards in design §3: confirmation matches this plan and operator present (22.2, 22.7); no concurrent apply/rollback on the instance (9.15); refuse an uncommitted revision (9.17); deletions require `confirmDeletions` (9.11); abort if any live object changed since plan creation, compared as drift does (9.4).
    - Capture and checksum-verify a Route_Backup within 60 s before the first write (9.3, 9.15); write each op, read back within 30 s, compare to `after`, and record the readback as the post-apply value (9.5); on any error/timeout/mismatch restore every written object in reverse order and audit the outcome (9.6, 9.16); prune backups to the instance retention (9.13); write the audit entry with operator, UTC times, revision, counts, outcome, and backup location (9.12).
    - Apply only the confirmed plan ops with their listed `after` values in order (9.14); secrets/bodies/tokenized segments excluded from every plan, backup, report, and audit entry (22.4, 22.5, 22.6).
    - _Requirements: 9.3, 9.4, 9.5, 9.6, 9.11, 9.12, 9.13, 9.14, 9.15, 9.16, 9.17, 22.2, 22.4, 22.5, 22.6, 22.7_

  - [x] 6.3 Rollback (`packages/fleet/src/reconcile/rollback.ts`)
    - Checksum the backup and confirm every apply-written object still equals its recorded post-apply value or its backup value, else refuse and report the drifted objects (9.7, 9.8); restore in reverse write order, deleting objects absent from the backup; stop and report on a restore write failure (9.16); refuse an apply/rollback for a `retired` or undeclared instance before any write (10.5).
    - _Requirements: 9.7, 9.8, 9.16, 10.5_

  - [x] 6.4 Secret resolution and missing-secret handling (`packages/fleet/src/omniroute/secrets.ts`)
    - Resolve each credential from its inventory secret ref at use time; if a needed secret does not resolve to a non-empty value within 10 s, send neither the request nor any substitute, report the ref/field-path/cause with no value, and treat an unsent write as an error and an unsent read's values as `unverified` (Requirements 22.3, 22.8, 22.9).
    - _Requirements: 22.3, 22.8, 22.9_

- [x] 7. Reconciler: onboarding and decommissioning
  - [x] 7.1 Preflight_Check and onboarding plan (`packages/fleet/src/reconcile/onboard.ts`)
    - Implement the read-only Preflight_Check (reachability, auth via secret, exact advertised model ids, exposed context) with the 3×10 s retry; on failure exclude the affected offerings and compile as if absent (which may trip Requirement 5.7); place new Slots into every eligible lane and create/update connections and published metadata; create a new connection inactive, sync its catalog, repeat Preflight, then activate; order connection create/sync/activate before any referencing combo (Requirements 11.1, 11.3, 11.4, 11.5, 11.6, 11.7).
    - Satisfy the inventory-only onboarding property: after a successful apply, a drift run reports no drift for the new entries (Requirement 11.2).
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [x] 7.2 Decommission and model-replacement plan (`packages/fleet/src/reconcile/decommission.ts`)
    - Remove every target that resolves to a dropped Model_Offering/Cloud_Target across all routes; place a same-tag replacement into every eligible lane; deactivate connections whose devices are all removed (ordered after the combo updates); keep connections for endpoints shared with surviving devices active; remove stale catalog entries and context overrides and report stale references in un-generated combos; report per-route local-Slot loss (Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6).
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 7.3 Reconciler property and integration tests (against the fake)
    - Create `packages/fleet/src/__tests__/reconciler.properties.spec.ts`.
    - **Property 8: Reconciler idempotence** — apply then plan with no live change yields an empty plan. **Property 9: Apply/rollback round-trip** — apply then rollback restores every object and deletes every created object. **Property 10: Secret and body absence** — with generated secrets injected, no plan/backup/report/audit/alert produced in the suite contains any secret value or tokenized path segment. ≥100 runs each, tagged.
    - Add integration tests driving the full inventory → compile → diff → plan → apply → rollback cycle on the fake, including: the mid-apply failure restore path; the drifted-live abort; the onboarding inventory-only no-drift check; and a decommission plan that removes the dead OpenRouter-free and 5090-reader targets.
    - Run `pnpm --filter @roo-code/fleet exec vitest run src/__tests__/reconciler.properties.spec.ts`.
    - _Requirements: 9.9, 9.10, 11.2, 12.1, 22.4_
    - _Properties: 8, 9, 10_

- [x] 8. Fleet_Observer
  - [x] 8.1 Attribution and the 90-day metrics copy (`packages/fleet/src/observe/attribution.ts`, `packages/fleet/src/observe/copy.ts`)
    - Implement attempt attribution to Device/Model_Offering or Cloud_Target, Public_Route, Lane_Definition, and Capability_Lane using the Fleet_Inventory_Revision live at the attempt start (from the Reconciler audit history) and stable Target_Identifiers; unattributable attempts go to a visible `unattributed` bucket (Requirements 17.1, 17.2, 17.5, 17.6).
    - Implement the ≥24 h body-free copy of attempt and health-probe fields into the observer sqlite store, retained ≥90 days, carrying no body or credential (Requirement 16.12). Reuse the exact field set already exported to `baseline-attempts-20261007-20261014.jsonl.gz`.
    - _Requirements: 16.12, 17.1, 17.2, 17.5, 17.6_

  - [x] 8.2 Metrics computation (`packages/fleet/src/observe/metrics.ts`)
    - Implement `metrics("1h"|"24h"|"7d")` producing per-Device, per-Model_Offering, per-input-bucket, per-Public_Route, Device busy-fraction, Local_Demand_Distribution, and health-probe metrics under the fixed conventions (2xx success, correlation-id requests, completion-anchored in-flight intervals, nearest-rank p50/p95 with sample counts, machine + human output), with `partial`/`no-data`/unreliable-TTFT marks (Requirements 16.1-16.11).
    - Validate the output against the design-time oracle: a fixture run over the baseline extract reproduces the findings §5-6 numbers within the stated tolerance (calibrated A0 landing and cloud-share within a few points; p50/p95 close).
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11_

  - [x] 8.3 Runtime anomaly detection (`packages/fleet/src/observe/anomalies.ts`)
    - Implement the detectors from Requirement 18: Capacity_Leak (two busy-slot skips >5 min apart with nothing in flight on the device), Dead_Target (10 consecutive or 24 h all-failed, ignoring capacity rejections and HTTP 499), cap overrun, rank inversion by bucket, Host_Preemption interval, and route degradation vs the Preservation_Floor; one alert per occurrence with the required names/values and evidence; alert write with ≤5 min/24 h retry and a detection-gap alert when records are unreadable (Requirements 18.1-18.10).
    - Add a regression test fixture for the live 4070 fault window (busy-slot skips with no in-flight attempt) asserting a Capacity_Leak alert fires.
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10_

  - [x] 8.4 Observer tests
    - Create `packages/fleet/src/__tests__/observer.spec.ts`: metric-definition tests over a small synthetic log; the baseline-extract oracle comparison; the 4070 Capacity_Leak regression; a Dead_Target that correctly ignores a ComfyUI preemption burst; and an attribution test across a simulated route regeneration (same Target_Identifier ⇒ same attribution).
    - Run `pnpm --filter @roo-code/fleet exec vitest run src/__tests__/observer.spec.ts`.
    - _Requirements: 16.9, 17.6, 18.1, 18.2_

- [x] 9. Arrangement_Evaluator
  - [x] 9.1 Port the pre-deployment estimate replay (`packages/fleet/src/evaluate/estimate.ts`)
    - Port `arrangement-replay.py`'s Requirement 21 replay to TypeScript over the observer store: group requests, assign each the first free local Slot in the compiled order, hold it start→end, and report free-local-slot fraction per Public_Route plus RouteCapacity next to the baseline Local_Demand_Distribution; deterministic over a fixed window; partial/no-data when records are missing (Requirements 21.1, 21.2, 21.5, 21.6).
    - Keep the speed-model simulation as a clearly-separated, optional extension used for ranking/sizing (not a Requirement), carrying the stated limits in a header comment; cross-check its A0 output against `arrangement-replay-results.md`.
    - _Requirements: 21.1, 21.2, 21.5, 21.6_

  - [x] 9.2 Evaluation window, floors, objectives, ranking (`packages/fleet/src/evaluate/evaluate.ts`)
    - Implement the Evaluation_Window (start after all Managed_Instances applied + longest timeout; end at the earliest 7-28 day offset where each ≥100-request route has ≥500 requests) and the metric computation reusing the observer conventions, including the initial-baseline `zoo-m5`-only route population (Requirements 19.1, 19.2, 19.7).
    - Report every Baseline_Metric with absolute/relative change and the baseline used; apply the Preservation_Floors (final success, code/research p95 ≤110%, local share ≥98.1%, rerank, zero Dead_Target attempts) to Gated_Routes only; report the improvement objectives and rank candidates by the inventory objective order; mark incomplete on an intervening apply/rollback or partial data (Requirements 19.3, 19.4, 19.6, 19.8, 20.1-20.7, 20.9, 20.10).
    - Implement the 24 h early check and the rollback recommendation (names the backup, does not perform rollback) when a floor fails (Requirements 21.3, 21.4); support a re-measured baseline retaining earlier baselines (Requirement 19.5).
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.9, 20.10, 21.3, 21.4_

  - [x] 9.3 Evaluator tests
    - Create `packages/fleet/src/__tests__/evaluate.spec.ts`.
    - **Property 11: Estimate determinism** — the replay over a fixed recorded window is deterministic. Add floor tests: an arrangement that pushes code+research cloud share over the 1.9% baseline is rejected on local-share (20.3); a p95 >110% is rejected (20.2); a Dead_Target attempt rejects (20.5); a non-Gated_Route never causes rejection (19.6, 20.10). Add a ranking test over the eight candidate arrangements asserting the objective-order comparison, and a window-boundary test.
    - Run `pnpm --filter @roo-code/fleet exec vitest run src/__tests__/evaluate.spec.ts`.
    - _Requirements: 20.1, 20.2, 20.3, 20.5, 20.7, 21.1_
    - _Properties: 11_

- [x] 10. `fleetctl` CLI (`packages/fleet/src/cli/`)
  - [x] 10.1 Implement the CLI commands
    - Build a `commander` CLI with: `validate` (parse+validate, print violations); `compile` (write/show the Desired_Route_State); `drift` (read-only report); `plan` (dry-run Change_Plan); `apply` (requires interactive per-invocation confirmation naming the instance, revision, and createdAt, and an explicit deletions flag); `rollback` (requires backup confirmation); `metrics <1h|24h|7d>`; `estimate <revision>`; `evaluate`. Every write command prompts for the Requirement 22.7 confirmation and never prints the management key.
    - Default every command to read-only; `apply`/`rollback` are the only writers.
    - _Requirements: 22.1, 22.2, 22.7_

  - [x] 10.2 CLI smoke tests
    - Add `packages/fleet/src/__tests__/cli.spec.ts` driving `validate`/`compile`/`drift`/`plan` against the fake and a fixture inventory, asserting read-only commands issue no write and `apply` without confirmation refuses.
    - Run `pnpm --filter @roo-code/fleet exec vitest run src/__tests__/cli.spec.ts`.
    - _Requirements: 22.1, 22.2_

- [x] 11. Author the initial `fleet/fleet.kdl` for today's fleet
  - Write the inventory for the current fleet (5090/4070/M5/4×Arc, the cluster `primary` and Mac-local `retired` instances, the lanes with the eight baseline route names, the embeddings and rerank lanes, residency swap latencies, cloud targets, and the improvement-objective order) and run `fleetctl validate` and `fleetctl compile` to confirm it is accepted and compiles.
  - Run `fleetctl drift` read-only against the cluster and confirm the report matches the findings (unmanaged duplicates, the dead targets, the Mac-local shadows).
  - _Requirements: 1.1, 4.2, 3.3, 3.5, 10.1_

- [x] 12. OmniRoute additive changes (fork, branch off `release/v3.8.52`)
  - [x] 12.1 Publish route metadata on the VS Code combos endpoint
    - Extend `projectCombo` (`src/app/api/v1/combos/projectCombo.ts`) and the `/api/v1/vscode/[token]/combos` projection with `kind` (`public`/`alias`/`internal`/`diagnostic`), `contextWindow` (from `computeComboContextLength`), and, for a Public_Route, `routeCapacity` and the `capabilityLane` map. Additive and body-free; older clients ignore the new fields.
    - Add OmniRoute-side unit tests for the projection fields; run its Vitest config.
    - _Requirements: 4.11, 13.1, 14.1, 14.2, 14.3_

  - [x] 12.2 Populate admission wait and record the Capability_Lane
    - Populate the existing `added_wait_ms`/`added_wait_cause` columns where the chat admission queue, connection-concurrency gate, rate limit, or lane max-queue-wait holds a request before dispatch, so admission wait + upstream duration reconstruct end-to-end latency within 1 ms (Requirement 17.3).
    - Persist the Capability_Lane name the client sends (via the existing `session_tag`/`x-omniroute-session-id` channel or the OpenAI `user` field) on the call-log row (Requirement 17.3).
    - Ensure fail-closed and lane-exhausted paths write a not-dispatched call-log row with a non-2xx status (Requirement 17.7).
    - Add OmniRoute-side tests for the wait population, lane recording, and not-dispatched rows.
    - _Requirements: 17.3, 17.7_

  - [x] 12.3 Emit a structured busy-slot-skip signal
    - Where `connectionConcurrencyGate` returns `saturated` and the local-provider skip-to-next fires, emit a structured record (a `combo-trace` decision entry or a per-`(connection, model)` skip counter) readable read-only by the Fleet_Observer, carrying routing metadata only (no body). This is what lets the Capacity_Leak detector run on data instead of log scraping.
    - Add an OmniRoute-side test asserting a skip emits the structured record.
    - _Requirements: 18.1_

- [x] 13. Menagerie_Client reads and flags
  - [x] 13.1 Carry published route metadata through the catalog fetch
    - Extend `omniRouteComboEntrySchema` / `OmniRouteCatalogResponse` (`packages/types/src/providers/openai.ts`) with the optional published fields and parse them in `fetchOmniRouteCatalog` (`src/api/providers/omniroute.ts`); unknown-field tolerance is preserved by the existing safe-parse.
    - Run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0` on the edited files.
    - _Requirements: 13.1, 14.1, 14.2_

  - [x] 13.2 Published route context windows feed auto-condense
    - Change `resolveOmniRouteContextWindow` (`src/api/providers/omniroute.ts`, consumed by `src/api/providers/openai.ts getModel`) to prefer the last successful published catalog for the profile's saved server URL, then the built-in constant, then the profile window, then 128k; refresh the catalog at task start when stale >60 min without delaying the first request; keep the static map only as fallback (Requirements 13.2, 13.3, 13.4, 13.5, 13.7, 13.8).
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.7, 13.8_

  - [x] 13.3 Published capacity and lane routing for the scheduler
    - Add a published-metadata-backed `RouteCapacityProvider` in `src/core/task/routeCapacityMap.ts` that builds the per-RouteCapability map from the published RouteCapacity records and Capability_Lane map via `laneToRouteCapability`, with a 5 s fallback to `STATIC_ROUTE_CAPACITY` and the operator override (Requirements 14.4, 14.5, 14.7, 14.8).
    - Add the opt-in `openAiOmniRoutePublishedLaneRouting` setting (default off) so a routeless parallel worker resolves to its lane's published Public_Route, with the disabled-fallback behavior (Requirements 14.6, 14.9). Follow the AGENTS.md persisted-setting checklist (schema in `packages/types`, `ExtensionState`, `cachedState` in SettingsView, `updateSettings` payload, `getState`, `getStateToPostToWebview`).
    - _Requirements: 14.4, 14.5, 14.6, 14.7, 14.8, 14.9_

  - [x] 13.4 Route-reference validation and lane attribution
    - On each successful catalog refresh, flag saved OmniRoute profile route references and the codebase-index embedder id that are not a published Public_Route/alias for the same origin, with reason `internal`/`direct-model`/`missing` from the published kind, shown in `OmniRouteSettings.tsx`, never rewriting or blocking requests, replacing prior flags within 1 s, keeping flags on a failed refresh (Requirements 15.1-15.8).
    - Attach the Capability_Lane name as request metadata on each request made for a task/worker with an assigned lane, spelled exactly, and on nothing else (Requirement 17.4).
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 17.4_

  - [x] 13.5 Menagerie client tests
    - Add `webview-ui` tests for the route-reference flags and the published-lane-routing setting `cachedState`/save round trip; add `src` package-local tests for `resolveOmniRouteContextWindow` precedence (published → constant → profile → 128k), the capacity-provider fallback, and lane-name request-metadata construction. No e2e test is added (no behavior needs the real extension host).
    - Run the narrowest `webview-ui` and `src` Vitest suites and the eslint prune-suppressions check on each edited file.
    - _Requirements: 13.3, 14.5, 15.1, 17.4_

- [x] 14. Final checkpoint
  - Run `turbo check-types` and `turbo test` for the touched packages and the OmniRoute suite in its repo; confirm all property tests pass and suppression counts did not increase. Confirm the open design decisions (Mac-local `retired`, tier mapping, lane-name channel, published-window-as-lane-minimum, improvement-objective order) with the user before the first confirmed `apply` to the live cluster. Ask the user if questions arise.

## Notes
- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses (`_Requirements:_`) and, where applicable, the design correctness properties (`_Properties:_`). All 22 requirements and all 11 correctness properties are covered.
- The `packages/fleet` toolkit is the only writer to OmniRoute, and only in apply/rollback mode with per-invocation operator confirmation; every other path (drift, metrics, estimate, Preflight) is read-only. Live reads stay read-only until an explicit confirmed `apply`.
- Pure components (parser, printer, validator, compiler, estimate replay) perform no I/O and are unit- and property-tested with `fast-check` (≥100 iterations, tagged `// Feature: omniroute-fleet-topology, Property N: ...`). The Reconciler and Observer take OmniRoute access through an injected `OmniRouteClient` and are tested against an in-memory fake.
- `arrangement-replay.py` and `baseline-attempts-20261007-20261014.jsonl.gz` (in the task folder) are the design-time oracles for the compiler/capacity/metric properties and the Arrangement_Evaluator; the TypeScript ports are checked against them.
- OmniRoute changes are additive, branch off `release/v3.8.52`, and do not alter combo-scheduling semantics. The image build and cluster deploy of those changes is a dependency of tasks 8 and 13 but is an operator step outside this plan's code tasks.
- Per AGENTS.md: after editing a Menagerie `src` file run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` and confirm its suppression count did not increase; new settings follow the SettingsView `cachedState`/`getStateToPostToWebview` round-trip; prefer typed APIs over `as any`; do not create `.changeset` files or edit `CHANGELOG.md`.

## Task Dependency Graph
```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 2, "tasks": ["2.4", "3.1", "4.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "4.2"] },
    { "id": 4, "tasks": ["3.4", "5.1"] },
    { "id": 5, "tasks": ["3.5", "5.2", "6.1", "8.1"] },
    { "id": 6, "tasks": ["6.2", "6.4", "8.2", "9.1"] },
    { "id": 7, "tasks": ["6.3", "7.1", "7.2", "8.3", "9.2"] },
    { "id": 8, "tasks": ["7.3", "8.4", "9.3", "10.1"] },
    { "id": 9, "tasks": ["10.2", "11", "12.1", "12.2", "12.3"] },
    { "id": 10, "tasks": ["13.1"] },
    { "id": 11, "tasks": ["13.2", "13.3", "13.4"] },
    { "id": 12, "tasks": ["13.5", "14"] }
  ]
}
```
