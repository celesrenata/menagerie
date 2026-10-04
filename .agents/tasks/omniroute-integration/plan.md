# OmniRoute failure-fix + tier dropdown — diagnosis-grounded implementation plan

Supersedes the earlier reader-fabric plan (that work is done and deployed — the live esnixi
`feat/nvfp4-reader-fabric` branch already serves the 5090 coder at `--max-model-len 131072`, the
dedicated 9B readers, and the GLM-over-MLX coder chain). THIS plan fixes the OmniRoute request
failures the user reported (messages 1–12) plus the per-request cost-tier dropdown.

This plan was authored diagnosis-first against the LIVE instance (`https://omniroute.celestium.life`),
the deployed call logs (`~/.omniroute/call_logs`, `~/.omniroute/logs/application/app.log`), the
OmniRoute source (`/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo`),
and the remote esnixi flake (`celes@192.168.42.254:sources/celesrenata/nix-flakes-refactored`,
branch `feat/nvfp4-reader-fabric`). Every root cause below cites evidence actually observed.

This work is FEAT-decomposed — see `features/FEAT-001..005.json` and `task.json`. This file is the
human-readable companion and the fallback the implement-and-review loop uses.

---

## Repos, branches, keys (do NOT change)

- **OmniRoute source** (agent edits + commits, do NOT push): `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo`. Source version 3.8.52.
- **Deployed OmniRoute instance** (3.8.50): runs via `omniroute serve --port 20128`; data dir `~/.omniroute`; the running fabric is on `http://127.0.0.1:20128` and public at `https://omniroute.celestium.life`. The deployed `injection.ts` matches source for the strict-system set. Rebuild/redeploy from source is OPERATOR-only.
- **esnixi flake** (agent edits over SSH + commits on `feat/nvfp4-reader-fabric`, do NOT push): `celes@192.168.42.254:sources/celesrenata/nix-flakes-refactored`. `nixos-rebuild switch` is OPERATOR-only.
- **Routing policy generators** (deployed to esnixi `~/.local/share/omniroute-editor/`): `home/programs/omniroute-mode.py` (tier/combo policy) and `home/programs/omniroute-routing.py` (combo + model-capability overrides). The agent CAN run these in `--apply` mode FROM THE MAC with the management key.
- **Management key**: `cat /run/secrets/omniroute_management_api_key` (confirmed readable; prefix `sk-5e47…`). **Inference key**: `sk-1e7cfaf93c3e6519-77e4fd-5cfca784`. Never echo full secret values into committed files.
- **menagerie** (this repo): webview + extension host for the tier dropdown (FEAT-005). Follow `AGENTS.md` (SettingsView cachedState rule, no `.changeset`, no CHANGELOG, ESLint suppression ratchet).

---

## DIAGNOSIS (the required deliverable)

### Failure A — empty-response 502 — root cause is NOT memory-injection. Evidence-backed.

The task hypothesized that Failure A (empty-502 on both `vllm/qwen3.8-27b-nvfp4` AND
`bedrock/claude-opus-5`) is caused by Failure C's memory-injection corrupting the message array.
**The logs do not support that hypothesis.** What the deployed logs actually show:

- `~/.omniroute/call_logs` has **33** status-502 records. **Every one has NO memory injected**
  (`"Memory context:"` absent from the request body). Memory injection is therefore not present on
  the failing requests, so it cannot be their cause.
- The dominant 502 cause is **`ECONNREFUSED`** (41 occurrences across `app.log`: 24× to
  `127.0.0.x:1800x`, 17× to a `192.168.x` upstream). Example: `2026-09-25T06:49:18Z`,
  `vllm/qwen3.8-27b-nvfp4`, `account=gremlin-4070ti`, `duration=21ms`, `tokens in/out = 0`,
  error `fetch failed (cause: ECONNREFUSED connect 127.0.0.1:18001)`. These are the backend/switcher
  being briefly unreachable (model-swap window or a backend not yet listening), NOT empty model output.
- The literal `"empty response without usable output"` string from the task appears in **zero**
  stored call logs and zero `app.log` lines. The nearest real empties are **2×
  `❌ huggingface [502]: Provider returned empty content`** — a different provider, not vllm/bedrock.
- The `bedrock/…claude-opus-5` failures in `app.log` are **`400: Invocation of model ID
anthropic.claude-opus-5 with on-demand throughput isn't supported`** — a Bedrock
  provisioned-throughput/model-id config error, NOT an empty-output 502, and NOT injection-related.

**Conclusion for A:** the empty-502 class as reported is not reproducible from the retained
artifacts, and where 502s DO exist they are connectivity (`ECONNREFUSED`, switcher-transition races)
or provider-config errors — none correlate with memory injection. Fixing C will not, by this
evidence, change the observed 502s. Per the task's instruction not to dismiss a reported failure on
source-reading alone, Failure A is carried into the plan (FEAT-004) as **needs-runtime-verification**:
the implementer must (a) add the empty-output producer's provider+injection-state to the diagnostic
log line so the next occurrence is self-classifying, and (b) if an empty-output 502 recurs on
vllm/bedrock during implementation, capture the exact request and re-open the injection hypothesis.
The empirically supported, actionable 502 reducers — the switcher's existing 409-not-502 fallthrough
and the `detectMalformedNonStream` classifier — are already in place; FEAT-004 hardens observability
rather than guessing at a fix for an unreproduced signature.

The parallel-worker symptom (Failure E) is a direct consequence: when a tier 502s/500s, the 3-tier
coder chain collapses onto the one capped GLM, so concurrent workers serialize. Fixing C (and
reducing transition 502s) restores spreading. See Failure E below.

### Failure B — context off-by-one at 131072 — root cause CONFIRMED, fix is a policy re-apply.

- The esnixi switcher is already correct and deployed: live `GET 127.0.0.1:8010/v1/models` returns
  `max_model_len=131072`; `vllm-switch.py` MODELS context=131072 ⇒ advertises `max_input_tokens =
131072 − 32768 = 98304`; `vllm.nix` `maxModelLen="131072"`. **esnixi needs no change for B.**
- The stale value lives in **OmniRoute's model-capability-overrides**. Live
  `GET /api/model-capability-overrides` returns `vllm/qwen3.8-27b-nvfp4 → context_length=147456,
max_input_tokens=114688` (the OLD pre-narrow pair) and `vllm/qwen3.8-27b-nvfp4-balanced →
context_length=147456, max_input_tokens=65536`. With max_input=114688 and max_output=16384 the
  advertised ceiling is exactly 131072 (zero slack), so a 114689-input request slips past OmniRoute's
  check and the real 131072-total backend rejects it with the "1 over" 400.
- `omniroute-routing.py` already carries the correct target: `layouts = {"vllm/qwen3.8-27b-nvfp4":
(131072, 98304)}` and applies it as a model-capability-override PATCH (lines ~200–245), but the
  apply has not been run against live (or was run `--code-only`, which skips the override block).
  The balanced variant is **missing** from `layouts`, so its stale `context_length=147456` is never
  corrected.

**Fix for B (agent-applicable from the Mac):** add `vllm/qwen3.8-27b-nvfp4-balanced` to `layouts`
with context_length 131072 (keeping its intentionally-smaller `max_input_tokens=65536` — the balanced
reasoning lane reserves more output headroom; do NOT raise it to 98304), then re-run
`omniroute-routing.py --apply` (NOT `--code-only`) with the management key so OmniRoute advertises
`vllm/qwen3.8-27b-nvfp4 → (131072, 98304)` and `…-balanced → (131072, 65536)`. Verify via the live
overrides API read-back. See FEAT-001.

### Failure C — memory-injection displaces the system message — root cause CONFIRMED, source fix.

- `app.log` shows **18× `[400]/[500]: System message must be at the beginning`**.
- Root cause in `src/lib/memory/injection.ts`: `providerSupportsSystemMessage("vllm"|"ollama-local"|
"llama-cpp")` returns `true` (none are in the no-system set), AND `systemMessageMustBeFirst(...)`
  returns `false` (the builtin strict set is only `{xiaomi-mimo, mimo, tokenrouter}` and
  `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` is unset on the deployed instance). So when prompt-caching is
  active (`cacheSafe`), `injectMemory` takes the generic path and `placeMessage` splices a
  `{role:"system"}` memory message **mid-array, before the last user turn** (logged
  `strategy:"system-cache-safe"`), pushing the real system message off index 0. The strict Qwen/
  GLM chat templates (`vllm` coder, `ollama-local/qwen3.8:27b-iq3-code144k`, and the MLX `llama-cpp`
  model) then raise "System message must be at the beginning".
- The 5090 `vllm` lane has a switcher-side defense (`vllm-switch.py normalize_chat_system_messages`
  merges system messages and re-floats one to index 0), which is why C bit the `ollama-local` IQ3
  and MLX lanes hardest — they have no such normalization.

**Fix for C (agent edits + commits in OmniRoute source):** add the strict-template provider ids to
`BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST` in `injection.ts` — `vllm`, `ollama-local`, `ollama`,
`llama-cpp`, `llamacpp` (cover both the hyphenated and unhyphenated catalog spellings observed in
`/v1/models`). This routes those providers through `injectSystemFirst`, which MERGES memory into the
existing index-0 system message (or prepends a leading system message), never mid-array — preserving
system-first ordering. Add focused tests. **Operator immediate-mitigation (documented, no rebuild):**
set `OMNIROUTE_STRICT_SYSTEM_PROVIDERS=vllm,ollama-local,ollama,llama-cpp,llamacpp` in the deployed
instance env and restart `omniroute serve` — the source already honors that env, giving relief before
the 3.8.52 source is redeployed. See FEAT-002.

### Failure D — stale `openai/gpt-5.6` in tier-5 — root cause CONFIRMED, policy edit + re-apply.

- `app.log` shows **30× `[400]: Model 'gpt-5.6' is not available in the active live catalog for
provider 'openai'`**.
- `omniroute-mode.py` CLOUD tier 5 line 89 lists `('openai/gpt-5.6', 35)`. Although the catalog
  `/v1/models` surfaces an `openai/gpt-5.6` alias, the request-time resolver rejects the bare id (the
  real resolvable ids are `openai/gpt-5.6-sol`, `-terra`, `-luna`).

**Fix for D (agent edits + commits + re-applies from the Mac):** change tier-5's `openai/gpt-5.6` to
`openai/gpt-5.6-terra` (tier 5 already carries `bedrock/global.openai.gpt-5.6-sol`, so `-terra` is
the distinct flagship that avoids a duplicate), then re-run `omniroute-mode.py tiered --apply`. See
FEAT-003. (FEAT-001 and FEAT-003 both re-apply policy — they are sequenced so one apply pass covers
both, see task.json ordering.)

### Failure E — parallel workers not spreading — mostly resolved by A+C, one optional config win.

- Coder-lane parallel capacity is 3 tiers × `maxConcurrent=1` each: esnixi-5090=1, stabulous-m5max
  GLM=1, gremlin-4070ti IQ3=1. The 5090 is correctly SERIALIZED (not double-called); not a bug.
- Last-hour evidence: GLM hit its cap 3×; the full coder chain exhausted 1×. The "doesn't spread to a
  second worker" symptom is the SAME A/C failures: when the 5090 502s or the IQ3 500s on
  system-ordering, the chain collapses onto the one capped GLM, so workers serialize/error.
- **Fix for E:** fixing C (and reducing transition 502s / improving observability from A) restores
  5090→GLM→IQ3 spreading — the primary resolution. **Optional, test-gated:** raise stabulous-m5max
  (GLM, `llama-cpp` on M5 Max) `maxConcurrent` 1→2 for wider fan-out IF it tests safe (M5 can batch).
  Do NOT raise esnixi-5090 (its 131072 KV pool fits ~1 full-context sequence; 2× OOMs — verified).
  Keep gremlin IQ3 at 1 (ollama doesn't parallelize that model type well). See FEAT-004.

### User messages 1–5 (GLM-over-MLX, readers-not-coder) — already in source, verify deployed.

`omniroute-mode.py` `TIER1_OVERRIDES` already encodes the user's decision: `code`/`tester` chains are
`[QWEN5090(55), GLM(24), IQ3(21)]` (GLM replaced MLX), and `reader` is `[READER5090(60),
READER4070(40)]` (dedicated 9B readers, not the coder). The policy re-apply in FEAT-001/003 makes sure
this is the LIVE routing, resolving "reading files with qwen 27b instead of our readers" and "the mlx
route is wrong". FEAT-004 verifies at runtime that a reader request hits a 9B reader and a code
request hits the GLM/5090 chain (never MLX).

---

## FEATURE PLAN (ordered; see features/\*.json for machine detail)

### FEAT-001 — Reconcile OmniRoute's advertised 5090 context (Failure B) [agent-applies]

What: add the balanced variant to `omniroute-routing.py` `layouts`
(`"vllm/qwen3.8-27b-nvfp4-balanced": (131072, 65536)`), keep the coder at `(131072, 98304)`; commit on
esnixi branch; then run `OMNIROUTE_API_KEY=<mgmt> python3 omniroute-routing.py --apply` from the Mac
against `https://omniroute.celestium.life`.
Files: (remote) `home/programs/omniroute-routing.py`.
Verify: `GET /api/model-capability-overrides` returns coder `(context_length=131072,
max_input_tokens=98304)` and balanced `(131072, 65536)`; `GET /v1/models` shows the coder at
`ctx=131072, max_in=98304`. No "1 over" 400 reproducible with a 98304-input probe.

### FEAT-002 — Keep the system message first for strict templates (Failure C) [agent source fix]

What: add `vllm, ollama-local, ollama, llama-cpp, llamacpp` to
`BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST` in `src/lib/memory/injection.ts`; extend
`src/lib/memory/__tests__/injection.test.ts` to assert that for each of these providers, with
`cacheSafe:true` and a leading system message, memory is MERGED into messages[0] (system stays at
index 0) and no mid-array system message is spliced. Commit on OmniRoute branch. Document the operator
env mitigation (`OMNIROUTE_STRICT_SYSTEM_PROVIDERS=…`) + source redeploy.
Files: `OmniRoute/src/lib/memory/injection.ts`, `OmniRoute/src/lib/memory/__tests__/injection.test.ts`.
Verify: `cd OmniRoute && npx vitest run --config vitest.config.ts src/lib/memory/__tests__/injection.test.ts`
passes new + existing cases; `npm run typecheck:core` clean.

### FEAT-003 — Replace stale tier-5 model id (Failure D) [agent-applies]

What: in `omniroute-mode.py` change tier-5 `('openai/gpt-5.6', 35)` → `('openai/gpt-5.6-terra', 35)`;
commit on esnixi branch; re-run `OMNIROUTE_API_KEY=<mgmt> python3 omniroute-mode.py tiered
--base-url https://omniroute.celestium.life --baseline <snapshot> --apply` from the Mac. Sequenced
right after FEAT-001 so the two policy applies run back-to-back against a settled catalog.
Files: (remote) `home/programs/omniroute-mode.py`.
Verify: no `gpt-5.6 is not available` 400 on a tier-5 request; a tier-5 chat completion resolves to a
real cloud model; `app.log` stops accruing that signature.

### FEAT-004 — Runtime verification + observability + optional fan-out (Failures A & E) [agent + operator]

What: (a) add provider + memory-injection-state to the empty-output 502 diagnostic line in
`open-sse/utils/diagnostics.ts`/its caller so any recurrence self-classifies; (b) runtime-verify after
FEAT-001/002/003 that: reader requests hit a 9B reader (not qwen-27b coder), code requests hit the
GLM/5090 chain (never MLX), two concurrent coder requests spread to DIFFERENT tiers (5090 + GLM) not
one-erroring/queuing, and no System-message-first 500 recurs; (c) OPTIONAL test-gated: raise
stabulous-m5max GLM `maxConcurrent` 1→2 only if a 2-concurrent GLM probe stays healthy. If an
empty-output 502 recurs on vllm/bedrock, capture the request and re-open the injection hypothesis.
Files: `OmniRoute/open-sse/utils/diagnostics.ts` (+ its chatCore call site) if the log line is
extended; otherwise verification-only, recorded in `reader-fabric-verification.md`.
Verify: observability edit covered by `npm run test:vitest:ui` / `test:unit` for diagnostics; runtime
checks recorded with evidence; the m5max change applied only if its probe passed.

### FEAT-005 — Per-request cost-tier dropdown next to YOLO ($–$$$$$) (messages 6–10) [agent, two repos]

What: a 5-step `$ $$ $$$ $$$$ $$$$$` tier selector in the chat action bar beside the YOLO/auto-approve
control that steers the per-request OmniRoute tier via a request header — granted on the OmniRoute
side, never locking management. Ground it on OmniRoute's existing per-request header mechanism
(`open-sse/services/autoCombo/requestControls.ts`, which already honors `X-OmniRoute-Mode` /
`X-OmniRoute-Budget` without mutating stored combo config). Add a tier-ceiling header
(`X-OmniRoute-Tier`, values 1–5) resolver there that expands the eligible model pool up to the
requested tier (mapping to the `MODES` ladder in `omniroute-mode.py`: 1=local-only … 5=tiered), and
have menagerie send it: new `omniRouteTier` setting in `packages/types` + `ExtensionState`, a chat-bar
dropdown bound through `cachedState` per `AGENTS.md`, and the header attached in
`src/api/providers/omniroute.ts`'s request path. OmniRoute default when the header is absent =
unchanged behavior (no lockdown).
Files: `OmniRoute/open-sse/services/autoCombo/requestControls.ts` (+ its chat entry-handler wiring and
a unit test); `menagerie/packages/types/src/*` (setting + ExtensionState + message types),
`menagerie/webview-ui/src/components/chat/*` (dropdown beside YOLO), `menagerie/src/api/providers/omniroute.ts`
(attach header), `menagerie/src/core/webview/webviewMessageHandler.ts` + `ClineProvider` (persist +
round-trip per the AGENTS.md Persisted-Setting Checklist).
Verify: OmniRoute — `npx vitest run` / `npm run test:unit` for the tier resolver + a request with
`X-OmniRoute-Tier: 3` admits tier≤3 models and rejects tier-5-only. menagerie — `pnpm --dir webview-ui test`
for the dropdown binding/save, `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <files>`
no suppression increase, and the extension-host round-trip test that the saved tier reaches
`getStateToPostToWebview()`.

---

## What the AGENT does vs what the OPERATOR must do

AGENT (edits/commits, and may run policy applies from the Mac):

- FEAT-001: edit `omniroute-routing.py`, commit, run `--apply` (model-capability overrides) with mgmt key.
- FEAT-002: edit `injection.ts` + tests, commit, run OmniRoute vitest/typecheck.
- FEAT-003: edit `omniroute-mode.py`, commit, run `tiered --apply` with mgmt key.
- FEAT-004: edit diagnostics log line (if taken), commit, run tests; execute read-only/live runtime probes with the inference key; apply the optional m5max `maxConcurrent` only if its probe passes.
- FEAT-005: edit OmniRoute resolver + menagerie UI/host, commit each repo, run both test suites.

OPERATOR (documented, agent does NOT run):

- Redeploy the OmniRoute instance from the 3.8.52 source so FEAT-002's source fix (and FEAT-005's
  resolver) run in production. Immediate pre-redeploy mitigation for C:
  `OMNIROUTE_STRICT_SYSTEM_PROVIDERS=vllm,ollama-local,ollama,llama-cpp,llamacpp` in the instance env
  then restart `omniroute serve`.
- No esnixi `nixos-rebuild switch` is required for B (already deployed). If any esnixi file is touched
  for another reason, the usual `ssh celes@192.168.42.254 'cd ~/sources/celesrenata/nix-flakes-refactored && sudo nixos-rebuild switch --flake .#esnixi'` applies — OPERATOR-only.

## Open items / assumptions (not blockers)

- Failure A's exact empty-output signature was not reproducible from retained logs; FEAT-004 adds the
  observability to classify the next occurrence and keeps the injection hypothesis re-openable. The
  balanced variant's `max_input_tokens=65536` is treated as an intentional reservation (not raised).
- FEAT-005's tier→MODES mapping (1=local-only, 2=local-free, 3=local-light-paid, 4/5=cloud tiers,
  5=tiered) is confirmed against `omniroute-mode.py MODES`; the exact header-to-pool expansion in
  OmniRoute is implemented at the `requestControls` layer where `X-OmniRoute-Mode`/`-Budget` already live.
