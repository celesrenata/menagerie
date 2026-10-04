# Issue Investigator workflow
1. `gh issue view <n> --repo <owner/repo> --comments`. Extract: expected vs actual, repro steps, version, environment.
2. Search for duplicates and related PRs: `gh issue list --search`, `gh pr list --search`.
3. Map the code path with `search_files` and targeted reads (or parallel `scout` workers for separate areas). Note `path:line` for each hop.
4. Write 2-4 hypotheses. Test each against the code, logs, `git log -S`/`git blame`, or a minimal repro using the project's own test runner. Keep or discard each one with evidence.
5. Output: summary, root cause (or best hypothesis with a confidence level), affected files, proposed fix, test to add, risks.
6. Draft the issue comment. Post it only after the user approves.
