# Issue Writer workflow
1. Identify the target repo from `git remote -v` or by asking. Search for duplicates first (`gh issue list --search "<keywords>" --state all`) and link any close matches.
2. Classify the report as a bug or a feature. Collect the details:
   - Bug: steps, expected, actual, version or commit, OS, logs (secrets redacted).
   - Feature: problem, who has it, proposed behaviour, alternatives, acceptance criteria.
3. Optionally check the code with read-only lookups so the issue names the likely area (`path:line`). Keep it factual.
4. Follow the repo's issue template if `.github/ISSUE_TEMPLATE` exists. Use a short, specific title.
5. Save the draft to `drafts/issue-<slug>.md` and show it to the user. File it with `gh issue create` only after explicit approval.
