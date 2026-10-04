# Shape-aware `injectSystemFirst` merge preserves array-shaped system content

The fix makes the memory-merge in `injectSystemFirst()` aware of the two runtime shapes `messages[0].content` can take. The destruction site (`injection.ts:186`) previously built the merged system message with a single template literal — `` `${memoryText}\n${first.content}` `` — which coerced the array-of-content-blocks shape that the Roo/Zoo OpenAI-format client actually sends into the literal string `"[object Object]"`, silently discarding the 54K orchestrator prompt for strict providers routed in by FEAT-002. The commit replaces that line with a three-way branch (string → concat, array → prepend a `{type:"text",text:memoryText}` block, other → a `toText()` flatten that never uses bare `String()`), widens `ChatMessage.content` to `string | ContentBlock[]` so the compiler forces callers to handle the array case, and adds a parametrized regression test across all five strict providers.

Watch for: nothing blocking. The widened content type is a public interface change on an exported type, but the one dependent assertion was correctly narrowed and the verification evidence shows a clean targeted typecheck of both edited files (confidence: confirmed). The array branch and `toText()` fallback both avoid any array/object stringification path, so `[object Object]` cannot regenerate on any branch (confidence: confirmed).

**Verdict**: APPROVED

## High-level view

The merge is now driven by the runtime shape of `first.content` rather than assuming string. The string branch is byte-for-byte the old behavior; the array branch mirrors the already-correct `Array.isArray(request.system)` Anthropic branch two lines down by prepending the memory as a leading text block and spreading the original blocks, so the orchestrator prompt survives in order; the else branch routes through a new `toText()` helper modeled on `strictSystemHoist.ts`'s `toTextContent()`, which returns `""` for unrecognized shapes instead of `String(x)`. This closes every path by which a non-string could reach a template literal.

The `ChatMessage.content` widening to `string | Array<{type: string; text?: string; [key: string]: unknown}>` is the structural half of the fix: it turns the latent class of bug (any future `${...content}` concat) into a compile error. The only cascading type error this surfaced was one `.startsWith()` call in an existing string-content test, which was narrowed with an explicit `typeof` guard and a `string` cast — the test's intent is unchanged. Other array-aware readers in the same file (`endsWithServerToolResult`) already cast `content as unknown` and were untouched.

The strict-provider set (`injection.ts:92-101`), the routing guard that reaches `injectSystemFirst` (`supportsSystem && systemMessageMustBeFirst(provider)`), the function signature, the Anthropic top-level `system` branches, and the non-strict cache-safe splice are all unchanged — the diff touches only two files and is confined to the type, the helper, the merge branch, and tests.

Regression coverage asserts the three properties that matter under a strict provider with array content: original block text present and in order, memory present as the leading block, and no `[object Object]` (checked on both the joined text and the full `JSON.stringify`). The existing string-content strict cases still assert the string merge order.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. The fix matches the spec in §Q5, the untouched regions are confirmed unchanged, and the regression test covers the array-content path across all five strict providers.

</details>

<details>
<summary>Details</summary>

### Shape-aware merge closes every coercion path

The replaced block decides on `first.content`'s runtime type before building the merged message:

```ts
let mergedContent: ChatMessage["content"]
if (typeof first.content === "string") {
	mergedContent = `${memoryText}\n${first.content}`
} else if (Array.isArray(first.content)) {
	mergedContent = [{ type: "text", text: memoryText }, ...first.content]
} else {
	mergedContent = `${memoryText}\n${toText(first.content)}`
}
```

The string branch reproduces the prior expression exactly, so existing string callers are unaffected. The array branch is the fix for the actual wire shape: it prepends the memory as a leading text block and spreads the original blocks, so the content stays an array and the orchestrator prompt is preserved in order — this is the same construction already used for the top-level `request.system` array branch and in `systemPrompt.ts`'s `prependToContent`. Critically, no branch interpolates an array or object into a template literal: the only template literals operate on `memoryText` (a string) and either `first.content` already narrowed to `string` or `toText(...)` (which returns a string). `[object Object]` cannot be regenerated on any path (confidence: confirmed, traced through all three branches and the helper).

The `toText()` helper is the else-branch's safety net:

```ts
function toText(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.filter(
				(part): part is { type: string; text?: unknown } =>
					Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text",
			)
			.map((part) => String(part.text ?? ""))
			.join("\n")
	}
	return ""
}
```

The only `String()` call is applied to `part.text ?? ""` — a per-block primitive, not the array or a block object — so even a malformed `text` value stringifies to its own representation, never `[object Object]`. Unrecognized top-level shapes yield `""`. This mirrors `strictSystemHoist.ts`'s `toTextContent()` as the findings recommended (confidence: confirmed).

### Type widening and its single cascade

`ChatMessage.content` moved from `string` to `string | Array<{ type: string; text?: string; [key: string]: unknown }>`. Because this is an exported interface, the widening is what forces every `${...content}` site to be revisited — the structural fix behind the behavioral one. The only in-repo cascade the coder reports is the existing string-content strict test calling `.startsWith()` on `result.messages[0].content`; the diff narrows it with `expect(typeof ...).toBe("string")` followed by a `string` cast before `.startsWith()`, leaving the assertion's meaning intact. The sibling `endsWithServerToolResult` reader already treated content as `unknown` with an `Array.isArray` guard, so it needed no change. Verification evidence shows the targeted typecheck of both edited files is clean after the narrowing (confidence: confirmed — read the diff and the verification log; did not independently re-run tsc per instructions).

### Untouched regions confirmed

The diff is two files and 97 insertions. The strict set at `injection.ts:92-101` (the FEAT-002 additions `vllm`/`ollama-local`/`ollama`/`llama-cpp`/`llamacpp`), the routing guard `supportsSystem && systemMessageMustBeFirst(provider)` that reaches `injectSystemFirst`, the function signature of `injectSystemFirst`, the Anthropic top-level `system` string/array branches, and the non-strict `placeMessage` cache-safe splice all appear verbatim in the current file and are absent from the diff (confidence: confirmed — read lines 85-99 and 200-330 of the current file).

### Regression coverage

The new parametrized test runs over all five strict providers inside the existing "Failure C" describe. For each it sends `messages[0].content` as an array of two text blocks, injects memory, and asserts: the content is still an array; `blocks[0]` deep-equals `{type:"text", text:"Memory context: User prefers concise answers"}` (memory prepended as the leading block); the joined block text contains both original strings in order; neither the joined text nor `JSON.stringify(result.messages)` contains `"[object Object]"`; and no system message exists at index > 0. The pre-existing string-content strict test was retained and still asserts the string merge order. This is the exact coverage §Q5 called for, placed at the correct unit layer (confidence: confirmed — read the test diff and the helper/constant definitions it depends on).

Not tested at this layer: the live end-to-end re-run against a real vllm/llama-cpp/ollama GLM backend with memory enabled. The verification notes correctly scope this as a deploy-time check outside this local change; it is not a gap in the unit fix.

Full diff: `git show f31c19682` on branch `feat/hybrid-reader-combo` in `/Users/celes/sources/celesrenata/OmniRoute`.

</details>

<details>
<summary>File map</summary>

- `src/lib/memory/injection.ts` — widened `ChatMessage.content` to `string | ContentBlock[]`; added `toText()` helper; replaced the single-line template-literal merge in `injectSystemFirst()` with a shape-aware string/array/other branch.
- `src/lib/memory/__tests__/injection.test.ts` — narrowed the existing string-content strict assertion to `string` before `.startsWith()`; added a parametrized array-content regression test across all five strict providers asserting prompt survival, memory-as-leading-block, and no `[object Object]`.

</details>
