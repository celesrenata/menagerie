# Requirements Document

## Introduction

This feature defines the **Retrieval Fabric** and the **Retrieval Gateway**: the Intel-side retrieval infrastructure that Menagerie consumes for repository code retrieval. It **extends** the existing, production k3s OpenVINO Model Server (OVMS) deployment in the `omniroute-memory` namespace rather than redesigning it. The deployment runs on four Intel SR-IOV nodes (`gremlin-1`..`gremlin-4`, `10.1.1.12`-`10.1.1.15`; `gremlin-4` is cluster-init), with manifests committed to the git repository at `sources/kube/omniroute-memory/`.

This spec is grounded in **verified live cluster state inspected over SSH**, not in the idealized engineering handoff. Several handoff claims about "current state" are, in reality, **gaps this spec must implement**:

- **Readiness is generic HTTP today, not real-inference.** The live `ovms-embeddings` StatefulSet and `ovms-reranker` Deployment both use the generic OVMS probes `readinessProbe httpGet /v2/health/ready` and `livenessProbe /v2/health/live`. The handoff's "real-inference readiness that already exists" is NOT in place. Real-inference readiness — a probe that issues a tiny real embedding request (and, for the reranker, a tiny real rerank request) — is the desired end state implemented here, because the HTTP health endpoint can report healthy while the Intel GPU serving path is wedged. A wedged GPU serving path (not HTTP connection pinning) is the stated root cause of historical replica load imbalance.
- **The deployed reranker is `bge-reranker-base`, not Qwen3.** The live `ovms-reranker` Deployment (1 replica, currently on `gremlin-2`) serves `bge-reranker-base` (`--model_path=/models/OpenVINO/bge-reranker-base-int8-ov`). "Add a Qwen3 reranker" is therefore a **replacement/standardization** of the existing BGE reranker with Qwen3-Reranker-0.6B INT8 (OpenVINO/OVMS-native), not a greenfield add.
- **Committed manifests have drifted from live state.** Only `ovms-embeddings-statefulset.yaml` is committed at `sources/kube/omniroute-memory/`. The reranker Deployment and several live settings exist only as cluster drift. The committed OVMS image reads `openvino/model_server:latest-gpu` while the live image is digest-pinned (`docker.io/openvino/model_server@sha256:e7a448...`). This spec reconciles committed manifests to live reality and captures all new fabric changes declaratively.
- **The binding memory boundary is the 8Gi pod memory limit, not node RAM.** Each Intel node has ~98.5GB capacity / ~94GB allocatable, and the Arc iGPUs draw from **shared system RAM**. But each OVMS pod sets `resources.limits.memory = 8Gi`, so the near-term out-of-memory boundary is the per-pod memory limit. Raising the per-item serving ceiling therefore requires raising the pod memory limit in tandem; both are sized together from measured iGPU + pod memory headroom on the 94GB-allocatable nodes. The `4096` per-item default is a legacy value, not a target.

The Menagerie-side consumption behaviors — the runtime `ExplorationPolicy`, known-target bypass, per-task semantic cache, worker bootstrap retrieval, reader-swarm retrieval packets, shared retrieval memory, Menagerie-side change-awareness policy, and Menagerie-side retrieval metrics — are owned by the existing **`semantic-first-retrieval`** spec, which will be extended to consume this gateway. This spec provides the gateway/fabric those behaviors consume; it does not redefine them.

Scope boundaries: no observatory, no loop detection, no tier semantics, no branding, no reasoning budgets, no parallelism scheduling. Menagerie MUST NOT select physical Intel nodes or GPUs; request distribution is owned by OmniRoute or the Retrieval Service. All deployment changes MUST be captured in the committed declarative config at `sources/kube/omniroute-memory/`, following its existing style, rather than left as live cluster drift.

## Glossary

- **Retrieval_Fabric**: The dedicated set of four Intel GPU nodes (`gremlin-1`..`gremlin-4`) in the `omniroute-memory` namespace serving embedding and (newly) reranking inference for repository retrieval. The fabric is retrieval-only infrastructure, distinct from general compute.
- **OVMS_Replica**: One OpenVINO Model Server instance serving model inference. In the live deployment there are four embedding replicas, one per Intel GPU node, managed by the `ovms-embeddings` StatefulSet.
- **Intel_GPU_Node**: A Kubernetes node exposing `gpu.intel.com/i915` resources with `nodeSelector intel.feature.node.kubernetes.io/gpu=true`, on which exactly one embedding OVMS_Replica is scheduled via required pod anti-affinity over `topologyKey kubernetes.io/hostname`.
- **Reranker**: An OpenVINO/OVMS-native reranking model that scores candidate (query, document) pairs. The live reranker serves `bge-reranker-base`; the desired reranker is Qwen3-Reranker-0.6B INT8. Qwen3-Reranker-4B exists only as a benchmark path.
- **Real_Inference_Readiness**: A readiness check that validates a real model serving path by issuing a tiny real inference request (a real embedding request for the embedding path, a real rerank request for the reranking path), rather than probing the OVMS HTTP `/v2/health/ready` endpoint alone.
- **Dual_Path_Readiness**: A Real_Inference_Readiness check that validates BOTH the real embedding serving path AND the real reranking serving path.
- **Per_Item_Serving_Ceiling**: The per-item token limit applied to each embedding/rerank request as an Intel iGPU out-of-memory guard. The current `4096` value is a legacy default, not a target; the ceiling is a documented, configurable value with a measured-safe default. In Menagerie code this maps to `MAX_EMBEDDING_REQUEST_PADDED_TOKENS` and `MAX_EMBEDDING_REQUEST_ITEMS` in `src/services/code-index/constants/index.ts`.
- **Pod_Memory_Limit**: The `resources.limits.memory` set on each OVMS pod (currently `8Gi`). On ~94GB-allocatable shared-RAM nodes this is the binding near-term OOM boundary, and it is sized together with the Per_Item_Serving_Ceiling.
- **Request_Batching_Guard**: The Menagerie-side guards that bound a single embedding request so an uncapped padded GPU batch cannot crash OVMS: `MAX_EMBEDDING_REQUEST_ITEMS` (32), `MAX_EMBEDDING_REQUEST_PADDED_TOKENS` (16384), consumed via `DEFAULT_EMBEDDING_REQUEST_LIMITS` and `planEmbeddingRequests` in `src/services/code-index/shared/embedding-batches.ts`, plus the 5xx-driven splitter bounded by `MAX_EMBEDDING_SPLIT_DEPTH` (5) in `embedders/openai-compatible.ts`.
- **Shared_System_RAM_OOM_Boundary**: The constraint that Arc iGPUs draw from shared system RAM, so embedding/rerank memory consumption is bounded by pod memory limits and node allocatable RAM (~94GB) rather than by dedicated VRAM.
- **Manifest_Drift**: A difference between live cluster state and the committed declarative config at `sources/kube/omniroute-memory/` (e.g. the uncommitted reranker Deployment, or `latest-gpu` committed vs. a digest-pinned live image).
- **Retrieval_Gateway**: The logical service exposing `retrieve(query, workspace, intent, limit)` so that callers do not address individual OVMS_Replicas or Intel_GPU_Nodes.
- **retrieve()**: The gateway entry point `retrieve(query, workspace, intent, limit)` that runs the full pipeline (decompose, dense retrieval, lexical/symbol retrieval, fuse, rerank) and returns an Evidence_Packet.
- **Evidence_Packet**: A bounded result set of approximately 5-8 Evidence_Items returned by `retrieve()`.
- **Evidence_Item**: A single result with shape `{ file, startLine, endLine, score, reason }`, with a compact snippet included only where it materially aids the caller.
- **Hybrid_Retrieval**: Retrieval that combines dense embedding similarity, exact identifier/lexical search, and symbol/file/path relevance, followed by reranking, rather than relying on vector similarity alone.
- **RRF_Fusion**: Reciprocal Rank Fusion — a deterministic mechanism that merges multiple ranked candidate lists into one combined ranking before reranking.
- **Query_Decomposition**: Expanding one engineering question into multiple independent retrieval queries dispatched across embedding capacity, without pointless query multiplication.
- **Matryoshka_Dimension**: A reduced embedding dimension (e.g. 256, 512, 768, 1024) supported by Qwen3 embeddings, chosen by measured retrieval quality against real repositories. `qwen3-embedding-0.6b` is dimension 1024 in `src/shared/embeddingModels.ts`.
- **Semantic_Chunk**: An indexing unit bounded by a semantic boundary (function, method, class, module, section, heading) and sized well below the Per_Item_Serving_Ceiling.
- **Change_Awareness**: The gateway/index freshness mechanism ensuring retrieval prefers current code over stale index entries, accounting for working-tree modifications, parallel worker patches, and files changed after indexing.
- **Index_Freshness**: The property that an index result reflects the current state of a file; a freshness miss is a result that reflects a stale version of a changed file.
- **Evaluation_Harness**: A repository retrieval benchmark built from real Menagerie/NerveCenter tasks, used to compare retrieval configurations by measured quality.
- **Recall_At_K / MRR_At_K / NDCG_At_K**: Retrieval quality metrics. Recall@K is the fraction of expected relevant files found within the top K results; MRR@K is the mean reciprocal rank of the first relevant result within K; NDCG@K is the normalized discounted cumulative gain over the top K results.
- **Graceful_Degradation**: The property that when the Retrieval_Fabric or Retrieval_Gateway is unavailable, Menagerie continues operating using existing code indexing and direct reads rather than failing, building on `CodeIndexManager` availability states (not configured / disabled / not initialized / Indexing / Indexed).
- **OmniRoute**: The request-distribution fabric that routes retrieval requests across OVMS_Replicas so callers address a logical endpoint. Today a Kubernetes Service fronts the four embedding replicas; the gateway sits logically above it.
- **Qdrant_Collection**: The vector store collection (the `qdrant` instance `qdrant-0` in `omniroute-memory`) whose configured vector dimension MUST match the stored embedding dimension (`getModelDimension` in `src/shared/embeddingModels.ts`, enforced by `vector-store-factory.ts`).

## Requirements

### Preserved Fabric Constraints

### Requirement 1: Preserve the four-replica per-node embedding topology

**User Story:** As a Retrieval_Fabric operator, I want the verified four-replica embedding topology preserved, so that the production deployment is extended rather than destabilized.

#### Acceptance Criteria

1. THE Retrieval_Fabric SHALL run four embedding OVMS_Replicas, exactly one OVMS_Replica per Intel_GPU_Node, managed by the `ovms-embeddings` StatefulSet with `podManagementPolicy Parallel`.
2. THE Retrieval_Fabric SHALL schedule embedding OVMS_Replicas using required pod anti-affinity on `app=ovms-embeddings` over `topologyKey kubernetes.io/hostname` so that no two embedding OVMS_Replicas share an Intel_GPU_Node.
3. THE Retrieval_Fabric SHALL request `gpu.intel.com/i915: 1` for each embedding OVMS_Replica and SHALL schedule embedding OVMS_Replicas with `nodeSelector intel.feature.node.kubernetes.io/gpu=true`.
4. THE Retrieval_Fabric SHALL serve the OpenVINO `Qwen3-Embedding-0.6B-int8-ov` model with args `--rest_port=8000 --model_name=qwen3-embedding-0.6b --model_path=/models/OpenVINO/Qwen3-Embedding-0.6B-int8-ov`.
5. THE Retrieval_Fabric SHALL pull the embedding model through the init container with `--source_model=OpenVINO/Qwen3-Embedding-0.6B-int8-ov --task=embeddings --pooling=LAST --target_device=GPU`, preceded by the chown init container.
6. THE Retrieval_Fabric SHALL back each embedding OVMS_Replica model volume with a Longhorn RWO `volumeClaimTemplate` (`models`, `10Gi`) and SHALL run pods with `fsGroup 5000`.
7. THE Retrieval_Fabric SHALL preserve embedding OVMS_Replica resources of limits `cpu 4` / `gpu.intel.com/i915 1` / `memory 8Gi` and requests `cpu 1` / `gpu.intel.com/i915 1` / `memory 2Gi`, except where modified by the Pod_Memory_Limit sizing in Requirement 7.
8. WHERE a deployment change modifies the Retrieval_Fabric, THE deployment change SHALL be expressed in the committed declarative config at `sources/kube/omniroute-memory/`, following its existing style.

### Requirement 2: Digest-pin the committed OVMS image

**User Story:** As a Retrieval_Fabric operator, I want the committed OVMS image digest-pinned to match live, so that the committed manifest reproduces the deployed image.

#### Acceptance Criteria

1. THE committed `ovms-embeddings` manifest SHALL reference the OVMS container image by digest pin matching the live digest (`docker.io/openvino/model_server@sha256:e7a448...`).
2. THE committed `ovms-embeddings` manifest SHALL NOT reference the OVMS image by the mutable `openvino/model_server:latest-gpu` tag.
3. WHEN the committed manifest is reconciled, THE Manifest_Drift between the committed `latest-gpu` tag and the live digest-pinned image SHALL be resolved in favor of the digest pin.

### Reranker & Topology

### Requirement 3: Replace the BGE reranker with an OVMS-native Qwen3 reranker

**User Story:** As a Retrieval_Fabric operator, I want the live `bge-reranker-base` Deployment replaced with a Qwen3 reranker, so that reranking is standardized on the Qwen3 model and captured in committed manifests.

#### Acceptance Criteria

1. THE Retrieval_Fabric SHALL replace the existing `ovms-reranker` Deployment serving `bge-reranker-base` with a reranker serving the Qwen3-Reranker-0.6B INT8 model.
2. THE Retrieval_Fabric SHALL serve the Qwen3 reranker as an OpenVINO/OVMS-native model.
3. THE Retrieval_Fabric SHALL start reranking production with the Qwen3-Reranker-0.6B INT8 model.
4. WHEN the Qwen3 reranker replaces `bge-reranker-base`, THE reranker Deployment SHALL be captured in the committed declarative config at `sources/kube/omniroute-memory/`, resolving the Manifest_Drift of the previously uncommitted reranker.

### Requirement 4: Benchmark before choosing the fallback topology

**User Story:** As a Retrieval_Fabric operator, I want the fallback topology chosen only after benchmarking, so that embedding capacity is not reduced preemptively.

#### Acceptance Criteria

1. THE Retrieval_Fabric SHALL adopt as its initial desired topology running both the embedding-0.6b model and the reranker-0.6b model on all four Intel_GPU_Nodes where memory and performance permit.
2. IF benchmarking shows meaningful contention or instability on the shared iGPU under the initial desired topology, THEN THE Retrieval_Fabric SHALL be eligible to adopt the fallback topology of three embedding-capacity nodes plus one dedicated reranker node.
3. THE Retrieval_Fabric SHALL NOT adopt the fallback topology before benchmarking demonstrates meaningful contention or instability.

### Requirement 5: Replace generic HTTP readiness with dual-path real-inference readiness

**User Story:** As a Retrieval_Fabric operator, I want readiness to validate both the real embedding and real reranking serving paths, so that an OVMS_Replica whose Intel GPU serving path is wedged is removed from rotation even while its HTTP endpoint reports healthy.

#### Acceptance Criteria

1. THE Real_Inference_Readiness check SHALL replace or augment the generic OVMS `readinessProbe httpGet /v2/health/ready` so that readiness is not determined by the HTTP `/v2/health/ready` endpoint alone.
2. THE Real_Inference_Readiness check SHALL validate the real embedding serving path by issuing a tiny real embedding request.
3. WHILE reranking is part of production retrieval, THE Dual_Path_Readiness check SHALL also validate the real reranking serving path by issuing a tiny real rerank request.
4. WHEN the Intel GPU embedding serving path OR the reranking serving path of an OVMS_Replica is wedged WHILE the OVMS HTTP `/v2/health/ready` endpoint reports healthy, THE readiness check SHALL report that OVMS_Replica as not ready.
5. THE readiness changes SHALL be captured in the committed declarative config at `sources/kube/omniroute-memory/`.

### Serving Ceiling & Pod Memory

### Requirement 6: Size the serving ceiling and pod memory together from measured headroom

**User Story:** As a Retrieval_Fabric operator, I want the per-item serving ceiling and the pod memory limit sized together from measured headroom, so that a larger per-item ceiling cannot produce a padded batch or pod footprint exceeding safe memory on the shared-RAM nodes.

#### Acceptance Criteria

1. THE Per_Item_Serving_Ceiling SHALL exist only as an out-of-memory guard and SHALL be a documented, configurable value with a measured-safe default rather than a fixed `4096`.
2. WHEN the Per_Item_Serving_Ceiling is raised, THE Pod_Memory_Limit (currently `8Gi`) SHALL be raised in tandem.
3. THE Per_Item_Serving_Ceiling, the `MAX_EMBEDDING_REQUEST_PADDED_TOKENS` guard, the per-request item cap `MAX_EMBEDDING_REQUEST_ITEMS`, AND the Pod_Memory_Limit SHALL be sized together from measured Intel iGPU and pod memory headroom on the ~94GB-allocatable nodes.
4. THE sized Per_Item_Serving_Ceiling and Pod_Memory_Limit SHALL be validated against the Dual_Path_Readiness real-inference probes before adoption.
5. THE sizing SHALL ensure that a request at the configured Per_Item_Serving_Ceiling cannot produce a padded GPU batch or pod memory footprint exceeding the measured safe memory.
6. THE Pod_Memory_Limit SHALL be expressed in the committed declarative config at `sources/kube/omniroute-memory/`.

### Requirement 7: Preserve the Menagerie-side request-batching guards

**User Story:** As a Menagerie engineer, I want the request-batching and request-splitting guards preserved, so that no single request can crash OVMS with an uncapped padded GPU batch.

#### Acceptance Criteria

1. THE Retrieval_Gateway SHALL preserve `MAX_EMBEDDING_REQUEST_ITEMS` and `MAX_EMBEDDING_REQUEST_PADDED_TOKENS` in `src/services/code-index/constants/index.ts` as functional guards consumed via `DEFAULT_EMBEDDING_REQUEST_LIMITS` and `planEmbeddingRequests`.
2. THE Retrieval_Gateway SHALL preserve the 5xx-driven request splitter bounded by `MAX_EMBEDDING_SPLIT_DEPTH` in `src/services/code-index/embedders/openai-compatible.ts`.
3. THE sizing in Requirement 6 SHALL NOT weaken the Request_Batching_Guard or the request-splitting behavior.
4. WHEN OVMS returns a 5xx for an embedding request, THE embedding path SHALL split the request up to `MAX_EMBEDDING_SPLIT_DEPTH` and retry.

### Retrieval Gateway & Evidence Packet

### Requirement 8: Expose a logical retrieve() entry point

**User Story:** As a Menagerie engineer, I want a single logical `retrieve(query, workspace, intent, limit)` entry point, so that Menagerie never addresses individual Intel replicas or nodes.

#### Acceptance Criteria

1. THE Retrieval_Gateway SHALL expose a `retrieve(query, workspace, intent, limit)` operation.
2. WHEN a caller invokes `retrieve()`, THE Retrieval_Gateway SHALL select which OVMS_Replica serves each inference request without caller involvement.
3. THE Retrieval_Gateway SHALL rely on OmniRoute or the Retrieval Service for request distribution across OVMS_Replicas, sitting logically above the Kubernetes Service that fronts the four embedding replicas.
4. THE Retrieval_Gateway SHALL NOT require the caller to select a physical Intel_GPU_Node or OVMS_Replica.

### Requirement 9: Execute the gateway retrieval pipeline

**User Story:** As a Menagerie engineer, I want the gateway to run a defined retrieval pipeline, so that one task query becomes a small set of high-quality evidence items.

#### Acceptance Criteria

1. WHEN `retrieve()` is invoked, THE Retrieval_Gateway SHALL create one or more semantic queries from the task.
2. WHEN semantic queries are created, THE Retrieval_Gateway SHALL run semantic retrieval over the Qdrant_Collection.
3. WHEN semantic retrieval runs, THE Retrieval_Gateway SHALL run exact/lexical/symbol retrieval for the same query.
4. WHEN semantic and lexical/symbol candidates are available, THE Retrieval_Gateway SHALL merge the candidate lists.
5. WHEN merged candidates are available, THE Retrieval_Gateway SHALL rerank the candidates with the Reranker.
6. WHEN reranking completes, THE Retrieval_Gateway SHALL return an Evidence_Packet.

### Requirement 10: Return a bounded evidence packet

**User Story:** As a Menagerie engineer, I want retrieval output bounded to a few high-quality items, so that the parent context receives compact evidence rather than dozens of full chunks.

#### Acceptance Criteria

1. WHEN `retrieve()` returns, THE Retrieval_Gateway SHALL return approximately 5 to 8 Evidence_Items.
2. THE Retrieval_Gateway SHALL NOT return 30 to 50 full chunks to Menagerie.
3. THE Retrieval_Gateway SHALL shape each Evidence_Item as `{ file, startLine, endLine, score, reason }`.
4. WHERE a compact snippet materially aids the caller, THE Retrieval_Gateway SHALL include the snippet in the Evidence_Item.
5. THE Retrieval_Gateway SHALL keep raw retrieval output bounded regardless of candidate volume.

### Hybrid Retrieval & Fusion

### Requirement 11: Combine dense, lexical, and symbol retrieval

**User Story:** As a Menagerie engineer, I want retrieval to combine dense and exact-token signals, so that queries containing exact identifiers, errors, paths, or UUIDs retrieve the right code.

#### Acceptance Criteria

1. THE Retrieval_Gateway SHALL combine dense embedding similarity, exact identifier/lexical search, and symbol/file/path relevance, followed by reranking.
2. THE Retrieval_Gateway SHALL NOT rely exclusively on vector similarity for candidate generation.
3. WHEN a query contains an exact token such as an identifier (for example `AUTO_READER_NAME` or `FooFactory`), an error string (for example `HTTP 502`), a named resource (for example `celestium-le-production`), a file path, or a UUID, THE Retrieval_Gateway SHALL include exact identifier/lexical and symbol/file/path retrieval for that query.

### Requirement 12: Deterministic fusion before reranking

**User Story:** As a Menagerie engineer, I want candidate lists fused deterministically before reranking, so that fusion order is reproducible and reranking operates on a single merged list.

#### Acceptance Criteria

1. WHEN multiple ranked candidate lists are available, THE Retrieval_Gateway SHALL merge them using Reciprocal Rank Fusion or another simple deterministic fusion mechanism.
2. THE Retrieval_Gateway SHALL perform RRF_Fusion before reranking the candidates.
3. WHEN the same candidate lists are fused twice, THE Retrieval_Gateway SHALL produce the same merged ranking.

### Query Decomposition

### Requirement 13: Decompose questions into multiple retrieval queries

**User Story:** As a Menagerie engineer, I want one engineering question to produce several focused retrieval queries, so that multi-faceted questions retrieve all relevant areas.

#### Acceptance Criteria

1. WHERE a task question spans multiple independent concerns (for example a wrong-Kubernetes-certificate question spanning ingress TLS, cert-manager `Certificate` resources, `ClusterIssuer`, hostname config, and manifests containing a hostname), THE Retrieval_Gateway SHALL produce multiple retrieval queries from that question.
2. WHERE multiple independent retrieval queries are produced, THE Retrieval_Gateway SHOULD dispatch the independent queries concurrently across embedding capacity where useful.
3. THE Retrieval_Gateway SHALL avoid producing retrieval queries that do not add distinct retrieval coverage.

### Reranking Pipeline

### Requirement 14: Reduce candidates to a bounded evidence set

**User Story:** As a Menagerie engineer, I want reranking to reduce the merged candidate list to a few evidence items, so that only the highest-quality results reach Menagerie.

#### Acceptance Criteria

1. WHEN hybrid merge produces approximately 30 to 50 candidates, THE Reranker SHALL reduce them to approximately 5 to 8 Evidence_Items.
2. THE Retrieval_Gateway SHALL use the Qwen3-Reranker-0.6B model for production reranking.

### Requirement 15: Keep reranker-4B as a benchmark-only path

**User Story:** As a Retrieval_Fabric operator, I want Qwen3-Reranker-4B available only as a benchmark path, so that the larger model is deployed only when real quality gains justify its latency.

#### Acceptance Criteria

1. THE Retrieval_Fabric SHALL provide a benchmark path for the Qwen3-Reranker-4B model.
2. THE Retrieval_Fabric SHALL NOT deploy the Qwen3-Reranker-4B model as the default production reranker.
3. WHERE real repository retrieval shows a meaningful quality gain at acceptable latency, THE Retrieval_Fabric SHALL be eligible to adopt the Qwen3-Reranker-4B model.

### Matryoshka Dimensions

### Requirement 16: Benchmark reduced embedding dimensions by retrieval quality

**User Story:** As a Retrieval_Fabric operator, I want reduced embedding dimensions benchmarked by retrieval quality, so that a smaller representation is adopted only when it preserves quality.

#### Acceptance Criteria

1. THE Evaluation_Harness SHALL benchmark Matryoshka_Dimension values of at least 256, 512, 768, and 1024 against real Menagerie repositories.
2. THE Evaluation_Harness SHALL measure retrieval quality for each Matryoshka_Dimension value rather than vector size alone.
3. WHERE a smaller Matryoshka_Dimension retains effectively the same retrieval quality as 1024, THE Retrieval_Fabric SHALL prefer the smaller Matryoshka_Dimension to reduce Qdrant memory, storage, network payload, and distance-computation cost.
4. WHEN the stored embedding Matryoshka_Dimension changes, THE Qdrant_Collection vector dimension SHALL be changed to match the stored embedding dimension reported by `getModelDimension` in `src/shared/embeddingModels.ts`.
5. WHEN the stored embedding Matryoshka_Dimension changes, THE existing `qdrant` instance (`qdrant-0` in `omniroute-memory`) SHALL be reindexed to the new dimension.
6. IF the stored embedding Matryoshka_Dimension does not match the Qdrant_Collection vector dimension, THEN THE Retrieval_Gateway SHALL reject the configuration as a dimension mismatch (as `vector-store-factory.ts` enforces).

### Chunking

### Requirement 17: Chunk on semantic boundaries below the serving ceiling

**User Story:** As a Retrieval_Fabric operator, I want indexing chunks sized below the serving ceiling and aligned to semantic boundaries, so that chunks embed safely and retrieve coherently.

#### Acceptance Criteria

1. THE indexing chunker SHALL produce Semantic_Chunks sized below the Per_Item_Serving_Ceiling.
2. THE indexing chunker SHALL target approximately 500 to 1200 tokens for source-code Semantic_Chunks.
3. THE indexing chunker SHALL target approximately 800 to 1600 tokens for documentation and specification Semantic_Chunks.
4. THE indexing chunker SHALL apply approximately 10% to 15% overlap between adjacent Semantic_Chunks.
5. THE indexing chunker SHALL prefer semantic boundaries — function, method, class, module, section, or heading — over arbitrary token slicing.

### Change Awareness

### Requirement 18: Prefer current code over stale index results

**User Story:** As a Menagerie engineer, I want retrieval to prefer current code, so that stale index entries do not outrank files that have changed.

#### Acceptance Criteria

1. THE Retrieval_Gateway SHALL prefer current code when returning Evidence_Items.
2. THE Retrieval_Gateway SHALL account for working-tree modifications, parallel worker patches, recently changed files, and files changed after indexing when ranking results.
3. THE Retrieval_Gateway SHALL NOT allow a stale index result to silently outrank a current changed file.
4. WHEN a file has changed after indexing, THE Retrieval_Gateway SHALL trigger incremental reindexing or apply a freshness weighting for that file.

### Metrics

### Requirement 19: Emit local retrieval metrics

**User Story:** As a Retrieval_Fabric operator, I want local retrieval metrics, so that retrieval effectiveness and latency are measurable.

#### Acceptance Criteria

1. THE Retrieval_Gateway SHALL record metrics for semantic queries issued, query decompositions produced, embedding latency, reranking latency, candidates before rerank, results after rerank, semantic hit rate, subsequent file reads, raw file-read tokens, cache hits, Index_Freshness misses, and reranker top-N quality.
2. THE Retrieval_Gateway SHALL record the percentage of raw file reads preceded by a relevant retrieval hit as a key product metric.
3. THE Retrieval_Gateway SHALL record the time from task creation to first useful source-code evidence.

### Evaluation Harness

### Requirement 20: Build a real-query repository retrieval benchmark

**User Story:** As a Retrieval_Fabric operator, I want a repository retrieval benchmark built from real tasks, so that configuration decisions use actual engineering queries as the deciding signal.

#### Acceptance Criteria

1. THE Evaluation_Harness SHALL be built from real Menagerie and NerveCenter tasks.
2. THE Evaluation_Harness SHALL define each case with a natural-language task or query, expected relevant files, and expected important symbols or ranges.
3. THE Evaluation_Harness SHALL measure Recall@30, Recall@10, MRR@5, NDCG@5, and Top-5 expected-file hit rate.
4. THE Evaluation_Harness SHALL compare the configurations vector-only, lexical-only, hybrid, hybrid plus reranker-0.6B, and hybrid plus reranker-4B.
5. THE Evaluation_Harness SHALL use actual engineering queries as the deciding signal rather than generic NLP benchmarks.

### Manifest Drift Reconciliation

### Requirement 21: Reconcile all fabric changes into committed declarative config

**User Story:** As a Retrieval_Fabric operator, I want every fabric change captured in committed config, so that retrieval-critical configuration never exists only as live cluster drift.

#### Acceptance Criteria

1. THE Qwen3 reranker, the Dual_Path_Readiness changes, the digest pins, the memory/ceiling sizing, and any per-node reranker capacity SHALL be captured in the committed declarative config at `sources/kube/omniroute-memory/`.
2. WHEN committed manifests are reconciled, THE Manifest_Drift (the uncommitted reranker Deployment and the `latest-gpu`-vs-digest image difference) SHALL be resolved into committed config.
3. THE cluster SHALL NOT be left with retrieval-critical configuration existing only as live drift.

### Architectural Invariants

### Requirement 22: Preserve retrieval architectural invariants

**User Story:** As a Menagerie architect, I want the retrieval architectural invariants enforced, so that the fabric stays dedicated, bounded, and degradable throughout migration.

#### Acceptance Criteria

1. THE four Intel_GPU_Nodes SHALL remain the dedicated Retrieval_Fabric.
2. THE Retrieval_Gateway SHALL rely on OmniRoute or the Retrieval Service for request distribution, and Menagerie SHALL NOT select physical Intel_GPU_Nodes.
3. THE Retrieval_Gateway SHALL return logical retrieval results to Menagerie.
4. THE Retrieval_Gateway SHALL keep raw retrieval output bounded.
5. WHERE a known-target exact read is required, THE Retrieval_Gateway SHALL allow the exact read to bypass semantic retrieval.
6. THE Retrieval_Gateway SHALL reduce filesystem walking rather than add a mandatory retrieval round trip to every tool invocation.
7. IF the Retrieval_Fabric or Retrieval_Gateway is unavailable, THEN Menagerie SHALL continue operating using existing code indexing and direct reads, building on the `CodeIndexManager` availability states (not configured / disabled / not initialized / Indexing / Indexed).
8. WHILE this feature is being migrated into production, THE existing code indexing SHALL remain usable.
9. WHILE the real-inference readiness is being introduced, THE changes SHALL NOT destabilize the existing Arc/OVMS readiness and load-spreading behavior.
