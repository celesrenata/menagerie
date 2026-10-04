# Final report: ovms-embeddings OOM fix

All three fixes are implemented, verified, and reviewed. All three reviews returned APPROVED. Nothing has been pushed.

## Commits

| Repo                 | Branch                                 | Commit                                     | What                                                                                                                                                                                          |
| -------------------- | -------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| menagerie (Zoo Code) | `feat/omniroute-tier-dropdown-feat005` | `6719b9aae28699b21c83d6f167ef631f063834a2` | FIX 1: limit embeddings requests to 32 items and 16384 padded tokens, set `maxRetries: 0`, split on 5xx instead of resending                                                                  |
| OmniRoute            | `feat/hybrid-reader-combo`             | `bb7a38057795afa51c410d22574d38a9f28bb00f` | FIX 2 r2: a split call counts once against quota, partial tokens are kept on failure, and splitting stops if the client aborts. It builds on `e16735ba1`, the first input-array split commit. |
| kube                 | (local)                                | `8672d4ba59fd175c168b27b4e068c484aa888222` | omniroute.yaml image bump to `3.8.60-embed-split-20261003`                                                                                                                                    |
| kube                 | (local)                                | `2fc8d37bc85fcc3e8ec04d56e5034f40a072e973` | omniroute.yaml image bump to `3.8.60-embed-split-r2-20261003` (currently deployed)                                                                                                            |
| kube                 | (local)                                | `2af4afdb186c09d11c28a84db931737441ad4ea5` | FIX 3: ovms-embeddings-statefulset.yaml gets `--truncate=true --max_length=8192`, and memory goes from 16Gi/4Gi to 8Gi/2Gi                                                                    |

kube `a972807` (esnixi-5090 concurrency) is the latest kube commit, but it belongs to separate work and is not part of this fix.

## Test results

FIX 1 (Zoo Code, run from `src/`):

- The 3 focused specs passed 144/144. They cover:
    - 700 items, with every request at most 32 items and within the padded budget, in input order
    - `maxRetries: 0`
    - splitting on 5xx and on connection errors, bounded at 6 requests for a dead server
    - no split on 4xx
- The `services/code-index` suite passed 841/841 across 36 files.
- `tsc --noEmit` exited 0. ESLint passed with no increase in suppressions.
- The VSIX `zoo-code-3.84.4.vsix` was built, installed, and copied into the m5max flake (sha256 `163aa735…de0a3`).

FIX 2 (OmniRoute):

- `embeddings-batch-split.test.ts` passed 13/13.
- The embedding suites passed 147/147, and the memory/provider embedding suites passed 106/106.
- `typecheck:core` exited 0. The full `tsc` run found no errors in touched files; its 5,860 errors were all already in the repo.
- ESLint, prettier, and the pre-commit hooks passed.
- The full `npm test` was not run.

FIX 3 (kube):

- The rollout finished with 4/4 pods updated, and all 4 regenerated graphs contain `truncate: true, max_length: 8192`.
- A ~7.9K-token input returned 200. Inputs of 15K, 25K, and 48K tokens returned a 400 `longer than allowed 8192`.
- In OVMS 2026.4.0, `truncate` does not actually truncate on the embeddings path, so `max_length=8192` works as a hard per-item reject cap. This was chosen on purpose. No known caller exceeds it: Zoo items are capped at 8191 tokens and memory traffic is about 400 tokens.

## Deploy digests

- `registry.celestium.life/library/omniroute:3.8.60-embed-split-20261003`: `sha256:a60f64791b2bcf414da391dba18625003a554f67099afffc34053eaf417bb7f9`. Built from `e16735ba1` and deployed via kube `8672d4b`.
- `registry.celestium.life/library/omniroute:3.8.60-embed-split-r2-20261003`: `sha256:995e03a01408b01c309a08e81c15f566fdf99de78b52f83e8b4d44bcb29435d4`. Built from `bb7a38057` and deployed via kube `2fc8d37`. This is the current image; pod `omniroute-79565bf8c-pqxcn`'s imageID matches the digest.

## 700-input live result

The test was `POST /v1/embeddings` to `arc-embed/qwen3-embedding-0.6b` with 700 varied strings.

| Run                               | Result                                                                             | Split           | call_logs             | Pod memory peak                                               |
| --------------------------------- | ---------------------------------------------------------------------------------- | --------------- | --------------------- | ------------------------------------------------------------- |
| Iteration 1 (`a60f6479…`), 09:26Z | 200 in 63.4 s, 700 embeddings, `index == position`, dimension 1024, 114,136 tokens | 22 sub-requests | 1 row, 200            | pod 0: 3434 Mi, pod 1: 3516 Mi (cgroup `memory.peak`)         |
| r2 (`995e03a0…`), 10:18Z          | 200 in 65.7 s, 700 embeddings, in order, dimension 1024, 114,351 tokens            | 22 sub-requests | 1 row, 200, 64,139 ms | highest 3322 MiB, on pod 2 (pods 0/1/3: 2954, 2834, 2741 MiB) |

The fleet-wide peak was about 3.3–3.5 GiB. The limit was 16Gi at the time. Before the fix, the same batch went above 15 GB and was OOMKilled. A real client batch, zoo-m5 with 709 items, also went through r2: it was split into 23 sub-requests and returned 200 in 88.4 s.

## Pod health

FIX 2 live verify: I cannot confirm "0 restarts, 4 ready" for this stage. The record shows something different:

- The r2 test ran with 3 of 4 pods Ready. Pod 3 was already unready before the test started.
- Between 10:18:01Z and 10:20:10Z there were no restarts and no Ready transitions.
- Between 09:46Z and 10:18Z, about 11 `Error/137` liveness restarts happened with no test load.
- Pod 3 restarted at 10:21:36Z and pod 2 at 10:24:34Z, after the test.
- There were 0 OOMKilled terminations and 0 kernel `oom-kill` lines on gremlin-1..4.
- The restarts come from the separate, pre-existing i915 VF fence-stall issue, not from FIX 2. The kernel logged 13 `Fence expiration time out` errors since 09:45Z (see `~/sources/kube/.agents/tasks/ovms-embeddings-crashloop.md`).
- The orchestrator changed the FIX 2 gate to "0 OOMKilled". That gate is met.

After the FIX 3 rollout: confirmed. At 10:32:26Z and again at 10:35:52Z:

- 4/4 ovms-embeddings pods were Ready with restartCount 0 and no `lastState.terminated`.
- One pod runs on each of gremlin-1..4 with the 8Gi limit and 2Gi request.
- cgroup memory peak was 2.9–3.4 GiB.

## Open follow-ups (non-blocking, from reviews)

- The i915 fence-stall liveness restarts need their own investigation.
- File an upstream OVMS issue: the embeddings calculator should set `truncation = true` along with `max_length`.
- `--max_length` caps each item, not the padded batch. FIX 1 and FIX 2 remain the real OOM guard.
- The 2Gi request is below the measured 2.4–3.4 GiB usage, which raises the pods' eviction priority under node pressure.
- On a failed split, OmniRoute's live dashboard event drops partial tokens, although call_logs records them.
- The Zoo watcher cap does not follow a user-lowered `embeddingBatchSize`. Cloud OpenAI-compatible embedders now send more requests.

## User action

Run the rebuild, then reload VS Code so it picks up the new Zoo Code VSIX:

```
darwin-rebuild switch --flake ~/sources/m5max-darwin-flake#stabulous
```
