# Zoo Dispatch Gate — Fix Plan

Scoped, confirmed-root-cause bug fix. The read-only investigation (`.agents/tasks/zoo-dispatch-gate/findings.md`) already root-caused this with file:line citations. This plan pins the exact minimal fix shape. Do NOT re-investigate.

## Confirmed root cause (restated)

Zoo sends native tools to OpenAI-compatible providers (the user's OmniRoute: `apiProvider=openai`, `openAiIsOmniRoute=true`) under OpenAI **strict mode**. `convertToolsForOpenAI` (`src/api/providers/base-provider.ts:30`) sets `strict: true` for every non-MCP tool and calls `convertToolSchemaForOpenAI` (`base-provider.ts:66`), which:

1. forces `result.required = allKeys` recursively for every object schema (`base-provider.ts:~83`), and
2. **collapses nullable unions** `["string","null"] → "string"` (`base-provider.ts:~91-94`).

Applied to `parallel_tasks` (`src/core/prompts/tools/native-tools/parallel_tasks.ts`), whose per-task item declares `todos: ["string","null"]` and `route: ["string","null"]` with `required: ["name","mode","message","todos","route"]`, the **wire** schema sent to the model says `todos`/`route` are REQUIRED non-null strings — while the tool's own description AND the system rule (`src/core/prompts/sections/rules.ts:170-173`) instruct the model to pass `todos: null` / `route: null`. The model (GLM-5.3, mode `spec-orchestrator`, `experiments.parallelTasks=true` — all verified correct) therefore cannot form a schema-valid `parallel_tasks` (or `new_task`) call and works inline, so the 3 GPUs stay idle.

The executor side (`ParallelTasksTool.ts`, `parallelTaskSpecSchema` with `.nullable().optional()`) already EXPECTS null/omitted — the mismatch is purely the strict-mode wire rewrite vs the executor intent + model instructions. This is NOT a mode/tool-group problem; findings §2 disproves that. **Do NOT add a tool group to any mode.**

## Fix shape — verified against OpenAI strict-mode rules

Verified via OpenAI docs and community guidance ([kuni strict-mode notes](https://github.com/Alex2772/kuni/blob/master/docs/openai_strict_mode_json_schema.md), [OpenAI community: optional via union with null](https://community.openai.com/t/wrapper-for-structured-outputs-with-non-required-fields/913246)): OpenAI strict mode requires **all** properties to be listed in `required`, and the sanctioned way to express an _optional_ field is a **nullable union type** that includes `"null"` (e.g. `["string","null"]`) while STILL listing the field in `required`. A "required but nullable" field is valid strict JSON schema. Content was rephrased for compliance with licensing restrictions.

So the current code satisfies rule 1 (`required = allKeys`) but **violates** the optionality mechanism by STRIPPING `"null"` from nullable unions. That strip is the bug.

**PRIMARY fix (findings §5 option 2):** In `convertToolSchemaForOpenAI`, keep forcing `required = allKeys` (strict needs it) but **stop stripping `"null"` from author-declared nullable unions**. Preserve the `["string","null"]` type array as-is. This keeps strict validity (field is required _and_ nullable) while aligning the wire schema with the tool description + system rules.

**BELT-AND-SUSPENDERS (option 1):** The dispatch tools (`parallel_tasks.ts`, `new_task.ts`) already declare their nullable fields as `["string","null"]` AND list them in `required` — which, after the PRIMARY fix, is exactly the shape the converter now preserves. Confirm (no edit needed) that the authored schemas match the fixed converter's behavior. See verification item 4.

**FALLBACK (option 3, NOT the plan):** Only if the above cannot satisfy both OpenAI strict rules and the OmniRoute/GLM endpoint would we disable strict for the dispatch tools (reusing the `isMcp ? strict:false` mechanism at `base-provider.ts:~45`). The OpenAI rule confirmation above makes this unnecessary; it stays documented as the safe last resort and is NOT implemented unless integration testing proves the endpoint rejects nullable-union-in-required.

## Critical shared-function safety constraint

`convertToolSchemaForOpenAI` is SHARED across ALL non-MCP tools for ALL OpenAI-compatible providers. The fix must NOT break strict validation for other tools:

- Still force `required = allKeys` (unchanged).
- Still set `additionalProperties: false` (unchanged).
- Still recurse into nested objects and array-of-object items (unchanged).
- ONLY stop the `"null"`-stripping transform.

Non-nullable fields (plain `type: "string"`, etc.) are completely unaffected — the strip branch only ever touched array-typed `type` members that included `"null"`.

## AGENTS.md gates carried into this plan

- `taskLifecycle.ts` is NOT touched → the lifecycle model-check gate is **N/A** (confirmed: fix is confined to `base-provider.ts` and a test file).
- `src/eslint-suppressions.json` counts must NEVER increase. Pre-existing `@typescript-eslint/no-explicit-any` counts: `api/providers/base-provider.ts` = 4, `api/providers/__tests__/base-provider.spec.ts` = 4. The fix introduces NO new `any`; test uses the existing `any`-typed `testConvertToolSchemaForOpenAI(schema: any)` helper (counted already). After each edit, run the prune-suppressions check and confirm the count did not increase.
- No `.changeset` files. No `CHANGELOG.md` / `src/CHANGELOG.md` edits.

---

# Implementation Plan

- [ ]   1. Remove the nullable-union stripping in `convertToolSchemaForOpenAI` so author-declared nullable types are preserved.
       In `src/api/providers/base-provider.ts`, delete the block (currently ~lines 90-94) that filters `"null"` out of array `prop.type` and collapses it. Keep everything else: `required = allKeys`, `additionalProperties: false`, and the recursion into nested objects and `array`→`object` items. Update the function's doc comment: replace the bullet that says it converts nullable types to non-nullable with a note that nullable unions are preserved (required-but-nullable is valid OpenAI strict schema, which is how optionality is expressed). Do NOT introduce any `as any` or new casts.
       Files: `src/api/providers/base-provider.ts`
       Verify: `pnpm --dir src exec tsc --noEmit -p .` (or the repo's typecheck) reports no new errors for this file; proceed to item 3 for behavior tests.

- [ ]   2. Confirm (do NOT edit) that the dispatch tool schemas already match the fixed converter.
       Read `src/core/prompts/tools/native-tools/parallel_tasks.ts` (per-item `todos`/`route` are `["string","null"]` and listed in `required: ["name","mode","message","todos","route"]`) and `src/core/prompts/tools/native-tools/new_task.ts` (`todos` is `["string","null"]` and listed in `required: ["mode","message","todos"]`). Both are already correct for the fixed converter, so no schema edit is required. If — and only if — review finds an authored dispatch field that is nullable in intent but NOT yet a `["T","null"]` union, add `"null"` to its type union and keep it in `required` (belt-and-suspenders). Document in the PR that no change was needed if that is the case.
       Files: (read-only unless a mismatch is found) `src/core/prompts/tools/native-tools/parallel_tasks.ts`, `src/core/prompts/tools/native-tools/new_task.ts`
       Verify: visual confirmation that each nullable field appears both as a `["type","null"]` union and in that object's `required` array.

- [ ]   3. Update and extend the base-provider unit tests to assert the new behavior.
       In `src/api/providers/__tests__/base-provider.spec.ts`:
       (a) REPLACE the existing test `"should convert nullable types to non-nullable"` (currently asserts `result.properties.name.type` toBe `"string"`) with `"should preserve nullable union types"` asserting the type array `["string","null"]` is preserved AND the field is still in `required`.
       (b) ADD a regression test building a `parallel_tasks`-shaped schema (array of objects with `name`/`mode`/`message` plus `todos: ["string","null"]` and `route: ["string","null"]`, inner `required` listing all five): assert the converted inner item retains `"null"` in the `todos` and `route` `type` unions, retains all five keys in `required`, and has `additionalProperties: false`.
       (c) ADD a regression test for `new_task`-shaped schema (`mode`/`message` strings + `todos: ["string","null"]`): assert `todos` retains the `"null"` member and is in `required`.
       (d) ADD a control test: a non-nullable tool schema (e.g. `{ path: { type: "string" } }`) still yields `required: ["path"]`, `additionalProperties: false`, and `type: "string"` unchanged (no spurious mutation).
       Use the existing public `testConvertToolSchemaForOpenAI` helper (already `any`-typed, counted in suppressions) — do NOT add new `any`.
       Files: `src/api/providers/__tests__/base-provider.spec.ts`
       Verify: `pnpm --dir src exec vitest run api/providers/__tests__/base-provider.spec.ts` — all tests pass, including the four new/updated assertions.

- [ ]   4. Run the eslint prune-suppressions check on both edited files and confirm counts did not increase.
       Files: (no edit) `src/api/providers/base-provider.ts`, `src/api/providers/__tests__/base-provider.spec.ts`
       Verify: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 api/providers/base-provider.ts` and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 api/providers/__tests__/base-provider.spec.ts` — both exit clean; then confirm `src/eslint-suppressions.json` still shows `base-provider.ts` no-explicit-any count ≤ 4 and the spec count ≤ 4 (counts must not increase). If `--prune-suppressions` lowers a count because an old suppression became unnecessary, that is acceptable (decrease is fine).

- [ ]   5. Run the broader provider test suite to confirm no regression for other OpenAI-compatible tools.
       Files: none
       Verify: `pnpm --dir src exec vitest run api/providers/__tests__/base-provider.spec.ts` passes, and optionally `pnpm --dir src run test:api` passes with no new failures attributable to the converter change. Confirm non-nullable tools in existing tests (e.g. `read_file` with `path`) still get `required=[...]` and `additionalProperties:false`.

## Notes / assumptions

- The symptom (model never dispatches) is explained entirely by the schema contradiction; after item 1 the wire schema will say "`todos`/`route` are required but may be null", which matches both the tool description and the executor's `.nullable().optional()` Zod schema. No change to `rules.ts`, `ParallelTasksTool.ts`, modes, or profiles is needed or wanted.
- Final real-world confirmation (one orchestrator turn on OmniRoute/GLM-5.3 emitting a dispatched `parallel_tasks` call) is an integration/manual check outside this unit-test scope; if that live test shows the endpoint rejects nullable-union-in-required, escalate to FALLBACK option 3 (strict:false for `parallel_tasks`/`new_task` only, via the existing `isMcp`-style mechanism). This is a documented contingency, not part of the planned edits.
