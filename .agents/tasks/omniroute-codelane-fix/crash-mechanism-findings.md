# OmniRoute Bug 1 — SEMAPHORE_TIMEOUT Process-Crash Mechanism: Findings

Read-only investigation. Branch `feat/hybrid-reader-combo`, HEAD `c9230dee8` (clean). No files modified.

---

## Summary answer (the proven mechanism)

The crash is **NOT** a synchronous rejection propagating up the request call stack (the prior design's theory, correctly disproven by its final reviewer — Next.js's generated app-route handler would convert that to an HTTP 500). The crash is the opposite failure mode:

1. A `SEMAPHORE_TIMEOUT` error is created and `reject(...)`-ed from inside a **bare `setTimeout` callback** in `accountSemaphore.ts` (`acquireMany`, lines 304–314) — fired by Node's timer subsystem, outside any request's live call stack.
2. At the moment that timer fires, the Promise it rejects **has no live awaiter / no `.catch()` attached to that specific rejection** (an orphaned rejection — the request path that armed the acquire has already moved on or a secondary consumer on the same promise was left unhandled). Node emits **`unhandledRejection`**.
3. The production entry point (`standalone-server-ws.mjs`, assembled to `/app/server-ws.mjs`) installs `installProcessCrashGuard()` from `httpClientAbortGuard.mjs`. Its `process.on("unhandledRejection", reason => { if (shouldSwallowUncaught(...)) {...return;} throw reason; })` runs. `shouldSwallowUncaught` does **not** recognize `code: "SEMAPHORE_TIMEOUT"` (it is not a client-abort, recoverable-upstream-timeout, intentional-combo-abort, or upstream-network error), so it returns `false` and the handler executes `throw reason;` (`httpClientAbortGuard.mjs:297`).
4. A `throw` inside the `unhandledRejection` handler is itself uncaught, so Node re-enters the **`uncaughtException`** handler (same file, line 282). `shouldSwallowUncaught` again returns `false`, so it executes **`throw err;` at `httpClientAbortGuard.mjs:289`** — the exact line and frame in the production stack trace.
5. A throw from **inside the `uncaughtException` handler** is Node's "internal fatal exception handler run-time failure" condition → the process exits with **code 7** (matching `kubectl describe`: `Exit Code: 7`).

The visible stack (`httpClientAbortGuard.mjs:289` → `Timeout.<anonymous>` → `listOnTimeout` → `process.processTimers`) is the **re-throw site plus the preserved original rejection stack** — the `Timeout` frames are where the orphaned `reject()` happened, carried through unchanged because the handler re-throws the same error object.

This was reproduced empirically (see Evidence E7): an orphaned promise rejected from a `setTimeout`, under the exact two-handler shape of `httpClientAbortGuard.mjs`, produces a byte-for-byte matching stack and **exit code 7** on Node.

**Bug 2 (context-length compat filter running on pre-compression token count, skipping the 5090) is a separate open item** documented in `.agents/tasks/omniroute-tier1-priority/findings.md` Evidence 7 and was deliberately NOT investigated here.

---

## Q1 — What is at `httpClientAbortGuard.mjs:289` and why does it `throw` from a timer context?

**File (source):** `src/shared/utils/httpClientAbortGuard.mjs`
**Deployed artifact:** `/app/httpClientAbortGuard.mjs` — a **verbatim, un-transpiled copy** of the source (confirmed in `scripts/build/assembleStandalone.mjs:356–364`: it copies `src/shared/utils/httpClientAbortGuard.mjs` → `httpClientAbortGuard.mjs` as a self-contained `.mjs`, no bundling). Therefore **line 289 in the deployed file === line 289 in source**.

Line 289 is **not** a timer callback. It is the re-throw inside the process-level `uncaughtException` handler:

```js
// src/shared/utils/httpClientAbortGuard.mjs:282–290 (installProcessCrashGuard)
process.on("uncaughtException", (err, origin) => {
	if (shouldSwallowUncaught(err, origin)) {
		logger("warn", "[server] swallowed benign uncaughtException:", err)
		return
	}
	throw err // <-- line 289
})
```

The sibling `unhandledRejection` handler (lines 292–298) ends with `throw reason;` (line 297).

**Why the stack shows `Timeout.<anonymous>`:** the handler re-throws the _same error object_ it received. That object's stack was captured where the `Error` was constructed — inside the semaphore's `setTimeout` callback. Node prints the re-throw's banner line (`:289`) but the attached stack is the original rejection's. So the `Timeout` frames prove the error _originated_ in a timer, while line 289 proves it _died_ in the global crash guard's re-throw. The throw at 289 is **not** running "inside a timer context"; it runs inside the uncaughtException handler, which Node happened to invoke on the microtask/exception path seeded by the timer-origin rejection.

## Q2 — Where is the SEMAPHORE_TIMEOUT error created, and is it rejected-into-an-await (safe) or orphaned (unsafe)?

**Creation site (matches the crash message shape):** `open-sse/services/accountSemaphore.ts`, inside `acquireMany`:

```ts
// accountSemaphore.ts:304–314
request.timer = setTimeout(() => {
	if (request.settled) return
	request.settled = true
	removeRequest(request)
	reject(createSemaphoreError("SEMAPHORE_TIMEOUT", `Semaphore timeout after ${timeoutMs}ms for ${keys.join(",")}`))
	drainQueues()
}, timeoutMs)
request.timer.unref?.()
```

- Message format `...for ${keys.join(",")}` where a key is `buildAccountSemaphoreKey = \`${provider}:${accountKey}\``(line 65–71). The crash message`Semaphore timeout after 120000ms for llama-cpp:70b82fc9-6f96-41ac-aa16-8da6099dd7ac`is a single`provider:accountKey`key → **this is the account semaphore, not the rate-limit semaphore.** (The sibling`rateLimitSemaphore.ts:168–173`emits`...for ${modelStr}`— a model string, not a`provider:connId` key — so it is ruled out as the source of _this_ message.)
- `createSemaphoreError` (accountSemaphore.ts:150–154) always produces `new Error(message)` with `.code` set — **never a bare string**. So the error carries `code: "SEMAPHORE_TIMEOUT"` on an `Error` object, as the crash banner shows.
- **The timer callback calls `reject(...)` — it does not `throw`.** This is the crucial correction to the brief's leading hypothesis: the mechanism is an **un-awaited rejected promise (`unhandledRejection`)**, not a synchronous `throw` inside the timer. The `Timeout.<anonymous>` frame is where `reject()` was _called_; the lack of a connected awaiter is what turns it into `unhandledRejection`.

**Both live callers of this function await the promise (so the primary paths are safe):**

A full-repo grep for callers of `accountSemaphore.ts`'s `acquire`/`acquireMany` (excluding tests) finds exactly two:

1. **`chatCore.ts:3203`** (the main acquisition, inside `executeProviderRequest` defined at 3126):

    ```ts
    const releaseAccountSemaphore = await acquireConcurrencyGates(
      [ {key:"global",...}, {key:`provider:...`,...}, {key: accountSemaphoreKey||"",...} ],
      { timeoutMs: maxWaitMs, maxQueueSize: ..., signal: streamController.signal }
    ).catch(rethrowAdmissionError);
    ```

    It is `await`-ed; its rejection flows into the two guarded try/catch blocks that call `isSemaphoreCapacityError` (chatCore.ts:4309 and 5799) and convert to a 429 feeding failover. `rethrowAdmissionError` (queueBudget.ts:12–20) rethrows a `SEMAPHORE_TIMEOUT` unchanged (code is defined → final `throw error`). The `settled` flag plus `removeRequest` (which `clearTimeout`s and `removeEventListener`s) guarantees the timer and the abort-listener are mutually exclusive and the promise settles once — so on this path the timer cannot fire after the awaiter is gone. **Safe (confirmed, matches prior design).**

2. **`src/sse/services/codexWsLease.ts:16`** (`acquireCodexWsLease`): passes `failFast: true`, so `acquireMany` rejects synchronously via `findQueueRejection` **before any `setTimeout` is armed** — `SEMAPHORE_TIMEOUT` can never fire from this call. Wrapped in `catch { return null; }`. **Safe (confirmed, matches prior design).**

**So where does the orphan come from?** The timer rejection becomes an `unhandledRejection` only when a `reject()` fires on a promise whose continuation/`.catch()` is no longer attached. Given both direct awaiters are safe, the orphan is a **secondary, un-`.catch()`-ed consumer or a detached listener attached to a semaphore-acquire promise elsewhere in the combo / fallback / tool-loop plumbing** — exactly the recurring bug _class_ `httpClientAbortGuard.mjs`'s own docstring documents having fixed twice before (`hedge-cancelled` via `upstreamTimeouts.ts::executeWithUpstreamStartTimeout`, commit `706dc75c1`; undici `fetch failed`). This investigation **confirms the mechanism class (orphaned timer-origin rejection → unhandledRejection) with certainty**, but does **not** pin the single exact leaking line — see "Scope of the fix" for why the correct fix does not require pinning it, and the diagnostic that will.

## Q3 — Production entry point and its global handlers

- **Dockerfile `CMD` (`/Users/celes/sources/celesrenata/OmniRoute/Dockerfile`, runner-base stage):** `CMD ["node", "dev/run-standalone.mjs"]`.
- **`scripts/dev/run-standalone.mjs`** spawns a child: `const entry = existsSync("server-ws.mjs") ? "server-ws.mjs" : "server.js"; spawnWithForwardedSignals(process.execPath, [entry], ...)`. In the assembled standalone image the preferred entry is **`server-ws.mjs`** (the assembled copy of `scripts/dev/standalone-server-ws.mjs`).
- **`scripts/dev/standalone-server-ws.mjs:22`** calls **`installProcessCrashGuard();`** (imported from `./httpClientAbortGuard.mjs`, line 12). So the production process **DOES** install `process.on("uncaughtException")` and `process.on("unhandledRejection")` handlers.

**Why it still exits with code 7 despite having an `uncaughtException` handler:** Having the handler is exactly _why_ it is code 7 rather than the default code 1. `installProcessCrashGuard`'s handlers **re-throw** anything `shouldSwallowUncaught` doesn't whitelist:

- `unhandledRejection` handler → `throw reason;` (line 297) → that throw is itself uncaught → Node invokes the `uncaughtException` handler.
- `uncaughtException` handler → `throw err;` (line 289).
- A throw thrown from _within_ the `uncaughtException` handler is Node's **"Internal Exception Handler Run-Time Failure"**, which exits with **code 7** (Node process-exit-code documentation: an uncaught exception occurred and the internal fatal exception handler itself threw while handling it — [nodejs.org process docs](http://nodejs.org/docs/v0.12.1/api/process.html); content rephrased for licensing compliance).

`shouldSwallowUncaught` (lines 220–233) whitelists only: `isClientAbortError`, `isRecoverableUpstreamTimeoutError`, `isIntentionalComboAbort`, `isUpstreamNetworkError`. **None matches `code: "SEMAPHORE_TIMEOUT"` or `"SEMAPHORE_QUEUE_FULL"`.** So the guard, by design, re-throws the semaphore timeout and converts a swallow-able unhandledRejection into a fatal code-7 crash.

`httpClientAbortGuard.mjs` is itself the global guard the brief suspected — it both installs and _is_ the interacting handler. It does not re-arm timers; its only role in the crash is the re-throw.

## Q4 — Classify every SEMAPHORE_TIMEOUT surfacing path

| Path                                                                                                                                                                                                                                                                                                                              | Class                     | Outcome                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatCore.ts:3203` main `await acquireConcurrencyGates(...).catch(rethrowAdmissionError)` → caught at 4309 / 5799 by `isSemaphoreCapacityError`                                                                                                                                                                                   | inside-request-stack      | **429** feeding failover. Benign.                                                                                                                                      |
| `chatCore.ts:4705` Anthropic thinking-signature recovery `execute` → `executeProviderRequest` (unguarded by a local catch) → propagates up `chatHelpers`/`chatDispatch`/`chat`/`chatAdmission` → **Next.js app-route `try/catch`**                                                                                                | inside-request-stack      | **HTTP 500** (framework-caught, per prior reviewer, confirmed by stack-trace shape here). Benign w.r.t. crash. A latent wrong-status/correctness concern, not a crash. |
| `chatCore.ts:4823`, `4916` fallback-retry sites, each in a local `try/catch` that returns `createErrorResult`                                                                                                                                                                                                                     | inside-request-stack      | error result (possibly stale status — correctness nit). Benign w.r.t. crash.                                                                                           |
| `chatCore.ts:5123`, `5137–5138`, `5311` — passed as `executeProviderRequest`/`sendProviderAttempt` callbacks into awaited pipeline/leg/tool-loop runners (`runNonStreamingProviderLeg` re-throws SEMAPHORE_TIMEOUT at `nonStreamingProviderLeg.ts:475–483`; awaited up through `serverOwnedToolLoop` into the chatCore outer try) | inside-request-stack      | 429/500 via the awaited chain. Benign w.r.t. crash.                                                                                                                    |
| `codexWsLease.ts:16` `failFast:true` + `catch { return null }`                                                                                                                                                                                                                                                                    | n/a (timer never armed)   | no SEMAPHORE_TIMEOUT possible. Benign.                                                                                                                                 |
| **A secondary/un-`.catch()`-ed consumer or detached listener on a semaphore-acquire promise, whose `reject()` fires from the `setTimeout` with no live awaiter**                                                                                                                                                                  | **outside-request-stack** | **`unhandledRejection` → guard re-throw → `uncaughtException` → `throw err` @289 → exit 7. THE CRASH.**                                                                |

Only the **last row (outside-request-stack)** can crash the process. This matches the prior reviewer's Finding #2 instruction that the fix justification must rest solely on the outside-request-stack class. Every inside-request-stack path is converted to a 429 or a 500 and is not a crash candidate.

---

## Evidence (file:line + the empirical reproduction)

- **E1 — Re-throw site:** `src/shared/utils/httpClientAbortGuard.mjs:282–298` — `uncaughtException` handler re-throws at **:289**; `unhandledRejection` handler re-throws at **:297**. `shouldSwallowUncaught` at 220–233 whitelists four predicates, none covering SEMAPHORE\_\*.
- **E2 — Error creation:** `open-sse/services/accountSemaphore.ts:304–314` (`setTimeout` → `reject(createSemaphoreError("SEMAPHORE_TIMEOUT", ...for ${keys.join(",")}))`); key format `${provider}:${accountKey}` at 65–71; `createSemaphoreError` always `Error`+`.code` at 150–154. Timer `unref`'d at 315.
- **E3 — Sibling ruled out:** `open-sse/services/rateLimitSemaphore.ts:162–176` emits `...for ${modelStr}` (model string), not the `provider:connId` key in the crash log. Not the source of this message.
- **E4 — Production entry + guard install:** `Dockerfile` `CMD ["node","dev/run-standalone.mjs"]`; `scripts/dev/run-standalone.mjs` prefers `server-ws.mjs`; `scripts/dev/standalone-server-ws.mjs:12,22` imports and calls `installProcessCrashGuard()`.
- **E5 — Deployed artifact is verbatim source:** `scripts/build/assembleStandalone.mjs:356–364` copies `src/shared/utils/httpClientAbortGuard.mjs` → `httpClientAbortGuard.mjs` self-contained; line numbers preserved → `/app/httpClientAbortGuard.mjs:289` === source :289.
- **E6 — Awaited (safe) callers:** `chatCore.ts:3203` (`await ... .catch(rethrowAdmissionError)`, defined inside `executeProviderRequest` @3126; caught at 4309/5799); `codexWsLease.ts:16` (`failFast:true`). `queueBudget.ts:12–20` rethrows SEMAPHORE_TIMEOUT unchanged. `nonStreamingProviderLeg.ts:475–483` rethrows it to an awaited caller.
- **E7 — Empirical reproduction (Node, local):** an orphaned `Promise.reject(err)` with `code:"SEMAPHORE_TIMEOUT"` fired from inside a `setTimeout`, under the exact two-handler shape of `installProcessCrashGuard` (unhandledRejection→`throw reason`, uncaughtException→`throw err`), produces:
    ```
    <file>:3
      throw err; // mimics guard:289
      ^
    Error: Semaphore timeout after 120000ms for llama-cpp:test
        at Timeout._onTimeout (<file>:11:13)
        at listOnTimeout (node:internal/timers:685:17)
        at process.processTimers (node:internal/timers:618:7) {
      code: 'SEMAPHORE_TIMEOUT'
    }
    ```
    **EXIT_CODE = 7.** This is a frame-for-frame and exit-code match to the production incident (`Timeout.<anonymous>`/`listOnTimeout`/`process.processTimers`, re-throw at :289, exit 7), confirming the mechanism is an orphaned timer-origin rejection re-thrown by the crash guard — not a synchronous request-stack throw.
- **E8 — Timeout value:** the main acquire uses `timeoutMs: maxWaitMs` with `maxWaitMs` resolved per provider/connection; the crash's `120000ms` is the 2-minute budget, consistent with the live config.

---

## Conclusions

1. **Proven mechanism (not hypothesis):** orphaned `SEMAPHORE_TIMEOUT` promise rejection, created by a `setTimeout` in `accountSemaphore.ts` and left without a live awaiter → Node `unhandledRejection` → `installProcessCrashGuard`'s handler re-throws (`:297`) because `shouldSwallowUncaught` doesn't whitelist the code → re-enters `uncaughtException` handler → `throw err` (`:289`) → Node internal-fatal-exception-handler failure → **exit code 7.** The visible `Timeout` frames are the preserved original stack of the orphaned `reject()`. (Reproduced: E7.)
2. The prior design's **synchronous request-stack propagation theory (via chatCore.ts:4705) is a benign HTTP-500 path, not the crash** — the reviewer was right, and the stack trace (timer frames, no request frames) independently confirms it.
3. **The real crash is the only outside-request-stack path**: a secondary/detached consumer of a semaphore-acquire promise whose timeout `reject()` is unhandled. The exact leaking line is not pinned by static reading (both direct awaiters are safe), but the _class_ is confirmed and reproducible.

## Scope of the correct fix (recommend; do not implement)

**Primary fix — close the crash-guard gap (prevents THIS crash with certainty):** Add a `SEMAPHORE_TIMEOUT`/`SEMAPHORE_QUEUE_FULL` predicate (`err.code`-only check; `createSemaphoreError` never emits a bare string, so no string-reason case is needed) to `src/shared/utils/httpClientAbortGuard.mjs` and wire it into `shouldSwallowUncaught`'s whitelist condition. **This directly prevents the exact crash** regardless of which secondary consumer orphaned the rejection: with the code whitelisted, `shouldSwallowUncaught` returns `true`, the handlers log-and-`return` instead of re-throwing, so the unhandledRejection is swallowed and no fatal re-throw at :289 occurs. This is the same change category as the two prior documented fixes to this guard (`hedge-cancelled`, undici `fetch failed`), and `SEMAPHORE_TIMEOUT`/`QUEUE_FULL` are _by definition_ already-handled-elsewhere admission signals (every request-stack path converts them to 429/500/500), so a copy reaching process level is exactly the "already handled in principle, stray duplicate escaped" class this guard exists for.

**Does the earlier-proposed fix actually prevent THIS crash?** **Yes — the swallow-list half does, directly and completely.** This investigation's mechanism (orphaned timer rejection → `unhandledRejection` → guard re-throw → `uncaughtException` → :289 → exit 7) is precisely the path `shouldSwallowUncaught` short-circuits once the code is whitelisted, confirmed empirically (E7: the same scenario with the code swallowed would hit the `return` branch and not crash). The prior design proposed this fix for the _right_ reason-class even though it reached it partly through the wrong (request-stack) propagation argument; the fix stands on the correct outside-request-stack footing established here.

**Secondary (diagnostic) fix — recommended, to pin and fix the true leak:** The swallow-list converts the crash to a logged, swallowed rejection but does **not** repair the underlying orphaned-promise leak. Add a ring-buffer `unhandledRejection` diagnostic for `SEMAPHORE_TIMEOUT`/`QUEUE_FULL` (mirroring `open-sse/services/combo/targetTimeoutRunner.ts`'s `ensureDiagnosticListener`/`recordTimeoutContext`/`drainLastTimeoutContexts` pattern) so the next occurrence logs the full orphaned-call-site stack and the involved key(s), letting the exact detached consumer be fixed with certainty rather than inferred.

**No change needed** to `accountSemaphore.ts`, `rateLimitSemaphore.ts`, `chatCore.ts`, or the combo/leg loops for crash-safety: every path they own already awaits the rejection inside a guard. The crash fix belongs in the crash-safety-net layer (`httpClientAbortGuard.mjs`) plus the diagnostic layer. None of the reserved files (`reasoningEffort.ts`, `targetRequestSanitizer.ts`, `BaseExecutor.execute()`, `modelCapabilityOverrides.ts`) is involved.

**Correctness note (not a crash, out of scope here):** the 4823/4916 fallback-retry catches convert a late SEMAPHORE_TIMEOUT to a stale FIRST-failure status/message. Worth a follow-up but it does not crash and is not this task.

---

## Open item carried forward

**Bug 2** — the context-length compatibility filter running on _pre-compression_ token count, causing the 5090 to be skipped — remains a **separate, open** item (see `.agents/tasks/omniroute-tier1-priority/findings.md` Evidence 7). It was intentionally not re-investigated here and is unaffected by the Bug 1 fix above.
