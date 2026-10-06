// Feature: retrieval-fabric
//
// Deployment-selection logic for the Retrieval Fabric: which reranker model
// and which node topology the fabric adopts.
//
// Two benchmark-before-adoption gates are enforced here as pure functions:
//
//  - Reranker gate (Req 15.1-15.3): production reranking defaults to
//    Qwen3-Reranker-0.6B. The larger Qwen3-Reranker-4B exists only as a
//    benchmark path and is adopted ONLY when a benchmark quality-gain signal
//    is present. It is never the default.
//
//  - Topology gate (Req 4.1-4.3): the initial desired topology runs both the
//    embedding-0.6b model and the reranker-0.6b model on all four Intel GPU
//    nodes. The fallback topology (3 embedding nodes + 1 dedicated reranker
//    node) is adopted ONLY when a benchmark-contention signal is present. It is
//    never selected preemptively.
//
// Both functions are pure and deterministic so they are safe to call from the
// deployment-planning path and from property tests (Property 9).

/**
 * The production reranker model served by the Retrieval Fabric.
 *
 * `qwen3-reranker-0.6b` is the production default; `qwen3-reranker-4b` is a
 * benchmark-only path adopted solely on a measured quality-gain signal
 * (Req 15.1-15.3).
 */
export type RerankerChoice = "qwen3-reranker-0.6b" | "qwen3-reranker-4b"

/**
 * The node topology adopted by the Retrieval Fabric.
 *
 * `all-four-nodes` is the initial desired topology (reranker-0.6b alongside the
 * embedding replica on every Intel GPU node). `fallback-3plus1` (3 embedding
 * nodes + 1 dedicated reranker node) is adopted only after benchmarking shows
 * meaningful iGPU contention (Req 4.1-4.3).
 */
export type TopologyChoice = "all-four-nodes" | "fallback-3plus1"

/** The default production reranker (Req 15.2). */
export const DEFAULT_RERANKER: RerankerChoice = "qwen3-reranker-0.6b"

/** The initial desired node topology (Req 4.1). */
export const DEFAULT_TOPOLOGY: TopologyChoice = "all-four-nodes"

/**
 * Benchmark signals that gate the non-default deployment choices.
 *
 * Absent (both unset/false) signals represent the state before any benchmark
 * has demonstrated a reason to move off the defaults, which is the common case.
 */
export interface DeploymentSelectionSignal {
	/**
	 * `true` iff real-repository retrieval benchmarking demonstrated a
	 * meaningful quality gain for Qwen3-Reranker-4B at acceptable latency
	 * (Req 15.3). Only then is the 4B reranker eligible for adoption.
	 */
	rerankerQualityGain?: boolean
	/**
	 * `true` iff benchmarking demonstrated meaningful contention or instability
	 * on the shared iGPU under the initial all-four-nodes topology (Req 4.2).
	 * Only then is the fallback topology eligible for adoption.
	 */
	contentionDetected?: boolean
}

/**
 * Select the production reranker model.
 *
 * Defaults to Qwen3-Reranker-0.6B and returns Qwen3-Reranker-4B ONLY when a
 * benchmark quality-gain signal is present. The 4B model is never the default
 * (Req 15.1, 15.2, 15.3). Pure and deterministic.
 *
 * @param signal The benchmark signals gating the choice.
 * @returns The selected reranker model.
 */
export function selectReranker(signal: DeploymentSelectionSignal = {}): RerankerChoice {
	return signal.rerankerQualityGain === true ? "qwen3-reranker-4b" : DEFAULT_RERANKER
}

/**
 * Select the node topology.
 *
 * Defaults to the initial desired `all-four-nodes` topology and returns the
 * `fallback-3plus1` topology ONLY when a benchmark-contention signal is present.
 * The fallback is never selected preemptively (Req 4.1, 4.2, 4.3). Pure and
 * deterministic.
 *
 * @param signal The benchmark signals gating the choice.
 * @returns The selected node topology.
 */
export function selectTopology(signal: DeploymentSelectionSignal = {}): TopologyChoice {
	return signal.contentionDetected === true ? "fallback-3plus1" : DEFAULT_TOPOLOGY
}
