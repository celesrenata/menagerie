# Zoo Dispatch Prompt Gap — Findings

Read-only investigation. Repo: `/Users/celes/sources/celesrenata/menagerie`, branch `feat/omniroute-tier-dropdown-feat005` (confirmed, not switched). No files modified.

Ground truth accepted as given and NOT re-investigated: `parallel_tasks` + `new_task` are on the wire (56-tool array, `tool_choice:"auto"`), the strict-schema nullable bug is fixed, model is GLM-5.3, mode is custom `spec-orchestrator`, both experiments on. The question is purely: why doesn't the model _choose_ to call `parallel_tasks`, and does the built-in `orchestrator` differ?

---

## Summary answer (TL;DR)

**There is NO built-in-`orchestrator`-slug-specific prompt scaffolding anywhere in the system-prompt assembly.** I grepped the entire `src/core/prompts/` tree for mode-slug comparisons and dispatch keywords. The only `=== mode`/`slug` checks are generic config lookups (`system.ts:74`, `system.ts:160`), not dispatch gating. No prompt section renders for the slug `"orchestrator"` that is withheld from `"spec-orchestrator"`. The leading hypothesis in the brief (hardcoded-slug prompt scaffolding) is **FALSE**.

**The one and only system-level dispatch guidance is tool-gated, not mode-gated, and it renders identically for both modes.** The `hasParallelTasks` rule (`src/core/prompts/sections/rules.ts:168-174`) and the `parallelToolExecution` rule (`rules.ts:176-180`) are emitted whenever `policy.tools.has("parallel_tasks")` is true (`rules.ts:84`). That predicate is true for BOTH the built-in `orchestrator` and the custom `spec-orchestrator` (both carry `parallel_tasks` via `ALWAYS_AVAILABLE_TOOLS`, with the experiment on). So the custom mode receives the exact same system-level dispatch rule the built-in gets. There is no missing section.

**The ONLY per-mode difference that can drive dispatch is the mode's own `roleDefinition` + `customInstructions`.** Both built-in and custom modes flow through the identical `generatePrompt` path (`src/core/prompts/system.ts:118-137`); `getModeSelection` (`src/shared/modes.ts:111-131`) returns `roleDefinition` + `baseInstructions` from the custom mode verbatim, and `baseInstructions` is appended at the bottom via `addCustomInstructions` (`system.ts:135`). Both modes' custom instructions land in the same "USER'S CUSTOM INSTRUCTIONS → Mode-specific Instructions:" block (`custom-instructions.ts:466` and `:508-520`). Placement and framing are identical.

**So the gap is a wording/strength gap in the two text fields, not a scaffolding gap.** The decisive difference:

- The built-in `orchestrator`'s **`roleDefinition`** bakes delegation into the model's _identity_ at the very top of the prompt: _"a strategic workflow orchestrator who coordinates complex tasks by delegating them to appropriate specialized modes"_ (`packages/types/src/mode.ts:224`). The top of the prompt is the strongest position, and it frames the agent as a delegator by nature.
- The custom `spec-orchestrator`'s **`roleDefinition`** is much softer and never says "delegate": _"You coordinate spec-driven development using explicit acceptance criteria, durable task IDs, independent workers and verified integration"_ (flake template `spec-orchestrator.roleDefinition`). "Coordinate … independent workers" is an abstract noun phrase, not an imperative to dispatch.
- The built-in's dispatch imperatives live in its **`customInstructions`** as a numbered, directive playbook ("Your role is to coordinate … you should: 1. … 2. When `parallel_tasks` is available, use it for 2–4 independent subtasks …", `packages/types/src/mode.ts:231`).
- The custom mode DOES contain even stronger dispatch language in its `customInstructions` ("parallel_tasks is the normal, expected path and is enabled; dispatch is the default, not a conditional"), but it is buried in a single ~700-word run-on paragraph that also tells the model, repeatedly, that it MAY do work inline for "small, decisive lookups," and it opens with reading/coordination framing before it ever reaches the dispatch imperative. The imperative is present but diluted and low in the prompt.

**Net:** both modes get the same system rule, but the built-in's _role identity_ says "you delegate," while the custom mode's role identity says "you coordinate spec work" and only reaches a dispatch imperative deep inside a dense custom-instructions paragraph that is simultaneously hedged with inline-work permissions. On a task the model can plausibly do inline (audit a spec + build a site + build an app), the weaker identity framing plus the explicit inline-work escape hatches let GLM rationalize doing it all itself. This is a **prompt-wording gap in the flake template**, fixable without touching extension code.

---

## Evidence (with citations)

### Q1 — Full system-prompt / role scaffolding: built-in orchestrator vs custom spec-orchestrator

Both modes assemble through one function, `generatePrompt` (`src/core/prompts/system.ts:48-139`). The prompt skeleton (`system.ts:106-137`), in order:

1. `${roleDefinition}` — top of prompt
2. `markdownFormattingSection()`
3. `getSharedToolUseSection()`
4. `getToolUseGuidelinesSection(policy)`
5. `getCapabilitiesSection(policy)`
6. `getModesSection(context)`
7. optional skills
8. `getRulesSection(cwd, settings, policy, parallelToolExecution)`
9. `getSystemInfoSection`
10. `getObjectiveSection`
11. `addCustomInstructions(baseInstructions, …)` — bottom of prompt

`roleDefinition` and `baseInstructions` are selected by `getModeSelection(mode, promptComponent, customModeConfigs)` (`system.ts:76`). Its logic (`src/shared/modes.ts:111-131`): if the slug matches a custom mode, return that custom mode's `roleDefinition` and `customInstructions` **verbatim** (`modes.ts:115-121`); otherwise use the built-in. **There is no branch that adds anything extra for the built-in `orchestrator`.** The custom mode is treated exactly like the built-in — same slots, same assembly.

Sections 2–10 are either static or gated purely on the **tool policy**, never on the mode slug:

- `getCapabilitiesSection` (`src/core/prompts/sections/capabilities.ts:16-88`) emits only tool-presence clauses; grep for `parallel|new_task|delegat|subtask|dispatch` in that file returned **no matches**.
- `getToolUseGuidelinesSection` — grep for `parallel_tasks|parallelTasks|new_task` in `src/core/prompts/sections/tool-use-guidelines.ts` returned **no matches**. It contains no dispatch guidance for any mode.
- `getModesSection` (`src/core/prompts/sections/modes.ts:9-36`) lists ALL available modes (via `getAllModesWithPrompts`) with their `whenToUse` text, identically regardless of the current mode. This is where `whenToUse` is used — as a catalog of delegation _targets_, not as the current mode's identity.

So what the built-in orchestrator's `roleDefinition`/`baseInstructions` include that drives dispatch is purely **its own two text fields** (`packages/types/src/mode.ts:224` and `:231`). It gets **no** special system-prompt section, no slug-specific tool-use guidance, no scaffolding the custom mode is denied. **Answer to the brief's explicit sub-question: NO — the built-in orchestrator does not receive a special system-prompt section that `spec-orchestrator` misses.**

### Q2 — How parallel_tasks guidance is injected, and whether it is gated on anything mode-specific

- `getRulesSection` reads `const hasParallelTasks = policy.tools.has("parallel_tasks")` (`src/core/prompts/sections/rules.ts:84`).
- The dispatch rule is pushed iff `hasParallelTasks` (`rules.ts:168-174`): _"When two or more parts of a task can be completed independently, start them together with one parallel_tasks call before doing the first part yourself…"_.
- A second rule is pushed iff `parallelToolExecution` is true (`rules.ts:176-180`), which `system.ts:135` passes from `experiments?.parallelToolExecution === true`.
- The `parallel_tasks` **tool description** itself (`src/core/prompts/tools/native-tools/parallel_tasks.ts:7`) rides on the wire tool array, not the system prompt text, and is identical for every mode.

**Is this guidance gated on anything true for the built-in but false for the custom mode?** No. `policy.tools.has("parallel_tasks")` is driven by `resolveEffectiveToolPolicy`, which (per the prior `zoo-dispatch-gate/findings.md`, §2) adds `parallel_tasks` via `ALWAYS_AVAILABLE_TOOLS` (`src/shared/tools.ts:333-342`) for every mode once `experiments.parallelTasks` is on. The flake has `experiments.parallelTasks: true`. Therefore `hasParallelTasks` is true for `spec-orchestrator`, and this rule **does render** for it. **There is no prompt section that renders only for a hardcoded `"orchestrator"` slug** — confirmed by the slug grep across `src/core/prompts/**`.

### Q3 — Any mode-slug-specific logic in prompt assembly

Grep of `src/core/prompts/**/*.ts` for `mode ===|slug ===|=== "orchestrator"|=== "code"` returned only:

- `src/core/prompts/system.ts:74` `getModeBySlug(mode, customModeConfigs) || modes.find((m) => m.slug === mode) || modes[0]` — a generic lookup/fallback.
- `src/core/prompts/system.ts:160` — the same generic lookup in `SYSTEM_PROMPT`.

Grep for the literal `orchestrator` across `src/core/prompts/**` returned only a test assertion (`__tests__/system-prompt.spec.ts:733-736`). **No `codeMode`/`orchestratorMode` constant, no hardcoded dispatch branch, nothing that gives the built-in orchestrator prompting a custom slug cannot get.** The brief's leading hypothesis is disproven.

### Q4 — What the custom mode's assembled prompt actually tells the model about dispatch

Reconstructed from the assembly code, `spec-orchestrator`'s final system prompt contains, with respect to delegation:

1. **Top (role identity, `roleDefinition`):** _"You coordinate spec-driven development using explicit acceptance criteria, durable task IDs, independent workers and verified integration."_ — no imperative verb like "delegate"/"dispatch"; "coordinate … independent workers" is descriptive, not directive. (Compare built-in `mode.ts:224`: _"…who coordinates complex tasks by delegating them to appropriate specialized modes."_)
2. **RULES section (`rules.ts:168-180`):** the standard `hasParallelTasks` + `parallelToolExecution` rules — identical to what the built-in gets. These DO instruct the model to split independent work into `parallel_tasks`. This is the strongest _system-authored_ dispatch instruction, and the custom mode receives it.
3. **MODES section:** the full catalog of delegate modes with their `whenToUse` text (so the model knows `code`, `project-reader`, `project-research`, etc. exist as targets).
4. **Bottom (USER'S CUSTOM INSTRUCTIONS → Mode-specific Instructions, `custom-instructions.ts:466`,`:508`):** the mode's long `customInstructions`, which include a genuinely strong line — _"parallel_tasks is the normal, expected path and is enabled; dispatch is the default, not a conditional"_ — but embedded in a ~700-word paragraph that also repeatedly authorizes inline work ("Reserve your own inline reads for small, decisive lookups…") and leads with reading/coordination/spec-authoring framing before the dispatch imperative.

So the brief's conditional in Q4 is only _half_ true: the custom mode's own `customInstructions` are NOT the _only_ place delegation is mentioned (the system RULES section mentions it too, identically for both modes). But the built-in's advantage is the **role-identity line at the top** that defines the agent as a delegator, which the custom mode's role line does not. The custom mode's dispatch imperative exists but is (a) absent from the high-salience role line, and (b) diluted and hedged with inline-work escape hatches in a dense low-position paragraph.

### Q5 — Minimal fix

Because the gap is wording, not scaffolding, the smallest effective fix is a **flake-template text change**, not an extension code change.

---

## Conclusions

- The tool is present and valid (ground truth); the system-level dispatch rule renders for the custom mode (`rules.ts:168-180`); there is no slug-specific scaffolding the custom mode misses (Q1–Q3). Prior `zoo-dispatch-gate` schema concern is reported fixed, so it is excluded here.
- The remaining, real difference is the **strength and position of dispatch language in the two mode-config text fields**. The built-in orchestrator's `roleDefinition` makes delegation the agent's identity in the top-of-prompt position; the custom `spec-orchestrator`'s `roleDefinition` does not, and its dispatch imperative is buried and hedged.
- On a task that _looks_ doable inline, a strong model with a weak role identity and explicit inline-work permissions will tend to proceed inline — exactly the observed GLM behavior.

## Recommendation (smallest effective fix)

**Primary (recommended): tighten the custom mode's `roleDefinition` in the flake template** `~/sources/m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json`, `customModes[slug="spec-orchestrator"].roleDefinition`. Make delegation the identity, mirroring the built-in's top-line framing. For example change it to something like:

> "You are a strategic spec-driven orchestrator who delivers work by delegating independent scopes to specialized worker modes via `parallel_tasks`, coordinating with explicit acceptance criteria, durable task IDs, and verified integration. You do not implement large scopes yourself; you dispatch them."

This is one line, lands at the strongest position in the prompt, and matches the mechanism that already makes the built-in orchestrator dispatch. It requires regenerating/re-applying the flake (the user's message "put this in my flake" indicates this is the intended surface).

**Secondary (belt-and-suspenders): front-load the dispatch imperative in the same mode's `customInstructions`** so the first sentence is the "dispatch is the default" directive, and move the inline-work escape hatches to the end / tighten them (e.g., "inline only a single short file read; everything else is dispatched"). The current paragraph leads with reading/spec-authoring and only reaches the dispatch mandate mid-paragraph.

**Option (a) — switch to the built-in `orchestrator` mode instead of the custom one:** viable and would immediately get the stronger role identity, but it loses the spec-kit-specific behavior (task IDs, acceptance criteria, reader-lane routing) that `spec-orchestrator` was built for, and it still routes through `omni-hybrid-planner` per `modeApiConfigs.orchestrator`. Not recommended unless the spec behavior is dispensable.

**Option (c) — code change to render a dispatch section for custom orchestrator-style modes:** unnecessary. The system-level dispatch rule already renders for the custom mode (`rules.ts:168-180`); adding more code-side prompting would duplicate guidance that is already present. The missing piece is in the mode's own identity text, which is the config's job.

**Option (d) — force `tool_choice`:** heavy-handed and risky. `tool_choice:"auto"` is correct for a mode that must also read/plan/report; forcing the tool would break non-parallelizable turns and the required-arguments flow. Not recommended as the general fix; at most a diagnostic probe.

**Smallest effective change: Primary alone** — rewrite `spec-orchestrator.roleDefinition` to make `parallel_tasks` delegation the agent's identity, mirroring `packages/types/src/mode.ts:224`. Verify by issuing one `spec-orchestrator` turn on the same parallelizable task and confirming a `parallel_tasks` call is emitted; if dispatch is still inconsistent, add the Secondary front-loading change.

---

## Appendix — key citations

- `src/core/prompts/system.ts:48-139` single `generatePrompt` path for all modes; `:76` `getModeSelection`; `:106-137` prompt skeleton; `:135` custom instructions appended last with `parallelToolExecution` flag.
- `src/shared/modes.ts:111-131` `getModeSelection` returns custom mode's `roleDefinition`/`customInstructions` verbatim.
- `src/core/prompts/sections/rules.ts:84` `hasParallelTasks = policy.tools.has("parallel_tasks")`; `:168-174` dispatch rule; `:176-180` `parallelToolExecution` rule.
- `src/core/prompts/sections/custom-instructions.ts:466` "Mode-specific Instructions:" push; `:508-520` "USER'S CUSTOM INSTRUCTIONS" wrapper (same section for built-in and custom modes).
- `src/core/prompts/sections/capabilities.ts:16-88` tool-gated only, no dispatch content (grep: no matches).
- `src/core/prompts/sections/tool-use-guidelines.ts` — grep `parallel_tasks|parallelTasks|new_task`: no matches.
- `src/core/prompts/sections/modes.ts:9-36` MODES catalog, identical for all modes; `:23` uses `whenToUse`.
- Grep `src/core/prompts/**` for `=== "orchestrator"` / slug checks: only generic lookups at `system.ts:74`,`:160`; literal `orchestrator` only in a test.
- `packages/types/src/mode.ts:224` built-in orchestrator `roleDefinition` ("…by delegating them to appropriate specialized modes"); `:229` `groups:["read"]`; `:231` dispatch-directive `customInstructions`.
- Flake `~/sources/m5max-darwin-flake/modules/home/zoo/omniroute-zoo-profiles.template.json`: `globalSettings.experiments.parallelTasks=true`, `parallelToolExecution=true`; `customModes[spec-orchestrator].roleDefinition` (soft "coordinate" framing, no "delegate"); its `customInstructions` ("dispatch is the default") buried in a dense paragraph with inline-work escape hatches; `modeApiConfigs.spec-orchestrator = omni-hybrid-planner` (→ `hybrid/planner`).
- `src/core/prompts/tools/native-tools/parallel_tasks.ts:7` tool description (on the wire, identical per mode); `src/core/prompts/tools/native-tools/new_task.ts` `new_task` description.
