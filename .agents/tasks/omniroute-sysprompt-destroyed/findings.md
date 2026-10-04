# OmniRoute System-Prompt Destruction — Root Cause Findings

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo`
Scope: READ-ONLY investigation. Nothing was modified.

---

## Summary answer (the one line)

The destruction site is **`src/lib/memory/injection.ts:186`**, inside `injectSystemFirst()`:

```ts
const merged: ChatMessage = { ...first, content: `${memoryText}\n${first.content}` }
```

`first.content` is the Zoo orchestrator's 54 354-char system prompt. The `ChatMessage.content` field is **declared `string`** (`injection.ts:24`), but the real wire shape sent by the Roo/Zoo (OpenAI-format) client is an **array of content blocks** (`[{ type: "text", text: "You are Zoo..." }, ...]`). JavaScript template-literal interpolation of that array calls `String(array)`, which yields the literal **`[object Object]`** — so the merged system content becomes `"Memory context: <~238 chars>\n[object Object]"` ≈ **254 chars**, and the entire 54 354-char orchestrator prompt (identity + the `parallel_tasks` "start them together" dispatch rule) is **discarded**.

This is the exact 254-char / `[object Object]` / "dispatch rule absent" signature in the live `providerRequest.body`. It is the single corruption point on the GLM path; no other transform in the forwarding pipeline touches `messages[0]` system content for this provider.

**FEAT-002 (commit `db3586f9e`, "route self-hosted strict Qwen/GLM providers through system-first memory injection") introduced/exposed the bug.** It added `vllm`, `ollama-local`, `ollama`, `llama-cpp`, `llamacpp` to `BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST`, which is precisely what routes these GLM backends into `injectSystemFirst()` (line 186) instead of the previous cache-safe mid-array splice (which never touched `messages[0].content`).

---

## The transform chain, in order (file:line)

The forwarding path for a GLM/vLLM/llama.cpp/ollama request (OpenAI source format → OpenAI target format) runs through `handleChatCoreInner()` in `open-sse/handlers/chatCore.ts`. Transforms that touch `messages`/system content, in execution order:

1. **`open-sse/handlers/chatCore.ts:651`** — `injectCustomSystemPrompt(body, _s.customSystemPrompt)`.
   Gated on `customSystemPromptEnabled === true`. **Correctly handles array content** (`Array.isArray(msg.content)` branch in `systemPrompt.ts`). Not the culprit; off unless configured.

2. **`open-sse/handlers/chatCore.ts:1362`** — `sanitizeChatRequestBody(body, sourceFormat, targetFormat)` (`chatCore/sanitization.ts`).
   Token-field normalization, empty-`name` stripping, tool filtering. **Does not read or rewrite system-message content.** Not the culprit.

3. **`open-sse/handlers/chatCore.ts:1370`** — `injectMemoryAndSkills({...})` (`chatCore/memorySkillsInjection.ts`).
   Resolves memory owner, retrieves memories, then calls `injectMemory(body, memories, provider, { cacheSafe })` at `memorySkillsInjection.ts:165`.
   → `injectMemory()` sees `supportsSystem === true` and `systemMessageMustBeFirst(provider) === true` for these providers (guard at `injection.ts:288`), so it takes the strict branch at **`injection.ts:289`**: `return injectSystemFirst(request, messages, memoryText, memories.length);`
   → **`injectSystemFirst()` `injection.ts:185-187`** — `messages[0].role === "system"` is true, so it runs the merge at **line 186 → DESTRUCTION**. (It never looks at `cacheSafe`; the strict path is unconditional.)

4. **`open-sse/handlers/chatCore.ts:1399` / `:2152` / `:2222`** — `adaptBodyForCompression()` + `compressContext()`.
   Runs _after_ memory injection. By this point `messages[0].content` is already the corrupted 254-char string, so compression only operates on the already-destroyed value. Not the origin of the destruction. (This is the source of the earlier "Prompt compressed (stacked)" log lines, which were a red herring.)

5. **`open-sse/handlers/chatCore.ts:2308`** — `applyProviderSystemTransforms(provider, body)` (`systemTransforms.ts`).
   **No-op for GLM/vLLM/ollama/llama-cpp** — the per-provider transform registry only has enabled pipelines for `claude` and `anthropic-compatible-cc-*` (`DEFAULT_SYSTEM_TRANSFORMS_CONFIG`, `systemTransforms.ts`). Returns the body unchanged. Not the culprit.

6. **`open-sse/handlers/chatCore.ts:2639`** — `translateRequest(...)` (`open-sse/translator/index.ts`).
   For OpenAI→OpenAI this is a near-passthrough. It calls `hoistLeadingSystemMessage()` (`translator/index.ts:460` and `:875`, from `translator/helpers/strictSystemHoist.ts:44`).

7. **`open-sse/translator/helpers/strictSystemHoist.ts:44` `hoistLeadingSystemMessage()`** — hoists `system` messages at index > 0 onto index 0 **only when there ARE offending index>0 system messages**. After step 3 the sole system message is already at index 0, so `offendingIndices` is empty and the function returns the array unchanged (`strictSystemHoist.ts:60`). **Not the destruction site**, though its own `toTextContent()` helper (`strictSystemHoist.ts:5-19`) is the correct pattern that `injectSystemFirst` lacks (see fix).

8. **`open-sse/handlers/chatCore.ts:3131`** — `prepareUpstreamBody({...})` (`chatCore/upstreamBody.ts`).
   `normalizeAttemptBody` → thinking/reasoning normalization, `sanitizeRequestForResolvedTarget`, tool truncation, prompt-cache key. **None read or rewrite `messages[0].content` text.** Not the culprit.

9. **`open-sse/handlers/chatCore.ts:3156`** — `injectSystemPromptPostTranslation(bodyToSend, { targetFormat })`.
   Global prefix/suffix injection; **array-content-safe** and gated on `cfg.enabled`. Not the culprit.

The claude-system-role lifters (`extractSystemRoleMessages`, `hoistLeadingTextSystemMessages`, `relocateDirectiveOnlyMessages`) are called only at `chatCore.ts:2468/2506/2515/2516`, **inside the Claude-target branch** — they do not run on the GLM (OpenAI-target) path.

**Conclusion:** on the GLM path, exactly one transform rewrites `messages[0]` system content: `injectSystemFirst()` at `injection.ts:186`. It is therefore the sole destruction site.

---

## Q1 — every transform between receipt and send

Answered in the ordered chain above. The system message at `messages[0]` is only ever _read-and-rewritten_ once on this path: at `src/lib/memory/injection.ts:186`.

## Q2 — which transform drops the 54K content

`injectSystemFirst()` at **`src/lib/memory/injection.ts:185-187`**. It takes the "merge into existing index-0 system message" branch (`first.role === "system"` is true, so it never falls to the else-branch), and the merge expression `` `${memoryText}\n${first.content}` `` coerces the **array-valued** `first.content` to the string `"[object Object]"`, discarding the original prompt. The result is a single system message of ~254 chars = memory text + `\n` + `[object Object]`. Same 22 messages, same 12 tools, because the merge replaces `messages[0]` in place and leaves everything else untouched.

## Q3 — strictSystemHoist × injectSystemFirst interaction, and the `[object Object]`

There is **no harmful double-handling** between the two for this case:

- `injectSystemFirst` runs first (memory stage, `chatCore.ts:1370`) and leaves the (now corrupted) system message at index 0.
- `hoistLeadingSystemMessage` runs later (translation, `translator/index.ts:460`) and is a **no-op** because there are no index>0 system messages to hoist.

The `[object Object]` is **not** produced by `strictSystemHoist` — its `toTextContent()` (`strictSystemHoist.ts:5-19`) correctly flattens an array of text blocks and would NOT emit `[object Object]`. The `[object Object]` is produced by the **template-literal stringification of the array** at `injection.ts:186`. That line is both the "drop the 54K" site and the "produce `[object Object]`" site — they are the same bug: a non-string (content-block array) is string-concatenated without flattening.

Root type cause: `ChatMessage.content` is typed `string` (`injection.ts:24`), so the author wrote string-only concatenation; the OpenAI wire shape (array content blocks) violates that assumption at runtime. Note the sibling code in the same repo (`systemPrompt.ts` `prependToContent`/`appendToContent`/`injectCustomSystemPrompt`, and `strictSystemHoist.ts` `toTextContent`) all branch on `Array.isArray(content)` — `injectSystemFirst` is the one place that does not.

## Q4 — is it provider-gated / memory-gated? (did FEAT-002 cause it?)

**Yes to both gates, and yes FEAT-002 caused it.**

- Provider gate: the destructive branch is reached only when `systemMessageMustBeFirst(provider) === true` (`injection.ts:303`). That set is `BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST` (`injection.ts:92-101`). Commit **`db3586f9e`** (FEAT-002, "route self-hosted strict Qwen/GLM providers through system-first memory injection", 2026-10-01) **added `vllm`, `ollama-local`, `ollama`, `llama-cpp`, `llamacpp`** to that set. Before this commit those providers were **not** strict, so `injectMemory` took the `placeMessage()` cache-safe splice (`injection.ts:356`), which inserts a NEW memory message and **never touches `messages[0].content`** → the 54K prompt survived. After this commit, the same request routes to `injectSystemFirst` line 186 → destruction. A provider NOT in the strict set (and not Claude-family / not Anthropic top-level `system`) still preserves the full prompt today.
- Memory gate: the branch only runs when `injectMemory` actually has memories (`injection.ts:271` returns early on no memories) and memory is enabled with `maxTokens > 0` (`memorySkillsInjection.ts:91`). Settings show `memoryEnabled=true`, `memoryMaxTokens=2000`, and memories matched — consistent with the ~238-char memory payload observed. **With memory disabled, `injectSystemFirst` is never called and the full 54K prompt is preserved.**

So FEAT-002's strict-set expansion is the trigger; it exposed a latent array-content bug in `injectSystemFirst` that the previously-strict members (`xiaomi-mimo`, `mimo`, `tokenrouter`) had apparently never hit with array-shaped system content.

## Q5 — the minimal fix (exact file:line)

Change **`src/lib/memory/injection.ts:186`** so the merge preserves the original system content whatever its shape (string OR content-block array), instead of blindly stringifying it.

Minimal, behavior-preserving fix — flatten/merge based on the runtime shape of `first.content`:

- If `first.content` is a **string** (current assumption): keep `` `${memoryText}\n${first.content}` `` (unchanged).
- If `first.content` is an **array** of content blocks: prepend the memory as a text block, e.g. `content: [{ type: "text", text: memoryText }, ...first.content]`. This mirrors the already-correct array handling in `injection.ts:196-198` (the `Array.isArray(request.system)` branch) and in `systemPrompt.ts`'s `prependToContent`.
- Defensive: for any other non-string value, coerce via a `toText()` helper equivalent to `strictSystemHoist.ts`'s `toTextContent()` rather than `String()`, so a stray object can never regenerate `[object Object]`.

Concretely, replace the single line at `injection.ts:186` inside the `if (first && first.role === "system")` block (lines 185-187) with a shape-aware merge. The function signature, the strict-provider routing, and every other branch stay exactly as they are. Also consider widening `ChatMessage.content` (`injection.ts:24`) from `string` to `string | Array<{ type: string; text?: string; [k: string]: unknown }>` so the type reflects the real wire shape and the compiler forces the array branch — otherwise the same class of bug can recur in any future `${...content}` concatenation.

A focused regression test belongs in `src/lib/memory/__tests__/injection.test.ts` (which today only exercises **string** `content` — e.g. lines 102, 195, 224, 256): add a case where `messages[0].content` is an array of text blocks under a strict provider (`vllm`/`llama-cpp`/`ollama`) and assert the merged result still contains the original block text and NO `[object Object]`.

---

## Conclusions & recommendations

1. **Root cause:** `src/lib/memory/injection.ts:186` destroys array-shaped system content via template-literal coercion to `[object Object]`. This is the real root of the "GLM never dispatches / 3 GPUs idle" saga — the orchestrator identity and the `parallel_tasks` dispatch rule literally never reach GLM, so GLM has only a 254-char memory stub + 12 tools and just reads files.
2. **Trigger:** FEAT-002 (`db3586f9e`) added the self-hosted GLM/Qwen providers to the strict set, routing them into the untested array-content path of `injectSystemFirst`. Every downstream fix (ds4 multi-tool-call PR, tool schema, mode roleDefinition, reader tiers) was downstream of this and could not work while the prompt was being erased.
3. **Fix:** make the `injectSystemFirst` merge at `injection.ts:185-187` shape-aware (string → concat; array → prepend text block; other → safe `toText`). Widen `ChatMessage.content` to reflect the array wire shape. Add an array-content regression test for a strict provider.
4. **Verification once fixed (not done here — read-only):** re-run the same Zoo orchestrator request against a `vllm`/`llama-cpp`/`ollama` GLM connection with memory enabled and diff the new call_log's `pipeline.providerRequest.body.messages[0].content` — it must contain the full `You are Zoo...` prompt and the `start them together` dispatch rule, with no `[object Object]`. The package's unit tests under `src/lib/memory/__tests__/injection.test.ts` should be extended and run from the package directory.

### Key citations

- `src/lib/memory/injection.ts:24` — `ChatMessage.content: string` (the mistaken type assumption)
- `src/lib/memory/injection.ts:92-101` — `BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST` (strict set, incl. the FEAT-002 additions)
- `src/lib/memory/injection.ts:185-187` — **destruction site** (`injectSystemFirst` merge branch, line 186)
- `src/lib/memory/injection.ts:288-289` — strict-provider routing into `injectSystemFirst`
- `src/lib/memory/injection.ts:196-198` — the correct array-handling pattern to mirror
- `open-sse/handlers/chatCore.ts:1370` — `injectMemoryAndSkills` call (memory stage)
- `open-sse/handlers/chatCore/memorySkillsInjection.ts:165` — `injectMemory` invocation
- `open-sse/translator/helpers/strictSystemHoist.ts:5-19,44-62` — hoist (no-op here; correct `toTextContent` reference)
- Commit `db3586f9e` — FEAT-002 strict-set expansion that triggered the bug
