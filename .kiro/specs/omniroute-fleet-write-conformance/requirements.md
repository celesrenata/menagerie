# Requirements Document

## Introduction

This is the **OmniRoute Fleet Write-Contract Conformance** follow-up to `omniroute-fleet-topology`. The parent spec shipped a complete, 1240+-test toolkit whose write path (`fleetctl apply`) had never been exercised against the live OmniRoute management API — only against the in-memory `FakeOmniRouteClient`, which accepted any payload shape. Bringing the toolkit up against the live cluster (`https://omniroute.celestium.life`, OmniRoute `release/v3.8.52`) surfaced a series of real divergences between the toolkit's assumed contract and OmniRoute's actual `/api/combos` + `/api/providers` behavior.

Six of the findings were fixed and committed during the bring-up (list-response unwrapping, connection address resolution, three combo-config payload fields, apply-readback normalization tolerance, cloud-model provider-prefix tolerance). The **seventh** is an architectural incompatibility — OmniRoute does not honor `isHidden` on either create or update via its management API — that cannot be resolved as a client patch and requires a deliberate design decision. This spec exists to:

1. Record every discovered live-contract gap with its evidence, so the knowledge is not lost.
2. Resolve the `isHidden` / internal-pool-visibility incompatibility by an explicit design choice.
3. Harden the `FakeOmniRouteClient` to mirror the real OmniRoute write contract so this class of bug is caught at the unit layer, not against production.
4. Reach a clean, confirmed `fleetctl apply` to the live cluster.

### Context: what is already fixed (parent spec, committed to `main`)

These are DONE and must not be re-litigated; they are listed so this spec builds on them:

- **F1 — List-response unwrapping.** `HttpOmniRouteClient` list reads (`listCombos`/`listConnections`/`getAdvertisedModels`/`getContextOverrides`/`readCallLogs`) assumed a bare JSON array; the live API wraps lists (`{ object, data, combos }`). Fixed with `requestArray`/`unwrapArray`. (commit `f8ee6f69c`)
- **F2 — Connection address resolution.** The live `/api/providers` records carry the upstream address nested in `providerSpecificData.baseUrl` (camelCase), not a top-level `address`; the endpoint→connection match keyed on `hostPort(connection.address)` and always failed. Fixed by lifting `baseUrl` in `listConnections`. (commit `f8ee6f69c`)
- **F3 — Combo payload fields.** The live create schema rejected (HTTP 400): `context_length < 1000` (internal pools/diagnostics emitted 0), `config.concurrencyPerModel` as a per-model MAP (coerced to NaN; live wants a scalar), and a missing `config.tierRouting.defaultTier`. Fixed in the compiler; strict-schema fake added. (commit `dfed1ea4b`)
- **F4 — Readback normalization tolerance.** OmniRoute normalizes a combo on write (fills model-step `weight`, defaults `providerId`/`connectionId` to null, strips dead config keys, adds `sortOrder`/`version`/`createdAt`/`updatedAt`/`computed_context_length`). The apply readback did exact `deepEqual` and false-failed. Fixed to compare only client-owned identity fields. (commit `b204d90bb`)
- **F5 — Cloud-model provider-prefix.** OmniRoute prefixes a cloud target's model id with its provider on write (`codestral-latest` -> `mistral/codestral-latest`). The readback model-step comparison now accepts the `<providerId>/<model>` form. (commit `bc7ea26da`)
- **F6 — tierRouting requires maximumTier.** When `config.tierRouting` is present, the live create schema requires BOTH `defaultTier` AND `maximumTier` as numbers. The compiler already emits both for real lanes; recorded here because an ad-hoc payload without `maximumTier` is rejected.

### The open finding this spec must resolve

- **F7 — `isHidden` is not honored by the OmniRoute management API.** PROVEN by controlled live probes:
  - `POST /api/combos` with `isHidden: true` returns `isHidden: false` (the `createComboSchema` in the OmniRoute fork does not declare `isHidden`, so Zod `.strip()` drops it).
  - `PUT /api/combos/:id` with `isHidden: true` ALSO returns and reads back `isHidden: false`, even though `updateComboSchema` DOES declare `isHidden: z.boolean().optional()`. Something downstream (db merge / `normalizeStoredCombo` / server override) does not persist it on this build.
  - Therefore internal pools (7) and diagnostics (3) — which the toolkit models as HIDDEN combos — cannot be hidden through the management API on OmniRoute `release/v3.8.52`.
  - A create-then-update workaround was committed (`bc7ea26da`) on the assumption the update path would honor `isHidden`; the later probe proved it does NOT. **That workaround is therefore ineffective dead code and this spec must remove or replace it.**

### Non-Goals

- This spec MUST NOT change OmniRoute combo-scheduling semantics.
- This spec MUST NOT perform a live `apply` without the parent spec's per-invocation operator confirmation.
- This spec does NOT re-implement the compiler/reconciler; it conforms their write payloads and verification to the live contract and resolves F7.
- Rebuilding/redeploying the OmniRoute container image is out of scope UNLESS the F7 decision is "fix OmniRoute" (Requirement 2, option B), in which case it is called out as an explicit operator step, not code in this repo.

## Glossary

- **Live_Write_Contract**: The actual request/response schema and normalization behavior of the OmniRoute management API (`/api/combos`, `/api/combos/:id`, `/api/providers`) on the deployed build, as distinct from the toolkit's assumed contract.
- **Strict_Fake**: `FakeOmniRouteClient` with `strictComboSchema` (and, per this spec, broader contract mirroring) enabled, so unit tests reject exactly what the live server rejects and normalize exactly what it normalizes.
- **Internal_Pool_Visibility**: Whether the 7 internal `pool/*` combos and 3 `diag/*` combos appear in the client-selectable catalog. OmniRoute cannot hide them via the API (F7); this spec decides the end state.

## Requirements

### Requirement 1: Dead isHidden workaround removal

**User Story:** As a maintainer, I want the ineffective create-then-hide workaround removed, so the code does not imply a capability OmniRoute does not provide.

#### Acceptance Criteria
1. WHEN the toolkit creates a combo THEN it SHALL NOT rely on a follow-up `updateCombo` to set `isHidden`, because the live API does not persist `isHidden` on create OR update (F7).
2. The `FakeOmniRouteClient` strict-mode behavior that models "create strips isHidden" SHALL be updated to also model "update does not persist isHidden" so no test implies the workaround works.
3. Any test asserting the create-then-hide path hides a combo SHALL be removed or rewritten to assert the chosen F7 end state (Requirement 2).

### Requirement 2: Resolve internal-pool visibility (the F7 decision)

**User Story:** As the fleet operator, I want an explicit decision on internal-pool visibility, so apply produces the intended catalog.

#### Acceptance Criteria

Exactly ONE option is chosen and implemented:
1. **Option A (accept visible):** WHEN internal pools/diagnostics are applied THEN the toolkit SHALL treat them as visible combos, the compiler SHALL set `isHidden: false` (or omit it), and the readback comparison SHALL NOT assert `isHidden`. The route-kind metadata (`internal`/`diagnostic`) SHALL still be tracked client-side even though the live catalog shows them.
2. **Option B (fix OmniRoute):** WHEN option B is chosen THEN the OmniRoute fork SHALL be amended so `isHidden` persists through create and/or update, AND the image rebuild + cluster redeploy SHALL be documented as an operator step; only then SHALL the toolkit assert hidden pools.
3. **Option C (no hidden-combo dependency):** WHEN option C is chosen THEN the compiler SHALL be reworked to not express internal pools as hidden combos at all, using an OmniRoute-supported mechanism.
4. The chosen option SHALL be recorded in this spec's design before implementation, and confirmed with the operator.

### Requirement 3: Strict_Fake mirrors the full live write contract

**User Story:** As a maintainer, I want the fake to reject/normalize exactly as the live server does, so write-path bugs are caught before production.

#### Acceptance Criteria
1. The Strict_Fake SHALL reject a combo payload the live server rejects: `context_length < 1000`; `config.tierRouting` present without a numeric `defaultTier` AND numeric `maximumTier` (F6); non-numeric `config.concurrencyPerModel`.
2. The Strict_Fake SHALL normalize on write exactly as the live server: fill model-step `weight`, default `providerId`/`connectionId` to null, prefix a cloud target's `model` with `<providerId>/`, strip dead config keys, add `sortOrder`/`version`/`createdAt`/`updatedAt`/`computed_context_length`, and force `isHidden` per the F7 decision.
3. The compiler→plan→apply conformance test SHALL run against the Strict_Fake and prove every generated payload is accepted and every readback matches.

### Requirement 4: Clean confirmed live apply

**User Story:** As the fleet operator, I want a successful, confirmed apply to the live cluster.

#### Acceptance Criteria
1. WHEN the inventory is committed and pinned to a revision THEN `fleetctl apply -i cluster` SHALL complete with outcome `succeeded` and all planned writes landed.
2. The apply SHALL require the per-invocation operator confirmation (parent spec Requirement 22.7) and SHALL NOT delete unmanaged combos without `--confirm-deletions`.
3. AFTER a successful apply, `fleetctl drift -i cluster` SHALL report zero missing/extra/changed for the managed combos.
4. The apply SHALL remain safe-by-rollback: any failed write SHALL restore to the pre-apply state (parent spec Requirement 9.6).

## Evidence Appendix (live probes, 2026-10-15)

- `POST /api/combos` create response for `pool/*`: `isHidden` sent `true` -> returned `false`; cloud model `codestral-latest` -> `mistral/codestral-latest`; added `sortOrder`, `version:2`, `createdAt`, `updatedAt`, `computed_context_length`; model steps gained `weight:0`, `providerId/connectionId` normalized.
- `PUT /api/combos/:id` with `isHidden:true` -> returned/readback `isHidden:false` (F7 proven for the update path).
- `createComboSchema` (OmniRoute fork `src/shared/validation/schemas/combo.ts`) has no `isHidden`; `updateComboSchema` has `isHidden: z.boolean().optional()` but it does not persist on the deployed build.
- All probes created a single combo and deleted it; the live cluster was left unchanged.
