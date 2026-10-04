# Byte-stable request history for GLM-5.3 prefix-cache reuse

Commit e980c9efb removes the per-request `<environment_details>` compaction from `Task.attemptApiRequest`. Every earlier snapshot now goes out verbatim, and compaction runs only at condense time (`condense/index.ts:339`). It also makes `OpenAiHandler.getModel()` default `preserveReasoning: true` for OmniRoute profiles. `buildCleanConversationHistory` then keeps plain-text reasoning blocks, and `convertToOpenAiMessages` emits them as `reasoning_content`. Together these close the two Zoo-side prefix breakers from the root-cause report (breakers 3 and 4). A new Task-level test drives two real `attemptApiRequest` calls through a real OmniRoute `OpenAiHandler`. It asserts that turn N's wire messages are a byte-for-byte prefix of turn N+1's. The coder ran that test against the old code and it failed in exactly the pattern the report describes.

Watch for: reasoning_content now goes to every backend OmniRoute routes to, including cloud ones (possible). Context also grows faster, because reasoning and stale env snapshots stay until condense (confirmed, an accepted trade-off). Even with this commit, the end-to-end KV hit rate depends on the two OmniRoute-side breakers (memory injection and Lite `compressToolResults`), which are outside this diff.

**Verdict**: APPROVED

## High-level view

The env-details change is a one-line removal in the request path. `compactHistoricalEnvironmentDetails` has one remaining caller, condense-time summarization (`keepLatest=false`), and its doc comment forbids request-path use. The change applies to every profile with no setting. That matches upstream Roo behavior, so it is not a new divergence for non-OmniRoute users.

The reasoning change is an overlay in `getModel()`. It sets `preserveReasoning` to true only when the profile is OmniRoute (openai provider with `openAiIsOmniRoute`) and the custom model info leaves the flag unset. An explicit `false` still wins. `Task` reads the flag through `requestModelInfo`, which is resolved from the handler's model info, so the overlay reaches `buildCleanConversationHistory`. The fixture's stored reasoning block shape (`{type:"reasoning", text, summary:[]}`) matches what `prepareAssistantMessage` actually persists, so the test uses the production storage shape.

The coder audited the other per-turn rewrites and either fixed or documented them. The ones left are one-time by design (condense, resume trim), gated off for this profile (`supportsPromptCache` cache_control moving), rare (`mergeConsecutiveApiMessages` after an empty-response retry), or server-side in OmniRoute. Verification evidence covers vitest (321 tests across the three touched suites), `tsc --noEmit`, eslint with `--prune-suppressions`, and suppression counts (no increase). I did not re-run any of it.

<details>
<summary>Issues (3)</summary>

1. **reasoning_content to non-GLM OmniRoute backends** (possible): the default applies to every OmniRoute route, including cloud backends that may reject or bill for `reasoning_content` in assistant history. Confirm that OmniRoute strips or translates the field for non-reasoning providers, or scope the default to the reasoning combos.
2. **Faster context growth** (confirmed, non-blocking): reasoning tokens and every earlier env snapshot (including the first-turn file listing) now stay in context until condense, so condense will trigger sooner on long tasks. Accept this as the cached-token trade-off, or follow up later with condense-threshold tuning.
3. **OmniRoute breakers still gate the outcome** (confirmed, out of scope): memory-context re-ranking and Lite tool-result truncation still diverge earlier than anything Zoo controls. Fix them in OmniRoute before measuring the ds4 live-KV hit rate.

</details>

<details>
<summary>Details</summary>

### Env-details compaction moved out of the request path

The removed `compactHistoricalEnvironmentDetails(messagesSinceLastSummary)` call was the breaker in Pair A/B of the report. Turn N's trailing env-only user message disappeared on turn N+1. The condense path still calls the function with `keepLatest=false`, so summaries don't carry stale snapshots, and `condense/__tests__/index.spec.ts` keeps covering the condense-time behavior. The comments at the call site and on the function explain why compaction must not come back to the request path. Nothing enforces that rule beyond the new Task test, which would fail if compaction returned.

Growth cost: the report estimates about 200 tokens per turn, plus about 6K for the turn-1 file listing that now persists. On cached backends those tokens are free to prefill but still count toward the context window. Uncached cloud models routed through Zoo pay full input price for them on every turn.

### preserveReasoning default for OmniRoute

```ts
const info: ModelInfo =
	isOmniRoute({ ...this.options, apiProvider: providerIdentifiers.openai }) &&
	baseInfo.preserveReasoning === undefined
		? { ...baseInfo, preserveReasoning: true }
		: baseInfo
```

`OpenAiHandler` doesn't hold `apiProvider` in its options, so the provider is forced to `openai` to satisfy `isOmniRoute`. That is correct because the handler only exists for that provider. The openai.spec tests cover four cases: an OmniRoute profile without the flag gets `true`, an explicit `false` is kept, non-OmniRoute profiles with `false` or `undefined` stay unset, and the shared defaults are not mutated.

The handler has a `deepseekReasoner` branch (`modelId` contains `deepseek-reasoner`, or R1 format is enabled) that uses `convertToR1Format` instead of `convertToOpenAiMessages`. An OmniRoute profile pointed at such a model id would skip the `reasoning_content` emission. OmniRoute combo ids like `hybrid/planner` don't hit it, so this is informational only.

The flag is profile-wide. OmniRoute routes `hybrid/*` combos across local and cloud backends, so cloud backends now receive `reasoning_content` in assistant history too (possible issue 1). The coder flagged this as unverified. I could not verify it from the Zoo side either.

### Test proof of prefix stability

The Task.spec test builds a history with a task message plus env `t1`, an assistant message with reasoning and tool_use, and a tool_result plus env `t2`. It sends turn N, appends a second assistant message (reasoning plus tool_use) and a tool_result plus env `t3`, then sends turn N+1. Both captured `createMessage` histories go through `convertToOpenAiMessages`. The test asserts `JSON.stringify(N+1.slice(0, N.length)) === JSON.stringify(N)`, that both earlier env snapshots are still present, and that both assistant turns carry `reasoning_content`. That covers both breakers in a single byte-level assertion, and the recorded run against the old code shows it catches the regression. The comparison stops at the converted message list. The system message and tools array are built by the handler and not compared, but the coder's audit covers them (the system prompt has no clock or cost, and `supportsPromptCache` is off by default).

Not tested: an assistant turn with visible text alongside reasoning, and the `supportsPromptCache=true` OmniRoute configuration, which still moves `cache_control` every turn (documented as audit item 5).

### AGENTS.md compliance

The commit adds no changeset and no CHANGELOG edit. It adds no `as any`. The test's reasoning fixtures use `as unknown as Anthropic.Messages.ContentBlockParam`, with a comment explaining that the stored reasoning block isn't in the SDK union. AGENTS.md allows that as a last resort. The commit doesn't touch `eslint-suppressions.json`, and the recorded counts stayed level (Task.ts 17, openai.ts 3, openai.spec.ts 4).

</details>

<details>
<summary>File map</summary>

- `src/core/task/Task.ts`: drop request-path env-details compaction and its import; explanatory comment.
- `src/core/task/compactEnvironmentDetails.ts`: doc comment restricting the function to condense time; reformatted condition.
- `src/api/providers/openai.ts`: OmniRoute `preserveReasoning` default overlay in `getModel()`.
- `src/api/providers/__tests__/openai.spec.ts`: overlay tests (default, explicit false, non-OmniRoute, no mutation).
- `src/core/task/__tests__/Task.spec.ts`: two-turn byte-stable prefix test; constructor reformat.
- `.agents/tasks/glm53-prefix-stability/zoo-verification.md`: verification evidence.

Full diff: `git show e980c9efb`.

</details>
