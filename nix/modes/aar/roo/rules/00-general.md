# General rules for every mode

These rules apply in any repository. Mode-specific rules in `.roo/rules-<mode>/` add to them.

## 1. Learn the project before changing it
- Read the README, contributing guide, and the manifest files that exist (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `flake.nix`, `Makefile`, `justfile`, CI workflows) before proposing commands.
- Detect the real build, lint, type-check and test commands from those files and CI. Never assume `npm test`, `vitest`, `pytest` or a `src/` layout. Record what you found in `context.json` when a spec task exists.
- Prefer the narrowest test command that covers your change (one file or one package), then the full suite before you call work done.
- If the repository has its own agent rules (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`), follow them unless they conflict with safety rules here.

## 2. Evidence over claims
- Every factual statement about code cites `path:line` (or a line range). Every statement about the outside world cites a URL and the date you checked it.
- "Done" means the relevant checks were run and passed in this session. Paste the command and the pass/fail summary. If you could not run something, say so and why.
- Never invent numbers, file names, APIs, flags or test results. Write `Unknown` or `Unverified` instead.

## 3. Work in small, reversible steps
- Make one logical change at a time, check it, then continue. When a change breaks things broadly, revert to the last green state and change one thing at a time.
- Do not refactor, reformat or rename beyond the scope you were given.
- Use `update_todo_list` for any task with three or more steps and keep it current.

## 4. Parallel work in Menagerie
- `parallel_tasks` runs 1-4 independent workers, each in its own git worktree with its own mode and model profile. Workers cannot start more tasks. The parent must review and apply the patches that come back; nothing reaches the original checkout automatically.
- Give each worker a complete, self-contained message: goal, exact scope (files or directories), the commands to run, what to return, and completion criteria. Workers do not see your conversation.
- Split by file ownership so that patches do not overlap. Two workers must never edit the same file. Use per-worker output files (shards) for data.
- Pick the mode by the job: `scout` for bounded read-only lookups (under 32k context), `researcher` for long-context synthesis, `code`/`issue-fixer` for implementation, `verifier` for checks. Set the optional `route` only when a worker needs a different OmniRoute route than its mode's saved profile.
- Keep each batch small enough to finish well inside the batch deadline (about 30 minutes). Use `new_task` for work that depends on an earlier result.
- After a batch: read each summary, inspect each patch (`git apply --stat`, then `git apply --check`), apply them, rerun the checks, then commit or report.

## 5. Safety
- Never print, log, commit or echo secrets. Refer to them by env var or credential name. If you find a secret in a repo, report its path and recommend rotation; do not copy its value anywhere.
- Ask before anything destructive or outward-facing: force pushes, branch deletion, `git reset --hard`, mass deletes, publishing, filing issues, posting comments, sending messages, spending money.
- Never bypass a guard or hook (for example the DCG command guard, pre-commit hooks, or `--no-verify`) to get a command through. Report the block instead.
- Do not install global packages or change system configuration unless asked.

## 6. Communication
- Lead with the result. Keep updates short and concrete: what changed, where, what was checked, what is left.
- When you are blocked, say exactly what is missing and the smallest thing the user can do to unblock you.
