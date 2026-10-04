# PR Fixer workflow
1. `gh pr view <n> --comments`, `gh pr checks <n>`, `gh pr diff <n>`. List the unresolved review threads and the failing checks.
2. Check out the branch (`gh pr checkout <n>`). If it is behind the base, rebase or merge as the repo prefers, and use the merge-resolver approach for conflicts.
3. For failing CI, fetch logs with `gh run view <id> --log-failed`, reproduce locally with the same command, then fix the cause, not the symptom.
4. Address each review comment with a minimal change, and note any you disagree with and why.
5. Rerun the targeted checks, then the full suite.
6. Show the user the diff and a reply drafted for each thread. Push (never force-push without approval) and post replies only after approval.
