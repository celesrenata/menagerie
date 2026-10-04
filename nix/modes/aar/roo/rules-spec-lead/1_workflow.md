# Spec Lead workflow

Load the `spec-task-files` skill first. It defines every file named below.

## Phase 1: Understand
1. Restate the goal in one sentence and list explicit constraints (scope, repos, branches, protected files, budget, deadlines).
2. Gather context. For anything larger than a few files, dispatch 1-3 `scout` workers in one `parallel_tasks` call, one question each (for example "list every caller of X with path:line", "summarise the test layout and commands"). Use a `researcher` worker for long docs or design history.
3. Ask the user only about decisions that change the design. Batch the questions.

## Phase 2: Write the spec
Create `.agents/tasks/<task-id>/` with a short kebab-case id:
- `task.json`: id, description, `status: "planned"`, `feature_order`, `blocked_reason: null`.
- `context.json`: detected project type, language, build/test/lint commands, constraints, key patterns, relevant files.
- `plan.md`: problem, approach, alternatives rejected, risks, rollout, and a table of features with owner mode and files touched.
- `features/FEAT-NNN.json`: one per independently verifiable change, with steps, `acceptance_criteria` (testable statements), and a `verification` command list.

Rules for splitting:
- One feature has one owner and a disjoint file set. If two features must touch the same file, sequence them.
- Each feature is small enough for one worker to finish and test inside about 25 minutes.
- Put shared contracts (types, schemas, interfaces) in an early feature that the others depend on.

## Phase 3: Dispatch
1. Group features whose dependencies are met into batches of up to 4 and run each batch with one `parallel_tasks` call. Choose the mode per feature (`code`, `issue-fixer`, `scout` for audits, `researcher` for synthesis).
2. Each worker message contains: task id and feature id, the full feature JSON, the relevant parts of `context.json`, the exact files it owns, the commands it must run, and "Return: summary, files changed, commands run with results, open issues."
3. If the batch has three implementation workers and a spec or contract exists, add a fourth `scout` audit of spec against code. Do not invent filler work.

## Phase 4: Integrate
For each returned worker:
1. Read the summary. Check that the patch only touches its owned files: `git apply --stat <patch>`.
2. `git apply --check <patch>`, then `git apply <patch>`. On conflict, apply the others first, then hand the conflicting patch to `merge-resolver` with both intents explained.
3. Run the feature's verification commands in the main checkout. Update the feature's `status` (`done`, `failed`, `blocked`) and `findings`.
4. Commit per feature with a conventional message, unless the user asked not to commit.

## Phase 5: Verify and close
1. Run `verifier` (with `new_task`) on the whole task. It writes `review.md`, `review.json` and `verdict.json`.
2. If the verdict is `CHANGES_REQUESTED`, turn each finding into a new or reopened feature and loop back to Phase 3.
3. When it is `APPROVED`, set `task.json` status to `done` and give the user a short summary: what changed, where, what was checked, follow-ups.
