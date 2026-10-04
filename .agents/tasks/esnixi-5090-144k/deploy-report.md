# esnixi 5090 144K deploy report

Result: PASS. All four checks pass.

Deployed by the user via interactive `sudo nixos-rebuild switch --flake .#esnixi` at 2026-10-03 17:05:50 PDT.

- Repo HEAD: `b1869ed feat(esnixi): 144K 5090 coder context, coder fast-retry in switcher`
- New generation: `system-440-link` -> `/nix/store/il8xbpf9q7ww3xwx3h99rhmzalcsbgdp-nixos-system-esnixi-26.11.20260922.6774f7b` (previous was 439 / `qsnq8v0a…`, running 131072)
- vllm-reader was inactive throughout, so no manual stop was needed.

## Checks

1. vllm.service command line: PASS
    - MainPID 1057862, active/running since 17:08:16, NRestarts=0 (the counter was reset by the switcher's `reset-failed`).
    - The process args contain `--max-model-len 147456`.
    - The engine config logs `max_seq_len=147456`.

2. `GET http://127.0.0.1:8010/v1/models`: PASS
    - `id=qwen3.8-27b-nvfp4`, `max_model_len: 147456`.

3. Switcher health: PASS
    - `vllm-switcher.service` active/running since 17:06:07, NRestarts=0. It is listening on 127.0.0.1:8011 and returns 401 without a token, so auth is enforced. I could not read the token without sudo, so I did not run an authenticated probe.
    - Its log shows `switch None -> qwen3.8-27b-nvfp4 ok in 216.0s`, and it has been proxying live traffic since (vLLM reports running requests and KV usage of about 35%).
    - One `BrokenPipeError` at 17:09:58 in `proxy()`. A client disconnected mid-stream. This is benign and did not affect the service.
    - `omniroute-vllm-proxy.service` is active.

4. OOM: PASS, with one OOM that recovered.
    - The first coder start (17:06:06) did a cold torch.compile (57.3 s backbone + 4.8 s eagle head). It then hit `torch.OutOfMemoryError` at 17:07:52 during KV/cudagraph setup: it tried to allocate 5.46 GiB with 7.31 GiB free.
    - The fast retry worked as designed. At 17:07:59 the switcher logged `WARNING coder start failed (unit restarted (NRestarts 0->1)); fast retry 1/2 in 15s`. It then ran `reset-failed` and started again at 17:08:16.
    - The retry used the warm compile cache (torch.compile 0.61 s + 0.06 s). Init took 60.0 s, the server was ready at 17:09:47, and it logged `Application startup complete`.
    - Timings:
        - First start to OOM: about 106 s.
        - Retry start to ready: about 91 s.
        - Total switch: 216 s, from the switcher log.
        - Only 1 of 2 retries was used.
    - No OOM or Traceback in vllm logs after 17:09:47. No kernel OOM-killer events.
    - KV cache: 231,087 tokens, max concurrency at 147,456 tokens/request = 1.57x. GPU memory in use: 30505 / 32607 MiB.

## Notes

- The cold-compile OOM will probably happen again whenever the compile cache is invalidated (vLLM or model change). The fast retry covers it at the cost of about 2 extra minutes on that first switch.
- Concurrency at full 147K context is 1.57x. Three concurrent sequences only fit when the prompts are shorter.
