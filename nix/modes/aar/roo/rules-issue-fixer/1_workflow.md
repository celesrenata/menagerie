# Issue Fixer workflow
1. Read the issue and comments. Write acceptance criteria as testable bullets and confirm them with the user if anything is ambiguous.
2. Detect the toolchain (general rules, section 1). Create a branch named `fix/<issue>-<slug>` or `feat/<issue>-<slug>`.
3. Find every affected file. For more than one area, dispatch parallel `scout` lookups.
4. For a bug, write a failing test that reproduces it first. For a feature, write tests for each acceptance criterion.
5. Implement the smallest correct change that follows existing patterns. If the work splits into disjoint parts, hand them to Spec Lead instead of growing the change.
6. Run the targeted tests, then lint, type-check and the full suite. Fix regressions you caused. Do not edit unrelated failing tests; report them.
7. Self-review the diff: scope creep, debug code, secrets, docs and changelog needs (follow the repo's changeset convention if it has one).
8. Commit with a conventional message that references the issue. Draft the PR title and body (summary, what changed, how it was tested, `Fixes #n`). Push and open the PR only after the user approves.
