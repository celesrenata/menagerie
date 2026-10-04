# OmniRoute catalog yields combo ids so chat requests carry a full tier/role route

The OmniRoute chat endpoint rejects a bare role id (`code`) with "Unable to determine provider for model 'code'" because the slash in a `tier/role` combo id is the provider/combo selector; without it there is no provider to resolve. The root-cause investigation (`bare-code-request-path.md`) established that the request path (`OpenAiHandler`) is already clean — it transmits `openAiModelId` verbatim as the chat `model` field with no prefix strip — and that the bare id originates at catalog selection, because `fetchOmniRouteCatalog` fetched `/models?prefix=alias` (bare alias namespace) and the webview stored `entry.id` verbatim. This change (commit `0cd8ff818`, Option A) repoints the catalog fetch at `/combos`, whose entries carry the full `tier/role` id in their `name` field, and introduces a dedicated schema that maps `name → id`, so the id the webview stores and later sends is already a valid combo id. The handler and the webview selection code are left untouched by design.

Watch for: nothing blocking. The combos-array fallback precedence is sound but worth a sanity note (possible); the webview search over `entry.family` is now always a miss since combos never carry `family` (confirmed, cosmetic); custom-routes still require the user to type a valid combo id (confirmed, pre-existing and documented).

**Verdict**: APPROVED

## High-level view

The fix targets the id namespace at the source rather than patching the symptom downstream. Because the request path was already proven to pass `openAiModelId` through verbatim, the correct place to intervene is where the selectable id is produced. Switching the catalog fetch from `/models?prefix=alias` (bare aliases) to `/combos` (full `tier/role` ids) means `entry.id` is valid for chat the moment it is stored, with no new strip, guard, or synthesis anywhere on the path.

The new `omniRouteComboEntrySchema` is intentionally minimal: it reads only `name`, transforms it to `{ id: name, name }`, and strips every other combo field (strategy, models, capabilities). It reuses the existing tokenized base URL and Bearer-header pattern, so auth and address derivation are unchanged. Response extraction prefers `data`, falls back to `combos`, then a bare array, which tolerates minor shape variation from the server.

The webview needs no change: `OmniRouteSettings.tsx` already stores `entry.id` verbatim through `setApiConfigurationField`, which binds to the SettingsView `cachedState` (not live state), per the repo's Settings-View rule. With `entry.id` now a combo id, selection stores a valid chat model id. The custom-routes block is unaffected and continues to store a user-typed `modelId` verbatim.

Test coverage lands at the two layers that matter: a request-path regression in `openai.spec.ts` asserting `openAiModelId = "hybrid/code"` reaches `client.chat.completions.create` as `model: "hybrid/code"` on both streaming and non-streaming paths, and schema/fetch tests in `omniroute.spec.ts` covering the `name → id` mapping, the combos endpoint target, the array fallback, and the missing-URL error. The design doc is corrected to state that the `tier/` prefix is required by the chat endpoint and is not server-synthesized from a bare alias; only effort/service-tier suffix variants are stripped server-side.

Scope is clean: the handler got no new strip/guard, `cleanModelId` is untouched, `parallelWorkerRouting.ts` and reader-route logic are untouched, and there are no `.changeset` or CHANGELOG edits. The `ProviderSettingsManager.ts` / `src/package.json` / `plan.md` entries in the `git diff main` output belong to the prior commit `1ea74fefe`, not to this Option A fix.

<details>
<summary>Issues (3)</summary>

1. **Combos-array fallback precedence** — `response.data?.data ?? response.data?.combos ?? response.data` means a combos payload shaped as a bare top-level array `[...]` only reaches the `?? response.data` branch, which is correct, but a `{ data: null, combos: [...] }` shape would skip `data` and hit `combos` as intended. Precedence is sound; no action required beyond awareness (possible).
2. **Search over `entry.family` is a dead branch for combos** — combo entries only ever carry `id`/`name`, so the `entry.family?.toLowerCase()` arm of the catalog search filter in `OmniRouteSettings.tsx` can never match. Cosmetic only; the alias schema still populates `family` elsewhere, so leaving the shared filter as-is is reasonable (confirmed).
3. **Custom routes still require a valid combo id** — the custom-route block stores a user-typed `modelId` verbatim, so a user can still type a bare `code` and get the 400. This is pre-existing, documented behavior and out of scope for this fix (confirmed).

</details>

<details>
<summary>Details</summary>

### Fixing the id namespace at the catalog, not the request path

The investigation doc had already traced that no site between profile load and HTTP send strips a prefix — the prefix was simply never present, because `prefix=alias` returns bare roles and the webview stores them verbatim. Option A is the minimal fix consistent with that finding: change what the catalog publishes so the stored id is valid, and leave the proven-clean request path alone.

```
/combos → { data: [ { name: "hybrid/code", ... }, ... ] }
   └─ omniRouteComboEntrySchema: { id: name, name }   → entry.id = "hybrid/code"
        └─ OmniRouteSettings: setApiConfigurationField("openAiModelId", entry.id)   (→ cachedState)
             └─ Save → openAiModelId = "hybrid/code"
                  └─ OpenAiHandler: model: this.options.openAiModelId  → "hybrid/code"   (valid)
```

The alternative (Option B — prefix a chosen tier onto a bare alias at selection time) would have required a tier selector in the UI and client-side id synthesis, which the design explicitly wants to avoid. Fetching the combos the server already publishes keeps the client a pure pass-through.

### Combo schema and auth reuse

`omniRouteComboEntrySchema` parses only `{ name: string }` and transforms to `{ id: name, name }`, discarding strategy/models/capabilities, so a newer OmniRoute combo shape will not break parsing. The `.safeParse(...).filter(success).map(data)` pipeline drops malformed entries rather than failing the whole fetch, matching the existing alias-path behavior. The combos fetch reuses `omniRouteTokenizedBaseUrl` and the `Authorization: Bearer` header (sent only when a key exists), so it inherits the same auth and address derivation as the prior models fetch — no new hardcoded host, no new token handling.

### Request-path regression guards both streaming and non-streaming

The handler builds the request body with `model: modelId` where `modelId = this.options.openAiModelId ?? ""` on both the streaming (`openai.ts:159`) and non-streaming (`openai.ts:235`) branches. The two new tests in `openai.spec.ts` construct a handler with `openAiModelId: "hybrid/code"` and assert `mockCreate` was called with `model: "hybrid/code"` on each branch. `"hybrid/code"` contains none of the `deepseek-reasoner`/`o1`/`o3`/`o4` triggers, so it stays on the normal path the tests exercise.

These tests genuinely guard the behavior: a reintroduced `.split("/").pop()` on the request path would turn `hybrid/code` into `code` and fail both assertions. The verification doc records exactly this guard-proof (temporarily breaking the handler, confirming both tests fail, then reverting with no residual diff), which I accept as the recorded evidence rather than re-running.

### Design-doc correction is accurate

The §1.2 and §2.2 edits state that the `tier/` prefix is read by the chat endpoint as the provider/combo selector and is NOT synthesized from a bare alias, while the server-side suffix strip applies only to effort/service-tier VARIANTS layered on a valid combo base. This matches the live symptom, and the two sections are consistent with each other in flagging the earlier (wrong) assumption explicitly.

### Scope discipline

The handler received no new strip or guard; `cleanModelId` in `ProviderSettingsManager.ts` is unchanged by this commit (its edit is in the prior `1ea74fefe`); `parallelWorkerRouting.ts` and reader-route logic are untouched; there are no `.changeset` or CHANGELOG edits. The schema change avoids `as any` — the two `(result as Record<string, unknown>)` casts in the omniroute test are narrow and exist to assert that combo fields were stripped, which is a legitimate test-only use. No floating promises are introduced; the fetch is `await`ed throughout.

</details>

<details>
<summary>File map</summary>

Option A fix is isolated to commit `0cd8ff818`:

- `packages/types/src/providers/openai.ts` — adds `omniRouteComboEntrySchema` mapping a combo's `name` to a catalog entry `id`.
- `src/api/providers/omniroute.ts` — `fetchOmniRouteCatalog` now GETs `/combos` and parses with the combo schema; response extraction prefers `data`, then `combos`, then a bare array.
- `src/api/providers/__tests__/openai.spec.ts` — request-path regression (streaming + non-streaming) asserting the full combo id reaches the chat `model` field.
- `src/api/providers/__tests__/omniroute.spec.ts` — combo-schema mapping test and `fetchOmniRouteCatalog` tests (combos endpoint, combo ids, array fallback, missing-URL error).
- `docs/architecture/omniroute-integration-design.md` — §1.2 / §2.2 corrected: the `tier/` prefix is required and not server-synthesized; the catalog is populated from `/combos`.
- `.agents/tasks/omniroute-integration/combo-fix-verification.md` — recorded verification evidence.

Not part of this fix (prior commit `1ea74fefe`, present in `git diff main`): `src/core/config/ProviderSettingsManager.ts`, `src/core/config/__tests__/ProviderSettingsManager.spec.ts`, `src/package.json`, `.agents/tasks/omniroute-integration/plan.md`.

Full diff: `git show 0cd8ff818`.

</details>
