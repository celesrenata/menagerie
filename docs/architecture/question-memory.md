# Follow-up question memory

Problem: `ask_followup_question` asked things that were already known from the user's original request, their earlier
replies, answers given in earlier tasks, or the project's own docs (README/AGENTS, steering, specs).

## Behaviour (on by default; setting "Remember answered questions")
Before the user is interrupted, `ask_followup_question` decides, deterministically and without a model:

1. **Reuse** - a question the user already answered in this project matches (token similarity, both sides >= 2
   content tokens, contained-question rule so "which test framework" matches "which test framework for the project").
   The stored answer is returned to the model with its date, and the user sees one line saying it was reused. If the
   question came with suggested options, the stored answer is reused only if it still matches one of them.
2. **Consult** - the original request, earlier replies in this conversation, or project docs overlap the question
   (>= 3 shared content tokens covering >= 60% of the question, or a short message that is mostly about it). The
   passages are returned to the model once, labelled with their source and line range, and the user is not asked yet.
3. **Ask** - otherwise, or when the same question is repeated in the same task. A repeat always reaches the user, so
   neither reuse nor consult can loop or trap the model.

Sources read (bounded to 40 files, 64 KB each, symlinks that leave the workspace ignored): README.md, AGENTS.md,
CLAUDE.md, CONTRIBUTING.md, `.kiro/steering/*.md`, `.roo/rules/*`, `.kiro/specs/*/{requirements,design,tasks}.md`, plus
the task's first message and the user's later replies. Assistant text is never a source.

## What is remembered
Genuine answers only, in `.kiro/memory/questions.json` (machine state, newest first, max 200) with a generated
`answered-questions.md` projection. Each entry carries the date and task. To forget an answer, delete its entry.
Not stored: answers that look like credentials, over-long answers, empty answers, answers with images, and any answer
while follow-up auto-approval is on (the answer may be an auto-selected suggestion, not something the user said).
Memory I/O failures fall back to simply asking.

## Known limits
- Matching is lexical. It will miss a paraphrase with no shared content words and can bounce a question whose words
  overlap a doc that does not actually answer it; the cost of a false bounce is one extra model turn, never a wrong
  answer shown as the user's.
- A reused answer can be stale. The model is told it may re-ask, and re-asking reaches the user and replaces the entry.
- Memory is per workspace root, not per user or machine. `.kiro/memory` may be committed; do not put secrets in answers.
