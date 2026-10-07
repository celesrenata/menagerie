# Design Review — Parallel-Worker Input Bloat (Revision 3)

Reviewed document: `.agents/tasks/parallel-input-bloat/design.md` (Revision 3).
Repo root: `/Users/celes/sources/celesrenata/menagerie`.

This is a fresh, source-verified review. Every structural claim the design makes
about the codebase was checked against the actual files (not taken on the
design's word), and the brief's blocking conditions were each evaluated.

## Verdict

APPROVED. Zero HIGH and zero MEDIUM findings. The one NIT below does not block.

The design resolves all five findings from the prior
`design-review.json` (1 MEDIUM + 4 NITs), and each resolution was independently
re-verified against source. None of the brief's blocking conditions are tripped.

---

## Brief blocking-condition checks

1. **Unproven claim about the dominant bloat source** — NOT TRIPPED. §A cites
   file:line evidence identifying the dominant source as *un-excluded junk reads*
   (not parent-transcript inheritance), and the supporting claims verify:
   - `getTaskHandoffContext` returns `{ mode, apiConfigName, apiConfiguration }`
     only (ClineProvider.ts ~3601) — no transcript inheritance. VERIFIED.
   - `createParallelTaskRuntime` (ClineProvider.ts ~3552) seeds the child with
     `${spec.message}` + a fixed preamble, `startTask: false`. VERIFIED.
   - `ReadFileTool` gates reads only on `rooIgnoreController?.validateAccess`
     (new-format ReadFileTool.ts:219, legacy :764). VERIFIED.
   - `.rooignore` contains only `.env` (5 bytes). VERIFIED.
   - `DIRS_TO_IGNORE` (services/glob/constants.ts) governs `listFiles`, not the
     read tool. VERIFIED (contents match, including `bundle`/`deps`/`pkg`/`.git`).
   - `DEFAULT_LINE_LIMIT = 2000` (read_file.ts:6). VERIFIED.
   The design distinguishes evidence from the single live-observed read (treated
   as corroboration, not sole proof) and names the structural gap. This is
   file:line evidence, not a guess.

2. **Denylist excluding legitimate source** — NOT TRIPPED. The default denies
   only vendored/generated categories, with two match modes:
   - `vendoredDirs` (anywhere-segment) limited to unambiguous third-party/tool
     dirs: `node_modules`, `vendor`, `Pods`, `.pnpm-store`, `.stryker-tmp`,
     `__pycache__`.
   - `rootDirs` (first-segment only) `dist`, `out`, `out-*`, `build`, `coverage`
     — root-anchored so nested first-party `src/features/build/…`,
     `packages/pkg/…`, nested `deps/…` stay readable (FR-4, AC-4a).
   - `files`/`globs` cover lockfiles, minified bundles, scoped source maps, and
     vendored typings only.
   Bare `pkg`/`deps`/`bundle`, anywhere-segment `build`/`out`, broad `**/*.map`,
   and `.git` are explicitly excluded from the default. This stays within the
   brief's allowance (vendored/generated only). And it is OVERRIDABLE two ways:
   the user-adjustable `parallelReadDenylist` setting (clear/replace a category)
   and the Known_Target bypass. VERIFIED against `.gitignore` (lists dist, out,
   out-*, coverage/, .pnpm-store, .stryker-tmp/, bin/, node_modules,
   package-lock.json; does NOT list build — design now flags build as a
   conventional superset no-op, which is accurate).

3. **Per-worker scoping change starving a worker** — NOT TRIPPED. Workers already
   start from a fresh buffer (no transcript to trim). Lever 2 bounds only
   *cumulative read bytes* and, past the budget, tightens the *default* line limit
   while honoring explicit `limit`/`offset`/`lineRanges`; it never silently drops
   a requested range (FR-5, AC-9). First-party source stays fully readable (FR-4).
   The 600k-byte default engages well above a normal multi-file investigation.

4. **Contradiction with retrieval specs** — NOT TRIPPED. Checked against
   `semantic-first-retrieval/requirements.md`:
   - The design's Known_Target override matches the spec's Known_Target concept
     (user-named path, diagnostic `file:line` e.g. `src/core/task/Task.ts:918`,
     worker-held path — Req 3.2–3.4). VERIFIED, consistent.
   - The read-input budget complements, not pre-empts, `Retrieval_Output_Budget`
     (Req 6 bounds parent-surfaced chunks; the budget bounds worker reads).
   - A targeted `read_file` after semantic retrieval (Req 6.4) will not be blocked
     by the denylist, because the code index excludes vendored dirs
     (`scanner.ts` applies `isPathInIgnoredDirectory` + `.gitignore`), so findings
     never point at `node_modules`/`typescript/lib`. VERIFIED — no conflict.
   Lever 4 (gateway/EvidencePacket) is explicitly out of scope, aligned not
   implemented.

5. **Touching out-of-scope infra** — NOT TRIPPED. NFR-1 and the Files-to-modify
   section explicitly exclude `timeout-config.ts`, `routeCapacityMap.ts`/scheduler,
   the 64k reader cap, and `taskLifecycle.ts`. No listed edit touches them.

6. **Missing measurability** — NOT TRIPPED. FR-6/AC-10 require a per-worker log of
   bytes denied and cumulative bytes ingested, plus a unit assertion that the
   predicate denies a representative vendored path and allows a source path.

---

## Findings

1. **NIT — batched-read clamp replacement line cited as `:115`, actual is `:117`.**
   Where: §C clamp step 1 ("replacing `limit ?? defaultBatchLimit` at `:115`").
   The `effectiveLimit = limit ?? defaultBatchLimit` assignment is at
   `ReadFileTool.ts:117`; lines `:113-116` build `defaultBatchLimit` itself. The
   `:112-117` range the design also cites is correct, so this is a one-line
   drift in the inner citation, not a logic error — the clamp semantics
   (`min(defaultBatchLimit, 500)`, applied only when `limit` is undefined) are
   accurate and monotonic. Fix: change "at `:115`" to "at `:117`" (the
   `effectiveLimit` assignment). Does not affect correctness or the verdict.

---

## Verified Assumptions

- Worker does not inherit the parent transcript: `getTaskHandoffContext` →
  `{ mode, apiConfigName, apiConfiguration }` (ClineProvider.ts ~3601);
  `createParallelTaskRuntime` seeds child from `${spec.message}` + preamble,
  `startTask: false` (ClineProvider.ts ~3552). CONFIRMED.
- `runParallelTasks` calls `getTaskHandoffContext` inside `specs.map` (~:363) and
  `createParallelTaskRuntime` (~:470), and the dispatch map only resolves
  per-worker model/route id (no transcript assembly). CONFIRMED.
- `ReadFileTool` read gate is solely `rooIgnoreController?.validateAccess`
  (new-format :219, legacy :764). CONFIRMED.
- `.rooignore` = `.env` only. CONFIRMED (file content `.env`).
- `DIRS_TO_IGNORE` includes `node_modules, __pycache__, env, venv,
  target/dependency, build/dependencies, dist, out, bundle, vendor, tmp, temp,
  deps, pkg, Pods, .git, .*` and feeds `listFiles`, not the read tool. CONFIRMED
  — this is why `bundle`/`deps`/`pkg` must be excluded from the read denylist.
- `DEFAULT_LINE_LIMIT = 2000`, `DEFAULT_BATCH_LINE_BUDGET = 2400`
  (prompts/tools/native-tools/read_file.ts). CONFIRMED.
- Batched default `defaultBatchLimit = min(DEFAULT_LINE_LIMIT,
  floor(DEFAULT_BATCH_LINE_BUDGET / uniquePaths.length))`, `effectiveLimit =
  limit ?? defaultBatchLimit` (ReadFileTool.ts:113-117). CONFIRMED.
- Slice-mode limit `entry.limit ?? DEFAULT_LINE_LIMIT` (ReadFileTool.ts:378);
  indentation governing limit at :350; display-only `effectiveLimit` at :359.
  CONFIRMED (prior-review correction `:361`→`:359` is right).
- `ParallelTaskSpec` fields are `name, mode, message, todos, route, reasoning,
  verification, capabilities`; `capabilities.scopeHints` is
  `z.record(z.string(), z.array(z.string()))`; no structured file-scope field
  (ParallelTasksTool.ts). CONFIRMED — Known_Target seed from `spec.message` only
  is correct.
- `ParallelTaskReader`: `MAX_READER_DOCUMENT_BYTES = 48*1024`,
  `MAX_READER_EXCERPT_CHARS = 10_000`, `SHARED_DOCUMENT` regex restricted to
  `(docs|specs|contracts)/…` md/mdx/txt/json/yaml/yml; `addSharedDocumentReader`
  iterates `referencedDocuments(spec.message)` then `fs.realpath` candidates —
  routing each candidate through `isDeniedRead` before stat is feasible.
  CONFIRMED.
- `parallelCapacityMap: parallelCapacityMapSchema.optional()` at
  global-settings.ts:216; `GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof()
  .options` at :389 (derived); `parallelCapacityMap` key in
  vscode-extension-host.ts:341. CONFIRMED — the persisted-setting precedent and
  derivation claims hold.
- `.gitignore` lists dist, out, out-*, coverage/, .pnpm-store, .stryker-tmp/,
  bin/, node_modules, package-lock.json; does NOT list `build`. CONFIRMED —
  design's revised "superset / harmless no-op" justification for `build` is
  accurate.
- Code index scanner excludes vendored dirs via `isPathInIgnoredDirectory` +
  `.gitignore` (scanner.ts), so semantic findings cannot point at vendored paths.
  CONFIRMED — no denylist-vs-retrieval conflict on targeted reads.
- Retrieval spec Known_Target (Req 3.2–3.4) and Retrieval_Output_Budget (Req 6)
  match the design's framing. CONFIRMED — complementary, not contradictory.

## Unverified / Wrong Assumptions

- None material. The only inaccuracy is the NIT above (inner batched-clamp
  citation `:115` vs actual `:117`); the surrounding `:112-117` range and the
  clamp logic are correct.
- The design's "~4 chars/token" sizing and the 600k-byte budget calibration are
  explicitly labeled heuristic, with FR-6 runtime measurement as the authoritative
  check. Not a verifiable code claim; acceptable as stated.
- The single live-observed OmniRoute compression figure (356335 → 242913 tokens)
  and the `web/node_modules/@types/react/index.d.ts` observed read are runtime
  observations not re-derivable from source; the design correctly treats them as
  corroboration layered on top of the structural file:line evidence, not as the
  sole proof, so this does not weaken the dominant-source claim.
