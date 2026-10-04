# esnixi switcher fail-safe: live verification

Host: esnixi (`celes@192.168.42.254`), repo `/home/celes/sources/celesrenata/nix-flakes-refactored`. Checked 2026-10-03 ~05:00–05:03 PDT. No secret values were printed or written anywhere.

## Deployed commit

- HEAD: `9fc737590e498c06acda88fb7962429e63134f76` — fix(esnixi): fail-safe vLLM switcher (rollback, breaker, watchdog, deadlines). Working tree clean apart from the untracked `distcc-monitor.sh`.
- `/run/current-system` → `/nix/store/4yhfh06h3alpx56sbfnkybkmp3k23j4j-nixos-system-esnixi-26.11.20260922.6774f7b` (the build in `deploy-report.md`).
- The running switcher's script `/nix/store/qcxignqf9v7g4brl5g40xxwwk7yfyzrz-vllm-switch.py` has the same sha256 as `esnixi/vllm-switch.py` at HEAD (`3b1543ed…c054cc`), so what is deployed is the reviewed code.

## Test results

Re-run on esnixi at the deployed HEAD (full detail in `verification.md`):

- `python3 esnixi/test_vllm_switch.py`: 32 tests, OK. This includes the fail-safe cases: t/x (start failure or NRestarts rise → 409 `start_failed`, coder restored, the next coder request needs no lifecycle action), u/v/w (breaker 409 `backoff` with `Retry-After`, capped backoff, half-open reset), p/p2 (bounded sleep/stop deadlines), q/r (409 `coder_busy`/`coder_resident`), and y–y5 (watchdog).
- `python3 esnixi/test_vllm_idle.py`: 7 tests, OK.

## (a) Forced reader failure: NOT done live, fell back to unit tests plus journal review

I could not inject a reader failure safely without sudo, so no failure was injected:

- `sudo -n true` → "a password is required".
- `systemctl --no-ask-password set-property --runtime vllm-reader.service …` → "Access denied … requires interactive authentication". So polkit gives `celes` no unit control, and I can't write runtime drop-ins under `/run/systemd/system` (root-owned).
- The switcher bearer token `/run/secrets/vllm_switcher_token` is `root:root 0400`, so I couldn't call the switcher port directly with a reader request.
- The only other way to trigger it, a real reader request through OmniRoute, would cause a real (non-failing) production switch and would not test the failure path. I did not do it.

Nothing was changed, so nothing needed reverting. The runtime drop-in dirs `/run/systemd/system/{vllm,vllm-long,vllm-switcher}.service.d/` were already there and empty (dated 2026-09-27). I left them untouched.

Instead, the rollback / 409 / coder-restore behaviour is covered by unit tests t, x, u, s (above). Journal review of `vllm-switcher.service` since the deploy:

```
04:59:04 systemd: Started Authenticated automatic vLLM model switcher for the RTX 5090.
05:00:04 INFO watchdog: adopted awake qwen3.8-27b-nvfp4
```

No errors, no breaker or rollback events, NRestarts=0. Live unit state: `vllm.service` (coder) active since 04:18:26 with NRestarts=0. `vllm-switcher.service` active since 04:59:04 with NRestarts=0. `vllm-reader.service` active since 04:59:04 with NRestarts=0 (still blocked on the GPU flock, as noted in `deploy-report.md`). `GET 127.0.0.1:8011/healthz` → 200. The 5090 has 30273 MiB used (the coder).

To do the live failure test, someone with sudo would need to run something like the steps below. Afterwards, check the journal for `start_failed` / `breaker OPEN`, check that `vllm.service` is serving, then remove the drop-in and run `daemon-reload` again.

```
sudo mkdir -p /run/systemd/system/vllm-reader.service.d
printf '[Service]\nExecStart=\nExecStart=/run/current-system/sw/bin/false\n' | sudo tee /run/systemd/system/vllm-reader.service.d/zz-failtest.conf
sudo systemctl daemon-reload
```

## (b) Normal coder traffic through OmniRoute: PASS

- I read the management key over SSH into a shell variable, used it only in the `Authorization` header, then unset it. It was never echoed.
- `POST https://omniroute.celestium.life/v1/chat/completions` with `model: hybrid/code` and header `X-OmniRoute-Tier: 1` at 2026-10-03T12:02:24Z → **HTTP 200** in 1.02 s. The response model was `qwen3.8-27b-nvfp4` and the content was `pong`.
- The coder journal shows the matching `05:02:25 "POST /v1/chat/completions HTTP/1.1" 200 OK`. There was no switcher lifecycle action, and all three units still had NRestarts=0 afterwards.

## Reversion

No failure injection was done, so nothing needed reverting. No units, drop-ins, or files were changed on esnixi. The local temp response file `/tmp/omni_resp.json` was deleted.
