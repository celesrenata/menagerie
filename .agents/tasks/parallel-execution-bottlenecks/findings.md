# Parallel Execution Bottlenecks — Findings Report

Read-only investigation into why Menagerie's parallel task execution serializes and times out. **No files were modified.** All citations are to `src/` in `/Users/celes/sources/celesrenata/menagerie`.

---

## Summary answer (the two root causes)

Two independent, confirmed root causes combine to produce the observed symptoms:

1. **The scheduler's inference-capacity layer is dead code at runtime.** `BoundedElasticScheduler` has a complete, correct `InferenceLeasePool` that would read live OmniRoute capacity and queue over-capacity generations — but `runParallelTasks.ts` **never calls `handle.acquireLease(...)`**. The only gate that actually runs is the dispatch semaphore (`maxDispatched`, default **8**). Worse, the capacity feed that *is* wired in (`GENEROUS_BATCH_ROUTES`) is a hard-coded stub that reports `available = 12` for every capability and `sustainedPressure = 0` always. So Menagerie will happily dispatch up to 8 concurrent code workers against a vLLM backend that has only ~2 real slots. The excess does **not** queue inside Menagerie — it is handed straight to OmniRoute, where it parks in the `[RATE-LIMIT]` queue. **This is why fan-out exceeds real backend capacity.**

2. **A client-side 300s stream-idle timeout aborts workers while they are legitimately queued at the provider.** `Task.ts` wraps every post-first-chunk `iterator.next()` in `awaitWithStreamTimeout(..., { timeoutMs: streamIdleTimeoutMs, phase: "between_chunks" })`, where `streamIdleTimeoutMs = getApiStreamIdleTimeout()` defaults to **300000ms**. A worker parked in OmniRoute's rate-limit queue (up to `remainingForQueue=300000ms`) produces no chunks, so this client timer fires at ~300s, throws `StreamIdleTimeoutError`, and calls `this.currentRequestAbortController?.abort(error)` — which propagates to the provider's forwarded `abortSignal` and closes the socket. **This is the `request_signal_aborted` / `client_disconnect` at ~333s and the "0 in / 0 out" zero-token worker failures.** The client gives up ~45 min before OmniRoute's `REQUEST_TIMEOUT_MS` would have let the request eventually run.

The two causes reinforce each other: cause #1 overcommits the backend (creating the queue), and cause #2 kills the queued workers before they drain, forcing the parent to redo work serially.

---

## Q1 — How does Menagerie size parallel fan-out?

**Answer: Fan-out is bounded by a fixed local ceiling (`maxDispatched`, default 8), clamped only downward by the user policy. It is NOT derived from any real backend-capacity signal. Over-capacity workers are NOT queued or blocked inside Menagerie — the dispatch permit is the only gate, and all dispatched workers are handed to OmniRoute concurrently, where the excess spills into OmniRoute's rate-limit queue.** CONFIRMED ROOT CAUSE.

### Evidence

Default bounds — `src/core/task/elasticTypes.ts`:
```ts
export const DEFAULT_SCHEDULER_BOUNDS: Pick<SchedulerBounds, "maxLive" | "maxDispatched"> = {
	maxLive: 12,
	maxDispatched: 8,
}
```
`SchedulerBounds.maxInferenceLeases` is documented as "Supplied by OmniRoute capacity, not a fixed local number" (same file, `SchedulerBounds` doc comment).

Scheduler construction — `src/core/task/runParallelTasks.ts` (`runParallelTasks`):
```ts
const scheduler = new BoundedElasticScheduler(
	{ ...DEFAULT_SCHEDULER_BOUNDS, maxInferenceLeases: DEFAULT_SCHEDULER_BOUNDS.maxDispatched },
	policy,
	GENEROUS_BATCH_ROUTES,
)
```
So `maxInferenceLeases` is seeded from `maxDispatched` (8) — a local number, exactly the "stand-in" the brief flagged.

The two gates — `src/core/task/BoundedElasticScheduler.ts` constructor:
```ts
this.bounds = {
	maxLive: clampCeiling(bounds.maxLive, policy.maxLive),
	maxDispatched: clampCeiling(bounds.maxDispatched, policy.maxDispatched),
	maxInferenceLeases: bounds.maxInferenceLeases,
}
this.dispatchSemaphore = new TaskSemaphore(this.bounds.maxDispatched)
```
`clampCeiling` only ever *lowers* the bound by the policy and floors at 1; it never raises it based on backend capacity. The dispatch semaphore size = `maxDispatched` (8).

Admission — `BoundedElasticScheduler.dispatch(...)`:
```ts
const release = await this.dispatchSemaphore.acquire()
...
try {
	await run(this.makeHandle(worker))
} finally {
	release()
}
```
Over-capacity workers **queue on the dispatch semaphore, never rejected** (confirmed by doc comment "over-capacity workers queue, never rejected — PAR-011.1"). But this queue bounds *dispatched* count at 8, not the number sent to the backend concurrently.

**The decisive gap: `acquireLease` is never called.** A repo-wide search for `acquireLease` returns matches only inside `BoundedElasticScheduler.ts` itself (the `DispatchHandle` interface declaration at line 38 and the `makeHandle` implementation at line 721). The `run` callback passed to `scheduler.dispatch(spec.name, async () => { ... })` in `runParallelTasks.ts` creates the workspace, runtime, broker, and calls `waitForParallelTask(child, ...)` — but **never invokes `handle.acquireLease(...)`**. The `DispatchHandle` argument to `run` is not even bound to a parameter name in `runParallelTasks.ts`. Therefore the entire per-generation inference-lease state machine (`waiting-for-inference` → `generating` → `runnable`, priority ordering, critical-path tiebreak) does not execute in the real run.

**Conclusion for Q1:** Yes — Menagerie can and does fan out more concurrent workers (up to 8 code workers) than the backends have real slots (~2 on vLLM). The excess is not queued or throttled inside Menagerie; it is dispatched to OmniRoute concurrently, and OmniRoute's `[RATE-LIMIT]` queue absorbs the overflow (matching the ~15 rate-limit events in 30 min). The dispatched count is driven by the fixed ceiling (8) clamped by the user policy — **never by a real backend-capacity signal.**

---

## Q2 — Is there a live capacity feed?

**Answer: No. No live OmniRoute capacity feed is threaded into the batch run. The `RouteCapacityProvider` the scheduler receives is a hard-coded stub (`GENEROUS_BATCH_ROUTES`) that always reports full availability and zero pressure. Even if `acquireLease` were called, it would read fabricated capacity.** CONFIRMED ROOT CAUSE (compounding Q1).

### Evidence

`src/core/task/runParallelTasks.ts`, the provider wired into the scheduler:
```ts
const GENEROUS_BATCH_ROUTES: RouteCapacityProvider = {
	capacitiesFor(capability: RouteCapability): readonly RouteCapacity[] {
		return [
			{
				route: `local:${capability}`,
				capability,
				capacity: DEFAULT_SCHEDULER_BOUNDS.maxLive,     // 12
				available: DEFAULT_SCHEDULER_BOUNDS.maxLive,     // 12
			},
		]
	},
	sustainedPressure(): number {
		return 0
	},
}
```
Its own doc comment states the design intent explicitly: *"...does not yet thread a live OmniRoute capacity feed through the child agent loops ... Until that feed exists, the scheduler must still admit and dispatch every useful worker, so this provider reports generous capability-only capacity and no sustained pressure."* This is the "stand-in until a live OmniRoute capacity feed is threaded through the child loops" the brief quoted — it is **confirmed still a stand-in**, not yet implemented.

Downstream consumers that are thereby neutralized:
- `InferenceLeasePool.liveCapacity()` (`src/core/task/InferenceLeasePool.ts`) sums `snapshot.available` → always 12. Combined with Q1 (never called), the lease pool never limits anything.
- `BoundedElasticScheduler.shouldAdmitNewFanOut()` returns `this.routes.sustainedPressure() < 0.8` → `0 < 0.8` → **always `true`**, so backpressure never throttles reader-swarm / speculative / work-stealing fan-out either.

**Conclusion for Q2:** The scheduler is flying blind on backend concurrency. The capacity abstraction exists and is well-formed, but it is fed constant, fabricated values and the lease side is never exercised.

---

## Q3 — Where is the client-side timeout causing the ~333s abort?

**Answer: `getApiStreamIdleTimeout()` (default 300000ms = 300s) enforced per-chunk in `Task.ts`. When a queued worker produces no stream chunk for 300s, `StreamIdleTimeoutError` is thrown and the request's `AbortController` is aborted, closing the socket. 300s matches the observed ~333s `request_signal_aborted` / `client_disconnect`.** CONFIRMED ROOT CAUSE.

### Evidence

Timeout values — `src/api/providers/utils/timeout-config.ts`:
```ts
const DEFAULT_TIMEOUT_SECONDS = 600          // getApiRequestTimeout(): first-chunk wait = 600s
...
const DEFAULT_STREAM_IDLE_SECONDS = 300      // getApiStreamIdleTimeout(): between-chunks = 300s
```
`getApiStreamIdleTimeout()` returns `Math.round(seconds * 1000)` → **300000ms** by default (config key `zoo-code.apiStreamIdleTimeout`; `0` disables it). `getApiRequestTimeout()` → **600000ms** by default (config key `zoo-code.apiRequestTimeout`).

Enforcement in the main agent loop — `src/core/task/Task.ts` (~lines 3578–3605):
```ts
const streamIdleTimeoutMs = getApiStreamIdleTimeout()
...
const nextChunk = (timeoutMs: number) =>
	awaitWithStreamTimeout(iterator.next(), {
		signal: this.currentRequestAbortController?.signal,
		timeoutMs,
		phase: "between_chunks",
	})

let item = await nextChunk(0)                 // first chunk: no idle timer (bounded by attemptApiRequest)
while (!item.done) {
	const chunk = item.value
	item = await nextChunk(streamIdleTimeoutMs)  // every subsequent chunk: 300s idle cap
	...
}
```

The timer — `src/core/task/streamIdleTimeout.ts`, `awaitWithStreamTimeout`:
```ts
if (timeoutMs > 0) {
	timer = setTimeout(() => settle(() => reject(new StreamIdleTimeoutError(phase, timeoutMs))), timeoutMs)
}
```

The abort on timeout — `src/core/task/Task.ts` (~lines 4014–4021):
```ts
} catch (error) {
	if (error instanceof StreamIdleTimeoutError) {
		// Close the stalled socket and the provider generator...
		this.currentRequestAbortController?.abort(error)
		void stream.return(undefined).catch(() => {})
	}
```
(The first-chunk path has the same handling at ~lines 5386–5396.)

The abort reaches the backend — the request's signal is forwarded to the provider. `src/core/task/Task.ts` builds the API-request metadata with `abortSignal: this.currentRequestAbortController.signal` (e.g. ~line 2166), and `src/api/providers/openai.ts` (`OpenAiHandler`, the handler OmniRoute uses — see Q4) forwards it:
```ts
private requestOptions(isAzureAiInference: boolean, signal?: AbortSignal): OpenAI.RequestOptions {
	return {
		...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
		...(signal ? { signal } : {}),
	}
}
```
Doc comment on `requestOptions`: *"Forwarding the task's abort signal lets a stream timeout close the socket; OmniRoute is assumed to cancel the upstream request on client disconnect."*

**Conclusion for Q3:** The client-side cap is **300s (`apiStreamIdleTimeout`, default 300000ms)**, applied between stream chunks in the Task loop. OmniRoute's server-side `STREAM_IDLE_TIMEOUT_MS` is also 300000ms, but the **client fires first** because *queue-wait at OmniRoute counts as "no chunk received" on the client* — a worker parked in the rate-limit queue is streaming nothing, so the client's between-chunks timer runs the entire 300s and aborts. This kills workers that OmniRoute's 45-min `REQUEST_TIMEOUT_MS` would eventually have serviced. The ~333s observed = 300s idle timer + teardown/jitter.

Note: `getApiStreamIdleTimeout()` is also enforced in `src/core/condense/index.ts` (the condense LLM call), so a large condense request parked in queue is subject to the same 300s abort.

---

## Q4 — How are workers routed to backends?

**Answer: A worker's model id is a pure pass-through chosen by role: readers → `openAiOmniRouteReaderRouteId` (9B/ollama lane), everything else (code + tester + research) → `openAiOmniRouteReasonerRouteId` (the single 27B vLLM). So all non-reader workers in a batch resolve to the SAME route id and land on the SAME vLLM backend, where they serialize behind its ~2 slots while the ollama-local 9B's 4 slots sit idle. The capability-lane layer that could spread them exists but is a pure/sidecar helper not wired into dispatch routing.** CONFIRMED ROOT CAUSE for the "vLLM is the bottleneck while ollama idles" symptom.

### Evidence

Model-id resolution at dispatch — `src/core/task/runParallelTasks.ts`:
```ts
context.apiConfiguration.openAiModelId = resolveWorkerModelId(
	spec.route,
	spec.mode,
	context.apiConfiguration,
	parent.apiConfiguration.openAiModelId,
)
```

`resolveWorkerModelId` + `roleDefault` — `src/core/task/parallelWorkerRouting.ts`:
```ts
export const READER_MODES: ReadonlySet<string> = new Set(["project-reader"])

export function roleDefault(mode: string, profile: ProviderSettings): string | undefined {
	return READER_MODES.has(mode) ? profile.openAiOmniRouteReaderRouteId : profile.openAiOmniRouteReasonerRouteId
}

export function resolveWorkerModelId(route, mode, workerProfile, parentModelId): string | undefined {
	if (route) return route
	const ownModelId = workerProfile.openAiModelId
	if (ownModelId && ownModelId !== parentModelId) return ownModelId
	return roleDefault(mode, workerProfile) ?? parentModelId
}
```
Only `project-reader` is a reader mode. Every code/tester worker (and `project-research`, which the comment notes is deliberately NOT a reader mode) resolves to the **single `openAiOmniRouteReasonerRouteId`** unless each has an explicit per-worker `route` or its own distinct profile model. With N code workers and no explicit per-worker routes, all N get the same route id → OmniRoute places them all on the one vLLM → they serialize behind vLLM's `maxConcurrent 2` (effectively 1 per the live logs).

**The lane layer exists but does not drive dispatch routing.** `parallelWorkerRouting.ts` defines `assignLane` / `assignLanes` / `LaneAssignment` and `laneToRouteCapability`, and `produceDeeperLaneFollowUp` — all documented as *"pure and synchronous ... performs no scheduler dispatch and no leasing"*. The resolved `RouteCapability` is intended to be "what the scheduler / InferenceLeasePool consume," but since the lease pool is never invoked (Q1) and the per-worker route id is a role pass-through (above), lane capability never influences which backend connection a dispatched worker actually hits.

**Conclusion for Q4:** The fan-out does **not** spread same-category workers across the vllm / ollama-local / llama-cpp connections. Multiple code-category workers land on the single vLLM route and serialize there; the reader lane (9B/ollama) is the only separate lane, and it is used only by `project-reader` workers. The ~2 vLLM slots are the bottleneck while ollama-local's 4 slots sit idle for code work.

---

## Q5 — Prompt size / input bloat (context for a later fix, not fixed here)

**Answer: Individual tool reads ARE bounded (read_file defaults to 2000 lines / 2400-line batch budget; reader-swarm documents capped at 48 KiB). The 356k-token input is driven by ACCUMULATED conversation history — many tool results, environment-detail snapshots, and prior turns piling up — not by a single unbounded read. Auto-condense (default on, at 80% of the context window) is what produced the observed 356335→242913 compression. Environment details list up to 200 file *paths* (names, rooIgnore-filtered), not file contents.** CONTRIBUTING FACTOR (amplifies first-token latency and queue pressure; the trigger for condense, itself a large queued request subject to the Q3 abort).

### Evidence

read_file caps — `src/core/prompts/tools/native-tools/read_file.ts`:
```ts
export const DEFAULT_LINE_LIMIT = 2000
export const DEFAULT_BATCH_LINE_BUDGET = 2400
```
`src/core/tools/ReadFileTool.ts` applies these (`limit ?? DEFAULT_LINE_LIMIT`, `readWithSlice(...)`, truncation warnings with `wasTruncated` / `totalLines`). There is **no `maxReadFileLine` setting in this fork** (repo-wide search: no matches) — so reads are not user-tunable, but they ARE line-capped by the 2000/2400 defaults. (2000 lines of a dense file is still large, so repeated large reads accumulate.)

Reader-swarm document cap — `src/core/task/ParallelTaskReader.ts`:
```ts
const MAX_READER_DOCUMENT_BYTES = 48 * 1024
const MAX_READER_EXCERPT_CHARS = 10_000
...
if (!stat.isFile() || stat.size > MAX_READER_DOCUMENT_BYTES) continue
```
Reader workers ingest ≤48 KiB documents and emit ≤10k-char excerpts (also encoded in `READER_OUTPUT_BOUNDS` in `elasticTypes.ts`). So the 356k-token prompt is **not** coming from reader workers — it is a code/tester/orchestrator conversation.

Environment details list paths, not contents — `src/core/environment/getEnvironmentDetails.ts`:
```ts
const { maxWorkspaceFiles = 200 } = state ?? {}
...
.slice(0, maxWorkspaceFiles)        // visible files: path list, capped at 200
...
const maxTabs = maxOpenTabsContext ?? 20
...
const [files, didHitLimit] = await listFiles(cline.cwd, true, maxFiles)   // workspace file *names*, capped at 200
```
Paths are filtered through `rooIgnoreController`. These are file names, not bodies, so env details are a modest contributor, not the 356k driver. (Whether `rooIgnore` excludes `node_modules`/`.d.ts`/build artifacts depends on the workspace's ignore config, which this read-only pass did not enumerate.)

Condense trigger — `packages/types/src/global-settings.ts`:
```ts
export const DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT = 80
```
`src/core/webview/ClineProvider.ts` returns `autoCondenseContext: ... ?? true` and `autoCondenseContextPercent: ... ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT`. So auto-condense is on by default and fires at 80% of the context window — consistent with the live 356335→242913 compression event. The condense call itself (`src/core/condense/index.ts`) is a large LLM request that is **also** subject to the 300s stream-idle abort (Q3), so a condense request queued at a saturated backend can be killed the same way.

**Conclusion for Q5:** Input bloat is a real amplifier (bigger prompts → longer first-token latency → more time parked in queue → more likely to hit the Q3 abort, plus heavier VRAM/context pressure on vLLM), but the per-read and per-reader bounds are in place. The bloat is conversation-accumulation driven, managed only reactively by condense at 80%. Not a primary root cause of serialization; it worsens the queue/timeout dynamics the other causes create.

---

## Prioritized fix targets (NOT implemented here)

### (a) Menagerie code fixes

1. **[Highest] Raise or disable the client-side stream-idle timeout for queued-at-provider waits** — `src/core/task/Task.ts` (the `nextChunk(streamIdleTimeoutMs)` loop) and `src/api/providers/utils/timeout-config.ts` (`DEFAULT_STREAM_IDLE_SECONDS = 300`). Change class: configuration + semantics. The current 300s between-chunks cap cannot distinguish "backend hung" from "my request is legitimately queued." Options: raise `apiStreamIdleTimeout` default toward/above OmniRoute's 45-min `REQUEST_TIMEOUT_MS`, make it 0 (disabled) when talking to OmniRoute, or thread a "queued, not idle" signal so queue-wait doesn't count against the idle timer. This single change stops the ~333s worker kills.

2. **[High] Wire real backend capacity into the scheduler and stop over-dispatching** — `src/core/task/runParallelTasks.ts` (`GENEROUS_BATCH_ROUTES` stub and the un-invoked `acquireLease`). Change class: implement the deferred feature. Replace the constant stub with a `RouteCapacityProvider` backed by an actual OmniRoute capacity query, and call `handle.acquireLease(capability, signal)` around each generation inside the `scheduler.dispatch(...)` run body (release in `finally`). This makes `InferenceLeasePool` (already correct) and `shouldAdmitNewFanOut` actually gate work so excess generations queue *inside Menagerie* instead of spilling into OmniRoute's rate-limit queue.

3. **[High] Spread same-category workers across available backends** — `src/core/task/parallelWorkerRouting.ts` (`roleDefault` / `resolveWorkerModelId`) and the dispatch site in `runParallelTasks.ts`. Change class: routing logic. Today all non-reader workers resolve to the single `openAiOmniRouteReasonerRouteId`. Either (a) have the mastermind assign explicit per-worker `route`s across the GLM/IQ3 overflow and other code-capable connections, or (b) connect the existing capability-lane assignment to the dispatched route id so code workers distribute across backends rather than all landing on vLLM.

4. **[Medium] Make `maxDispatched` / inference ceiling reflect real slots** — `src/core/task/elasticTypes.ts` (`DEFAULT_SCHEDULER_BOUNDS.maxDispatched = 8`, `maxInferenceLeases` seeding in `runParallelTasks.ts`). Change class: config derived from capacity. Once #2 exists, seed `maxInferenceLeases` from the live capacity sum (~7 total, ~2 vllm) instead of `maxDispatched`.

5. **[Lower] Proactive context trimming for parallel workers** — `src/core/environment/getEnvironmentDetails.ts`, `src/core/tools/ReadFileTool.ts` (no `maxReadFileLine` exists), and condense policy in `src/core/condense/index.ts`. Change class: input-scope tightening. Consider a smaller default read limit or a per-worker context budget so prompts stay well below the 356k range and condense (itself abort-prone) fires less often.

### (b) Cluster / OmniRoute-config changes (applied by the user on the remote host, `~/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py`)

1. **Reduce `remainingForQueue` / rate-limit park duration below the client's idle timeout, OR return a fast "retry-later" instead of silently parking** — the 300000ms (5-min) queue park exactly equals the client's 300s idle timeout, so every parked request races the client abort and usually loses. Parking shorter (or streaming keepalive/heartbeat chunks while queued) would keep the client's between-chunks timer from expiring.

2. **Raise vLLM real concurrency if VRAM allows** — `PROVIDER_POLICIES` vllm `maxConcurrent 2` with a "slow overflow" 2nd slot means effectively 1 concurrent 27B request. If the RTX 5090 can hold a second active sequence at the chosen quant, increasing effective `maxNumSeqs`/concurrency directly widens the bottleneck.

3. **Route some code-capable work off vLLM** — since reader lanes already use ollama-local's 4 slots and the GLM/IQ3 overflow exists, biasing OmniRoute to place a share of code/tester generations on the overflow/ollama-capable routes would stop concentrating all code work on the single vLLM.

---

## What could not be determined from the code

- **Exact mastermind-requested worker counts per batch.** The dispatched count is bounded by `maxDispatched`/policy, but the actual number of specs the mastermind emits per batch is a runtime decision not fixed in the files read; whether real batches hit the 8 ceiling or stay under it is not determinable statically.
- **Whether `rooIgnore` excludes `node_modules`/`.d.ts`/build artifacts in this workspace.** `getEnvironmentDetails` and `ParallelTaskReader` filter through `rooIgnoreController`, but the effective ignore set depends on the workspace's `.rooignore`, which was not enumerated in this read-only pass.
- **The precise composition of the 356k-token prompt.** It is confirmed to be an accumulated non-reader conversation (readers are 48 KiB-bounded), but the per-source breakdown (how much is tool results vs. system prompt vs. prior turns) is a runtime property not recoverable from source alone.
- **OmniRoute's actual capacity-query surface.** Fix (a)#2 assumes OmniRoute exposes a capacity/pressure endpoint to back a real `RouteCapacityProvider`; the shape of that endpoint lives in the remote `omniroute-mode.py`, which this investigation treated as read-only external context and did not inspect in detail.

*Content from the live-log excerpts and remote config in the brief was treated as provided evidence and correlated against the code; it was rephrased for compliance.*
