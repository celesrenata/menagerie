# Parallel-Worker Input Bloat — Requirements & Technical Design

Status: Design — Revision 3 (addresses the latest `design-review.json`, verdict
CHANGES_REQUESTED: 1 MEDIUM + 4 NITs). Responses to each finding are recorded at
the end of this document under "Review Responses (Revision 3)". The prior
"Review Responses (Revision 2)" section is retained below it for history.

Repo root: `/Users/celes/sources/celesrenata/menagerie`.

Prior investigation consumed as input: `.agents/tasks/parallel-execution-bottlenecks/findings.md` (Q5 — input bloat).

---

## Summary

Parallel worker prompts balloon toward ~356k tokens and become the amplifier
behind queue pressure and slow serialized generation (one observed OmniRoute
compression: 356335 → 242913 tokens). This design confirms the dominant source
with code evidence, then specifies a bounded, measurable fix.

Confirmed dominant source (see §A): **un-excluded junk reads accumulating in a
worker's tool-result history**, NOT parent-transcript inheritance. A worker is
created with a fresh message buffer seeded only by `spec.message` plus a fixed
instruction preamble — it does NOT inherit the parent's accumulated conversation
(`ClineProvider.getTaskHandoffContext` carries only
`{ mode, apiConfigName, apiConfiguration }`;
`createParallelTaskRuntime` seeds the child with `spec.message`, not the parent
transcript). The bloat therefore grows *inside* the worker loop from (1)
`read_file` tool results — each capped at 2000 lines but with **no vendored/
generated-path exclusion** on the read path — and (2) per-turn environment
details. The decisive gap: `read_file` gates only on `RooIgnoreController.
validateAccess`, and this workspace's `.rooignore` contains only `.env`, so
reading `node_modules/@types/react/index.d.ts` or `typescript/lib/lib.dom.d.ts`
is allowed and returns up to 2000 lines of vendored typings per call. The
`DIRS_TO_IGNORE` denylist that excludes `node_modules`/`dist` applies to
`listFiles` (environment-detail *path listing*) only — it never touches the read
tool.

Primary lever: **Lever 1 — read-scope junk exclusion**, enforced in one shared,
overridable predicate consumed by both the file-read path and the reader-swarm
document pick. Secondary lever: **Lever 2 — a per-worker read-input budget** that
caps cumulative bytes a single worker ingests from vendored/large reads and nudges
toward targeted reads, reconciled with `runParallelTasks` child-context assembly
and with auto-condense so the two do not fight. Lever 3 (map-reduce) is deferred
with rationale. Lever 4 (retrieval/EvidencePacket wiring) is explicitly out of
scope to implement, and this design is shaped to not conflict with it.

---

## Functional Requirements

- **FR-1 (junk exclusion on the read path).** The file-read tool
  (`ReadFileTool`) SHALL deny reads of vendored/generated content by default. The
  default denylist uses two match modes so it never denies first-party source:
  - *Vendored roots matched anywhere in the path* (unambiguously third-party or
    tool-generated, never a first-party source root): `node_modules`, `vendor`,
    `Pods`, `.pnpm-store`, `.stryker-tmp`, `__pycache__`, and the two-segment
    build-dependency paths `target/dependency`, `build/dependencies`.
  - *Build-output roots matched only at the workspace root* (first path segment):
    `dist`, `out`, `out-*`, `build`, `coverage`. Root-anchored matching is
    required because `build`/`out` and even `dist` legitimately appear as nested
    first-party directory names (e.g. `src/features/build/pipeline.ts`); only the
    repo-root instances are build outputs. These are conventional root-anchored
    build-output directory names — a superset of this repo's `.gitignore` outputs
    (`.gitignore` lists `dist`, `out`, `out-*`, `coverage/`, `.pnpm-store`,
    `.stryker-tmp/`, and `bin/` as root-level outputs; it does NOT list `build`,
    which is retained here only as a conventional build-output name and is a
    harmless no-op in this repo because no root `build/` exists).
  - *File/glob rules:* lockfiles (`package-lock.json`, `pnpm-lock.yaml`,
    `yarn.lock`), minified bundles (`**/*.min.js`, `**/*.min.css`), generated
    source maps scoped to code extensions (`**/*.js.map`, `**/*.css.map`), and
    vendored TypeScript typings under `**/node_modules/@types/**` and
    `**/typescript/lib/*.d.ts`.
  The default SHALL NOT include bare `pkg`, `deps`, `bundle`, nor an
  anywhere-segment `build`/`out`, because `pkg/` and `deps/` are first-party
  source roots in Go and other ecosystems and `build`/`out` recur as nested
  first-party directories. The default SHALL NOT include a broad `**/*.map`
  (which would match first-party `.map` data/fixture files) nor `.git` (not an
  established reachable `read_file` target under `task.cwd`).
- **FR-2 (shared enforcement).** The same denylist predicate SHALL govern both
  the worker read path (`ReadFileTool`) and the reader-swarm document pick
  (`ParallelTaskReader.addSharedDocumentReader`), so a single source of truth
  covers both ingestion routes.
- **FR-3 (override).** A user who genuinely needs a denied path SHALL be able to
  read it. Overrides: (a) an explicit `.rooignore`-style allow is unnecessary
  because denial is advisory-with-escape — the user adjustable
  `parallelReadDenylist` map lets a workspace clear/replace categories; and (b)
  the denylist is bypassed when the exact path is explicitly named in the task
  text (a Known_Target), so legitimate intentional reads of a `.d.ts` succeed.
  Mastermind-assigned file scope is carried in the prose `spec.message` (there
  is no structured file-scope field on `ParallelTaskSpec` — see §B), so the same
  message-grammar extraction covers it.
- **FR-4 (no legitimate-source regression).** First-party source under the
  worktree (e.g. `src/**`, `webview-ui/src/**`, `packages/**`, `docs/**`,
  `.kiro/**`) SHALL remain readable; the denylist SHALL match only vendored/
  generated categories, never a blanket extension or directory that also holds
  first-party code.
- **FR-5 (per-worker read-input budget — Lever 2).** A parallel worker SHALL
  track cumulative bytes returned by its `read_file` results and, once a bounded
  threshold is exceeded, SHALL (a) emit a one-line budget notice steering the
  model toward targeted/offset reads and semantic retrieval, and (b) tighten the
  effective default per-read line limit for subsequent reads in that worker. The
  budget SHALL NOT silently drop content a worker explicitly requested.
- **FR-6 (measurability).** The system SHALL log, per worker, a before/after read
  input figure (bytes denied by the denylist and cumulative bytes ingested) so
  the reduction is observable, and the test suite SHALL assert the denylist
  denies a representative vendored path and allows a representative source path.

## Non-Functional Requirements

- **NFR-1 (no interference with shipped infra).** This design SHALL NOT modify
  `src/api/providers/utils/timeout-config.ts`, `src/core/task/routeCapacityMap.ts`
  / the scheduler, the 64k reader result cap, or the task-lifecycle reducers.
- **NFR-2 (no double-trim with auto-condense).** The read-input budget SHALL act
  *before* content enters history (deny/limit at read time), so it reduces what
  auto-condense ever sees rather than competing with it after the fact.
- **NFR-3 (deterministic + unit-testable).** The denylist predicate SHALL be a
  pure function of `(relPath, denylistConfig, knownTarget?)` with no I/O, so it
  is unit-testable at the lowest layer.
- **NFR-4 (reader isolation preserved).** Changes SHALL preserve reader-swarm
  bounds (48 KiB document cap, 10k-char excerpt) and the reader lane routing.

## Acceptance Criteria

1. Given a worker reads `node_modules/@types/react/index.d.ts` with no explicit
   user/scope naming of that path, the read is denied with a one-line notice
   naming the matched category, and no file content enters the tool result.
2. Given a worker reads `typescript/lib/lib.dom.d.ts` (vendored typings) under
   the same conditions, the read is denied.
3. Given a worker reads `package-lock.json` / `pnpm-lock.yaml` / a `*.min.js`
   bundle, each is denied.
4. Given a worker reads `src/core/task/Task.ts` (first-party source), the read is
   allowed and returns content exactly as today.
4a. Given a worker reads first-party paths whose segments collide with denylist
   names but are NOT vendored — `packages/pkg/index.ts`, `src/features/build/
   pipeline.ts`, a nested `deps/foo.ts`, and a first-party `fixtures/sample.map`
   — each read is ALLOWED by default (proves `pkg`/`deps`/nested-`build`/`out`
   and broad `*.map` are not denied; review HIGH 1, MEDIUM 5).
5. Given the exact path `node_modules/@types/react/index.d.ts` appears in the
   worker's task text (`spec.message`) — bare, quoted, or as
   `…index.d.ts:918` — the read is allowed (Known_Target override). This covers
   both a user-named path and a mastermind-assigned scope, because mastermind
   scope is written into `spec.message` prose (no structured scope field exists;
   §B). `extractKnownTargetPaths(spec.message)` extracts the `.d.ts` path and
   strips any `:line` suffix.
6. Given a `parallelReadDenylist` map that clears the `typings` category, reading
   a vendored `.d.ts` is allowed; given the default (unset) map, it is denied —
   and the unset case is a byte-for-byte no-op versus the hardcoded default.
7. The reader-swarm document pick (`addSharedDocumentReader`) never selects a
   path matched by the denylist, even if a design doc references it.
8. A unit test asserts the predicate denies a representative vendored path and
   allows a representative first-party path for both the read tool and the
   reader-swarm selection.
9. After exceeding the per-worker read-input budget, a subsequent default-limit
   `read_file` in that worker returns at most the tightened line limit and the
   result carries the budget notice; an explicit `limit`/`offset` request is
   honored (no silent truncation below the requested range).
9a. A budget-crossed BATCHED read (no explicit `limit`) returns at most
   `BUDGET_TIGHTENED_LINE_LIMIT` lines per file even when the batch size would
   have made `defaultBatchLimit` larger — i.e. the clamp is `min(defaultBatchLimit,
   500)` and never raises the limit (review HIGH 2).
10. A worker-level log line records bytes denied and cumulative bytes ingested,
    confirming measurable reduction.
11. `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>`
    does not increase the suppression count for any touched file.

## Out of Scope

- Changing timeout config, scheduler/route-capacity map, the 64k reader result
  cap, or lifecycle reducers (NFR-1).
- Implementing the full retrieval-fabric / EvidencePacket wiring (Lever 4) — only
  alignment, not implementation (see §Lever 4).
- Explicit map-reduce chunking contract (Lever 3) — deferred with rationale.
- Reworking auto-condense policy or its 80% threshold.

---

## Technical Design

### Technology stack (locked once approved)

TypeScript, existing VS Code extension host. New logic lives in `src/` as plain
TS modules and reuses the established patterns: a shared constants/predicate
module alongside `src/services/glob/constants.ts`; a persisted setting defined in
`packages/types/src/global-settings.ts` mirroring the existing
`parallelCapacityMap` precedent (schema + optional key + merge-over-static-default);
Vitest for unit tests under `src/`. No new runtime dependency is introduced; the
`ignore` library already in use (`src/core/ignore/RooIgnoreController.ts`,
`src/services/glob/list-files.ts`) is reused for glob-style matching.

### A. Root mechanism (with evidence)

A worker does **not** inherit the parent transcript:

- `ClineProvider.getTaskHandoffContext` (`src/core/webview/ClineProvider.ts:3601`)
  builds a `DelegatedChildContext` of `{ mode, apiConfigName, apiConfiguration }`
  only — no messages. `runParallelTasks` calls it per spec at
  `src/core/task/runParallelTasks.ts:364`.
- `ClineProvider.createParallelTaskRuntime`
  (`src/core/webview/ClineProvider.ts:3552`), invoked from `runParallelTasks` at
  `src/core/task/runParallelTasks.ts:470` (the `getTaskHandoffContext` call is
  the one at `:364`), creates the child via `createTask`
  with the task text = `${spec.message}` + a fixed instruction preamble
  ("You are an independent parallel worker…", `ClineProvider.ts` ~3573–3582) and
  `startTask: false`. The child's message buffer therefore starts from the spec,
  not from the parent's accumulated conversation. The code comment on
  `runParallelTasks` ("children never mutate the parent's message buffers")
  corroborates isolation.

So the 356k accumulates **inside the worker loop**, dominated by:

1. **Un-excluded junk reads.** `ReadFileTool` gates a read solely on
   `task.rooIgnoreController?.validateAccess(relPath)` (new-format path:
   `src/core/tools/ReadFileTool.ts:219`; legacy path: `:764`). `RooIgnoreController.
   validateAccess` returns `true` when no `.rooignore` content applies
   (`src/core/ignore/RooIgnoreController.ts`, `validateAccess`: "Always allow
   access if .rooignore does not exist"). This workspace's `.rooignore` contains
   only `.env` (confirmed: file is 5 bytes, content `.env`). Therefore reading
   `node_modules/@types/react/index.d.ts` or `typescript/lib/lib.dom.d.ts`
   **passes** and returns up to `DEFAULT_LINE_LIMIT = 2000` lines
   (`src/core/prompts/tools/native-tools/read_file.ts`; applied in
   `ReadFileTool.processTextFile` via `readWithSlice(..., DEFAULT_LINE_LIMIT)`).
   Repeated such reads pile 2000-line vendored blocks into history. The
   `DIRS_TO_IGNORE` set (`src/services/glob/constants.ts`: `node_modules`, `dist`,
   `out`, `vendor`, …) governs only `listFiles`
   (`src/services/glob/list-files.ts`, `buildRecursiveArgs`) — i.e. environment-
   detail path *listing* — and does **not** touch the read tool. This is the
   smoking gun matching the observed live reads of vendored `.d.ts`.

2. **Per-turn environment details (secondary).** `getEnvironmentDetails`
   (`src/core/environment/getEnvironmentDetails.ts`) appends visible files,
   open tabs, terminals, and a workspace file *path* list capped at
   `maxWorkspaceFiles = 200` (`:30`, `:270` via `listFiles(cline.cwd, true,
   maxFiles)`), rooIgnore-filtered. These are names, not bodies — a modest
   contributor, not the 356k driver (consistent with findings Q5).

Reader-swarm workers are not the source: `ParallelTaskReader` caps documents at
`MAX_READER_DOCUMENT_BYTES = 48 * 1024` and excerpts at `MAX_READER_EXCERPT_CHARS
= 10_000`, and its `SHARED_DOCUMENT` regex only matches `docs|specs|contracts`
`.md/.mdx/.txt/.json/.yaml/.yml` paths — it can never select a `.d.ts`
(`src/core/task/ParallelTaskReader.ts`). This confirms the bloat is in the
code/tester/orchestrator conversations, and that the dominant lever is **Lever 1
(junk-read exclusion)**, with Lever 2 (per-worker read budget) as the structural
backstop.

### B. Where junk-exclusion is enforced, the default denylist, and the override

**Enforcement site.** Introduce one shared predicate module,
`src/services/glob/readDenylist.ts`, exporting:

```ts
export interface ReadDenylistConfig {
  vendoredDirs: readonly string[]   // directory name matched ANYWHERE in the path
  rootDirs: readonly string[]       // matched ONLY as the first path segment; `*` suffix = prefix match
  files: readonly string[]          // exact basenames
  globs: readonly string[]          // ignore-style globs (reuses `ignore`), full-path match
}
export const DEFAULT_READ_DENYLIST: ReadDenylistConfig
export function isDeniedRead(
  relPath: string,
  config: ReadDenylistConfig,
  opts?: { knownTarget?: boolean },
): { denied: boolean; category?: string }
```

`isDeniedRead` is pure (NFR-3): it normalizes `relPath`, returns `{ denied:false }`
immediately when `opts.knownTarget` is true (override, FR-3b), then applies the
five-step match semantics specified under "Default denylist" below, returning the
first matched `field:entry` as the category for the notice.

Two call sites consume it:

1. **Read path.** In `ReadFileTool`, immediately after the existing
   `rooIgnoreController.validateAccess` check (new-format `:219`, legacy `:764`),
   add a denylist check. On deny, mark the file result `blocked` with a one-line
   notice (`File: <path>\nNote: Skipped vendored/generated path (<category>). To
   read it anyway, name the exact path in your task or set
   parallelReadDenylist.`) and set `task.didToolFailInCurrentTurn` consistent
   with the existing blocked path. The predicate receives
   `opts.knownTarget = task.isKnownTargetPath(relPath)` (see Known_Target below).
   This covers *any* worker read tool, satisfying FR-1/FR-2.

2. **Reader-swarm pick.** In `ParallelTaskReader.addSharedDocumentReader`, filter
   each candidate `relativePath` through `isDeniedRead(relativePath, config)`
   before the `fs.stat`/excerpt step, skipping denied paths (FR-2, AC-7). In
   practice the `SHARED_DOCUMENT` regex already excludes `.d.ts`, but routing the
   pick through the same predicate keeps one source of truth and future-proofs a
   widened regex.

**Default denylist (`DEFAULT_READ_DENYLIST`).** The config has three fields with
*distinct, explicitly specified* match semantics so first-party source is never
caught (addresses review HIGH 1, MEDIUM 5):

```ts
interface ReadDenylistConfig {
  vendoredDirs: readonly string[]   // directory NAME matched ANYWHERE in the relPath segments
  rootDirs: readonly string[]       // matched ONLY as the FIRST path segment (root-anchored);
                                    //   entries ending in `*` are prefix-matched (e.g. "out-*")
  files: readonly string[]          // exact basename match
  globs: readonly string[]          // `ignore`-compiled globs against the full relPath
}
```

- `vendoredDirs` (anywhere-segment, unambiguously third-party / tool-generated):
  `node_modules`, `vendor`, `Pods`, `.pnpm-store`, `.stryker-tmp`, `__pycache__`.
  Plus the two-segment forms kept as `globs` (below) rather than bare segments.
- `rootDirs` (first-segment only): `dist`, `out`, `out-*`, `build`, `coverage`.
  Matched against the workspace-relative path's first segment, so
  `src/features/build/x.ts`, `packages/pkg/index.ts`, and a nested `deps/`
  first-party file are all ALLOWED (FR-4). `out-*` is prefix-matched to cover the
  `.gitignore` `out-*` entry. `dist`, `out`, `out-*`, and `coverage` are literal
  `.gitignore` root outputs; `build` is NOT in this repo's `.gitignore` — it is
  retained only as a conventional root-anchored build-output name (a superset of
  the repo's actual outputs) and is a harmless no-op here because no root
  `build/` directory exists.
- `files` (exact basename): `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`.
- `globs`: `**/node_modules/@types/**`, `**/typescript/lib/*.d.ts`, `**/*.min.js`,
  `**/*.min.css`, `**/*.js.map`, `**/*.css.map`, `target/dependency/**`,
  `build/dependencies/**`.

Explicitly EXCLUDED from the default (per review): bare `pkg`, `deps`, `bundle`,
anywhere-segment `build`/`out` (they recur as first-party roots/segments), broad
`**/*.map` (narrowed to `**/*.js.map`/`**/*.css.map` so a first-party
`fixtures/foo.map` is allowed), and `.git` (no established reachable `read_file`
path under `task.cwd`; its removal costs nothing because `.git` is not a source
target workers request).

The default intentionally does NOT deny all `*.d.ts` (first-party ambient
declarations under `src/**` or `packages/**/*.d.ts` can be legitimate) — only
*vendored* `.d.ts` under `node_modules/@types` and `typescript/lib` (FR-4).

**Match semantics (so `isDeniedRead` is unambiguous):** the predicate normalizes
`relPath` to forward-slash workspace-relative form, splits into segments, then:
(1) returns `{denied:false}` immediately if `knownTarget`; (2) denies if any
segment equals a `vendoredDirs` entry; (3) denies if the FIRST segment equals a
`rootDirs` entry (or matches an `out-*`-style prefix); (4) denies if the basename
is in `files`; (5) denies if any `globs` entry matches via the `ignore` library.
The returned `category` is the field+entry that matched, for the notice.

**Override paths (FR-3).**

- **Known_Target bypass.** `isDeniedRead` short-circuits when the path is a
  Known_Target. A path is a Known_Target when it appears verbatim in the worker's
  task text (`spec.message`). This single source covers both a user-named path
  and a mastermind-assigned file scope: there is **no structured file-scope field
  on `ParallelTaskSpec`** — its fields are `name`, `mode`, `message`, `todos`,
  `route`, `reasoning`, `verification`, `capabilities`
  (`ParallelTasksTool.ts:88-105`), and `capabilities.scopeHints` is a
  `Record<capabilityId, string[]>` of arbitrary strings, not a file-path list
  (`ParallelTasksTool.ts:84`). The mastermind therefore writes assigned file
  scope into the prose `message`, which the grammar below extracts. The
  extraction is a NEW,
  explicitly-specified parser (NOT a reuse of `referencedDocuments`, whose
  `SHARED_DOCUMENT` regex is hard-restricted to `(docs|specs|contracts)/…`
  markdown-ish files at `ParallelTaskReader.ts:8-10` and cannot match a `.d.ts`
  or arbitrary source path — review MEDIUM 3). The grammar for a path literal:

  > A **path literal** is a token that (a) contains at least one `/`, (b) ends in
  > a file extension `.[A-Za-z0-9]+` (optionally a compound extension such as
  > `.d.ts`), and (c) is either workspace-relative bare text delimited by
  > whitespace/paren/comma/semicolon, or enclosed in backticks/single/double
  > quotes. An optional `:<line>` or `:<line>:<col>` suffix (diagnostic
  > `file:line` form) is stripped before storing. Tokens containing a `..`
  > segment are rejected (no path traversal).

  Implementation: `extractKnownTargetPaths(message: string): Set<string>` in the
  new `src/services/glob/readDenylist.ts` module, returning normalized
  workspace-relative paths with any `:line[:col]` suffix removed. A per-`Task`
  `knownTargetPaths: Set<string>` is seeded **solely** from
  `extractKnownTargetPaths(spec.message)` (no other source — mastermind scope is
  in that same message prose); `task.isKnownTargetPath
  (relPath)` consults it (membership compares normalized paths). `ReadFileTool`
  passes `opts.knownTarget = task.isKnownTargetPath(relPath)`. This satisfies AC-5
  (a path named in `spec.message`, whether by the user or the mastermind, →
  read allowed) and aligns
  with the retrieval spec's Known_Target concept — user-named path, diagnostic
  `file:line`, worker-held path (semantic-first-retrieval Req 3.2–3.4), Lever 4
  alignment.
- **User-adjustable setting.** `parallelReadDenylist` (persisted; see §F) lets a
  workspace clear or replace categories. Unset/empty = the hardcoded default
  (byte-for-byte no-op), mirroring how `parallelCapacityMap` merges over
  `STATIC_ROUTE_CAPACITY`.

### C. Per-worker context scoping and the read-input budget (Lever 2)

A worker already starts tight: a fresh buffer seeded by `spec.message` + preamble
(§A). The remaining growth is *during* the loop. Rather than rebuild child-context
assembly in `runParallelTasks` (it does not inherit the transcript, so there is
nothing to trim at dispatch), Lever 2 caps **cumulative read bytes** a worker
ingests and tightens reads once the budget is spent:

- Add a per-`Task` counter `readInputBytesConsumed` incremented in
  `ReadFileTool` by the byte length of each returned `nativeContent`. This is a
  worker-local field; parallel workers each have their own `Task`.
- Define `DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES` (shared default constant in
  `packages/types/src/global-settings.ts`). **This is read-only byte accounting,
  not a total-prompt token budget** — it counts only bytes `ReadFileTool`
  returns, not env details, preamble, or accumulated turns, so it is NOT directly
  comparable to the 356k total-prompt figure (review MEDIUM 4). The default is
  chosen to engage *well before* reads alone could dominate a prompt: proposed
  **`600_000` bytes ≈ ~150k tokens** at the ~4 chars/token heuristic. Arithmetic:
  the observed total prompt was 356k tokens (~1,424,000 bytes) and the condensed
  figure 242,913 tokens (~971,652 bytes); 600,000 read bytes is ~42% of the raw
  prompt bytes and ~62% of the condensed-prompt bytes, so cumulative worker reads
  are bounded far under the point where read accumulation alone recreates the
  bloat, while still comfortably permitting a legitimate multi-file first-party
  investigation (≈ 60–120 typical source files at ~5–10 KiB each before the soft
  tightening even begins). The value is user-adjustable (§F) and FR-6 measurement
  is the authoritative calibration, not the heuristic. When
  `readInputBytesConsumed` crosses the budget, for any read with **no explicit
  `limit`** the computed default line limit is clamped — the clamp applies to
  whichever default the code path uses, never raising it:
  1. **Batched path** (`ReadFileTool.executeBatch:112-117`): the per-file default
     is `defaultBatchLimit = min(DEFAULT_LINE_LIMIT, floor(DEFAULT_BATCH_LINE_BUDGET
     / uniquePaths.length))`. When the budget is crossed, use
     `min(defaultBatchLimit, BUDGET_TIGHTENED_LINE_LIMIT)` as `effectiveLimit`
     (replacing `limit ?? defaultBatchLimit` at `:115` only when `limit` is
     undefined). Because this is a `min`, it can only lower the limit — it is
     never a no-op-upward even for large batches where `defaultBatchLimit < 500`.
  2. **Slice path** (`processTextFile` slice mode, `:378` `entry.limit ??
     DEFAULT_LINE_LIMIT`): when `entry.limit` is undefined and the budget is
     crossed, use `min(DEFAULT_LINE_LIMIT, BUDGET_TIGHTENED_LINE_LIMIT)`.
  3. **Indentation path** (`processTextFile` indentation mode): the governing
     read limit is `entry.limit ?? DEFAULT_LINE_LIMIT` at `ReadFileTool.ts:350`
     — this is the authoritative clamp site. Apply the same clamp there when
     `entry.limit` is undefined. (A second `entry.limit ?? DEFAULT_LINE_LIMIT` at
     `:359` only builds the truncation-message `effectiveLimit` display text, not
     the limit that governs the read; clamping it too is harmless but not
     required.)
  `BUDGET_TIGHTENED_LINE_LIMIT = 500` (shared constant). Because every clamp is a
  `min(computedDefault, 500)`, the tightening is monotonic — it reduces or leaves
  the limit, never increases it, in every path (review HIGH 2).
  4. Each tightened result carries a one-line notice steering toward targeted
     `read_file` (offset/limit) and semantic retrieval.
  5. Explicit `limit`/`offset`/`lineRanges`/indentation-mode reads with an
     explicit `limit` are honored unchanged — the budget never silently drops a
     range the model asked for (FR-5, AC-9).

**Reconciliation with `runParallelTasks` child-context assembly.** The dispatch
site (`src/core/task/runParallelTasks.ts`, `contexts = await Promise.all(specs.
map(...))` ~`:363`) only resolves `apiConfiguration`/model-id per worker; it does
not assemble a transcript to trim. Lever 2 therefore lives in the worker runtime
(`Task` + `ReadFileTool`), not at dispatch — this is the correct layer because
the growth is per-turn read accumulation, and it keeps `runParallelTasks`
unchanged except for passing through the resolved budget setting (already carried
via provider state).

**Why not seed workers from a tighter scoped context instead?** Workers are
already scoped (fresh buffer). The lever that matters is bounding what the loop
*adds*, which §B (deny junk) + §C (budget) accomplish without a child-context
rewrite. A scoped-retrieval seed is the retrieval-fabric direction (Lever 4),
deferred.

### D. Interaction with auto-condense and shipped scheduling

- **Auto-condense (don't double-trim).** Auto-condense fires reactively at 80%
  of the context window (`DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT = 80`,
  `packages/types/src/global-settings.ts`). Levers 1 and 2 act *before* content
  enters history (deny at read time; tighten limits before the read returns), so
  they reduce the raw input auto-condense ever sees rather than trimming already-
  stored history. There is no second trimmer competing with condense: the budget
  does not delete prior messages, it only shapes *new* reads (NFR-2).
- **Shipped infra untouched.** No change to `timeout-config.ts`,
  `routeCapacityMap.ts`/scheduler, the 64k reader result cap, or lifecycle
  reducers (NFR-1). Smaller worker prompts reduce first-token latency and queue
  parking, which *helps* the already-shipped capacity-aware scheduling and 1800s
  timeouts without altering them.

### E. Error handling, validation, invariants

Per operation that can fail:

- **Denylist match (`isDeniedRead`).** Pure, cannot throw on well-formed strings;
  a malformed `relPath` yields `{ denied:false }` (fail-open to preserve
  legitimate reads — the budget in §C is the backstop against abuse). Not logged
  per call; the aggregate denied-bytes figure is logged once per worker (FR-6).
- **Read-path deny.** Recoverable, non-fatal: the file result is `blocked` with a
  notice, matching the existing rooIgnore-blocked flow in `ReadFileTool`
  (`:221`/`:766`), and `task.didToolFailInCurrentTurn` is set as that flow does.
  The model receives the notice and can retry with an explicit path (override).
- **Reader-swarm skip.** Recoverable: a denied candidate is skipped like any
  non-existent/oversized document in the existing loop; if no candidates remain,
  `addSharedDocumentReader` returns `specs` unchanged (current behavior).
- **Budget crossing.** Non-fatal: tightened limit + notice; never an error.
- **Setting parse.** `parallelReadDenylistSchema` validation failures are
  rejected at the persistence boundary (zod `.safeParse`), exactly as
  `parallelCapacityMapSchema` does; an invalid stored value never reaches the
  predicate because unset/invalid falls back to `DEFAULT_READ_DENYLIST`.

External-input validation:

- `read_file` `path`: required, string, resolved under `task.cwd`; the denylist
  predicate receives the workspace-relative path. On empty path the existing
  missing-param error path runs (unchanged).
- `parallelReadDenylist`: optional map; keys constrained to known category names
  (`dirs`/`files`/`globs` lists of strings), values validated by schema; limits
  and behavior-on-failure as above.

Invariant ownership:

- *"Vendored/generated content never silently enters worker history."* Owned by
  `ReadFileTool` (the single read chokepoint for workers) + `ParallelTaskReader`
  (the only other ingestion route). Enforced via the shared predicate so the two
  cannot drift.
- *"A user/scope-named path is always readable."* Owned by the Known_Target
  short-circuit in `isDeniedRead`, populated by `Task`.

### F. Persisted Setting Checklist — `parallelReadDenylist`

Following `AGENTS.md`, tracing the full round trip (modeled on `parallelCapacityMap`):

- [ ] **Define schema + optionality.** Add `parallelReadDenylistSchema` and the
  shared default `DEFAULT_READ_DENYLIST` in `packages/types/src/global-settings.ts`;
  add `parallelReadDenylist: parallelReadDenylistSchema.optional()` to
  `globalSettingsSchema` (precedent: `parallelCapacityMap` at
  `global-settings.ts:216`). `GLOBAL_SETTINGS_KEYS` is derived
  (`globalSettingsSchema.keyof().options` at `global-settings.ts:389`), so the new
  key is auto-included — there is no separate array to hand-edit. The shared
  `DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES` constant is defined here too (single
  source of truth for every reader).
- [ ] **ExtensionState + message types.** Add `parallelReadDenylist` to the
  `ExtensionState`-relevant key union in
  `packages/types/src/vscode-extension-host.ts` (precedent: `parallelCapacityMap`
  at `:341`).
- [ ] **SettingsView binds to `cachedState`.** The denylist control (an advanced
  "Parallel read exclusions" editor) reads and writes **local `cachedState`**,
  NOT live `useExtensionState()` — buffering edits until Save, per the Settings
  View Pattern.
- [ ] **Save payload.** Include `parallelReadDenylist` in the `updateSettings`
  payload from `SettingsView.handleSubmit()`.
- [ ] **webviewMessageHandler.** Persist via the generic `contextProxy.setValue()`
  path (no special normalization beyond schema validation).
- [ ] **`ClineProvider.getState()`.** Return `parallelReadDenylist` with the
  intended default semantics (unset → merge over `DEFAULT_READ_DENYLIST`), so the
  worker runtime reads one effective config. Add a `getEffectiveReadDenylist()`
  merge helper. **Merge semantics (explicit, review NIT 6):** `mergeReadDenylist`
  merges per field (`vendoredDirs`, `rootDirs`, `files`, `globs`). For each
  field: if the stored config **omits** the key, the default array is inherited
  unchanged; if the stored config **provides** the key (including an explicit
  empty array `[]`), that array **replaces** the default for that field (replace,
  not union — an empty array therefore *clears* that category, which is how a
  user re-enables reading a whole category such as vendored typings). This
  per-field replace rule makes AC-6 (unset = byte-for-byte no-op: every field
  omitted → every default inherited) and AC-7 (clearing a category allows the
  vendored read) unambiguous. Note this differs from `mergeRouteCapacityMap`
  (which merges numeric route values key-by-key); the denylist uses per-field
  array replace because array union could never *remove* a default entry.
- [ ] **`getStateToPostToWebview()`.** Add `parallelReadDenylist` to both the
  destructuring and the returned object so a saved value does not visually revert.
- [ ] **Runtime consumers.** `ReadFileTool` and `ParallelTaskReader` read the
  effective denylist via provider state (`ReadFileTool` already calls
  `task.providerRef.deref()?.getState()`); both use the same merge semantics.
- [ ] **Import/export.** Schema inclusion makes it round-trip; no secret/
  non-exportable handling needed.
- [ ] **Tests.** (a) UI binding/save behavior in `webview-ui`; (b) schema
  round-trip (set/empty/unset) and merge-over-default in `packages/types`; (c)
  `getStateToPostToWebview()` returns the saved value; include both default
  (denies vendored) and cleared-category (allows vendored) cases.
- [ ] **Vitest.** Run the narrowest suites from each declaring package dir.

### Testability

- **Unit (lowest layer, preferred):** `isDeniedRead` truth table —
  DENIED: `node_modules/@types/react/index.d.ts`, `typescript/lib/lib.dom.d.ts`,
  `package-lock.json`, `app.min.js`, repo-root `dist/bundle.js`, repo-root
  `out/x.js`, `target/dependency/foo.jar`;
  ALLOWED: `src/core/task/Task.ts`, first-party `src/types/global.d.ts`,
  `docs/x.md`, `packages/pkg/index.ts`, `src/features/build/pipeline.ts`, nested
  `services/deps/client.ts`, `fixtures/sample.map`, `webview-ui/out/README.md`
  only if `out` is nested (not root) — i.e. root-anchoring and the narrowed
  `*.js.map`/`*.css.map` globs are both exercised. Plus Known_Target override and
  cleared-category override rows. Pure function, no I/O (NFR-3).
  `extractKnownTargetPaths` tests: extract a bare `.d.ts`, a backtick-quoted
  path, and a `path:line` form; reject a `..`-traversal token. Schema round-trip
  + per-field replace-merge (omit = inherit; `[]` = clear) in `packages/types`.
- **Integration:** `ReadFileTool` denies a vendored path and blocks it with the
  notice while allowing a source read (uses existing tool test harness and
  `src/test-utils`); `addSharedDocumentReader` skips a denied candidate.
  Per-worker budget: after crossing the threshold a default read is tightened and
  an explicit `limit` read is honored.
- **webview-ui:** SettingsView control binds to `cachedState` and emits the Save
  payload.
- **No new e2e required:** the behavior is provable at unit/integration layers;
  no VS Code extension-host boundary is involved. (Per `AGENTS.md` test-placement
  guidance.)

### Expected reduction (quantified where feasible)

The dominant contributor is 2000-line vendored reads. `node_modules/@types/react/
index.d.ts` and `typescript/lib/lib.dom.d.ts` are each on the order of thousands
of lines; a single 2000-line vendored read is ≈ tens of thousands of tokens.
Eliminating even a handful of such reads per worker removes the bulk of the gap
between the ~356k observed and the ~243k post-condense figure. Precise reduction
is runtime-dependent (it scales with how many vendored reads a given model
attempts), so FR-6/AC-10 make it **measurable** via a per-worker logged
denied-bytes / ingested-bytes figure rather than asserting a fixed percentage.

---

## Levers 3 and 4

### Lever 3 — map-reduce reads: DEFERRED

The parallel-task system already fans out, and reader workers are 48 KiB-bounded
with 10k-char excerpts (`ParallelTaskReader`). With Lever 1 (junk exclusion) +
Lever 2 (per-worker read budget) in place, a worker's ingestion is both scoped
and bounded, which addresses the measured bloat without a new chunking contract.
An explicit map-reduce read contract would add coordination surface and interact
with lifecycle/scheduler concerns this task must not touch (NFR-1). Rationale for
deferral: the dominant source is junk reads, not legitimate large-file reads that
would need chunking; map-reduce solves a problem we do not yet have. Revisit only
if, after Levers 1–2, legitimate single-file reads still dominate.

### Lever 4 — retrieval / EvidencePacket wiring: OUT OF SCOPE (aligned, not implemented)

`.kiro/specs/semantic-first-retrieval/requirements.md` and
`.kiro/specs/retrieval-fabric/` describe the long-term direction: workers receive
a bounded `Evidence_Packet` (≈5–8 items of file/line/score/reason) via the
Retrieval_Gateway instead of raw files, with `Worker_Bootstrap_Retrieval` and
`Reader_Swarm_Packet` seeding worker context (Reqs 9–11), a `Retrieval_Output_
Budget` keeping large chunks out of parent context (Req 6), and a `Known_Target`
bypass (Req 3). This design is deliberately shaped to not conflict:

- The §B **Known_Target** override reuses the retrieval spec's exact concept via
  the new `extractKnownTargetPaths` parser (§B) — grammar aligned with
  semantic-first-retrieval Req 3.2–3.4 (user-named path, diagnostic `file:line`,
  worker-held path) — so when retrieval lands, the same Known_Target signal
  governs both. It does NOT depend on `referencedDocuments`, whose regex is
  restricted to `(docs|specs|contracts)/…` markdown.
- The §C **read-input budget** complements `Retrieval_Output_Budget` (one bounds
  worker reads, the other bounds parent-surfaced chunks) and does not pre-empt it.
- The denylist is a *read-time* filter; retrieval is a *targeting* mechanism. A
  worker seeded with an Evidence_Packet still reads files through `ReadFileTool`,
  so the denylist keeps protecting that path after retrieval ships.

Implementing the gateway wiring here is not "genuinely small" (it spans the
ExplorationPolicy, gateway client, caching, and metrics across two specs), so it
remains out of scope per the brief.

---

## Files to modify / add

- Add `src/services/glob/readDenylist.ts` — `DEFAULT_READ_DENYLIST`,
  `ReadDenylistConfig` (`vendoredDirs`/`rootDirs`/`files`/`globs`), pure
  `isDeniedRead` (five-step match semantics), `extractKnownTargetPaths` (the new
  path-literal parser, §B), and `mergeReadDenylist` (per-field replace-over-
  default; an explicit `[]` clears a field — NOT the numeric key-merge of
  `mergeRouteCapacityMap`).
- `src/core/tools/ReadFileTool.ts` — denylist check after the existing
  `validateAccess` gate (new-format `:219`, legacy `:764`); per-worker
  read-input byte accounting + budget-tightened default limit.
- `src/core/task/ParallelTaskReader.ts` — route the document pick through
  `isDeniedRead` in `addSharedDocumentReader`.
- `src/core/task/Task.ts` — `knownTargetPaths` set seeded solely from
  `extractKnownTargetPaths(spec.message)` (mastermind scope lives in that same
  message prose; no structured scope field exists on `ParallelTaskSpec`),
  `isKnownTargetPath`; `readInputBytesConsumed` counter + effective-budget read.
- `packages/types/src/global-settings.ts` — `parallelReadDenylistSchema`,
  `DEFAULT_READ_DENYLIST` wiring, `DEFAULT_WORKER_READ_INPUT_BUDGET_BYTES`,
  `globalSettingsSchema` + `GLOBAL_SETTINGS_KEYS` additions.
- `packages/types/src/vscode-extension-host.ts` — add `parallelReadDenylist` key.
- `src/core/webview/ClineProvider.ts` — `getState()` default +
  `getStateToPostToWebview()` round trip + `getEffectiveReadDenylist()` helper.
- `src/core/webview/webviewMessageHandler.ts` — persist via `contextProxy.setValue()`.
- `webview-ui/.../SettingsView` — `cachedState`-bound exclusions control.
- Tests: `readDenylist` unit, `ReadFileTool`/`ParallelTaskReader` integration,
  `global-settings` schema round-trip, `getStateToPostToWebview` assertion,
  SettingsView binding.

Explicitly NOT modified: `src/api/providers/utils/timeout-config.ts`,
`src/core/task/routeCapacityMap.ts` / scheduler, the 64k reader result cap,
lifecycle reducers (`src/core/task-persistence/taskLifecycle.ts`).

---

## Assumptions

- The live-observed `web/node_modules/@types/react/index.d.ts` read occurred in a
  task whose `cwd` is the real checkout (orchestrator/code worker), not inside a
  gitignore-stripped worktree — because `snapshotWorkingTree` uses `git add -A`
  which excludes gitignored `node_modules` (`src/core/task/ParallelTaskWorkspace.ts`).
  Either way the fix (deny at the read path, not just `listFiles`) covers both the
  orchestrator and any worktree worker.
- "~4 chars/token" is a rough sizing heuristic for the budget default only; the
  budget is user-adjustable and the measurability requirement (FR-6) is the
  authoritative check, not the heuristic.

---

## Review Responses (Revision 3)

Addressing every finding in the latest `design-review.json` (verdict
CHANGES_REQUESTED: 1 MEDIUM, 4 NITs). Each claim was re-verified against source.

- **Finding 1 (MEDIUM) — Known_Target "mastermind-assigned file scope" source is
  unspecified/unverified. ADDRESSED (Option A).** Confirmed against
  `ParallelTasksTool.ts:88-105`: `ParallelTaskSpec` has only `name`, `mode`,
  `message`, `todos`, `route`, `reasoning`, `verification`, `capabilities`, and
  `capabilities.scopeHints` (`:84`) is `z.record(z.string(), z.array(z.string()))`
  — arbitrary strings keyed by capability id, not a file-path list. There is no
  structured file-scope field. Per the review's recommended Option A, the design
  now seeds `knownTargetPaths` **solely** from `extractKnownTargetPaths(spec.
  message)` and removes every "plus mastermind-assigned file scopes" clause. The
  §B Known_Target bypass, FR-3, AC-5, and the `Task.ts` entry in "Files to modify"
  now all state that mastermind file scope is carried in the prose `spec.message`
  (so the same message-grammar extraction covers it) and cite
  `ParallelTasksTool.ts:88-105` / `:84` for the field inventory.

- **Finding 2 (NIT) — indentation clamp cited the display-only line. ADDRESSED.**
  Verified `ReadFileTool.ts:350` is the governing `entry.limit ?? DEFAULT_LINE_LIMIT`
  passed to `readWithIndentation`, and `:359` only builds the truncation-message
  `effectiveLimit` text. §C clamp step 3 now cites `:350` as the authoritative
  clamp site and notes `:359` is a harmless display hint; the incorrect `:361`
  is corrected to `:359`.

- **Finding 3 (NIT) — `build` rootDir justification did not match `.gitignore`.
  ADDRESSED.** Verified `.gitignore` lists `dist`, `out`, `out-*`, `coverage/`,
  `.pnpm-store`, `.stryker-tmp/`, and `bin/` as root outputs but does NOT list
  `build`. Kept `build` in `rootDirs` (per the review's "keep and reword" option)
  and reworded FR-1 and §B to state the `rootDirs` set is conventional
  root-anchored build-output names — a superset of this repo's actual
  `.gitignore` outputs — explicitly flagging `build` as not gitignored here and a
  harmless no-op because no root `build/` exists. The Testability truth table uses
  only real gitignore entries (`dist/bundle.js`, `out/x.js`) for its DENIED rows,
  so no false `build` claim remains.

- **Finding 4 (NIT) — `GLOBAL_SETTINGS_KEYS` is derived, not hand-edited.
  ADDRESSED.** Verified `GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options`
  (`global-settings.ts:389`). §F "Define schema + optionality" now says to add the
  key to `globalSettingsSchema` only, noting `GLOBAL_SETTINGS_KEYS` auto-includes
  it (no separate array to edit).

- **Finding 5 (NIT) — Summary under-described `DelegatedChildContext`.
  ADDRESSED.** The Summary now says `getTaskHandoffContext` carries only
  `{ mode, apiConfigName, apiConfiguration }`, matching §A.

---

## Review Responses (Revision 2)

Addressing every finding in the Revision-2 `design-review.json` (verdict
CHANGES_REQUESTED). Retained for history.

- **Finding 1 (HIGH) — bare-segment `dirs` deny first-party source. ADDRESSED.**
  `ReadDenylistConfig` now splits directory matching into `vendoredDirs`
  (anywhere-segment, only unambiguously third-party: `node_modules`, `vendor`,
  `Pods`, `.pnpm-store`, `.stryker-tmp`, `__pycache__`) and `rootDirs`
  (first-segment only: `dist`, `out`, `out-*`, `build`, `coverage`). Bare `pkg`,
  `deps`, `bundle`, and anywhere-segment `build`/`out` are removed from defaults;
  `target/dependency` and `build/dependencies` are kept as two-segment globs.
  FR-1 rewritten, §B denylist rewritten with explicit match semantics, and AC-4a
  + unit truth-table rows prove `packages/pkg/index.ts`,
  `src/features/build/pipeline.ts`, and nested `deps/` are ALLOWED.

- **Finding 2 (HIGH) — budget-tightening ignored the batched-read default.
  ADDRESSED.** §C now specifies the clamp per code path: batched
  (`min(defaultBatchLimit, 500)` at `:112-117`/`:115`), slice (`:378`), and
  indentation (`:350`), each a `min(computedDefault, BUDGET_TIGHTENED_LINE_LIMIT)`
  applied only when `limit` is undefined, so it is monotonic (never a no-op
  upward). AC-9a asserts a budget-crossed batched read is clamped even when
  `defaultBatchLimit` would be larger.

- **Finding 3 (MEDIUM) — Known_Target reused a docs/specs-only extractor.
  ADDRESSED.** Replaced the `referencedDocuments` reuse with a new, explicitly-
  specified `extractKnownTargetPaths` parser (path-literal grammar: contains `/`,
  has an extension incl. compound `.d.ts`, bare/quoted/backticked, optional
  `:line[:col]` stripped, `..` rejected). AC-5 updated; unit tests extract a
  `.d.ts` and a `path:line`. Aligned with semantic-first-retrieval Req 3.2–3.4.

- **Finding 4 (MEDIUM) — budget default sat above the problem. ADDRESSED.**
  Default lowered from 1,500,000 to **600,000 bytes (~150k tokens)** and
  explicitly reframed as read-only byte accounting (not comparable to the 356k
  total-prompt figure). Arithmetic shown (~42% of raw prompt bytes, ~62% of
  condensed bytes). FR-6 remains the authoritative calibration.

- **Finding 5 (MEDIUM) — `*.map` / `.git` risks. ADDRESSED.** Broad `**/*.map`
  narrowed to `**/*.js.map` and `**/*.css.map`; `.git` dropped from defaults
  (no established reachable `read_file` path). AC-4a adds a `fixtures/sample.map`
  ALLOWED row.

- **Finding 6 (NIT) — merge semantics unspecified. ADDRESSED.** §F now states
  per-field replace-over-default: omit = inherit default; explicit array
  (including `[]`) = replace/clear that field. Noted it differs from
  `mergeRouteCapacityMap`'s numeric merge. AC-6/AC-7 now unambiguous; unit test
  added.

- **Finding 7 (NIT) — citation drift. ADDRESSED.** §A and Files-to-modify now
  cite `createParallelTaskRuntime` at `runParallelTasks.ts:470`, with the
  `getTaskHandoffContext` call noted at `:364` (both verified against source).
