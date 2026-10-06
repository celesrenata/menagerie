# Implementation Plan: Retrieval Fabric

## Overview

This plan implements the Retrieval Fabric in two halves, incrementally and in dependency order:

1. **Menagerie TypeScript** — the logical Retrieval Gateway pure logic and surfaces, serving/dimension sizing coupling, change-awareness/freshness ranking, graceful degradation, deployment-selection logic, metrics, the chunker, and the runnable evaluation harness. These live in the Menagerie `src/` tree alongside the existing code-index service and reuse (never duplicate) the existing embedding guards and `vector-store-factory` dimension enforcement.
2. **Committed declarative config deltas** — edits to the committed manifests at `sources/kube/omniroute-memory/` (digest pin, dual-path real-inference readiness probes + probe scripts, the Qwen3-Reranker-0.6B Deployment replacing the uncommitted `bge-reranker-base` drift, pod-memory sized with the serving ceiling). These modify the committed declarative config and reconcile drift; they are **not** TypeScript and do **not** introduce a parallel deployment system.

Build order: TS data models/types → pure gateway logic → sizing/dimension coupling → freshness/degradation/deployment selection → gateway wiring + metrics → chunker → committed config deltas → config-assertion test → evaluation harness + smoke test → live-cluster verification checklist.

Testing follows `AGENTS.md`: fast-check property tests (100+ iterations, tagged `// Feature: retrieval-fabric, Property N: ...`) for the 9 correctness properties at the narrowest `src` layer; a config-assertion test parsing the committed manifests; a runnable eval harness with a smoke test (not a CI gate); and a manual, non-CI live-cluster check. Run the narrowest Vitest suite plus `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>` after TS edits. Do NOT create `.changeset` files.

## Tasks

- [x] 1. Define gateway data models and types
  - [x] 1.1 Add gateway surface and evidence types
    - Create the retrieval-fabric gateway types module under `src/services/code-index/retrieval-fabric/types.ts`
    - Define `RetrievalIntent`, `RetrieveParams`, `EvidenceItem` (`{ file, startLine, endLine, score, reason, snippet? }`), `EvidencePacket` (`{ items, degraded }`), and the `RetrievalGateway` interface exactly as the design specifies; `RetrieveParams` MUST carry no node/replica selection field
    - Define the internal `RankedCandidate` and `HybridQueryPlan` shapes used by the pure-logic surfaces
    - _Requirements: 8.1, 8.4, 10.3, 22.3_

  - [x] 1.2 Add sizing, dimension, eval, and metrics types
    - Add `ServingSizing` (`perItemServingCeilingTokens`, `maxPaddedTokens`, `maxItems`, `podMemoryLimitGi`) to the retrieval-fabric types
    - Add `DimensionConfig` (`storedDimension`, `qdrantCollectionDimension`)
    - Add `EvalCase`, `EvalConfig`, `EvalResult` as shaped in the design
    - Add the full `RetrievalMetrics` interface including `rawReadsPrecededByRelevantHitPct` and `timeToFirstUsefulEvidenceMs`
    - _Requirements: 6.1, 6.3, 16.4, 16.6, 19.1, 19.2, 19.3, 20.2, 20.3_

- [x] 2. Implement pure gateway logic (fusion, planning, decomposition, bounding)
  - [x] 2.1 Implement `fuseRRF` deterministic fusion
    - Create `src/services/code-index/retrieval-fabric/fusion.ts` with `fuseRRF(rankedLists, k?)` as a pure Reciprocal Rank Fusion over multiple ranked candidate lists; identical inputs MUST produce identical merged order
    - Produce the ~30-50 merged candidate list consumed before reranking
    - _Requirements: 9.4, 12.1, 12.2, 12.3_
    - _Properties: 3_

  - [ ]* 2.2 Write property test for `fuseRRF` determinism and pre-rerank ordering
    - **Property 3: RRF fusion is deterministic and runs before reranking**
    - fast-check: generate arbitrary ranked lists; assert fusing twice yields the identical ranking and the pipeline orders fusion before rerank
    - Tag: `// Feature: retrieval-fabric, Property 3: ...`; 100+ iterations
    - _Requirements: 9.4, 9.5, 12.1, 12.2, 12.3_
    - _Properties: 3_

  - [x] 2.3 Implement `planHybridQuery`
    - Create `src/services/code-index/retrieval-fabric/query-planning.ts` with `planHybridQuery(query)` returning a `HybridQueryPlan`; always include lexical/exact-token and symbol/file/path modes when the query carries an exact token (identifier, error string, named resource, file path, UUID); never rely on dense similarity alone
    - _Requirements: 11.1, 11.2, 11.3_
    - _Properties: 4_

  - [ ]* 2.4 Write property test for exact-token planning
    - **Property 4: exact-token queries include lexical and symbol retrieval**
    - fast-check: generate queries embedding identifiers (e.g. `AUTO_READER_NAME`, `FooFactory`), error strings (`HTTP 502`), resource names (`celestium-le-production`), file paths, and UUIDs; assert the plan includes lexical and symbol modes
    - Tag: `// Feature: retrieval-fabric, Property 4: ...`; 100+ iterations
    - _Requirements: 11.1, 11.2, 11.3_
    - _Properties: 4_

  - [x] 2.5 Implement `decomposeQuery`
    - Add `decomposeQuery(query, intent)` to `query-planning.ts`; expand a multi-concern question into independent queries only where it adds distinct coverage; avoid pointless/duplicate query multiplication
    - _Requirements: 13.1, 13.3_

  - [ ]* 2.6 Write unit tests for `decomposeQuery`
    - Assert the multi-concern "wrong Kubernetes certificate" question decomposes into distinct ingress-TLS / cert-manager `Certificate` / `ClusterIssuer` / hostname queries with no exact-duplicate queries
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 2.7 Implement `toEvidencePacket` bounding
    - Create `src/services/code-index/retrieval-fabric/evidence-packet.ts` with `toEvidencePacket(reranked, degraded)` returning ~5-8 correctly shaped `EvidenceItem`s and the `degraded` flag; never return the full 30-50 candidate set; include `snippet` only where it materially aids the caller
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 14.1, 22.4_
    - _Properties: 2_

  - [ ]* 2.8 Write property test for bounded evidence packet
    - **Property 2: retrieve() returns a bounded evidence packet**
    - fast-check: generate reranked candidate lists of arbitrary size; assert the packet is ≤ ~8 items, correctly shaped, and never the full set
    - Tag: `// Feature: retrieval-fabric, Property 2: ...`; 100+ iterations
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 14.1, 22.4_
    - _Properties: 2_

- [x] 3. Implement serving-ceiling / pod-memory and dimension coupling
  - [x] 3.1 Implement `ServingSizing` coupling logic
    - Create `src/services/code-index/retrieval-fabric/serving-sizing.ts`; raising `perItemServingCeilingTokens` MUST raise `podMemoryLimitGi` monotonically (non-decreasing); `maxPaddedTokens`/`maxItems` MUST never drop below the guard defaults (16384 / 32)
    - Reuse the existing `MAX_EMBEDDING_REQUEST_PADDED_TOKENS` / `MAX_EMBEDDING_REQUEST_ITEMS` constants from `src/services/code-index/constants/index.ts`; do not weaken `DEFAULT_EMBEDDING_REQUEST_LIMITS`, `planEmbeddingRequests`, or the splitter
    - Expose the chosen `podMemoryLimitGi` so it can be emitted into the committed manifest
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 7.1, 7.3_
    - _Properties: 6_

  - [ ]* 3.2 Write property test for sizing coupling
    - **Property 6: raising the serving ceiling raises pod memory and never weakens the guards**
    - fast-check: generate ceiling increases; assert `podMemoryLimitGi` is monotonically non-decreasing and guards never drop below 16384 / 32
    - Tag: `// Feature: retrieval-fabric, Property 6: ...`; 100+ iterations
    - _Requirements: 6.2, 6.3, 6.5, 7.3_
    - _Properties: 6_

  - [x] 3.3 Implement `DimensionConfig` coupling logic
    - Create `src/services/code-index/retrieval-fabric/dimension-config.ts`; accept a configuration iff `storedDimension` (from `getModelDimension` in `src/shared/embeddingModels.ts`) equals `qdrantCollectionDimension`, else reject as a dimension mismatch exactly as `vector-store-factory.ts` enforces
    - Signal that a Matryoshka dimension change requires reindexing `qdrant-0`
    - _Requirements: 16.4, 16.6_
    - _Properties: 5_

  - [ ]* 3.4 Write property test for dimension coupling
    - **Property 5: a Matryoshka dimension change keeps stored and collection dimensions equal**
    - fast-check: generate dimension pairs; assert accept iff stored == collection dim, else reject
    - Tag: `// Feature: retrieval-fabric, Property 5: ...`; 100+ iterations
    - _Requirements: 16.4, 16.6_
    - _Properties: 5_

- [x] 4. Implement freshness, degradation, and deployment-selection logic
  - [x] 4.1 Implement change-awareness / freshness ranking
    - Create `src/services/code-index/retrieval-fabric/freshness.ts`; prefer current code, account for working-tree modifications, parallel worker patches, recently changed files, and files changed after indexing; a stale index entry MUST NOT silently outrank a current changed version of the same file; a file changed after indexing triggers incremental reindex or freshness weighting
    - _Requirements: 18.1, 18.2, 18.3, 18.4_
    - _Properties: 7_

  - [ ]* 4.2 Write property test for freshness ranking
    - **Property 7: a current changed file is not silently outranked by a stale index result**
    - fast-check: generate rankings containing stale+current pairs for a changed file; assert the stale entry never outranks the current file
    - Tag: `// Feature: retrieval-fabric, Property 7: ...`; 100+ iterations
    - _Requirements: 18.1, 18.2, 18.3, 18.4_
    - _Properties: 7_

  - [x] 4.3 Implement graceful degradation across `CodeIndexManager` states
    - Create `src/services/code-index/retrieval-fabric/degradation.ts`; across every `CodeIndexManager` availability state (not configured / disabled / not initialized / Indexing / Indexed), when the fabric or gateway is unavailable, return a `degraded: true` result via existing code indexing and direct reads rather than throwing; do not duplicate the Menagerie-side exploration policy owned by `semantic-first-retrieval`
    - _Requirements: 22.7, 22.8_
    - _Properties: 8_

  - [ ]* 4.4 Write property test for graceful degradation
    - **Property 8: graceful degradation preserves Menagerie function when the fabric is unavailable**
    - fast-check: generate `CodeIndexManager` states with the fabric unavailable; assert a degraded result is returned, never a throw
    - Tag: `// Feature: retrieval-fabric, Property 8: ...`; 100+ iterations
    - _Requirements: 22.7, 22.8_
    - _Properties: 8_

  - [x] 4.5 Implement deployment-selection logic
    - Create `src/services/code-index/retrieval-fabric/deployment-selection.ts`; default reranker is Qwen3-Reranker-0.6B and never 4B without a benchmark quality signal; the fallback topology (3 embedding + 1 dedicated reranker) is selected only when a benchmark-contention signal is present (benchmark-before-fallback gate)
    - _Requirements: 4.2, 4.3, 15.1, 15.2, 15.3_
    - _Properties: 9_

  - [ ]* 4.6 Write property test for deployment selection
    - **Property 9: the 4B reranker and the fallback topology are never the default without a benchmark gate**
    - fast-check: generate deployment-selection inputs; assert default reranker is 0.6B and fallback/4B appear only with a benchmark signal
    - Tag: `// Feature: retrieval-fabric, Property 9: ...`; 100+ iterations
    - _Requirements: 4.2, 4.3, 15.1, 15.2, 15.3_
    - _Properties: 9_

- [x] 5. Checkpoint - pure logic complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Wire the `RetrievalGateway.retrieve()` pipeline and metrics
  - [x] 6.1 Implement `retrieve()` pipeline orchestration
    - Create `src/services/code-index/retrieval-fabric/retrieval-gateway.ts` implementing `RetrievalGateway.retrieve(params)`: decompose → dense (via the existing embedder + Qdrant through the Kubernetes Service, reusing the preserved request-batching/splitting guards) + lexical/symbol → `fuseRRF` → Qwen3 reranker → freshness → `toEvidencePacket`
    - Select which OVMS replica serves each request via OmniRoute / the Service without caller involvement; expose no node/replica parameter; on reranker/fabric unavailability return the fused top candidates bounded and `degraded: true`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.5, 9.6, 11.1, 14.1, 14.2, 22.1, 22.2, 22.3, 22.5, 22.6_
    - _Properties: 2, 3, 4, 7, 8_

  - [ ]* 6.2 Write unit tests for the retrieve() surface
    - Assert `retrieve()` exposes no node/replica parameter, bounds output to ~5-8 items, uses Qwen3-Reranker-0.6B for production reranking, and returns `degraded: true` when the reranker/fabric is unavailable
    - _Requirements: 8.2, 8.4, 14.2, 22.4_
    - _Properties: 2, 8_

  - [x] 6.3 Implement `RetrievalMetrics` recording
    - Create `src/services/code-index/retrieval-fabric/metrics.ts` recording every required field: semantic queries issued, decompositions produced, embedding/reranking latency, candidates before/after rerank, semantic hit rate, subsequent file reads, raw file-read tokens, cache hits, index-freshness misses, reranker top-N quality, the headline `rawReadsPrecededByRelevantHitPct`, and `timeToFirstUsefulEvidenceMs`
    - Wire metric recording into the `retrieve()` pipeline
    - _Requirements: 19.1, 19.2, 19.3_

  - [ ]* 6.4 Write unit tests for metrics
    - Assert the metrics object carries every required field including the headline raw-reads-preceded-by-hit percentage and time-to-first-useful-evidence
    - _Requirements: 19.1, 19.2, 19.3_

- [x] 7. Implement the semantic-boundary chunker
  - [x] 7.1 Implement semantic chunking
    - Create `src/services/code-index/retrieval-fabric/chunker.ts` producing `Semantic_Chunk`s sized below the per-item serving ceiling; target ~500-1200 tokens for source code and ~800-1600 tokens for docs/specs; apply ~10-15% overlap between adjacent chunks; prefer semantic boundaries (function, method, class, module, section, heading) over arbitrary token slicing
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [ ]* 7.2 Write unit tests for the chunker
    - Assert chunks stay below the serving ceiling, hit the source and doc token targets, and apply 10-15% overlap on semantic boundaries
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 8. Apply committed config deltas (declarative manifests at `sources/kube/omniroute-memory/`)
  - [x] 8.1 Digest-pin the embedding StatefulSet image
    - In the committed `sources/kube/omniroute-memory/ovms-embeddings-statefulset.yaml`, replace `openvino/model_server:latest-gpu` with the live digest `docker.io/openvino/model_server@sha256:e7a448ec4eb885cab232a5f5ff8b9f41fb3b6f69401633c2af83cac260c40e8e` on both the `ovms` container and the `model-pull` init container; preserve all other topology (replicas 4, required hostname anti-affinity, i915, nodeSelector, Longhorn 10Gi PVC, fsGroup 5000, model/pull args)
    - _Requirements: 1.8, 2.1, 2.2, 2.3, 21.1, 21.2, 21.3_

  - [x] 8.2 Add dual-path readiness probe scripts
    - Add the committed readiness probe scripts `embed-probe.sh` (tiny real embedding request, asserts a well-formed embedding of the expected dimension) and `rerank-probe.sh` (tiny real rerank request, asserts a well-formed score) under `sources/kube/omniroute-memory/`, mounted/baked as `/opt/readiness/`; report not-ready on failure/timeout even when `/v2/health/ready` is green
    - _Requirements: 5.2, 5.3, 5.4, 5.5_
    - _Properties: 1_

  - [x] 8.3 Replace embedding httpGet readiness with the real-inference exec probe
    - In the committed `ovms-embeddings-statefulset.yaml`, replace/augment `readinessProbe httpGet /v2/health/ready` with the `exec` real-embedding probe (`/opt/readiness/embed-probe.sh`), using a longer timeout than HTTP and a `failureThreshold` that tolerates brief blips; retain the HTTP liveness probe so load-spreading is not destabilized
    - _Requirements: 5.1, 5.4, 5.5, 22.9_
    - _Properties: 1_

  - [x] 8.4 Set the embedding pod memory limit sized with the serving ceiling
    - In the committed `ovms-embeddings-statefulset.yaml`, set `resources.limits.memory` to the `podMemoryLimitGi` value emitted by the sizing logic (replacing the legacy `8Gi`), sized together with the per-item serving ceiling; leave requests and other resources intact
    - _Requirements: 6.2, 6.6_

  - [x] 8.5 Commit the Qwen3-Reranker-0.6B Deployment replacing the bge drift
    - Create the committed `sources/kube/omniroute-memory/ovms-reranker-deployment.yaml` serving Qwen3-Reranker-0.6B INT8 OVMS-native (`--model_name=qwen3-reranker-0.6b`, `--model_path=/models/OpenVINO/Qwen3-Reranker-0.6B-int8-ov`; `model-pull` `--source_model=OpenVINO/Qwen3-Reranker-0.6B-int8-ov --task=rerank --target_device=GPU`), digest-pinned to match the embedding image, with the dual-path `rerank-probe.sh` readiness exec probe, i915 request, nodeSelector, fsGroup 5000, chown init container, `reranker-models` PVC, and pod memory sized with the ceiling; initial committed topology runs the reranker on all four nodes (fallback 3+1 only after the benchmark-contention gate). This replaces the uncommitted `bge-reranker-base` drift
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 5.3, 5.5, 6.6, 21.1, 21.2, 21.3_
    - _Properties: 1_

- [x] 9. Add the manifest config-assertion test
  - [x] 9.1 Write the config-assertion test over the committed manifests
    - Create a Vitest test parsing `sources/kube/omniroute-memory/` asserting: embedding image is the live digest pin and never `latest-gpu` (model-pull image matches); embedding topology preserved (replicas 4, required hostname anti-affinity, i915, nodeSelector, Longhorn 10Gi PVC, fsGroup 5000, model/pull args); reranker model is `qwen3-reranker-0.6b` and not `bge-reranker-base`, OVMS-native, committed as a file; readiness probes are the dual-path real-inference `exec` probes, not `httpGet /v2/health/ready` alone; pod memory limit and serving ceiling are present and sized together; no retrieval-critical configuration remains as live-only drift
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 3.1, 3.2, 3.4, 5.1, 5.5, 6.6, 21.1, 21.2, 21.3_
    - _Properties: 1_

- [x] 10. Build the evaluation harness (runnable benchmark, not a gate)
  - [x] 10.1 Implement the evaluation harness
    - Create `src/services/code-index/retrieval-fabric/eval/harness.ts` running real Menagerie/NerveCenter `EvalCase`s (natural-language task, expected relevant files, expected symbols/ranges); measure Recall@30, Recall@10, MRR@5, NDCG@5, and Top-5 expected-file hit rate; compare `vector-only` / `lexical-only` / `hybrid` / `hybrid+reranker-0.6b` / `hybrid+reranker-4b`; sweep Matryoshka dimensions 256/512/768/1024 by retrieval quality; emit the full `EvalResult` set. Run on demand, NOT as a unit-test gate
    - _Requirements: 16.1, 16.2, 16.3, 20.1, 20.2, 20.3, 20.4, 20.5_

  - [ ]* 10.2 Write a harness smoke test
    - Confirm the harness executes each config and emits the full `EvalResult` metric set over a tiny fixture set of cases; keep it a smoke test, not a quality gate
    - _Requirements: 20.3, 20.4_

- [x] 11. Live-cluster verification checklist (MANUAL, non-CI — not auto-verifiable)
  - [x] 11.1 Author the live-check verification document
    - Create a committed verification checklist (manual, run on `gremlin-1`..`gremlin-4` after the committed config is applied, flagged clearly as non-CI): confirm dual-path readiness removes a replica from rotation while HTTP `/v2/health/ready` stays green (GPU-wedge detection); confirm per-node vs dedicated reranker contention under real iGPU load to drive the benchmark-before-fallback gate; confirm the sized ceiling/pod-memory validated against the live real-inference probes before adoption
    - _Requirements: 4.2, 4.3, 6.4, 22.9_
    - _Properties: 1, 9_

- [x] 12. Final checkpoint - ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are optional (property/unit/integration/smoke tests) and can be skipped for a faster MVP; core implementation and the committed config deltas are never optional.
- Property tests use fast-check at 100+ iterations and are tagged `// Feature: retrieval-fabric, Property N: ...` per `AGENTS.md`.
- Config-as-code tasks (8.x) edit the committed declarative manifests at `sources/kube/omniroute-memory/` and reconcile drift into committed config — they do not introduce a parallel deployment system.
- Task 11 is a manual, non-CI live-cluster verification task (GPU-wedge readiness, reranker contention, sized-memory validation) that cannot be fully auto-verified.
- The eval harness (task 10) is a runnable decision tool, not a unit-test gate.
- Reuse the existing Menagerie request-batching/splitting guards and `vector-store-factory` dimension enforcement; do not duplicate the `semantic-first-retrieval` exploration policy.
- After TS edits, run the narrowest Vitest suite and `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <file>`; do NOT create `.changeset` files.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.3", "2.7", "3.1", "3.3", "4.1", "4.3", "4.5", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.5", "2.8", "3.2", "3.4", "4.2", "4.4", "4.6", "7.2"] },
    { "id": 3, "tasks": ["2.6", "6.1", "10.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "10.2"] },
    { "id": 5, "tasks": ["6.4", "8.1", "8.2", "8.5"] },
    { "id": 6, "tasks": ["8.3"] },
    { "id": 7, "tasks": ["8.4"] },
    { "id": 8, "tasks": ["9.1"] },
    { "id": 9, "tasks": ["11.1"] }
  ]
}
```
