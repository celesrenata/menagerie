# OmniRoute System-Prompt Destruction — Final Report

Date: 2026-10-03
Status: **FIXED and LIVE-VERIFIED**. The deployed fix preserves the full array-shaped
orchestrator system prompt (incl. memory prepend) on the strict GLM path. No `[object Object]`.

---

## 1. Root cause (proven)

Full read-only investigation in `findings.md`. One-line cause:

- Destruction site: **`src/lib/memory/injection.ts:186`**, inside `injectSystemFirst()`:
    ```ts
    const merged = { ...first, content: `${memoryText}\n${first.content}` }
    ```
- `first.content` is the Zoo orchestrator system prompt. `ChatMessage.content` was **typed
  `string`**, but the real OpenAI wire shape sent by Zoo/Roo is an **array of content blocks**
  (`[{ type: "text", text: "You are Zoo..." }, ...]`). Template-literal interpolation of an
  array calls `String(array)` → the literal **`[object Object]`**, so the merged system message
  collapsed to `"Memory context: <~238 chars>\n[object Object]"` ≈ **254 chars**, discarding the
  entire ~54K orchestrator prompt (identity + the `parallel_tasks` "start them together"
  dispatch rule).
- Trigger: **FEAT-002 (`db3586f9e`)** added `vllm`, `ollama-local`, `ollama`, `llama-cpp`,
  `llamacpp` to `BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST`, routing those GLM backends into
  `injectSystemFirst()` (strict system-first merge) instead of the previous cache-safe splice
  that never touched `messages[0].content`.
- Gates: only fires for a strict provider AND when memory retrieval returns ≥1 memory (so
  `injectSystemFirst` runs its merge branch). This is the real root of the "GLM never
  dispatches / GPUs idle" saga — the orchestrator identity + dispatch rule never reached GLM.

Evidence that this was the single corruption point on the GLM path, and that no other
transform in the forwarding pipeline rewrites `messages[0]` system content for this provider,
is in `findings.md` (full ordered transform chain, file:line).

## 2. The exact fix

Commit **`f31c19682`** on branch **`feat/hybrid-reader-combo`** (local only, **NOT pushed**):
`fix(memory): shape-aware injectSystemFirst merge preserves array-shaped system content`

Diff summary (`src/lib/memory/injection.ts` +44, `__tests__/injection.test.ts` +59; 2 files,
97 insertions, 6 deletions):

- Widened `ChatMessage.content` from `string` to
  `string | Array<{ type: string; text?: string; [k: string]: unknown }>` so callers must
  handle the array wire shape and the compiler forces the array branch.
- Added a `toText()` helper (mirrors `strictSystemHoist.ts`'s `toTextContent()`): flattens an
  array of `{type:"text",text}` blocks to a newline-joined string; never bare `String()`.
- Made the `injectSystemFirst()` merge **shape-aware** at the former destruction line:
    - string content → `` `${memoryText}\n${first.content}` `` (unchanged behavior)
    - **array content → `[{ type: "text", text: memoryText }, ...first.content]`** (prepend
      memory as a leading text block, preserving the original blocks)
    - other shape → `` `${memoryText}\n${toText(first.content)}` `` (defensive, never `String()`)
- Added a parametrized strict-provider regression test (`vllm`/`ollama-local`/`ollama`/
  `llama-cpp`/`llamacpp`) asserting array-shaped system content keeps the original block text,
  memory as the leading block, and NO `[object Object]`.

Strict-provider routing, function signature, Anthropic top-level `system` branches, and the
FEAT-002 provider set are all unchanged.

## 3. Local test results (`verification.md`)

- `vitest run src/lib/memory/__tests__/injection.test.ts` → **34/34 pass** (29 pre-existing + 5
  new array-content cases).
- `npm run typecheck:core` → pass (exit 0). Targeted `tsc` of the two edited files under the
  project tsconfig → no real errors after narrowing a test's `.startsWith()` to `string`.
- `eslint` on both edited files → clean (0 warnings/errors). No ESLint suppression count
  increased.

## 4. Deploy digest (`deploy-report.md`)

- Image: `registry.celestium.life/library/omniroute:3.8.55-sysprompt-fix-20261002`
- Pushed registry digest: **`sha256:99bc612fb1c05ed8ae097eeff15d50abb09a8d721d5ba0e35715dadfe78a7028`**
- Kube YAML bump committed locally (NOT pushed): `034c7bd20b98...`
- Rollout: `deployment.apps/omniroute configured`, strategy `Recreate`, replicas 1.

Confirmed live at verification time:

- Pod `omniroute-67466d9798-fjcmj`, **1/1 Running, 0 restarts**, started `2026-10-03T04:43:01Z`.
- Running imageID digest **`sha256:99bc612fb1c05ed8ae097eeff15d50abb09a8d721d5ba0e35715dadfe78a7028`**
  — matches the pushed digest EXACTLY.

## 5. LIVE before/after verification (the deliverable)

Method: same one the bug was found with — send a chat completion that routes to a STRICT
provider with a large ARRAY-shaped system message (mimicking Zoo), memory enabled, then read
OmniRoute's own `call_logs` artifact (`pipeline.clientRawRequest.body` vs
`pipeline.providerRequest.body`) and compare `messages[0].content`.

Transport note: the public ingress (`https://omniroute.celestium.life`) did not land the test
request on the pod during the window (nothing logged for ~30 min), so the request was issued
**from inside the deployed pod against `http://127.0.0.1:20128`** using the pod's own Node
runtime and the management Bearer key. This guarantees the request was served by the
digest-verified fixed pod. It routed to the real GLM GPU backend
(`llama-cpp/ds4-glm53` → `http://192.168.133.2:7777`, HTTP 200, ~28s, ~10.7K prompt tokens).

### Request shape

- Model: `llama-cpp/ds4-glm53` (strict `llama-cpp` provider → `injectSystemFirst` path).
- System message: ARRAY of 2 text blocks — block 1 = "You are Zoo, the orchestrator..."
  (orchestrator identity), block 2 = "DISPATCH RULE (parallel_tasks): ...start them together..."
  (dispatch rule). Joined length **56,146 chars**.
- Memory enabled (server `memoryEnabled=true`, strategy `hybrid`). To make retrieval return a
  memory for the test key, a single verification memory was seeded for the requesting
  `apiKeyId` and reindexed into the vector store, so `injectSystemFirst`'s **memory-merge
  branch** actually executed. (All test artifacts were removed afterward — see Cleanup.)

### Call-log evidence

| Metric                                         | BEFORE fix (old-pod log `2026-10-03T04:19:25Z`, pre-04:43 pod) | AFTER fix (new-pod log `2026-10-03T04:58:03Z`)                                 |
| ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `providerRequest` system shape                 | **string**                                                     | **array (3 blocks)**                                                           |
| `providerRequest` system length                | **254 chars**                                                  | **56,365 chars** (joined); json 56,453                                         |
| First block / head                             | `"Memory context: ... [object Object]"`                        | `"Memory context: VERIFY-FIX note: injectSystemFirst..."` then original blocks |
| Contains `You are Zoo` (orchestrator identity) | **NO** (discarded)                                             | **YES**                                                                        |
| Contains dispatch rule `start them together`   | **NO** (discarded)                                             | **YES**                                                                        |
| Memory context prepended                       | yes (but as the ONLY content)                                  | **YES** (as leading block, original preserved)                                 |
| Contains `[object Object]`                     | **YES**                                                        | **NO**                                                                         |

- **BEFORE**: `providerRequest.body.messages[0].content` was a 254-char string beginning
  `"Memory context: ..."` and containing `[object Object]`; the 54K orchestrator prompt was gone.
  (This 254-char/`[object Object]` signature is the exact pre-fix evidence recorded in
  `findings.md`.)
- **AFTER**: `clientRawRequest` system = array(2), 56,146 chars, Zoo + dispatch, no
  `[object Object]`. `providerRequest` system = **array(3)**, **56,365 chars** — the memory block
  prepended as `messages[0].content[0]` (`"Memory context: VERIFY-FIX note: injectSystemFirst
shape-aware merge..."`) followed by the two ORIGINAL blocks fully intact: `You are Zoo` =
  present, `start them together` = present, and **`[object Object]` = absent**.
- Server log for the after-request:
  `memory.retrieval.complete {count:1, tier:"hybrid-rrf"}` — confirms the memory-merge branch
  fired (count ≥ 1), i.e. the exact code path that previously destroyed the prompt.

A control request with memory NOT matching (retrieval count 0) also passed the array system
message through unchanged (array(2), 56,146 chars, no `[object Object]`), confirming the
no-memory path is likewise intact.

### Outcome

**PASS.** The fix is live and working. `providerRequest` system prompt went from **254 chars
with `[object Object]`** (prompt destroyed) to **56,365 chars** containing the full orchestrator
identity + dispatch rule plus the prepended memory context, with **no `[object Object]`**.

## 6. Cleanup

- No debug pods were created; verification used `kubectl exec` against the existing pod.
- Removed all debug scripts copied into the pod (`/app/data/*.js`).
- Deleted the single seeded verification memory; memory ownership restored to the original
  12 rows (9 global + 3 `zoo-m5`), `memory_fts` rebuilt clean (12 rows), 0 seed rows left.
- Note: the pre-existing 12 memories were reindexed into the vector store during verification
  (they were `needs_reindex=1`); this only populated embeddings that should have existed and
  did not alter any memory content.

## 7. Git

- Fix commit `f31c19682` on `feat/hybrid-reader-combo` — **local only, not pushed** (verified:
  no remote branch contains it).
- Kube deploy commit `034c7bd20b98...` — local only, not pushed.
- No branches pushed, no PRs opened.
