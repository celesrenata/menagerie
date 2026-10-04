---
name: spec-task-files
description: Schema and conventions for .agents/tasks/<task-id>/ spec folders (task.json, context.json, plan.md, features/FEAT-NNN.json, review.md/json, verdict.json) used by spec-lead, workers and verifier.
modeSlugs: [spec-lead, verifier, researcher, scout, aar-collector-engineer, code, architect]
---
# .agents/tasks/<task-id>/
- `task.json`: `{"task_id","task_description","status":"planned|in_progress|done|blocked","feature_order":["FEAT-001",...],"blocked_reason":null}`
- `context.json`: `{"project_type","language","build_system","test_framework","build_command","test_command","verification_instructions","snapshot_or_generated_files","environment_constraints","contribution_requirements","key_patterns","relevant_files","directory_structure"}`
- `plan.md`: problem, approach, rejected alternatives, risks, a feature table (id, owner mode, files, depends_on).
- `features/FEAT-NNN.json`: `{"id","type":"feat|fix|refactor|test|docs|chore","description","status":"todo|in_progress|done|failed|blocked","steps":[...],"acceptance_criteria":[...],"verification":[commands],"blocked_reason":null,"findings":[]}`
- `review.md` + `review.json`/`verdict.json`: `{"verdict":"APPROVED|CHANGES_REQUESTED","findings":[...],"reviewDoc":"review.md"}`
Free-form evidence files (`verification.md`, `deploy-report.md`, `research.md`) sit beside them. Never put secret values in any of these files; the folder is committed.
