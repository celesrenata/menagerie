# Setup Notes — omniroute-codelane-fix

## Repository / Branch

- Repo: /Users/celes/sources/celesrenata/OmniRoute
- Branch: feat/hybrid-reader-combo (operating directly on this branch, NO worktree)

## Working tree state

- `git status`: clean — "nothing to commit, working tree clean"
- No untracked or modified files.

## HEAD commit

- c9230dee8 — fix(api): clamp pagination limit instead of 400, log silent combo-row drops

## Recent commits (last 20, feat/hybrid-reader-combo)

```
c9230dee8 (HEAD -> feat/hybrid-reader-combo) fix(api): clamp pagination limit instead of 400, log silent combo-row drops
8d9d5f7a8 feat: per-request X-OmniRoute-Tier cost-tier ceiling (FEAT-005)
f48cdb12a feat: record provider + memory-injection state on empty-output 502 diagnostic
db3586f9e fix: route self-hosted strict Qwen/GLM providers through system-first memory injection
8e046cb57 test(combo): validate hybrid/reader tiered combo payload and 409 fallthrough
dbe703a00 (origin/release/v3.8.52, origin/HEAD, release/v3.8.52) fix(deps): bump transitive undici, brace-expansion and fast-uri to their patched releases (#15210)
536527b60 fix(docs): sync v3.8.52 version in readme and llm mirrors (#15113)
0b62441db chore(release): ledger the v3.8.51 -> v3.8.52 CHANGELOG sync-back
d9fcf0993 docs(changelog): carry the final [3.8.51] section into release/v3.8.52
79edf9408 fix(release): let an Electron dispatch build the ref it is dispatched on again (#15165)
cc187baef fix(electron): resync electron/package-lock.json with its package.json (#15157)
d3a20f592 chore(release): sync-back step 2 — record main (Release v3.8.51 squash) in release/v3.8.52 ancestry
4ab6313d8 chore(release): sync-back step 1 — merge release/v3.8.51 into release/v3.8.52
fc5e2bccd fix(release): let an Electron dispatch build the ref it is dispatched on again (#15165)
21f1573d7 fix(electron): resync electron/package-lock.json with its package.json (#15157)
c1e30b767 Release v3.8.51
a1a2dce1a fix(security): require admin for API-key routes and reserve login slots during password checks (#15146)
2f42a9ac1 fix(build): derive the pack-boot CLI token against the smoke's DATA_DIR (#15147)
dfb563d5d test(e2e): align four release E2E specs with the contracts #11670/#11798 shipped (#15145)
3a1523a08 fix(idempotency): namespace the replay key by the calling API key (#15128)
```

## CONCURRENT WORK WARNING (verbatim)

another active workflow (session `omniroute-reasoning-effort-fix`) is working on this SAME branch/repo right now, paused in a design-review loop, not yet implementing. It is scoped to these files which THIS workflow must NOT edit: `open-sse/executors/base/reasoningEffort.ts`, `src/lib/providerModels/targetRequestSanitizer.ts` (or wherever `BaseExecutor.execute()` lives), `src/lib/db/modelCapabilityOverrides.ts` / `src/lib/combos/modelCapabilityOverrides.ts`, and `src/lib/combos/check-provider-consistency.ts`. If any later step finds it would need to touch those files, or sees unexpected new commits appear mid-task, it must STOP and report rather than guessing.
