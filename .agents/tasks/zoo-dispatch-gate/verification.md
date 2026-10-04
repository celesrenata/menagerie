# Zoo Dispatch Gate — Verification Evidence

Branch: `feat/omniroute-tier-dropdown-feat005` (operated directly, no worktree, no branch switch).
Iteration: FIRST (no `fix-review.json` present at start).

## Root cause (restated)

`convertToolSchemaForOpenAI` in `src/api/providers/base-provider.ts` runs on all non-MCP tools
under OpenAI strict mode. It forced `result.required = allKeys` AND collapsed nullable unions
`["string","null"] -> "string"`. For `parallel_tasks` (per-task `todos`/`route` declared
`["string","null"]` and listed in `required`) and `new_task` (`todos` likewise), the wire schema
sent to the OmniRoute/GLM endpoint therefore declared those fields as REQUIRED, NON-NULL strings —
while the tool descriptions and `src/core/prompts/sections/rules.ts:170-173` instruct the model to
pass `todos:null` / `route:null`. The model could not form a schema-valid dispatch call and worked
inline, leaving the extra GPUs idle. The executor (`ParallelTasksTool.ts`,
`parallelTaskSpecSchema` with `.nullable().optional()`) already expects null/omitted.

## Fix (primary — findings §5 option 2, verified against OpenAI strict-mode rules)

OpenAI strict mode requires every property to appear in `required`; optionality is expressed by
making a property NULLABLE (a type union including `"null"`) while KEEPING it in `required`. A
"required but nullable" field is valid strict JSON schema. So the `required = allKeys` behavior is
correct and KEPT; the bug was the `"null"`-stripping transform.

File: `src/api/providers/base-provider.ts`, method `convertToolSchemaForOpenAI`.

Before (the bug, ~lines 90–94):

```ts
// Handle nullable types by removing null
if (prop && Array.isArray(prop.type) && prop.type.includes("null")) {
	const nonNullTypes = prop.type.filter((t: string) => t !== "null")
	prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
}
```

After (null-stripping removed; nullable unions preserved):

```ts
// Preserve author-declared nullable unions (["type", "null"]) as-is. Under OpenAI
// strict mode a field expresses optionality by being nullable while remaining in
// `required`, so we intentionally do NOT strip "null" here.
```

Everything else unchanged: `required = allKeys` still forced, `additionalProperties: false` still
set, recursion into nested objects and `array`→`object` items preserved. Non-nullable fields are
untouched (the strip branch was the only path that ever mutated nullable-union `type` arrays).
The doc comment was updated to describe the preserved-nullable behavior.

### Belt-and-suspenders (option 1) — no edit needed

`src/core/prompts/tools/native-tools/parallel_tasks.ts` already declares per-item `todos` and
`route` as `["string","null"]` and lists them in `required: ["name","mode","message","todos","route"]`.
`src/core/prompts/tools/native-tools/new_task.ts` already declares `todos` as `["string","null"]`
and lists it in `required: ["mode","message","todos"]`. Both already match the fixed converter, so
no schema edit was required.

### Fallback (option 3) — NOT used

Preserving nullable-under-strict is valid per OpenAI's rules, so disabling `strict` for the
dispatch tools was unnecessary and was not implemented.

## Regression tests

File: `src/api/providers/__tests__/base-provider.spec.ts`.

- Replaced `"should convert nullable types to non-nullable"` with
  `"should preserve nullable union types"` — asserts `["string","null"]` is preserved and the
  field remains in `required`.
- Added `"should preserve nullable per-item fields for a parallel_tasks-shaped schema"` — asserts
  per-item `todos`/`route` retain `"null"` in their type union, all five keys remain in `required`,
  and `additionalProperties:false` is set.
- Added `"should preserve the nullable todos field for a new_task-shaped schema"` — asserts `todos`
  retains the `"null"` member and stays in `required`.
- Added `"should leave non-nullable control tools unchanged except for strict normalization"` —
  a plain `{ path: { type: "string" } }` control still yields `required:["path"]`,
  `additionalProperties:false`, and unchanged `type:"string"` (no spurious mutation).

All use the existing public `testConvertToolSchemaForOpenAI` helper; no new `any` introduced.

## Verification results

(a) Typecheck — CLEAN:

```
pnpm --dir src exec tsc --noEmit -p .   # exit 0, no errors
```

(b) Vitest (base-provider suite, new + existing):

```
pnpm --dir src exec vitest run api/providers/__tests__/base-provider.spec.ts
# Test Files 1 passed (1) | Tests 18 passed (18) | exit 0
```

(c) ESLint prune-suppressions per edited file — both exit 0, counts did NOT increase:

```
pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 api/providers/base-provider.ts                       # exit 0
pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 api/providers/__tests__/base-provider.spec.ts        # exit 0
```

`@typescript-eslint/no-explicit-any` counts (src/eslint-suppressions.json), before == after:

- `api/providers/base-provider.ts`: 4 -> 4 (unchanged)
- `api/providers/__tests__/base-provider.spec.ts`: 4 -> 4 (unchanged)
  Note: `--prune-suppressions` reformatted `src/eslint-suppressions.json` (whitespace only,
  0 non-whitespace diff lines, no count changes); that whitespace-only churn was reverted to keep the
  diff clean and avoid broad unrelated changes per AGENTS.md.

(d) VSIX build (`pnpm vsix`) — DONE, NOT installed (user installs/tests):

```
Packaged: ../bin/zoo-code-3.84.4.vsix (1932 files, 33 MB)
```

VSIX path: `/Users/celes/sources/celesrenata/menagerie/bin/zoo-code-3.84.4.vsix`

## AGENTS.md gates

- No `.changeset` files created.
- No `CHANGELOG.md` / `src/CHANGELOG.md` edits.
- `src/core/task-persistence/taskLifecycle.ts` NOT touched — lifecycle model-check gate is N/A
  (fix confined to `base-provider.ts` and its test).
- Suppression counts did not increase.

## Commit

Commit: local only, not pushed; it is the current `HEAD` on branch
`feat/omniroute-tier-dropdown-feat005` (run `git -C <repo> rev-parse HEAD` to read the exact SHA —
the SHA is intentionally not pinned here because this file is part of the commit, so pinning it
would be stale after the final amend).
Message: `fix(openai-strict): preserve nullable unions so dispatch tools stay callable`.
Pre-commit hook (lint-staged prettier + turbo lint) ran and passed; no residual
changes to the two source files afterward.
