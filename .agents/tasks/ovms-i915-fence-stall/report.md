# ovms-embeddings liveness kills: i915 "Fence expiration time out" root cause

Read-only investigation, 2026-10-03 10:27–11:11Z. I changed nothing on the cluster, the nodes, the manifests, or any code. The tools used were kubectl get/describe/logs/exec (read-only), Prometheus queries over a port-forward, read-only SSH to gremlin-1..4 (journalctl, /proc, sysfs, debugfs reads), a read-only SQLite query of OmniRoute `call_logs`, and a local clone of `strongtz/i915-sriov-dkms@2026.09.16` to read source.

## Summary

The "fence stall" is not a fence wait, GPU contention, or a lost interrupt. It is i915's **per-request watchdog** killing an embedding inference that runs longer than **20 s**. The compute runtime never recovers from that, so the OVMS process wedges for good.

1. **Trigger: one long input.** OmniRoute's internal context-summary embedder (`api_key_name = null`) sends a single 20,000-char `"## Conversation Summary…"` input of **9,276 tokens**. On the Arc VF, single-sequence latency grows faster than linearly with length. Measured from `call_logs`: 1k tokens 0.8 s, 4k 4.6 s, 6k 10.1 s, 7k 13 s, 8.85k 18.7 s, and 9.28k more than 20 s.
2. **Kernel kill.** The dkms i915 sets every GEM context's watchdog to `request_timeout_ms = 20000` (`CONFIG_DRM_I915_REQUEST_TIMEOUT=20000`). `intel_gt_watchdog_work()` in `gt/intel_gt_requests.c:259` prints `Fence expiration time out i915-<pdev>:ovms[tid]:<seqno>!` and calls `i915_request_cancel(rq, -EINTR)`. Every fence line lands at request start + 20 s.
3. **Permanent wedge in userspace.** After the cancel, the VF's ccs0 is idle (`Awake 0`, no requests, `Idle? yes`, reset count 0) and the process's `drm-engine-compute` counter stops moving. Meanwhile one OVMS thread spins at about 98% CPU, which fits NEO (libze-intel-gpu 26.18.38308) polling a completion tag that the cancelled batch will never write. The graph uses `NUM_STREAMS 1`, so every later inference queues behind it.
4. **How that becomes exit 137.** Each readiness probe (an exec `curl -m 2` POST embedding every 5 s) and each client request leaves a stuck request inside OVMS. After about 22 × 5 s ≈ 110 s, all 22 drogon unary threads are taken (`Will start 22 REST workers`). Then `/v2/health/live` stops answering too, the 6 × 15 s = 90 s liveness budget runs out, and kubelet sends SIGTERM. OVMS logs `HTTPServerModule shutting down` but cannot exit, so it is SIGKILLed after the 30 s grace period, giving exit 137. Fence-to-kill took 3m18s to 7m.
5. **Why all 4 pods fail together and why it comes in waves.** The client retries the same poison input, and each retry lands on another replica through the Service. That gives fleet-wide storms while the summary is being re-sent, and quiet stretches when it isn't. One example is the 26 h with no liveness kills from 10-02 06:47Z to 10-03 08:29Z (the 01:49Z restarts in that window were OOM kills). This is the same mechanism as the earlier OOM poison batch.

**Root-cause category:** an OVMS workload limit (unbounded sequence length) combined with the i915 driver's default 20 s request watchdog, plus a compute-runtime failure to recover from a cancelled request. It is **not** contention, **not** a firmware hang, and **not** a probe that is too aggressive. The probes only time the kill; the process can never recover on its own.

**State today:** revision 5 (kube `2af4afd`, `--max_length=8192 --truncate=true`, rolled out 10:29–10:32Z) rejects the 9,276-token input with HTTP 400 `Input length 9276 longer than allowed 8192`. That happens even though `truncate: true` is in `graph.pbtxt`. Since the rollout there have been **0 fence timeouts and 0 restarts on all 4 nodes** (checked at 11:11Z, about 40 min). In the hour before, there were about 20 restarts. The margin is thin, though: from the latency curve, an 8,192-token input would take about 16–17 s against a 20 s limit, with no headroom for GPU contention.

## Manifest version observed

`/Users/celes/sources/kube/omniroute-memory/ovms-embeddings-statefulset.yaml` was read at 10:27Z (live revision 4, `86d9675b9f`, 16Gi/4Gi):

- liveness: `httpGet /v2/health/live`, `initialDelaySeconds 120`, `periodSeconds 15`, `timeoutSeconds 5`, `failureThreshold 6` (from `d76ace9`). The brief described a different liveness probe (a POST every 5 s); that is out of date.
- readiness: exec `curl -sf -m 2 -X POST /v1/embeddings {"input":"ping"}`, `periodSeconds 5`, `timeoutSeconds 3`, `failureThreshold 3`.

At 10:29:34Z the fix workflow created revision 5 (`6cc48c746c`). It changes the limits from 16Gi/4Gi to 8Gi/2Gi and adds `--truncate=true --max_length=8192` to the `model-pull` init args (kube HEAD `2af4afd`). The live `graph.pbtxt` now contains `truncate: true, max_length: 8192, plugin_config '{"NUM_STREAMS":"1"}'`.

Revision history (`kubectl get controllerrevisions`):

| Rev | Created      | Change                                                             |
| --- | ------------ | ------------------------------------------------------------------ |
| 1   | 10-01 09:39Z | original                                                           |
| 2   | 10-01 23:34Z | image pinned, readiness switched to the embedding curl (`6e9fcb8`) |
| 3   | 10-02 00:30Z | liveness softened (`d76ace9`)                                      |
| 4   | 10-03 08:37Z | 16Gi (`47747f7`)                                                   |
| 5   | 10-03 10:29Z | 8Gi, max_length/truncate (`2af4afd`)                               |

Storms happened under revisions 1, 3 and 4, and quiet stretches happened under revision 3. No spec change lines up with them, but client traffic does (Evidence 4).

## Evidence

### 1. Platform versions (all 4 nodes identical)

- Kernel `7.2.5` (NixOS 26.11.20260913). Cmdline: `i915.enable_guc=3 i915.max_vfs=7 i915.force_probe=7d55 module_blacklist=xe intel_iommu=on iommu=pt`.
- i915 module `2026.09.14-sriov`, from flake input `github:strongtz/i915-sriov-dkms?ref=2026.09.16` (rev `b42c0f8`). That is the latest release; its README lists kernels 6.17–7.2 as supported. The same README says the **xe driver does not support MTL/LNL** SR-IOV.
- Firmware: GuC `mtl_guc_70.bin` 70.53.0 (GT0 and GT1), HuC `mtl_huc_gsc.bin` 8.5.4 (authenticated), DMC `mtl_dmc.bin` v2.23. SLPC and RC are enabled.
- Kconfig: `DRM_I915_REQUEST_TIMEOUT=20000`, `FENCE_TIMEOUT=10000`, `HEARTBEAT_INTERVAL=2500`, `PREEMPT_TIMEOUT_COMPUTE=7500`. Live `/sys/module/i915/parameters/request_timeout_ms = 20000`. `enable_hangcheck=Y`, `reset=3`.
- PF scheduling provisioning (`/sys/class/drm/card1/prelim_iov/{pf,vf1..7}/gt0`): `exec_quantum_ms=0` and `preempt_timeout_us=0` for the PF and every VF. Policies are `engine_reset=0` and `sched_if_idle=0`. `adverse_events` is empty.
- CPU: Intel Core Ultra 9 185H, 22 threads, `avx_vnni`, no AMX.
- OVMS 2026.4.0.869b2186a (OpenVINO 2026.4.0). NEO `libze-intel-gpu1` / `intel-opencl-icd` 26.18.38308, IGC 2.34.4.

### 2. What the message actually means (source)

- `drivers/gpu/drm/i915/gem/i915_gem_context.c:~997` calls `intel_context_set_watchdog_us(ce, request_timeout_ms*1000)` for every user context when `CONFIG_DRM_I915_REQUEST_TIMEOUT` is set.
- `drivers/gpu/drm/i915/gt/intel_gt_requests.c:259` (`intel_gt_watchdog_work`): if the request is not completed, it logs `Fence expiration time out i915-%s:%s:%llx!` and then calls `i915_request_cancel(rq, -EINTR)`.
- The timeline name `ovms[553876]` is an OVMS thread. On gremlin-4, `/proc/553862/task/553876` exists, which confirms it belongs to the embeddings process.
- `gt/iov/intel_iov_memirq.c:263`: `Unexpected memirq status 0x0 from ccs0` is logged when the user-interrupt status byte isn't 0xFF. The handler still calls `intel_engine_signal_breadcrumbs()` either way, so no completion is lost. The memirq flood is noise. It is not causal, and the kokoro VFs log thousands of these lines with zero stalls. This corrects the attribution in `~/sources/kube/.agents/tasks/ovms-embeddings-crashloop.md`.

### 3. Live wedged process (gremlin-4, ovms-embeddings-0, fence at 10:29:02Z, inspected 10:30–10:31Z)

- Process 553862 (`--model_name=qwen3-embedding-0.6b`) has 105 threads. 99 are in `futex_do_wait`, 4 in `do_epoll_wait`, and **1 is running (tid 553944) at 98.2% CPU** (utime 12472 → 12764 over 3 s). No thread is in D state.
- In the pod netns, port 8000 had 22 sockets in LISTEN state and **27 in CLOSE_WAIT** (requests abandoned by the client but still held by OVMS). `/v2/health/live` and `/v2/health/ready` both timed out at 5 s, and an embedding call timed out at 8 s.
- fdinfo for `pci-0000:00:02.3-render` showed `drm-engine-compute: 28344704180 ns`, unchanged over 5 s. The GPU was doing nothing.
- debugfs `/sys/kernel/debug/dri/0000:00:02.3/i915_engine_info` for ccs0 showed `Awake? 0`, an empty Requests list, `Idle? yes`, `Reset count: 0`, `heartbeat_interval_ms 2500`, and `preempt_timeout_ms 7500`.
- Previous-container logs (`kubectl logs --previous`) for emb-0, 1 and 2 have no errors at all. Each one ends with `HTTPServerModule shutting down`, followed exactly 30 s later by the exit-137 finish time (crictl, emb-1: shutdown 10:28:12Z, finished 10:28:42Z).

### 4. Timeline correlation

Pod to VF mapping (container `/dev/dri` mapped to host `/dev/dri/by-path`, at 10:27Z):

| Node | ovms-embeddings | kokoro | speaches | other                                                  |
| ---- | --------------- | ------ | -------- | ------------------------------------------------------ |
| g1   | emb-1: .7       | .3     | .6       | none; .1/.2 vfio with no consumer                      |
| g2   | emb-3: .4       | .5     | .7       | reranker .6; .1/.2 vfio (plex worker VM)               |
| g3   | emb-2: .4       | .3     | .5       | clusterplex-pms (all render nodes, idle); qemu on vfio |
| g4   | emb-0: .3       | .5     | .7       | qemu on vfio (plex worker VM)                          |

**Fence timeouts since 09:00Z, all on the embeddings VF:**

| Node | Fence times (Z)                                                      |
| ---- | -------------------------------------------------------------------- |
| g1   | 09:48:56, 09:56:09, 10:01:12, 10:08:53, 10:24:54, 10:30:38           |
| g2   | 09:22:47, 09:35:14, 09:40:53, 09:58:52, 10:08:29, 10:13:52           |
| g3   | 09:25:53, 09:35:53, 09:43:16, 09:52:02, 10:05:47, 10:13:52, 10:20:37 |
| g4   | 09:30:53, 10:01:11, 10:29:02                                         |

Every fence names a different OVMS tid, so each container instance gets one fence and then dies.

**No contention at the moment of the stall.** Per-VF memirq counts show which VFs are active. I counted them in [-60,-20), [-20,0) and [0,+20) s around each of the 22 fences:

- Every window on every node had **only the embeddings VF** active. Kokoro, speaches and the reranker had 0 interrupts.
- On the embeddings VF, activity drops to 2–11 interrupts in the 20 s before the fence. That is one long-running submission.
- gremlin-1 has no PF or VM GPU tenant at all (no process holds renderD128 or a vfio group), and it still had the most fences.

**Fence = request start + 20 s.** OmniRoute `call_logs` rows with `duration ≈ 600 s` (504 "aborted due to timeout"); start = row end − duration:

| 504 row end   | start    | input                                  | fence               |
| ------------- | -------- | -------------------------------------- | ------------------- |
| 09:35:33      | 09:25:33 | 20,000 chars "## Conversation Summary" | g3 09:25:53 (+20 s) |
| 09:58:32      | 09:48:32 | same                                   | g1 09:48:56 (+24 s) |
| 10:08:32 (×2) | 09:58:32 | same                                   | g2 09:58:52 (+20 s) |
| 10:30:17      | 10:20:17 | same                                   | g3 10:20:37 (+20 s) |

At 10:30:58Z, after revision 5, the same input returned `400 … Input length 9276 longer than allowed 8192`, three times. The remaining fences fit retries of that same input to the next replica at roughly 5-minute intervals. For example, 09:30:53 on g4 is 5 min after the 09:25:33 start, and 09:35:14 on g2 is about 5 min later again. I could not tie every remaining fence to a logged row: one `call_logs` row covers a whole logical call, including its retries.

**Single-input latency vs tokens** (all successful single-input `/v3/embeddings` calls since 10-01 09Z):

| Tokens | n   | Median (s) | Max (s)                                                  |
| ------ | --- | ---------- | -------------------------------------------------------- |
| 1k     | 38  | 0.8        |                                                          |
| 2k     | 22  | 2.2        |                                                          |
| 4k     | 13  | 4.6        |                                                          |
| 5k     | 18  | 7.4        |                                                          |
| 6k     | 22  | 10.1       |                                                          |
| 7k     | 4   | 13.0       |                                                          |
| 8.85k  | 1   | 18.7       | (10-03 09:03Z)                                           |
| 9.28k  |     |            | more than 20 s; every attempt was killed by the watchdog |

**Restart history** (Prometheus `kube_pod_container_status_restarts_total`, 30 s steps):

- Liveness storms with all 4 pods together: 10-01 10:17–12:10, 15:45–18:12, 20:53–23:00; 10-02 00:06–00:23 (load test), 04:42–06:47; 10-03 09:28–10:29.
- Quiet for 26 h from 10-02 06:47 to 10-03 08:29. The only restarts in that window were the 01:49Z and 08:29–08:36Z OOM kills, which are a separate issue.
- Embedding call volume was similar in storm and quiet hours (for example 95 calls/h at 10-03 03Z, quiet, vs 71/h at 09Z, storm). Volume doesn't explain the storms; whether the long summary was being re-sent does.

**Time to kill.** emb-1: fence 10:24:54, kill 10:28:12 (3m18s). emb-2: fence 10:20:37, kill 10:24:04 (3m27s). emb-0: fence 10:01:11, kill 10:07:39 (6m28s). emb-3: fence 10:13:52, kill about 10:21:06. That is about 110 s of worker exhaustion, then the 90 s liveness budget, with some variation in how many requests were already stuck.

**After the fix.** Per-second fdinfo monitoring on all 4 nodes, 10:58–11:10Z, showed normal busy/idle cycling, no stalls, and 0 `Fence expiration` lines since 10:32Z. All 4 pods were 1/1 Ready with 0 restarts at 11:11Z.

## Conclusions

1. **Timeline:** every liveness kill follows a watchdog cancel on that pod's VF by 3–7 min. Each cancel lines up with a single ~9.3k-token input started 20 s earlier. No other GPU tenant was active, and there was no GPU hang or reset.
2. **Category:** a workload that exceeds the i915 request watchdog (driver default) combined with the compute runtime's inability to recover. It is not contention, not GuC/firmware, and the probes are not too aggressive.
3. **Versions:** listed in Evidence 1. The driver is already the latest dkms release. I found no upstream bug for MTL SR-IOV "fence timeout" because none is needed: this is documented watchdog behaviour (Kconfig help: "timeout after which any user submissions will be forcefully terminated"). Similar `Fence expiration time out` reports from long compute jobs exist on other Intel GPUs, for example an [A350M mlperf thread](https://community.intel.com/t5/Graphics/Fence-expiration-on-A350M-while-running-mlperf-3d-unet-kits19/m-p/1590568) and [llama.cpp on an Arc iGPU](https://github.com/ggml-org/llama.cpp/issues/16684).

## Recommendations (ranked)

1. **Bound per-request GPU time well under 20 s.** _Partly done in revision 5; tighten it._
    - Lower `--max_length` from 8192 to **4096**, which takes about 4.6 s (or 6144 at about 10 s). At 8192 the estimate is about 16–17 s, which leaves no room for contention or clock drops.
    - Fix the client too: OmniRoute's internal summary embedder (`api_key_name` null, 20,000-char input) should chunk or cap its input at about 12k chars, and should not resend a request that timed out to another replica.
    - Note that `truncate: true` did not truncate. OVMS returned 400 instead, which the fix workflow should know about.
    - Effect: removes the trigger entirely. Risk: long inputs get a 400 (or a lossy truncation) until the client chunks them. Recall quality for long summaries changes, which is user-visible.
2. **Raise the i915 request watchdog**, for example to `i915.request_timeout_ms=60000` in `boot.kernelParams` in `modules/i915-sriov.nix`.
    - The parameter can also be written at runtime (0600, an "unsafe" param that taints the kernel). It only applies to contexts created afterwards, so OVMS needs a restart.
    - Effect: an over-long inference finishes instead of wedging the pod.
    - Risks:
        - With `exec_quantum_ms=0` and `preempt_timeout_us=0` on every VF, one long embedding can hold ccs0 for up to 60 s, starving kokoro and whisper on the same GT.
        - A truly hung batch also takes 60 s to be cleared.
        - The persistent change needs a reboot of each node, one at a time (never gremlin-2/3/4 together; no live VF rebind).
    - Use this as defence in depth behind #1, not as a replacement.
3. **Probe tuning:** keep the liveness probe as it is. A cheaper or longer liveness probe would not help, because the wedge is permanent: the GPU is idle, the runtime spins, and the process can't even exit on SIGTERM. A kill is the only recovery, and a longer probe would only mean more downtime. Keep the embedding readiness probe, since `/v2/health/ready` still returns 200 until the workers are used up.
    - Optional: `terminationGracePeriodSeconds: 5`. Shutdown never finishes on a wedged pod, so this saves about 25 s per kill. Low risk.
    - Effect is small either way.
4. **OVMS settings:** `NUM_STREAMS 1` is already set, and OVMS has no per-request deadline that could stop a GPU job already in flight. Max length (#1) is the only useful lever. Adding `--metrics_enable` would let you alert on request latency above 15 s before the watchdog fires. Low risk.
5. **GPU tenancy limits:** these do not address the root cause, since there was no contention at any stall. Setting a non-zero `exec_quantum_ms` and `preempt_timeout_us` per VF (PF `prelim_iov/vfN/gt0/`) would protect other tenants from a long embedding job, but would also slow the embedding job and push it toward 20 s. Only consider this after #1, and test it on one node first. Medium risk.
6. **Kernel/driver:** no upgrade is available, since the driver is already on the latest dkms and GuC 70.53.0. **Switching to xe is not an option**, because xe has no SR-IOV support on MTL. The memirq `0x0` log flood is harmless. Silencing it would need a driver patch. No action needed.
7. **Move embeddings to the CPU:** this is a fallback only. It has no watchdog. The latency below is an unmeasured estimate for a 0.6B int8 model, 4-core limit, Ultra 9 185H with AVX-VNNI:
    - short 150-token requests: about 0.2–0.5 s (GPU today: 0.08–0.12 s);
    - 6k-token inputs: about 20–60 s (GPU: 10 s);
    - bulk indexing: about 2–4× slower (the 700-item, 114k-token test took 64 s on GPU).

    Risks: CPU pressure on nodes shared with other pods, and slower indexing. A hybrid is worth considering: one CPU replica, used only for inputs over 4k tokens.

## Not verified / caveats

- The NEO busy-poll is inferred from the thread state (one thread at 100% CPU, `wchan 0`, GPU idle). I did not take a userspace stack (no gdb in the image or on the host).
- I did not reproduce the stall on purpose. Sending a 9k-token input would have killed a pod.
- Some fences could not be tied to a specific `call_logs` row (retries inside one logical call). Their timing and VF fit the same mechanism.
- The CPU latency numbers are estimates, not measurements.
- The 0-fence result after revision 5 covers only about 40 minutes.
