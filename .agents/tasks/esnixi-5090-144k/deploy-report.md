# esnixi 5090 144K deploy report

Result: PASS (all four checks). Verified over SSH at 2026-10-03 17:36 PDT.

Deployed: commit `b1869ed` (nix-flakes-refactored, main), via the user's interactive
`sudo nixos-rebuild switch --flake .#esnixi`. Generation `system-440-link` →
`/nix/store/il8xbpf9q7ww3xwx3h99rhmzalcsbgdp-nixos-system-esnixi-...` (it was 439 / `qsnq8v0a...`).

## Checks

1. The vllm.service command line is correct. MainPID 1057862 (`/proc/<pid>/cmdline`) includes
   `--max-model-len 147456`. vLLM non-default args report `'max_model_len': 147456`, `max_num_seqs: 3`.
   The unit is active/running, Result=success, and it entered that state at 17:08:16.
2. The model endpoint reports the new context. `GET http://127.0.0.1:8010/v1/models` returns `qwen3.8-27b-nvfp4`
   with `"max_model_len":147456`.
3. The switcher is healthy. `vllm-switcher.service` is active/running with NRestarts=0, and `GET 127.0.0.1:8011/healthz` returns
   `{"status":"ok"}` 200. vLLM has served 27 `POST /v1/chat/completions` 200s since it started up.
   The switcher log shows 2 `BrokenPipeError` tracebacks (17:18). These are clients disconnecting mid-stream, and the switcher itself kept running.
4. There is no unrecovered OOM. The only OOM came from the expected cold start, and the fast retry fixed it. Details below. There are 0 OOM lines
   in `journalctl -u vllm` after 17:08:16.

## Cold start / fast retry

- 17:06:06: vllm.service is started by the switch, which also begins the cold torch.compile.
- 17:07:52: EngineCore OOMs. It was allocating the 5.46 GiB KV cache with 7.31 GiB "free",
  while the process held 23.34 GiB, including 5.70 GiB in CUDA-graph pools. The unit failed at 17:07:58.
- 17:07:59: The switcher logs `coder start failed (unit restarted (NRestarts 0->1)); fast retry 1/2 in 15s`.
- 17:08:16: The retry starts vllm.service. The torch.compile cache is now warm.
- 17:09:47: `Application startup complete`.

The retry recovered on its first attempt, with no second retry. Startup took about 91 s from the retry start,
about 109 s from the failure, and about 3m41s from the first start to serving. During the switch window,
clients got 409 `switching ... retry` responses (17:08:12, 17:09:01), which is expected.

GPU memory at verification time: 30505 / 32607 MiB used, which leaves about 2 GiB of headroom.
