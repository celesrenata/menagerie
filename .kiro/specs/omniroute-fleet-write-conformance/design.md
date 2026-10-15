# Design Document — OmniRoute Fleet Write-Contract Conformance

## Overview

The parent `omniroute-fleet-topology` toolkit is correct in structure and passes 459 tests, but its write path was validated only against a permissive fake. Live bring-up revealed seven divergences from OmniRoute `release/v3.8.52`'s management API (see requirements F1–F7). F1–F6 are fixed and committed; F7 (`isHidden` not honored) is an architectural incompatibility requiring a decision. This design resolves F7, hardens the fake to the full live contract, and reaches a clean confirmed apply.

## The F7 decision

**Recommended: Option A — accept visible internal pools/diagnostics.**

Rationale:
- OmniRoute `release/v3.8.52` cannot hide a combo via create or update (proven). Honoring the toolkit's hidden-pool model would require Option B (an OmniRoute fork change + image rebuild + cluster redeploy) — a larger, cross-repo operation with its own risk — or Option C (a compiler redesign to avoid hidden combos entirely).
- The functional cost of Option A is cosmetic: the 7 `pool/*` and 3 `diag/*` combos appear in the client-selectable catalog alongside the public `hybrid/*` routes. They remain valid, correctly-wired routes; they are simply visible. Clients already see ~94 combos today, so the catalog is not "clean" regardless.
- The route-kind metadata (`internal`/`diagnostic`) the toolkit publishes is independent of the live `isHidden` flag, so drift/plan/evaluate semantics are unaffected.

If the operator prefers a truly hidden internal tier, Option B is the correct long-term fix and should be its own OmniRoute-fork task; this design does not block that.

### Option A implementation sketch
- Compiler: set internal-pool and diagnostic combos to `isHidden: false` (or omit the field), and keep emitting the `internal`/`diagnostic` route-kind in `PublishedRouteMetadata.kinds` (client-side only).
- Apply readback: already compares only client-owned identity fields; drop `isHidden` from the compared set (it is server-owned on this build).
- Remove the ineffective create-then-hide workaround in `applyOneOp` (commit `bc7ea26da`) and its fake modeling; the Strict_Fake instead models "isHidden always stored false."
- Tests: the strict conformance test asserts pools/diagnostics are created (accepted, readback matches) WITHOUT asserting `isHidden: true`.

## Strict_Fake contract mirroring (Requirement 3)

Extend `FakeOmniRouteClient` strict mode to a single `normalizeComboOnWrite` that mirrors the live server, applied in both `createCombo` and `updateCombo` so readback equals what the live server would return:
- Reject: `context_length < 1000`; `tierRouting` present without numeric `defaultTier` + `maximumTier`; non-numeric `concurrencyPerModel`.
- Normalize: model-step `weight` default, `providerId`/`connectionId` -> null, cloud `model` -> `<providerId>/<model>`, strip dead config keys, add `sortOrder`/`version`/`createdAt`/`updatedAt`/`computed_context_length`, force `isHidden: false`.

This makes the compiler→plan→apply conformance test a true contract test.

## Verification / live apply (Requirement 4)

1. Recompile the (committed) inventory; `fleetctl plan -i cluster` must be error-free.
2. `fleetctl apply -i cluster --revision <commit>` with per-invocation operator confirmation -> `succeeded`, 19/19 writes.
3. `fleetctl drift -i cluster` -> zero missing/extra/changed for managed combos.
4. Rollback safety preserved.

## Architecture

The toolkit's write path is a thin, injectable pipeline: `fleetctl apply` -> `apply()` (reconcile/apply.ts) -> `OmniRouteClient` (HTTP or Fake). This spec changes NO structure; it conforms the data crossing the client boundary to the Live_Write_Contract and makes the Fake a faithful stand-in. The compiler (`compile/compiler.ts`) emits combo payloads; the client sends them; OmniRoute normalizes and stores; the apply reads back and compares. The only architectural decision is F7 (internal-pool visibility), resolved as Option A (accept visible) — no new components, no new boundaries.

## Components and Interfaces

- `compile/compiler.ts` — emits `Combo` payloads. Change: internal pools + diagnostics `isHidden: false`; keep `internal`/`diagnostic` route-kind in `PublishedRouteMetadata.kinds` (client-side only).
- `reconcile/apply.ts` — `applyOneOp` (create/update/delete) and `comboReadbackMatches`. Change: remove the create-then-hide follow-up update; drop `isHidden` from the compared identity fields.
- `omniroute/client.ts` — `HttpOmniRouteClient`. No change beyond F1–F6 (already committed).
- `omniroute/fake.ts` — `FakeOmniRouteClient`. Change: single `normalizeComboOnWrite(payload)` mirroring the live reject + normalize rules, applied in `createCombo` and `updateCombo` under strict mode; `isHidden` always stored `false` in strict mode.

## Data Models

No persisted schema changes. The in-memory shapes are unchanged (`Combo`, `ComboInput`, `Connection`, `PublishedRouteMetadata`). The behavioral contract tightened is the mapping from a sent `ComboInput` to the readback `Combo` the live server returns:
- `isHidden`: server-owned; always `false` on this build (not compared).
- cloud model step `model`: stored as `<providerId>/<model>`.
- model steps: gain `weight`, `providerId`/`connectionId` normalized to null.
- server-added fields: `id`, `sortOrder`, `version`, `createdAt`, `updatedAt`, `computed_context_length` (ignored by the readback comparison).

## Correctness Properties

#### Property 1: Payload acceptance
For every inventory the compiler accepts, every emitted combo payload is accepted by the Live_Write_Contract (and by the Strict_Fake).

#### Property 2: Readback stability
Applying a compiled inventory, then reading back, matches on all client-owned identity fields (name, strategy, context_length, authored config keys, model-target identity) ignoring server-owned normalization.

#### Property 3: Rollback safety preserved
Any single failed write restores to the pre-apply state (inherited from the parent spec, must not regress).

## Error Handling

- A payload the live server would reject MUST be rejected by the Strict_Fake at the unit layer (fail fast in tests, never discover it against production).
- A live apply that hits any write error MUST fail-and-restore (unchanged parent behavior); this spec adds no new partial-apply path.
- The management secret resolving to empty/absent MUST abort before any write (unchanged parent behavior).

## Testing Strategy

- Unit: Strict_Fake reject/normalize rules, each field, including the F7 `isHidden`-always-false behavior.
- Integration: compile -> plan -> apply through the Strict_Fake proving P1 + P2 for a fast-check-sampled inventory and for the real `fleet/fleet.kdl`.
- Live (operator-gated): one confirmed `apply` to the cluster -> `succeeded`; `drift` -> clean; rollback spot-check.

## Tasks (plan)

- [ ] 1. Record the F7 decision (Option A unless operator overrides) in this design and confirm with the operator.
- [ ] 2. Remove the ineffective create-then-hide workaround (`applyOneOp`) and the fake's "create strips isHidden but update honors it" modeling.
- [ ] 3. Compiler: internal pools + diagnostics `isHidden: false` (keep internal/diagnostic route-kind client-side).
- [ ] 4. Apply readback: drop `isHidden` from the compared identity fields.
- [ ] 5. Strict_Fake: single `normalizeComboOnWrite` mirroring the full live contract (reject + normalize rules above), applied to create AND update.
- [ ] 6. Conformance test: compile→plan→apply through the Strict_Fake; assert all accepted + readback matches; no `isHidden: true` assertion.
- [ ] 7. Re-plan live (read-only) and confirm zero errors.
- [ ] 8. Confirmed live apply -> succeeded; drift -> clean; verify rollback safety unchanged.

## Known evidence (do not re-derive)

See requirements Evidence Appendix. The management secret is at `/run/secrets/omniroute_management_api_key` (file-backed; the inventory references it as a bare env token, so apply runs with `omniroute_management_api_key=$(cat /run/secrets/...)` exported, OR the inventory is changed to `secretfile:/run/secrets/omniroute_management_api_key`). The committed inventory lives at `fleet/fleet.kdl`; memory (embed/rerank) is intentionally scoped out because its Arc backends are OmniRoute provider-NODES, not provider-connections — a separate gap tracked for a future "provider-nodes support" effort.
