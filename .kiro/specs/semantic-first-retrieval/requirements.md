# Requirements Document

## Introduction

This feature (FEAT-004 of the Menagerie Autonomous Operations Lift) makes semantic retrieval the default runtime exploration mechanism for repository code when a code index is available. Prompt guidance that merely recommends `codebase_search` first has proven insufficient: models still walk directories and read many files manually before converging on the relevant code. This feature introduces a runtime ExplorationPolicy that biases tool selection so repository exploration prefers semantic retrieval before broad filesystem walking.

The policy is backed by a per-task semantic exploration cache (so repeated exploration of the same concept reuses prior findings) and a retrieval output budget (so the parent context receives a compact ranked list of evidence rather than large code chunks). The feature also emits retrieval metrics so the effectiveness of semantic-first exploration can be measured, with the headline metric being the percentage of raw file reads that were preceded by a useful semantic hit.

The ExplorationPolicy is additive and non-breaking. It influences tool selection and affordances; it does not silently block the model's tool calls. Semantic retrieval is NOT mandatory when the index is unavailable (not configured, disabled, not initialized, or still indexing) or when the task already knows the exact target file. The existing `codebase_search` tool contract (CodebaseSearchTool, name `codebase_search`, `execute({query, path?})` emitting `codebase_search_result` and `pushToolResult`) is preserved; compact output is a preferred, additive behavior rather than a change to that contract.

Semantic retrieval is now served by the sibling retrieval-fabric gateway's `retrieve(query, workspace, intent, limit)`, which runs the full retrieval pipeline (query decomposition, dense semantic retrieval, exact/lexical/symbol retrieval, deterministic fusion, and reranking) and returns a bounded reranked evidence packet of roughly 5-8 items. This spec defines how Menagerie consumes that gateway: the ExplorationPolicy obtains its semantic-retrieval evidence from the gateway and feeds the resulting bounded packet into the existing navigation flow, output budget, caching, and metrics behaviors described below.

Explicit non-goals for this spec: no observatory, no loop detection, no tier semantics, no branding, no reasoning budgets, no parallelism, and no GPU scheduling. Those belong to separate specs. The Intel fabric deployment, the reranker, hybrid fusion, query decomposition, and the evaluation harness are owned by retrieval-fabric (not this spec); this spec covers only the Menagerie-side consumption of the gateway.

## Glossary

- **Menagerie**: The autonomous operations system under which tasks run and explore repositories, including the runtime that selects and executes tools on behalf of a model.
- **ExplorationPolicy**: A runtime policy component that, before broad filesystem exploration, evaluates whether semantic retrieval should be preferred for the current task and influences tool selection and affordances accordingly. It is a runtime policy, not prompt text.
- **Semantic_Retrieval**: Querying the code index through the `codebase_search` tool (CodebaseSearchTool), which calls `CodeIndexManager.searchIndex(query, directoryPrefix)` and returns ranked `VectorStoreSearchResult` entries containing file path, start line, end line, score, and code chunk.
- **Broad_Filesystem_Walking**: Repository exploration that enumerates or reads files without a specific known target, such as `list_files` on a directory, recursive directory reads, or `search_files` followed by reading many candidate files.
- **Known_Target**: An exact file path (optionally with a line range) that the task already has before exploring, such as a user instruction naming `package.json`, a compiler error naming `src/core/task/Task.ts:918`, or a worker already holding `file = deployments/kubernetes/base/ingress.yaml`.
- **Index_Availability**: Whether the per-workspace code index can serve semantic queries. The index is available only when `CodeIndexManager.isConfigurationLoaded`, `isFeatureEnabled`, `isFeatureConfigured`, and `isInitialized` are all true and the manager `state` is not `Indexing`. It is unavailable when configuration is not loaded, the feature is disabled, the feature is not configured, the manager is not initialized, or the manager `state` is `Indexing`.
- **SemanticFinding**: A record produced by a semantic query, with fields `query`, `file`, `startLine`, `endLine`, and `score`.
- **Semantic_Exploration_Cache**: A small per-task map of SemanticFinding entries that lets repeated exploration of the same concept reuse prior semantic results.
- **Retrieval_Output_Budget**: The constraint that semantic retrieval surfaces compact evidence to the parent context (file path, line range, score, and a one-line reason) as a short ranked list, rather than large code chunks.
- **Useful_Semantic_Hit**: A SemanticFinding whose file is subsequently opened with a targeted `read_file` by the task, within a line range that overlaps the finding's `startLine`-`endLine`.
- **Semantic_Hit_Rate**: The ratio of semantic queries that produced at least one Useful_Semantic_Hit to the total number of semantic queries issued by the task.
- **Retrieval_Gateway**: The retrieval-fabric service exposing `retrieve(query, workspace, intent, limit)` that returns a bounded reranked evidence packet. Menagerie consumes the gateway and does not address individual Intel replicas or nodes.
- **Evidence_Packet**: The bounded result of roughly 5-8 items returned by the Retrieval_Gateway, where each item has fields `file`, `startLine`, `endLine`, `score`, and `reason`, with compact snippets included only where they materially help.
- **Worker_Bootstrap_Retrieval**: An optional automatic task-context retrieval performed before a reader or reasoner worker begins broad investigation, seeding its first model generation with top relevant evidence.
- **Reader_Swarm_Packet**: A per-reader Evidence_Packet delivered to each reader scope (such as deployment, authentication, frontend, or tests) before that reader does targeted investigation.
- **Shared_Retrieval_Memory**: A per-task store of SemanticFinding entries shared across sibling readers, reasoners, verifier workers, and the GLM mastermind, without injecting another worker's full chat history into a consumer. Shared_Retrieval_Memory is the cross-worker visibility, within one task, of the findings held by the per-task Semantic_Exploration_Cache.
- **Change_Aware_Preference**: The Menagerie-side consumption rule that Menagerie prefers current code when using gateway evidence, so a stale index result does not silently outrank a current changed file (working-tree modifications, parallel worker patches, recently changed files, or files changed after indexing). The gateway and index freshness mechanism is owned by retrieval-fabric; this term names the Menagerie-side preference applied when consuming gateway results.

## Requirements

### Requirement 1: Runtime ExplorationPolicy prefers semantic retrieval

**User Story:** As a Menagerie operator, I want the runtime to prefer semantic retrieval before broad filesystem walking when the index is available, so that tasks stop blindly walking directories to find relevant code.

#### Acceptance Criteria

1. WHEN the code index Index_Availability is available AND the task is exploring an unseen repository area AND no Known_Target applies, THE ExplorationPolicy SHALL prefer Semantic_Retrieval before Broad_Filesystem_Walking.
2. THE ExplorationPolicy SHALL be implemented as a runtime policy that influences tool selection and affordances, independent of prompt text.
3. IF any one of the three preference conditions does not hold — the index is unavailable, OR the task is not exploring an unseen repository area, OR a Known_Target applies — THEN THE ExplorationPolicy SHALL NOT prefer Semantic_Retrieval for that exploration.
4. WHEN the ExplorationPolicy prefers Semantic_Retrieval, THE ExplorationPolicy SHALL allow the model to proceed with its chosen tool rather than blocking the tool call.

### Requirement 2: Semantic navigation flow

**User Story:** As a model running a task, I want a semantic-first navigation flow, so that I converge on the exact files to read instead of listing and reading many files.

#### Acceptance Criteria

1. WHEN the ExplorationPolicy prefers Semantic_Retrieval for an exploration, THE ExplorationPolicy SHALL present Semantic_Retrieval as the next exploration affordance so the flow proceeds from user request to semantic query to top relevant chunks to targeted `read_file`.
2. WHEN Semantic_Retrieval returns ranked results for a query, THE ExplorationPolicy SHALL surface the top relevant files and line ranges so the model can choose exact files to read with a targeted `read_file`.
3. WHILE the ExplorationPolicy prefers Semantic_Retrieval for the current exploration, THE ExplorationPolicy SHALL deprioritize the `list_files` then read-many then `search_files` then read-more pattern as the first exploration step.

### Requirement 3: Known-target bypass

**User Story:** As a model running a task, I want to read a file I already know the path to directly, so that I do not waste a semantic query on a target I have already identified.

#### Acceptance Criteria

1. WHERE a Known_Target applies to the current exploration, THE ExplorationPolicy SHALL permit a direct `read_file` of the Known_Target without requiring a prior Semantic_Retrieval.
2. WHEN a user instruction names an exact file path, THE ExplorationPolicy SHALL treat that path as a Known_Target.
3. WHEN a compiler error or diagnostic names an exact file path and line, THE ExplorationPolicy SHALL treat that path as a Known_Target.
4. WHEN a worker already holds an exact file path for the current exploration, THE ExplorationPolicy SHALL treat that path as a Known_Target.

### Requirement 4: Index-unavailable fallback

**User Story:** As a Menagerie operator, I want exploration to continue when the code index is unavailable, so that tasks are never blocked by missing or in-progress indexing.

#### Acceptance Criteria

1. IF `CodeIndexManager.isConfigurationLoaded` is false, THEN THE ExplorationPolicy SHALL treat Index_Availability as unavailable and SHALL allow Broad_Filesystem_Walking.
2. IF `CodeIndexManager.isFeatureEnabled` is false, THEN THE ExplorationPolicy SHALL treat Index_Availability as unavailable and SHALL allow Broad_Filesystem_Walking.
3. IF `CodeIndexManager.isFeatureConfigured` is false, THEN THE ExplorationPolicy SHALL treat Index_Availability as unavailable and SHALL allow Broad_Filesystem_Walking.
4. IF `CodeIndexManager.isInitialized` is false, THEN THE ExplorationPolicy SHALL treat Index_Availability as unavailable and SHALL allow Broad_Filesystem_Walking.
5. WHILE the `CodeIndexManager` state is `Indexing`, THE ExplorationPolicy SHALL treat Index_Availability as unavailable and SHALL allow Broad_Filesystem_Walking.
6. WHEN Index_Availability is unavailable, THE ExplorationPolicy SHALL NOT require Semantic_Retrieval and SHALL NOT block exploration.
7. WHEN Index_Availability is unavailable, THE ExplorationPolicy SHALL record an index-unavailable event for retrieval metrics.

### Requirement 5: Per-task semantic exploration cache

**User Story:** As a model running a task, I want prior semantic findings to be reused, so that re-exploring the same concept does not re-query the index or rediscover the same files.

#### Acceptance Criteria

1. WHEN Semantic_Retrieval returns results for a query, THE Semantic_Exploration_Cache SHALL store a SemanticFinding for each result with fields `query`, `file`, `startLine`, `endLine`, and `score`.
2. WHEN the task explores a concept that matches a query already present in the Semantic_Exploration_Cache, THE ExplorationPolicy SHALL offer the cached SemanticFinding entries for reuse before issuing a new Semantic_Retrieval query.
3. THE Semantic_Exploration_Cache SHALL be scoped to a single task.
4. WHEN a cached SemanticFinding is reused for an exploration, THE ExplorationPolicy SHALL record a queries-reused event for retrieval metrics.

### Requirement 6: Retrieval output budget

**User Story:** As a Menagerie operator, I want semantic results surfaced to the parent context as compact evidence, so that large code chunks do not flood the mastermind context.

#### Acceptance Criteria

1. WHEN Semantic_Retrieval returns results, THE Retrieval_Output_Budget SHALL surface to the parent context a ranked list of entries each containing file path, line range, score, and a one-line reason.
2. THE Retrieval_Output_Budget SHALL NOT automatically inject large semantic code chunks into the parent context.
3. WHERE a large semantic code chunk is retained, THE Retrieval_Output_Budget SHALL retain it in an artifact or worker-local context rather than the parent context.
4. WHEN the model needs the full code for a surfaced entry, THE ExplorationPolicy SHALL require the model to request the exact code range with a targeted `read_file`.
5. THE Retrieval_Output_Budget SHALL preserve the existing `codebase_search` tool contract, adding compact output as a preferred behavior rather than altering the documented `codebase_search_result` and `pushToolResult` output.

### Requirement 7: Retrieval metrics

**User Story:** As a Menagerie operator, I want retrieval metrics emitted per task, so that I can measure whether semantic-first exploration reduces blind filesystem reads.

#### Acceptance Criteria

1. THE ExplorationPolicy SHALL emit, per task, the count of semantic queries issued.
2. THE ExplorationPolicy SHALL emit, per task, the Semantic_Hit_Rate.
3. THE ExplorationPolicy SHALL emit, per task, the count of files returned by Semantic_Retrieval.
4. THE ExplorationPolicy SHALL emit, per task, the count of files subsequently opened with a targeted `read_file`.
5. THE ExplorationPolicy SHALL emit, per task, the count of raw file reads.
6. THE ExplorationPolicy SHALL emit, per task, the count of tokens consumed by file reads.
7. THE ExplorationPolicy SHALL emit, per task, the count of queries reused from the Semantic_Exploration_Cache.
8. THE ExplorationPolicy SHALL emit, per task, the count of index-unavailable events.
9. THE ExplorationPolicy SHALL emit, per task, the percentage of raw file reads that were preceded by a Useful_Semantic_Hit.
10. THE ExplorationPolicy SHALL emit, per task, the count of gateway-unavailable events.
11. THE ExplorationPolicy SHALL emit, per task, the elapsed time from task creation to the first useful source evidence.

### Requirement 8: Consume the retrieval-fabric gateway

**User Story:** As a Menagerie operator, I want semantic retrieval to be served by the retrieval-fabric gateway, so that Menagerie consumes a bounded reranked evidence packet instead of orchestrating raw embedding calls across Intel replicas.

#### Acceptance Criteria

1. WHEN the ExplorationPolicy prefers Semantic_Retrieval, THE ExplorationPolicy SHALL obtain evidence by invoking the Retrieval_Gateway `retrieve(query, workspace, intent, limit)` rather than issuing raw per-replica embedding calls.
2. WHEN the Retrieval_Gateway returns an Evidence_Packet, THE ExplorationPolicy SHALL consume the bounded Evidence_Packet and SHALL NOT request or ingest the full 30-50 candidate set.
3. THE ExplorationPolicy SHALL NOT select a physical Intel node or OVMS replica, because request distribution is owned by the Retrieval_Gateway and OmniRoute.
4. WHERE the Retrieval_Gateway is available, THE ExplorationPolicy SHALL treat the reranked Evidence_Packet as the Semantic_Retrieval result that feeds the Semantic navigation flow of Requirement 2 and the Retrieval_Output_Budget of Requirement 6.
5. IF the Retrieval_Gateway is unavailable, THEN THE ExplorationPolicy SHALL fall back to the index-availability behavior of Requirement 4 by allowing Broad_Filesystem_Walking without blocking exploration, and SHALL record a gateway-unavailable event for retrieval metrics.

### Requirement 9: Worker bootstrap retrieval

**User Story:** As a model running a reader or reasoner worker, I want an automatic task-context retrieval before I begin broad investigation, so that my first model generation starts from relevant evidence instead of blind filesystem wandering.

#### Acceptance Criteria

1. WHERE Worker_Bootstrap_Retrieval is enabled AND a reader or reasoner worker is about to begin broad repository investigation AND no Known_Target applies, THE ExplorationPolicy SHALL perform an automatic Retrieval_Gateway `retrieve()` from the task or worker description before the worker's first model generation.
2. WHEN Worker_Bootstrap_Retrieval returns an Evidence_Packet, THE ExplorationPolicy SHALL seed the worker's initial context with that bounded Evidence_Packet.
3. THE Worker_Bootstrap_Retrieval SHALL be configurable and SHALL NOT run WHERE a Known_Target applies, consistent with Requirement 3.
4. WHEN the worker's initial context is seeded by Worker_Bootstrap_Retrieval, THE ExplorationPolicy SHALL start the worker from the retrieved evidence so that initial `list_files`, `search_files`, and `read_file` wandering is reduced.

### Requirement 10: Reader-swarm retrieval packets

**User Story:** As a Menagerie operator running a reader swarm, I want each reader scope to receive its own retrieval packet, so that each reader reasons over targeted evidence instead of walking the filesystem to discover filenames.

#### Acceptance Criteria

1. WHERE a reader swarm decomposes investigation into independent scopes, THE ExplorationPolicy SHALL deliver a per-scope Reader_Swarm_Packet to each reader by invoking the Retrieval_Gateway for that scope before the reader begins targeted investigation.
2. THE Reader_Swarm_Packet SHALL be a bounded Evidence_Packet.
3. WHEN a reader receives a Reader_Swarm_Packet, THE reader SHALL reason over the Reader_Swarm_Packet rather than discovering filenames via Broad_Filesystem_Walking.
4. THE reader-swarm scheduling itself is owned by the elastic-parallel-execution spec; THE ExplorationPolicy SHALL define only that each reader scope receives a Reader_Swarm_Packet.

### Requirement 11: Shared retrieval memory across workers

**User Story:** As a model running one of several sibling workers, I want retrieval findings shared across workers in the same task, so that I can reuse what a sibling already discovered without inheriting its full chat history.

#### Acceptance Criteria

1. THE ExplorationPolicy SHALL maintain Shared_Retrieval_Memory per task containing SemanticFinding entries with fields `query`, `file`, `startLine`, `endLine`, and `score` produced by any worker's retrieval.
2. THE ExplorationPolicy SHALL make Shared_Retrieval_Memory readable by sibling readers, reasoners, verifier workers, and the GLM mastermind within the same task.
3. THE ExplorationPolicy SHALL share Shared_Retrieval_Memory findings without injecting another worker's full chat history into a consumer.
4. WHEN a worker would explore a concept already present in Shared_Retrieval_Memory, THE ExplorationPolicy SHALL offer the shared findings for reuse before issuing a new Retrieval_Gateway `retrieve()`, extending the per-task cache reuse of Requirement 5 to cross-worker visibility, and SHALL record a queries-reused event for retrieval metrics consistent with Requirement 5 and Requirement 7.

### Requirement 12: Change-aware preference when consuming evidence

**User Story:** As a model consuming gateway evidence, I want current code preferred over stale index results, so that a changed file is not silently outranked by an outdated indexed version.

#### Acceptance Criteria

1. WHEN the ExplorationPolicy consumes Evidence_Packet items, THE ExplorationPolicy SHALL prefer current code so that a stale index result SHALL NOT silently outrank a current changed file, including working-tree modifications, parallel worker patches, recently changed files, and files changed after indexing.
2. WHERE the Retrieval_Gateway supplies freshness information or an index-freshness signal, THE ExplorationPolicy SHALL honor that signal when ordering and consuming evidence.
3. THE index-freshness mechanism, including incremental reindex and freshness weighting, is owned by retrieval-fabric; THE ExplorationPolicy SHALL apply only the Menagerie-side Change_Aware_Preference when consuming results.
4. WHEN the ExplorationPolicy detects a changed file that the consumed evidence did not reflect, THE ExplorationPolicy SHALL record an index-freshness-miss event for retrieval metrics consistent with Requirement 7.
