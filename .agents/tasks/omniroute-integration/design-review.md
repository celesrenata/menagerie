# Design Review: OmniRoute Integration (revision 3)

Reviewed document: `docs/architecture/omniroute-integration-design.md`
Reviewer: design-review subagent (fresh context)
Scope: ambiguity, gaps, unverified assumptions, feasibility, scope creep,
conflicts, error handling, input validation.

All source claims were independently verified against the menagerie workspace
and the local OmniRoute checkout at `~/sources/celesrenata/omniroute`. This is
the third revision; the design's §11 carries responses to two prior review
rounds (round 1: 3 HIGH / 4 MEDIUM / 3 NIT; round 2: 0 HIGH / 2 MEDIUM / 2 NIT).
I re-reviewed the current text on its own merits rather than trusting the prior
closures, and I confirmed each of the two MEDIUM and two NIT items from round 2
is actually resolved in the current text (see "Round-2 findings re-checked").

The design's file/line/symbol claims are accurate across the board (see Verified
Assumptions). The residual items below are all NIT-level precision gaps; none
blocks implementation.

## Verdict basis

Findings are counted mechanically: any HIGH or MEDIUM ⇒ CHANGES_REQUESTED; zero
HIGH and zero MEDIUM ⇒ APPROVED.

---

## Findings

### 1. NIT — §3 says "reuse the existing model-fetch plumbing" but the existing fetch returns only `string[]` and must be replaced, not reused

§3 opens with "Reuse the existing model-fetch plumbing rather than inventing a
channel" and cites `getOpenAiModels(baseUrl, apiKey, …)`. Verified against
`src/api/providers/openai.ts:569`: `getOpenAiModels` issues
`axios.get(\`${trimmedBaseUrl}/models\`)` and then does
`response.data?.data?.map((model) => model.id)`, returning a de-duplicated
`string[]`. It discards `family`, `toolCalling`, `vision`, the reasoning-effort
metadata, and the per-model `url` the catalog UI needs. The design *correctly*
concludes it needs a dedicated `omniRouteCatalog` message pair (not the string
list), and correctly notes the fetch must target `${base}/models?prefix=alias`,
so the substance is right. The wording "reuse the existing plumbing" is slightly
misleading: what is reused is the *message-round-trip pattern* and the unsaved
-edit `message.values` convention, not `getOpenAiModels` itself, which cannot be
reused (it drops the fields and hardcodes the `${baseUrl}/models` shape).

CONCRETE FIX: In §3, change "Reuse the existing model-fetch plumbing" to "Follow
the existing model-fetch *message pattern* (webview posts server root + key from
`cachedState`; handler fetches and posts back), but add a dedicated fetch — the
existing `getOpenAiModels` returns only `string[]` and cannot carry the enriched
catalog fields." Optionally name the new fetch (e.g. `getOmniRouteCatalog(base,
apiKey)` in `src/api/providers/openai.ts`) and its return type
(`OmniRouteCatalogEntry[]`) so the coder does not have to infer placement.

### 2. NIT — §3 typo ("filters is done server-side") could read as a missing subject

§3 states the handler "issues `GET ${base}/models?prefix=alias`, filters is done
server-side, and returns the enriched entries." The clause "filters is done" is
ungrammatical and momentarily ambiguous about whether the *client* filters.
Verified: filtering is server-side — the tokenized route
(`src/app/api/v1/vscode/[token]/models/route.ts:349`) applies
`.filter(isUsableChatModel)`, so the intent (no client-side filtering) is
correct.

CONCRETE FIX: Reword to "…issues `GET ${base}/models?prefix=alias`; chat-model
filtering happens server-side (`isUsableChatModel`), and the handler returns the
enriched entries verbatim."

---

## Round-2 findings re-checked (all resolved in current text)

- **R2-Finding 1 (MEDIUM, tool-arg migration mechanism):** RESOLVED. §7 now
  specifies per subsystem — change `parallelTaskSpecSchema` from `.strict()` to
  `.strip()` for the transition (the only `ZodObject` mode that accepts and
  silently drops unknown keys), leave `parallelTasksSchema` unchanged, restore
  `.strict()` later; for hand-read `new_task`/`switch_mode`, not reading the
  fields is the tolerate step. §4.4 repeats the `.strict()`→`.strip()` step and
  §8 pins the transitional test to `.strip()` behavior. Verified against
  `ParallelTasksTool.ts` (both schemas end in `.strict()` today).

- **R2-Finding 2 (MEDIUM, ambiguous approval summary):** RESOLVED. §4.4 now
  makes one concrete choice with no "may/optionally": the summary becomes
  `${spec.name} (${spec.mode})` and appends `spec.route` verbatim when set;
  it explicitly does not attempt to show the role-defaulted/parent-fallback id
  because that resolution happens later in `runParallelTasks.ts` and is out of
  scope where the tool assembles the string. `spec.route` is in scope in
  `ParallelTasksTool.ts` (feasible).

- **R2-Finding 3 (NIT, combos-path wording):** RESOLVED. §2.2/§5/§6 now use the
  positive verified fact ("client uses `/api/v1/vscode/<token>/combos`; a
  non-tokenized top-level `/api/v1/combos` route also exists but is not used
  here"). Both routes confirmed to exist on disk.

- **R2-Finding 4 (NIT, taskBoard label):** RESOLVED. §4.7 now names both
  surfaces precisely — the `tier` const (≈104) feeding the **"Requested
  capability"** card (≈137) and the **"Requested tier:"** tree tooltip
  (≈188–189), with all four `row.routing` reads (≈104, ≈137, ≈188–189, ≈214)
  removed. Labels confirmed verbatim in `taskBoard.ts`.

---

## Verified Assumptions

Each of these design claims was checked against actual source and is correct.

Menagerie:

1. **Two production `omniroute.celestium.life` literals** — exactly
   `src/core/task/omnirouteTier.ts:29` and
   `webview-ui/src/components/chat/ChatView.tsx:138`, plus test fixtures at
   `Task.spec.ts:979`, `ChatView.spec.tsx:432`, `omnirouteTier.spec.ts:14`.
   Repo-wide grep confirms no other production hits. Criterion (a).
2. **`omnirouteTier.ts` exports** `taskRouting`, `userTaskRouting`,
   `modelTaskRouting`, `childTaskRouting`, `applyTaskRouting`, `withChildRouting`,
   `USER_SELECTED_ROUTING_REASON`, `TaskRouting`, `isOmniRoute`, the
   `X-OmniRoute-Tier` header construction, and the `hybrid/`-prefix throw guard —
   all present exactly as §4.1 describes.
3. **`history.ts`** — `taskRoutingSchema` (line 9), `historyItemSchema
   .omnirouteRouting` (line 52), and the `create_subtask` variant's
   `omnirouteRouting` in `pendingTaskActionSchema` (line 24) — all three uses
   §4.2 names are present.
4. **`providerHandoff.ts`** — `TaskExecutionContext.omnirouteRouting` (line 4),
   matching §4.2.
5. **`vscode-extension-host.ts`** — `setOmniRouteTier` in the `WebviewMessage`
   action union (line 478), `routingTier?: number` field (line 654), and the
   distinct top-level `tab?: "settings" | … | "cloud"` union (line 657). §2.1's
   claim that `tab` is a separate top-level selector, not the settings
   `SectionName` registry, is correct.
6. **`Task.ts`** — the `omnirouteRouting` field (≈383),
   `initialOmniRouteRouting` `TaskOptions` (≈222) and destructuring (≈585), the
   constructor init block ending `isOmniRoute(initialConfiguration) ?
   taskRouting(1) : undefined` (≈640–645), `applyTaskRouting(initialConfiguration,
   …)`, the `historyItem.omnirouteRouting = …` persistence line (≈1457), the
   `applyTaskRouting` in `updateApiConfiguration` (≈1871), the `setOmniRouteTier`
   method (≈1875), and the pending-subtask `omnirouteRouting: action
   .omnirouteRouting` (≈2705) — all present.
7. **`ClineProvider.ts`** — `withChildRouting`/`TaskRouting` import (line 1),
   `initialOmniRouteRouting` on `createTask` options (≈3439), `omnirouteRouting?`
   on `initClineWithTask` (≈3871) and `initNewTask` (≈3884), and the
   `withChildRouting(getTaskHandoffContext(parent, mode), params.omnirouteRouting
   ?.tier, …reason, parent.omnirouteRouting)` computation (≈3924–3927). §4.3a
   accurate. `getTaskHandoffContext(parent, mode, preferSavedModeProfile = true)`
   signature confirmed, so §4.5's `getTaskHandoffContext(parent, spec.mode,
   true)` call is valid.
8. **Tools & shared types** — `routing_tier`/`routing_reason` in
   `src/shared/tools.ts` (`new_task`, `parallel_tasks`, `switch_mode`),
   `parallelTaskSpecSchema` with `routing_tier`/`routing_reason` and `.strict()`
   in `ParallelTasksTool.ts` (both spec and wrapper `.strict()`), and the current
   approval fragment `${spec.name} (${spec.mode}, tier ${Math.max(spec
   .routing_tier ?? 1, task.omnirouteRouting?.tier ?? 1)})` — all present.
9. **Native tool schemas** — `native-tools/routingTier.ts` exports
   `routingTierParameter`/`routingReasonParameter`; `switch_mode.ts`,
   `new_task.ts`, `parallel_tasks.ts` each import them and list them in both
   `properties` and `required`; `switch_mode.ts`'s description instructs the
   model to "set routing_tier". §4.4 accurate.
10. **`runParallelTasks.ts`** — `withChildRouting` import (line 8) + call over
    `provider.getTaskHandoffContext(parent, spec.mode, true)` (≈43–49), and
    `ParallelTaskResult.routingTier` populated from `contexts[index]
    ?.omnirouteRouting?.tier`. §4.5 accurate.
11. **`taskBoard.ts`** — `routing?` row field (≈13), `routing: task
    .omnirouteRouting` (≈38), the `tier` const (≈104), the "Requested capability"
    card (≈137), the "Requested tier:" tooltip (≈188–189), and the
    `· T${row.routing.tier}` fragment (≈214) all present.
12. **`ChatView.tsx`/`ChatTextArea.tsx`** — `newTaskRoutingTier` state + reset
    effect (≈131–135), the `usesOmniRoute` memo with the second literal (≈138),
    `allowsHigherRoutingTiers` (≈143), the `newTask` postMessage `routingTier`
    (≈705) + dependency array entries (≈747–748), the `<ChatTextArea>` props
    including `currentTaskItem?.omnirouteRouting?.tier` and the `setOmniRouteTier`
    postMessage (≈1908–1914); in `ChatTextArea.tsx` the four `routingTier*` props
    + destructuring (≈49–52, 79–82), the `RoutingTierSelector` import (≈30), and
    the render block (≈1347–1355). All present exactly as §4.6 describes.
13. **`SettingsView.tsx`** — `sectionNames`/`SectionName` registry, the automatic
    i18n/search indexing loop (`settings:sections.${section}`), and the
    `targetSection` deep-link mechanism are present. Adding `"omniroute"` to
    `sectionNames` + a `sections[]` entry is correct and sufficient; no
    `WebviewMessage.tab` change is needed. §2.1 accurate.
14. **Provider schema & secret** — `openAiBaseUrl`, `openAiApiKey`,
    `openAiModelId` (`OPEN_AI_MODEL_ID_FIELD`) defined in `provider-settings/
    openai.ts`; `openAiApiKey` listed in `SECRET_STATE_KEYS` (`global-settings.ts`
    :318). New fields land in the right schema; the key is already
    SecretStorage-backed. Criterion (a) + (e).
15. **Catalog message plumbing** — `webviewMessageHandler.ts` handles
    `OpenAiModelsMessageType.requestOpenAiModels` via `getOpenAiModels(message
    .values.baseUrl, message.values.apiKey, …)` reading the unsaved-edit path
    (≈1503–1520), exactly the pattern §3 follows. (See Finding 1: the *fetch* is
    not reusable, only the pattern.)

OmniRoute (`~/sources/celesrenata/omniroute`):

16. **`serviceTierVariants.ts`** — `SERVICE_TIER_VARIANT_PATTERN =
    /__tier_(priority|flex)$/i`, `supportsVscodeServiceTierVariants()` gated on
    `CODEX_FAST_TIER_DEFAULT_SUPPORTED_MODELS`, and `resolveVscodeServiceTierRequest()`
    rewriting the body server-side. §2.2's "service-tier suffixes are Codex-only;
    reasoning-effort suffixes are the general axis" is correct. Criterion (d)
    parallel-replacement basis.
17. **`enrichModelForVscode`** (`vscode/[token]/models/route.ts:167`) — emits
    `url = ${tokenBaseUrl}/responses#models.ai.azure.com` or
    `${tokenBaseUrl}/chat/completions#models.ai.azure.com` (fragment **always**
    appended, lines 227–228); the route forwards `request` into
    `getUnifiedModelsResponse(request)` (line 333) and filters via
    `isUsableChatModel` (line 349). §1.2/§2.2/§3 accurate.
18. **`withPathTokenApiKey`** (`tokenizedRequest.ts:47`) — sets `x-api-key` and
    `authorization: Bearer <token>` **only when those headers are absent**;
    `warnTokenInUrlOnce` present (line 14). §1.2 accurate (header-carried key is
    honored, path token authorizes when headers absent).
19. **`prefix` propagation through the tokenized base** — the tokenized models
    route forwards `request` into `getUnifiedModelsResponse`, and `catalog.ts:335`
    reads `new URL(request.url).searchParams.get("prefix")` and honors `"alias"`.
    §3's end-to-end propagation claim is exactly correct at the cited line.
20. **Combos routes** — both `src/app/api/v1/vscode/[token]/combos/route.ts`
    (tokenized, used) and `src/app/api/v1/combos/route.ts` (top-level,
    not used) exist. §2.2/§5/§6 accurate.
21. **Admission knobs** — `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` and
    `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS` exist in `chatBodyAdmission.ts`; a code
    comment (≈832) confirms heavy-in-flight is unset by default. §5/§6's
    downgraded claim (no specific `=4`/`=30000`; setting a cap is a k8s-manifest
    ops task) is accurate.

### Criteria roll-up (per the task's specific checks)

- **(a) No hardcoded address + key in SecretStorage** — SATISFIED. Both
  production literals removed (§1.1, §4.1, §4.6); base URL derived from user
  input + key/`"public"` placeholder (§1.2); `openAiApiKey` reused, already in
  `SECRET_STATE_KEYS` (Verified #14). §8 adds a zero-occurrence grep acceptance
  test.
- **(b) All client-side tier math removed, every call site named** — SATISFIED.
  `taskRouting`/`userTaskRouting`/`modelTaskRouting`/`childTaskRouting`/
  `applyTaskRouting`/`withChildRouting` and the `X-OmniRoute-Tier` header named
  across §4.1–§4.7a; call sites in `omnirouteTier.ts`, `history.ts`,
  `providerHandoff.ts`, `Task.ts`, `ClineProvider.ts`, the three tools + shared
  `tools.ts` + native schemas + `routingTier.ts`, `runParallelTasks.ts`,
  `taskBoard.ts`, `webviewMessageHandler.ts`, `ChatView.tsx`, `ChatTextArea.tsx`,
  `RoutingTierSelector.tsx` (Verified #2–#12). §10 lists every file.
- **(c) All OmniRoute UI in ONE settings tab (live catalog + custom routes +
  connection check)** — SATISFIED. §2 places endpoint setup, connection check,
  live catalog, custom routes, and the reader/reasoner "Parallel worker defaults"
  pickers in one `OmniRouteSettings.tsx` section (Verified #13).
- **(d) Four named ambiguities resolved** — SATISFIED. Connection storage
  (§1.1, per-profile opt-in on the OpenAI profile); parallel `routing_tier`/
  `routing_reason` replacement (§5.2, `spec.route ?? roleDefault(spec.mode) ??
  parent.openAiModelId`); OmniRoute-side change needed (§6, none — Verified
  #16–#21); migration (§7, profile transform + history tolerate-and-ignore +
  `.strip()` transition).
- **(e) Persisted Setting Checklist for every new setting** — SATISFIED. §9
  walks the checklist for `openAiIsOmniRoute`, `openAiOmniRouteCustomRoutes`,
  `openAiOmniRouteReaderRouteId`, `openAiOmniRouteReasonerRouteId`, and the
  `openAiApiKey` reuse; Verified #14 confirms schema location + secret handling,
  and `getStateToPostToWebview` returns `apiConfiguration` as a whole object so
  new provider-profile fields ride along with no field-by-field projection.

## Unverified / Wrong Assumptions

- **None materially wrong.** Every source-level claim spot-checked against the
  menagerie workspace and the OmniRoute checkout matched (Verified #1–#21),
  including the specific cited line `catalog.ts:335` for `prefix` propagation and
  the always-appended `#models.ai.azure.com` fragment.
- **Imprecise (not wrong):** the §3 "reuse the existing model-fetch plumbing"
  phrasing (Finding 1 — the *pattern* is reused, the `getOpenAiModels` fetch is
  not) and the §3 "filters is done server-side" typo (Finding 2). Neither
  changes the design's correctness.
- **Deployment-dependent (correctly flagged out of scope):** the actual
  WireGuard route target / OmniRoute service address (§1.3) and any concrete
  `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` value (§5/§6) live in the k8s manifest at
  `ssh://celes@192.168.42.254:sources/kube/omniroute`, which was not inspected.
  The design does not depend on either, so this is not a finding.

---

## Verdict

HIGH: 0 · MEDIUM: 0 · NIT: 2 → **APPROVED**

The design is implementation-ready. Its core direction — OmniRoute as the single
owner of routing/tiering/placement, menagerie as a thin per-profile client, all
OmniRoute UI in one settings section, no hardcoded address, API key in
SecretStorage — is sound and thoroughly verified against both repositories. Every
file/line/symbol claim checked out, the four named ambiguities are resolved with
concrete mechanisms, and the two prior MEDIUM findings (tool-arg migration
mechanism and approval-summary output) are closed in the current text. The two
remaining items are NIT-level wording fixes in §3 that do not block coding.
