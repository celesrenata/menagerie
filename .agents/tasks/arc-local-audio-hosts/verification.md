# Verification: OMNIROUTE_LOCAL_AUDIO_HOSTS (iteration 1)

Repo `/Users/celes/sources/celesrenata/OmniRoute`, branch `feat/hybrid-reader-combo`. All commands were run from the repo root.
`TEST` = `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit`

| Command                                                                                                                     | Result                                  |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `TEST` on the 4 new or edited test files (allowlist, routes, live-request helper, topology arc)                             | PASS: 24/24                             |
| `TEST` on all focused files from plan items 1–4, in one invocation (18 files, listed below)                                 | PASS: 125/125, 0 fail                   |
| `npm run typecheck:core`                                                                                                    | PASS: exit 0, 0 `error TS`              |
| `npx eslint --suppressions-location config/quality/eslint-suppressions.json --max-warnings=0` on all 15 changed `.ts` files | PASS: exit 0, no output                 |
| `npm run check:env-doc-sync`                                                                                                | PASS: "Env / docs contract is in sync." |

The 18 focused files were: audio-local-hosts-allowlist, audio-local-hosts-routes, audio-provider-nodes-selection, audio-speech-dynamic-node-9096, audio-live-request-events, audio-speech-handler, audio-transcription-handler, audio-translations-route, audio-nested-model-credential-fallback, 9134-repro-audio-combo-rejection, issue-6686-quota-preflight-coverage, live-request-lifecycle-helper, issue-13544-audio-transcription-call-log, media-cost-headers-handlers, topology-provider-nodes-arc, home-provider-topology-live-state, topology-active-requests-3507, and topology-filtering-and-click (all under `tests/unit/`, `.test.ts`).

## Not run, and other notes

- I did not run the full unit suite, to spare the Mac's CPU. No pre-existing failures turned up in the focused files.
- ESLint suppressions: `config/quality/eslint-suppressions.json` is unchanged; `git status` shows it unmodified. The `src/eslint-suppressions.json` path that AGENTS.md names does not exist in this repo, so I used the plan's `config/quality` command instead. The only changed file with an existing entry is `src/app/api/v1/audio/speech/route.ts` (`no-unused-vars`: 1), and its count did not change.
- The route-level test `audio-local-hosts-routes.test.ts` stubs `fetch` and checks four things. First, speech goes to `http://kokoro-tts.kokoro-service.svc.cluster.local:8880/v1/audio/speech` with no `Authorization` header. Second, transcription goes to the speaches host with no auth. Third, a configured connection key is sent as `Bearer sk-local-test`. Fourth, a node on a non-allowlisted host returns 400 and nothing is fetched. `AUDIO_REMOTE_PROVIDER_NODES` stays at its default (off) throughout.
- "Live request finishes on error" is tested through `runLiveRequestTail` in `live-request-lifecycle-helper.test.ts`, which covers three cases: the tail throws, a finish happens before the throw, and the tail succeeds. The routes' real post-processing doesn't throw on its own, so the plan's decision 4 tests the helper the routes now wrap their tail in.
- Live verification against the cluster still needs an image rebuild, so it is out of scope here.
