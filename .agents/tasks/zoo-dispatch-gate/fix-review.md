# Preserve nullable unions in OpenAI strict-mode tool-schema converter

The fix deletes the `"null"`-stripping branch in `convertToolSchemaForOpenAI` (`src/api/providers/base-provider.ts`) so that author-declared nullable unions like `["string","null"]` survive the strict-mode rewrite instead of collapsing to `"string"`. Everything else the converter does is kept: `required = allKeys`, `additionalProperties: false`, and recursion into nested objects and `array`→`object` items. This resolves the dispatch-gate root cause where `parallel_tasks`' per-task `todos`/`route` and `new_task`'s `todos` were sent to the OmniRoute/GLM endpoint as required non-null strings, contradicting the tool descriptions and system rules that instruct the model to pass `null` — leaving the model unable to form a schema-valid dispatch call. The function is shared across all non-MCP tools for all OpenAI-compatible providers, so the review centers on whether the change preserves strict validity for tools that have no nullable fields.

Watch for: nothing blocking. The converter still forces `required = allKeys` and `additionalProperties: false` for every object schema, so non-nullable control tools are unaffected (confirmed). One unrelated task-notes file (`.agents/tasks/omniroute-integration/plan.md`) is bundled in the same commit — not production code, non-blocking (confirmed).

**Verdict**: APPROVED

## High-level view

The change is a single-branch deletion matching the plan's PRIMARY option (findings §5 option 2): stop stripping `"null"`, keep forcing all keys required. The "required but nullable" shape it now produces is the OpenAI-sanctioned way to express optionality under strict mode, so dispatch tools become callable-as-described while remaining strict-valid.

The shared-function safety constraint holds. The deleted branch was the only code path that ever mutated a `type` array; it only fired when `prop.type` was an array containing `"null"`. Plain-string and other scalar-typed fields never entered that branch, so control tools emerge with `required=allKeys`, `additionalProperties:false`, and their original `type` untouched. The new control-tool test proves this directly.

The authored dispatch schemas already match the fixed converter, so no schema edit was needed (plan item 2, belt-and-suspenders). `parallel_tasks` declares per-item `todos`/`route` as `["string","null"]` inside `required: ["name","mode","message","todos","route"]`; `new_task` declares `todos` as `["string","null"]` inside `required: ["mode","message","todos"]`. Both read exactly as the plan asserts.

The regression tests cover the four required cases: the replaced nullable-preservation test, a `parallel_tasks`-shaped nested-array schema, a `new_task`-shaped schema, and a non-nullable control tool. They assert the specific behaviors (nullable union retained, field still in `required`, `additionalProperties:false`, no spurious scalar mutation) rather than just that the function runs.

The scope constraints are met: no tool group added to any mode, `taskLifecycle.ts` untouched, no `.changeset`/CHANGELOG edits, no suppression-count increase, no new `: any`.

<details>
<summary>Issues (1)</summary>

1. **Unrelated file bundled** — `.agents/tasks/omniroute-integration/plan.md` is modified in the same commit as the fix. Non-blocking (task notes, not production code); mention it so the author can split it out if desired.

</details>

<details>
<summary>Details</summary>

### The deleted branch was the sole nullable mutator

The removed code was:

```ts
if (prop && Array.isArray(prop.type) && prop.type.includes("null")) {
	const nonNullTypes = prop.type.filter((t: string) => t !== "null")
	prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
}
```

Its guard required `prop.type` to be an array containing `"null"`. A field typed `{ type: "string" }` has a string `type`, not an array, so it never matched. This is why control tools are provably unaffected: the only transform that touched a `type` value is gone, and the remaining transforms (`required = allKeys`, `additionalProperties: false`) are orthogonal to field type. The replacement is a comment plus the untouched recursion, so nested objects and array-of-object items are still walked. The doc comment was rewritten to describe the preserved-nullable behavior and explain why (required-but-nullable is valid strict schema). Confirmed by reading the full method.

### Regression tests prove the behavior, not just execution

The `parallel_tasks`-shaped test reaches into `result.properties.tasks.items` and asserts `item.properties.todos.type` and `item.properties.route.type` each equal `["string","null"]`, that `item.required` lists all five keys, and that `item.additionalProperties` is `false`. This exercises the array→object recursion path, which is the exact structure that previously collapsed. The `new_task`-shaped test asserts the top-level `todos` retains `["string","null"]` and stays in `required`. The control test (`{ path: { type: "string" } }`) asserts `type` stays `"string"`, `required` is `["path"]`, and `additionalProperties` is `false` — proving no regression for non-nullable tools, which is the shared-function safety requirement. The former `"should convert nullable types to non-nullable"` test was correctly replaced rather than left to contradict the new behavior; no other test in the suite referenced the old stripping (confirmed via grep). Confidence: confirmed — tests read from disk, assertions traced against the fixed converter logic.

### Fallback not taken, and correctly so

The plan's FALLBACK (disable strict for dispatch tools via the `isMcp ? strict:false` mechanism) was not implemented. Since required-but-nullable is valid OpenAI strict schema, the PRIMARY fix satisfies both the strict rules and the executor's `.nullable().optional()` Zod expectation, so the fallback was unnecessary. The one caveat the plan itself flags remains open: whether the live OmniRoute/GLM endpoint accepts nullable-union-in-required is an integration check outside this unit-test scope. That is a documented contingency, not a defect in this fix. Confidence: confirmed per plan/verification; the live-endpoint behavior is explicitly out of scope.

</details>

<details>
<summary>File map</summary>

- `src/api/providers/base-provider.ts` — removed the nullable-stripping branch in `convertToolSchemaForOpenAI`; updated the doc comment to describe preserved-nullable behavior. `required=allKeys`, `additionalProperties:false`, and recursion unchanged.
- `src/api/providers/__tests__/base-provider.spec.ts` — replaced the convert-to-non-nullable test with a preserve-nullable test; added `parallel_tasks`-shaped, `new_task`-shaped, and non-nullable control-tool regression tests.
- `.agents/tasks/zoo-dispatch-gate/{findings,fix-plan,verification}.md` — task notes (context, not reviewed code).
- `.agents/tasks/omniroute-integration/plan.md` — unrelated task-notes change bundled in the same commit (non-blocking).

Full diff: `git diff HEAD~1 -- src/api/providers/base-provider.ts src/api/providers/__tests__/base-provider.spec.ts`

</details>
