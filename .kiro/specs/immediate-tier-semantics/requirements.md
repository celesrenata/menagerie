# Requirements Document

## Introduction

This feature (FEAT-003 of the Menagerie Autonomous Operations Lift) makes the user's selected OmniRoute cost tier apply immediately and atomically to the exact request submitted at that moment, and defines the tier-ceiling semantics for mastermind worker execution.

Today the per-request tier selector (`OmniRouteTierDropdown`) persists the chosen tier asynchronously by posting an `updateSettings` message and then reads the tier back from live extension state. A user who selects a tier and immediately submits a request can have that request sent with the previous (stale) tier, because the settings round trip has not yet been incorporated. This feature eliminates that race by making the tier a field of the request envelope captured at submit time, with a defined resolution order of request-envelope tier over saved tier over OmniRoute default.

The feature also constrains how the mastermind requests tiers for its workers: the user's selected tier is a request ceiling. The mastermind may request cheaper (lower) tiers for individual workers but must not send a tier above the user's ceiling. OmniRoute remains solely responsible for actual model, provider, and GPU placement; this feature only constrains the tier ceiling that Menagerie sends on the request.

This feature is scoped only to immediate tier semantics and the worker tier ceiling. Observatory, loop detection, semantic retrieval, branding, reasoning budgets, parallelism scheduling, and the parallelism-mode envelope field are out of scope and covered by separate specs.

## Glossary

- **Request_Envelope**: The payload submitted for a single user request. Its shape is `{ text, images?, requestTier? }`, where `requestTier` is an optional integer cost tier in the range 1 through 5. This feature adds the `requestTier` field; no other envelope field is in scope.
- **Request_Tier**: The effective cost tier applied to a single submitted request, resolved from the Request_Envelope tier, the Saved_Tier, and the OmniRoute_Default in that order of precedence.
- **Composer_Local_Tier_State**: The tier value held locally in the composer (chat input) component. It is named `selectedOmniRouteTier` and is updated synchronously when the user makes a selection, independent of any persistence round trip.
- **Saved_Tier**: The persisted global `omniRouteTier` setting, stored through `ContextProxy` and round-tripped onto the active OmniRoute profile by `ClineProvider.getState()`.
- **OmniRoute_Default**: OmniRoute's own default routing behavior, used when no tier is specified. Expressed by sending no `X-OmniRoute-Tier` header.
- **Tier_Ceiling**: The maximum cost tier the mastermind may request for any worker during a mastermind execution. It equals the user's selected Request_Tier for that execution.
- **X_OmniRoute_Tier_Header**: The `X-OmniRoute-Tier` HTTP request header (constant `OMNIROUTE_TIER_HEADER`) that carries the resolved integer tier (1 through 5) to OmniRoute.
- **Atomic_Submission**: The guarantee that the Request_Tier applied to a request is captured at the moment the request is submitted, so no request is ever sent with a stale tier due to an uncompleted settings persistence round trip.
- **OmniRoute_Profile**: A provider profile that is an OpenAI-compatible provider (`apiProvider` of `openai`) with `openAiIsOmniRoute` set to `true`. This is the sole discriminator for OmniRoute behavior.
- **Composer**: The chat input component (`ChatView` and the `OmniRouteTierDropdown` it hosts) through which the user selects a tier and submits requests.
- **Mastermind**: The Menagerie orchestration component that fans work out to parallel worker tasks during a mastermind execution.

## Requirements

### Requirement 1: Composer-local immediate tier state

**User Story:** As a user, I want my tier selection to register in the composer instantly, so that the request I submit next uses the tier I just selected without waiting for a settings round trip.

#### Acceptance Criteria

1. WHEN the user selects a cost tier of 1, 2, 3, 4, or 5 in the Composer, THE Composer SHALL set Composer_Local_Tier_State to the selected tier synchronously within the same event handler.
2. WHEN the user selects the Default option in the Composer, THE Composer SHALL set Composer_Local_Tier_State to undefined synchronously within the same event handler.
3. WHERE the Composer updates the Saved_Tier, THE Composer SHALL post the `updateSettings` message carrying `omniRouteTier` asynchronously as a separate action from updating Composer_Local_Tier_State.
4. THE Composer SHALL derive the displayed tier label from Composer_Local_Tier_State rather than from the live `omniRouteTier` value read from extension state.
5. THE Composer SHALL render the tier selector only WHERE the active profile is an OmniRoute_Profile.

### Requirement 2: Request envelope carries the submit-time tier

**User Story:** As a user, I want each request to carry the tier I had selected when I pressed submit, so that the request is routed at that tier.

#### Acceptance Criteria

1. WHEN the user submits the first message of a task, THE Composer SHALL include the Composer_Local_Tier_State value as `requestTier` on the submitted `newTask` message.
2. WHEN the user submits a subsequent message, THE Composer SHALL include the Composer_Local_Tier_State value as `requestTier` on the submitted message-response `askResponse` message.
3. WHERE Composer_Local_Tier_State is undefined at submit time, THE Composer SHALL omit `requestTier` from the Request_Envelope.
4. THE Request_Envelope SHALL carry `requestTier` only as an integer in the range 1 through 5 when present.
5. IF a `requestTier` value outside the range 1 through 5 is present on a Request_Envelope, THEN THE System SHALL treat the Request_Envelope as having no `requestTier`.

### Requirement 3: Request tier resolution order

**User Story:** As a user, I want a predictable rule for which tier applies to a request, so that my per-request selection always takes precedence over the saved default.

#### Acceptance Criteria

1. WHERE a Request_Envelope carries a valid `requestTier`, THE System SHALL resolve the Request_Tier to the Request_Envelope `requestTier`.
2. WHERE a Request_Envelope carries no valid `requestTier` AND a Saved_Tier is set, THE System SHALL resolve the Request_Tier to the Saved_Tier.
3. WHERE a Request_Envelope carries no valid `requestTier` AND no Saved_Tier is set, THE System SHALL apply the OmniRoute_Default by resolving no Request_Tier.
4. WHEN the Request_Tier resolves to an integer in the range 1 through 5 for an OmniRoute_Profile, THE System SHALL emit the X_OmniRoute_Tier_Header carrying that integer as a string.
5. WHERE no Request_Tier is resolved, THE System SHALL omit the X_OmniRoute_Tier_Header so OmniRoute applies the OmniRoute_Default.

### Requirement 4: Atomic submission with no stale tier

**User Story:** As a user, I want selecting a tier and immediately submitting to send that request at the selected tier, so that I never get the previous tier because of a pending settings update.

#### Acceptance Criteria

1. WHEN the user selects a tier and then submits a request before the `updateSettings` round trip completes, THE System SHALL resolve the Request_Tier for that request to the selected tier.
2. THE Composer SHALL capture the `requestTier` on the Request_Envelope from the value of Composer_Local_Tier_State at the moment of submission.
3. IF the Saved_Tier has not yet been updated to the user's latest selection when a request is submitted, THEN THE System SHALL still resolve the Request_Tier from the Request_Envelope rather than from the Saved_Tier.
4. THE System SHALL resolve the Request_Tier without requiring a state-echo round trip from the extension host back to the Composer.

### Requirement 5: Tier ceiling for mastermind workers

**User Story:** As a user, I want my selected tier to cap how expensive the mastermind's workers can be, so that the mastermind can economize with cheaper workers but never exceed the cost I authorized.

#### Acceptance Criteria

1. WHEN a mastermind execution begins, THE Mastermind SHALL set the Tier_Ceiling to the resolved Request_Tier for that execution.
2. WHERE the Mastermind requests a worker at a tier lower than the Tier_Ceiling, THE Mastermind SHALL send that lower tier for that worker.
3. IF the Mastermind would request a worker at a tier above the Tier_Ceiling, THEN THE Mastermind SHALL clamp the requested tier to the Tier_Ceiling.
4. WHERE no Request_Tier is resolved for a mastermind execution, THE Mastermind SHALL impose no Tier_Ceiling and SHALL rely on the OmniRoute_Default for worker placement.
5. THE Mastermind SHALL delegate actual model, provider, and GPU placement to OmniRoute and SHALL constrain only the tier ceiling sent on each worker request.

### Requirement 6: Backward compatibility

**User Story:** As an existing user, I want this change to leave the existing tier setting, header behavior, and non-OmniRoute profiles working as before, so that nothing regresses.

#### Acceptance Criteria

1. THE System SHALL continue to persist and read the existing global `omniRouteTier` setting as the Saved_Tier.
2. THE System SHALL emit the X_OmniRoute_Tier_Header only WHERE the active profile is an OmniRoute_Profile.
3. WHERE the active profile is not an OmniRoute_Profile, THE System SHALL omit the X_OmniRoute_Tier_Header regardless of any `requestTier` on the Request_Envelope.
4. WHEN a request carries no `requestTier` and the Saved_Tier is set on an OmniRoute_Profile, THE System SHALL emit the X_OmniRoute_Tier_Header for the Saved_Tier exactly as it did before this feature.
5. THE System SHALL leave `withOmniRouteTier` behavior for non-OmniRoute profiles unchanged, carrying no tier on non-OmniRoute profiles and dropping invalid tiers.
