# Verification — OmniRoute System-Prompt Destruction Fix

Repo: `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo` (no worktree).
HEAD at start: `9ac4f2f84 fix(reasoning-effort): drop effort above ceiling for ollama-local qwen3.5/qwen3.8`.
Iteration: FIRST (no `review.json` present).

## What changed

### 1. `src/lib/memory/injection.ts`

- **`ChatMessage.content` type widened** (was line 24): from `string` to
  `string | Array<{ type: string; text?: string; [key: string]: unknown }>`, with a doc
  comment explaining the real OpenAI wire shape (Roo/Zoo sends the orchestrator system
  prompt as an array of content blocks). This forces callers to handle the array case
  instead of silently coercing to `"[object Object]"`.

- **New `toText()` helper**: mirrors `strictSystemHoist.ts`'s `toTextContent()`. Flattens an
  array of `{type:"text",text}` blocks to a newline-joined string; returns `""` for other
  shapes. Never uses bare `String()` (which regenerates `"[object Object]"`).

- **`injectSystemFirst()` merge made shape-aware** (the destruction site, formerly the single
  template-literal line). The `first.role === "system"` branch now:
    - string content → `` `${memoryText}\n${first.content}` `` (unchanged behavior).
    - array content → `[{ type: "text", text: memoryText }, ...first.content]` (prepend memory
      as a leading text block, preserving the original blocks — mirrors the already-correct
      `Array.isArray(request.system)` branch and `systemPrompt.ts`'s `prependToContent`).
    - any other shape → `` `${memoryText}\n${toText(first.content)}` `` (defensive, never
      `String()`).

    Function signature, strict-provider routing (`injection.ts` guard `supportsSystem &&
systemMessageMustBeFirst(provider)`), the Anthropic top-level `system` branches, and every
    other branch are unchanged. The FEAT-002 strict-provider set
    (`vllm`/`ollama-local`/`ollama`/`llama-cpp`/`llamacpp`) was NOT touched.

### 2. `src/lib/memory/__tests__/injection.test.ts`

- Added, inside the existing "self-hosted strict system-first providers (Failure C)" describe,
  a parametrized regression test over `["vllm","ollama-local","ollama","llama-cpp","llamacpp"]`
  that sends `messages[0].content` as an ARRAY of text blocks under a strict provider and
  asserts the merged result:
    - (a) still contains the original block text (`"You are Zoo, the orchestrator."` and
      `"start them together"`),
    - (b) contains the memory text as the leading block
      (`{ type: "text", text: "Memory context: ..." }`),
    - (c) contains NO `"[object Object]"` (checked both on the joined text and on
      `JSON.stringify(result.messages)`),
    - plus: content stays an array and no system message exists at index > 0.
- Updated the existing STRING-content strict test to narrow `content` to `string` before
  calling `.startsWith()` (required now that `content` is a `string | ContentBlock[]` union).
  Behavior/intent of that test is unchanged; it still asserts string merge order.

## Commands run and results

All run from the repo root `/Users/celes/sources/celesrenata/OmniRoute`.

1. **Memory injection vitest suite** (the suite that exercises this file; it uses `vitest`):

    ```
    npx vitest run src/lib/memory/__tests__/injection.test.ts --config vitest.config.ts
    ```

    Result: **PASS** — `Test Files 1 passed (1)`, `Tests 34 passed (34)` (29 pre-existing + 5
    new array-content cases). Re-run after the test-file type narrowing: still 34/34 pass.

2. **Core typecheck** (project script):

    ```
    npm run typecheck:core   # tsc -p tsconfig.typecheck-core.json
    ```

    Result: **PASS**, exit 0. (Note: this config uses an explicit `files` allow-list that does
    not include `injection.ts`, so it does not by itself exercise the change — see #3.)

3. **Targeted typecheck of the two edited files** under the project `tsconfig.json` options
   (via a temporary `tsconfig.verify-injection.json` extending `./tsconfig.json` with just
   these two files; removed afterward):

    ```
    npx tsc --pretty false -p tsconfig.verify-injection.json \
      | grep -E "memory/injection|memory/__tests__/injection"
    ```
    - Before the test narrowing fix: surfaced one REAL error —
      `injection.test.ts(237,36): Property 'startsWith' does not exist on type
'string | {...}[]'` (caused by the content widening). Fixed by narrowing to `string`.
    - After the fix: **no real errors** in either file.
    - The only remaining lines matching the filter are config-resolution noise from the narrow
      temp config (`Cannot find name 'process'` / `Cannot find namespace 'NodeJS'` on the
      UNCHANGED env-parsing lines 115/123/136, and a strict-null `Memory` literal mismatch on
      the unchanged test helper line 12). These are not produced by this change and do not
      appear under the project's normal build/test tooling.

4. **ESLint on both edited files**:

    ```
    npx eslint --no-cache src/lib/memory/injection.ts src/lib/memory/__tests__/injection.test.ts
    ```

    Result: **clean**, exit 0, zero warnings/errors.

5. **ESLint suppression counts** (`config/quality/eslint-suppressions.json`): no entry exists
   for `src/lib/memory/injection.ts` or its test, so no suppression count increased
   (AGENTS.md constraint satisfied).

## Not done (out of scope / environment)

- Full-project `tsc -p tsconfig.json` was attempted but the Next.js monorepo typecheck OOM/
  aborted locally; verification of the edited files was done with the targeted config in #3
  instead. `typecheck:core` (the session's standard core gate) passes.
- Live re-run against a real vllm/llama-cpp/ollama GLM backend (findings §"Verification once
  fixed") is a deploy-time check, not part of this local change.

## Commit

Committed locally on `feat/hybrid-reader-combo` (not pushed). See the step summary for the
commit hash.
