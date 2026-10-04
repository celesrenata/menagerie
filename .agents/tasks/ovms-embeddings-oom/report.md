# ovms-embeddings OOMKilled: root cause and fix

Read-only investigation, 2026-10-03 08:39–09:01Z. No cluster state, manifests, or code were changed.

## Summary

The OOMs are not a leak and not load volume. They are a poison request: one oversized embedding request kills whichever replica gets it, and client retries carry the same request to the next replica.

- What kills a pod: Zoo Code's file-watcher indexing path (`api_key_name = zoo-m5`, OpenAI JS SDK 5.23.2 on the Mac) sends one `/v1/embeddings` request with all chunks of one large file. The crash-time requests carried 707–725 inputs (~45K real tokens, ~210 KB body). OVMS runs the whole array as a single GPU inference. Within 2–4 s, GPU buffer memory goes from about 1.2 GB to the cgroup limit.
- Raising the limit did not help. At 16Gi, all 4 fresh pods were OOMKilled again at 08:47:08–13Z by two batches of 707 and 709 inputs. Kernel memcg stats at the kill show `shmem 16.4 GB` and `anon 0.68 GB`. The peak need of one such request is above 15 GB and has no upper bound.
- Where the memory goes: the gremlins use a Meteor Lake Arc iGPU (`0x7d55`) through an i915 SR-IOV VF. GPU allocations are i915 GEM shmem objects in host RAM, and they are charged to the pod's memory cgroup as unevictable `shmem`. Process RSS stays under 1 GB (`shmem-rss:0`). The graph has `truncate: false` and no per-request item or token cap, and the batch is padded to its longest member (inferred, see 3d). So a 700-item batch with one 1,129-char item costs about 700 × longest, not the sum of real tokens.
- Why all 4 die together: each poison batch is sent 3 times. The OpenAI SDK default is `maxRetries: 2`, and the log shows `x-stainless-retry-count: 2`. The file watcher also processes up to 10 files concurrently and re-fires. Each attempt is round-robined by the Service to a different healthy replica. Every OOM kill on every node lines up within about 1 s with a `zoo-m5` 502 in OmniRoute `call_logs`.
- LAN bypass: no traffic arrived through the `ovms-embeddings-lan` LoadBalancer (:2702 / NodePort 31323) while I checked. Zero conntrack flows on all 4 nodes, and every kill is explained by OmniRoute-logged `zoo-m5` requests. Internal OmniRoute traffic (memory/qdrant embeddings, `api_key_name` null, ~400 tokens, ~1/min) is harmless.
- The 404 `Mediapipe graph definition with requested name is not found` at 08:29:20Z is not a wrong model name. It was the same `zoo-m5` 716-input batch on SDK retry #2, with the same model `arc-embed/qwen3-embedding-0.6b` as that client's successful calls. Most likely it hit a just-restarted container whose REST port was already listening while its graph was still loading. In the logs, REST is up at 08:37:18.48 and the graph is AVAILABLE at 08:37:24.89, about 6 s later.

Durable fix: bound the work per request.

1. Zoo client: cap inputs per HTTP request and the padded-token budget, honor `embeddingBatchSize` in the file-watcher path, sort by length, set SDK `maxRetries: 0` for embeddings, and split a failed batch instead of resending it.
2. OmniRoute: split oversized embedding input arrays before forwarding to `arc-embed`, so every caller is protected.
3. OVMS: `truncate: true` with a bounded max length.

After those, the memory limit can go back to about 8Gi. Section 5 has the details.

---

## Evidence

### 1. Memory growth profile: flat, then a single-request spike

`kubectl top pod -n omniroute-memory` every 60 s, 08:39–09:00Z (22 samples; raw data in the Appendix):

```
08:39  1826 1828 1851 1852 Mi
08:46  1835 1834 1892 1854 Mi
08:47:08-13Z  all 4 OOMKilled at 16Gi (the 60 s sampler missed the spike)
08:48  1853 1833 1870 1827 Mi   (fresh containers)
09:00  1938 1840 1922 1875 Mi
```

- There is no steady growth. The readiness probe (`POST /v1/embeddings {"input":"ping"}` every 5 s) and internal traffic (~1 request/min) do not grow memory.
- cgroup breakdown on an idle pod (`/sys/fs/cgroup/memory.stat`): `anon 0.60G`, `shmem 1.18G` (all unevictable). `memory.current` is 2.39G and `memory.peak` is 2.82G (the peak is from model compile at startup). The shmem is the GPU-resident model and buffers.
- Kernel OOM records (read-only `journalctl -k` / `dmesg` on gremlin-1..4) at the 8Gi limit, for example gremlin-1 08:34:58Z:
    ```
    memory: usage 8388608kB, limit 8388608kB
    anon 684015616   shmem 7885848576   unevictable 7443865600   file_mapped 0
    Killed process (ovms) anon-rss:667984kB file-rss:301140kB shmem-rss:0kB
    ```
    At the 16Gi limit, all 4 nodes at 08:47:08–13Z show `memory: usage 16777216kB`, `anon ~0.66–0.72 GB`, `shmem 16.44–16.49 GB`.
- Conclusion: the pressure is GPU buffer memory. On this integrated GPU it is host shmem charged to the container. It jumps by more than 15 GB inside one request; the OmniRoute 502 durations at kill time are 3.5–7.3 s. Prometheus has no cAdvisor `container_*` series for `omniroute-memory`; only kube-state-metrics and node-exporter are scraped for it. So I could not get sub-minute history, and the kernel OOM records are the authoritative data.
- Node-exporter `MemTotal-MemAvailable` on the 4 nodes is flat before each kill and drops 2.5–4 GB after it, with no ramp at 1-minute resolution. That fits a spike, not a leak.

### 2. Clients and request shapes

OmniRoute `call_logs` (`/app/data/storage.sqlite`, read-only) for `path like '%embedding%'`. Bodies come from `/app/data/call_logs/<date>/*.json` artifacts (`requestBody.input_count`, `pipeline.clientRawRequest`).

| caller                                                                                                                    | volume since 10-01            | shape                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `zoo-m5` (Zoo Code on the Mac, `user-agent: vn/JS 5.23.2`, `x-stainless-os: MacOS`)                                       | 5,620 OK / 26 × 502 / 1 × 404 | mostly < 1K tokens. Tail: 98 requests 5–10K, 19 at 10–20K, 7 above 20K tokens. Max 54,733 tokens. |
| internal (null key: OmniRoute `memoryEmbeddingProviderModel` / `qdrantEmbeddingModel` = `arc-embed/qwen3-embedding-0.6b`) | 1,128 OK / 63 × 502           | 1 input, about 400 tokens. Occasional 4–7K.                                                       |
| `sops-management`, `live-verify-arc-topology-temp`                                                                        | 4                             | trivial                                                                                           |

Every kernel OOM kill matches a `zoo-m5` large batch (kernel time, then call_logs row time and input_count):

| kernel OOM kill (node, UTC)                                  | OmniRoute `zoo-m5` row                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| g2 01:49:00, g3 01:49:14, g4 01:49:15                        | 01:49:15.0 502 (15.0 s, 716 inputs); 01:49:16.0 502                                          |
| g1 01:49:35, g4 01:49:36, g3 01:49:38                        | 01:49:35.6 502; 01:49:38.2 502                                                               |
| g2 08:29:16, g1 08:29:17, g4 08:29:18                        | 08:29:17.9 502 (716 inputs); 08:29:19.0 502; 08:29:20.0 404 (`x-stainless-retry-count: 2`)   |
| g4 08:30:50, g2 08:30:51, g1 08:30:53, g3 08:30:55           | 08:30:51.5 / 53.4 / 55.4 502                                                                 |
| g4 08:34:56, g1 08:34:58, g2 08:35:00, g3 08:35:01           | 08:34:58.3 / 08:35:01.2 / 08:35:02.2 502                                                     |
| g3 08:35:33                                                  | 08:35:33.7 502                                                                               |
| **16Gi:** g1 08:47:08, g4 08:47:09, g2 08:47:12, g3 08:47:13 | 08:47:08.8 502 (707), 08:47:13.2 502 (709), 08:47:13.2 502 (707), plus 3 more 502s (707/709) |

The poison batch at 08:29:20, from the retained raw request: 716 inputs, `content-length 213263`, item lengths 50–1,129 chars with a median of 158. The content is a JSON export of OmniRoute combos (`{"name":"local/5090","models":[...]}`). The real token count is about 45K (the 725-input sibling at 01:49:56 reports `prompt_tokens 44914`). Padding to the longest item multiplies the work about 6–7×. For contrast, the largest batch that succeeded at 8Gi was 60 inputs of uniform 1,031-char hex strings (54,733 tokens, no padding waste).

Code paths in this repo that produce it:

- `src/services/code-index/processors/file-preparation.ts` `FilePreparation.preparePoints()` calls `embedder.createEmbeddings(texts)` with every block of one file. The file watcher uses this through `file-watcher.ts` `processFile()`. `codeIndex.embeddingBatchSize` (default 60) is only applied to the Qdrant upsert loop (`file-watcher.ts` ~L362), not to embedding. Since `e277ab927` (2026-09-29) this has been the extracted `FilePreparation`.
- `src/services/code-index/embedders/openai-compatible.ts` `createEmbeddings()` packs items only by estimated tokens (`chars/4`) up to `MAX_BATCH_TOKENS = 100000`, with `MAX_ITEM_TOKENS = 8191` (`constants/index.ts`). There is no item-count cap. A 1 MB file (`MAX_FILE_SIZE_BYTES`) can become one request of hundreds or thousands of inputs.
- The same file builds `new OpenAI({ baseURL, apiKey })` without `maxRetries`, so the SDK default of 2 retries applies on connection errors and 5xx. Zoo's own `_embedBatchWithRetries` only retries 429s. `FILE_PROCESSING_CONCURRENCY_LIMIT = 10` in `file-watcher.ts` lets two big files (707 and 709 inputs at 08:47) be in flight at once.

Direct LAN traffic: `/proc/net/nf_conntrack` on gremlin-1..4 showed 0 flows to dport 2702/31323. OVMS pods saw only kubelet probes and OmniRoute (`10.42.3.218`). OVMS has no access log at `--log_level` INFO and `--metrics_enable` is not set, so I can't fully rule out historical LAN use. It is not needed to explain any kill.

### 3. OVMS / MediaPipe configuration

`/models/OpenVINO/Qwen3-Embedding-0.6B-int8-ov/graph.pbtxt` is regenerated on every pod start by the `model-pull` init container (mtime 08:38):

```
calculator: "EmbeddingsCalculatorOV"
normalize_embeddings: true, truncate: false, pooling: LAST,
target_device: "GPU", plugin_config: '{"NUM_STREAMS":"1"}'
# OVMS_GRAPH_QUEUE_MAX_SIZE: AUTO
```

- (a) Device: GPU (`Available devices: CPU, GPU`). The GPU is the Meteor Lake iGPU via an i915 VF, so host memory is used.
- (b) Model `config.json`: hidden 1024, intermediate 3072, 28 layers, 16 Q / 8 KV heads, `max_position_embeddings 32768`. With `truncate: false`, any item up to 32K tokens is accepted.
- (c) No max batch, no max total tokens, no static shapes, no CACHE_DIR. The OVMS 2026 embeddings options are only `--num_streams`, `--normalize`, `--truncate`, `--pooling`, and a max input length (the docs print it as `--max_legth`) ([OVMS parameters](https://docs.openvino.ai/2026/model-server/ovms_docs_parameters.html)). OVMS has no server-side request-size cap for embeddings.
- (d) Padding (inference, not instrumented): the tokenizer pads the batch to its longest member. The OpenVINO GPU plugin compiles and allocates per dynamic shape, and its memory grows with dynamic shapes ([openvino#27198](https://github.com/openvinotoolkit/openvino/issues/27198)). Intel's iGPU guide confirms iGPU allocations come out of host RAM ([Managing iGPU memory](https://docs.openvino.ai/nightly/openvino-workflow/running-inference/optimize-inference/managing-igpu-memory-usage.html)). The steady-state growth effect here is small: 1.83 to 1.94 GB over 22 min. The kill comes from the per-request spike.
- Rough sizing from the data: about 55K padded positions succeeded under 8Gi, while about 300K or more padded positions needed more than 15 GB. That puts the cost around 50–120 KB per padded token position on this stack. This is a bracket from two data points, not a measurement.
- `--rest_workers` defaults to 22, and OVMS log says `Will start 22 REST workers`. Concurrent big requests on one pod add up.

### 4. Why all 4 died together

The poison batch is deterministic, and every replica has the same limit, so each attempt kills its target. Each `zoo-m5` batch is attempted 3 times: the SDK's `x-stainless-retry-count` goes 0 → 1 → 2. Up to 10 files are in flight at once, and the file watcher re-fires the same file later. The Service spreads attempts across replicas, which were evenly balanced after `d76ace9`. The result is 3–4 replicas killed within 2–5 s, repeating at 08:29, 08:30, 08:35, and 08:47. The earlier restart storms on 10-01 and 10-02 ended as `Error/137`, not OOMKilled. Those were liveness kills from the i915 VF fence-stall, documented in `~/sources/kube/.agents/tasks/ovms-embeddings-crashloop.md` and fixed by `d76ace9`. That is a separate issue. The OOMKilled ones started on 10-01 at 11:18Z (gremlin-3), then 10-03 at 01:49Z (kube-state-metrics `kube_pod_container_status_last_terminated_reason`).

---

## Recommendations (not applied)

In priority order. Expected effects are estimates from the sizing above.

1. **Zoo Code client (this repo), the root producer.**
    - In `openai-compatible.ts` `createEmbeddings()`, add an item-count cap per HTTP request: use `codeIndex.embeddingBatchSize`, or a new constant of 32 for openai-compatible. Also add a padded budget, `count × max(itemTokens) ≤ ~32K`, instead of only `sum ≤ 100K`. Sort texts by length before batching so batches pad less, and keep the index mapping. This bounds each request to roughly 2–4 GB worst case on OVMS.
    - Construct the embeddings `OpenAI` client with `maxRetries: 0`, or 1 with jitter. On 5xx or connection-reset, bisect the batch instead of resending it unchanged. This stops one bad file from walking across every replica.
    - Optionally skip or deprioritize JSON/data files with no line structure (here a combos export). Alternatively, rely on `.rooignore`.
    - Workaround the user can apply right away: add the offending JSON export to `.rooignore`. The path isn't known; it's a JSON export of OmniRoute combos about 200 KB in size. Setting `codeIndex.embeddingBatchSize` low does not help, because the file-watcher path ignores it.
2. **OmniRoute (protects every caller; matches "OmniRoute should pay attention to what kind of requests it gets").**
    - For `/v1/embeddings` to `arc-embed`/`ovms-arc`, split `input` arrays larger than N (32) or larger than T padded tokens into sequential sub-requests, then concatenate `data` and `usage`.
    - Don't retry onto sibling replicas when an embeddings attempt ends in an upstream connection reset right after send. Treat it as a poison request and fail fast after one attempt.
    - The prior note says OmniRoute `requestRetry: 3` retries onto siblings. I did not re-verify that setting in this run.
3. **OVMS graph (defense in depth).** Set `--truncate` (true) and a max input length of 2048 tokens on the `model-pull` init container args in `~/sources/kube/omniroute-memory/ovms-embeddings-statefulset.yaml`. The graph is regenerated each start, so editing `graph.pbtxt` by hand won't stick. Zoo chunks are at most about 1,150 chars, so this loses nothing for code search, and it caps how far one long item can pad a batch. It does not cap item count, so 1 and 2 are still required. Check the exact flag name with `ovms --help`, since the docs print `--max_legth`.
4. **Memory limit.** 16Gi did not prevent the OOM and only raises the blast radius on the node; a node is about 94 GB shared with 4–5 GPU pods. Once 1 or 2 is in place, set request 3Gi and limit 8Gi. Idle is about 1.9 GB and bounded requests stay under about 4 GB. Keep the limit, so a future unbounded request kills one container instead of pressuring the node.
5. **Observability (optional).** Add `--metrics_enable` to OVMS. Either fix the Prometheus cAdvisor scrape so `container_memory_working_set_bytes` exists for `omniroute-memory` (currently missing), or alert on `kube_pod_container_status_last_terminated_reason{reason="OOMKilled",namespace="omniroute-memory"}`.

## Not verified / caveats

- Padding behavior and the cost per padded position are inferred from the OOM records and two successful batches. I did not send synthetic batches, because that could have killed pods.
- I didn't find the exact workspace path of the offending JSON file on the Mac.
- The 404 explanation (request reached a restarting container whose graph wasn't loaded yet, via stale endpoints) fits the timing but wasn't directly observed.
- I couldn't confirm the OmniRoute-side retry count (`requestRetry`) from storage in this run.

## Appendix: raw sampler (`kubectl top`, Mi; pods 0 1 2 3)

```
08:39 1826 1828 1851 1852 | 08:40 1832 1833 1854 1853 | 08:41 1834 1833 1854 1853 | 08:42 1834 1834 1890 1853
08:43 1835 1834 1891 1854 | 08:44 1835 1834 1891 1853 | 08:45 1835 1834 1892 1854 | 08:46 1835 1834 1892 1854
[08:47:08-13 OOMKilled x4 at 16Gi]
08:48 1853 1833 1870 1827 | 08:49 1859 1838 1876 1833 | 08:50 1859 1839 1876 1869 | 08:51 1864 1840 1876 1870
08:52 1864 1840 1876 1871 | 08:53 1865 1840 1877 1871 | 08:54 1865 1840 1877 1871 | 08:55 1865 1840 1877 1871
08:56 1865 1840 1877 1871 | 08:57 1934 1840 1877 1871 | 08:58 1938 1840 1877 1871 | 08:59 1938 1840 1922 1875
09:00 1938 1840 1922 1875
```
