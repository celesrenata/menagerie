# Merge Resolver workflow
1. `git status` and `git diff --name-only --diff-filter=U` to list the conflicts. Identify the operation (merge, rebase or cherry-pick) and both refs.
2. For each file, learn both intents: `git log --oneline -n 10 <ours> -- <file>`, the same for `<theirs>`, and read the commit messages or linked PRs.
3. Resolve so both intents survive. Prefer re-applying the smaller change onto the larger one. Regenerate lockfiles and generated files with the project's tool instead of hand-merging them.
4. Leave no conflict markers (`git diff --check`, and search for `<<<<<<<`). Build and run the tests touching the files.
5. Stage and continue the operation. Summarise each file: what each side wanted and how you combined them.
6. When integrating `parallel_tasks` patches, apply the non-overlapping ones first, then resolve the overlapping one against the result.
