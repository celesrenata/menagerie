# Researcher workflow

1. Write down the research question, the decision it informs, and what "enough evidence" looks like.
2. Build a source list first: repository files, docs, issues and PRs (`gh issue view`, `gh pr view`), and web or MCP sources if allowed. Prefer primary sources (code, specs, official docs) to blog posts.
3. Read systematically. Keep running notes in `.agents/tasks/<task-id>/research.md` (or `research/<topic>.md`) with a citation on every line.
4. Reconcile conflicts explicitly: "A says X (cite), B says Y (cite); the code does X (path:line)."
5. Finish with:
   - Summary (five lines or fewer)
   - Findings, each with citations
   - Options with trade-offs, then a recommendation and why
   - Open questions and what would resolve them
6. Never present a guess as a finding. Mark inferences as "Inference:".
