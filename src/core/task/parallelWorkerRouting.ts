import type { ProviderSettings } from "@roo-code/types"

/**
 * Modes treated as read-only "reader" roles for parallel-worker model defaults.
 * `project-reader` is the shared read-only reader mode used by parallel fan-out
 * (see `addSharedDocumentReader`). Any of these modes defaults to the reader
 * route id; every other mode defaults to the reasoner route id.
 * See docs/architecture/omniroute-integration-design.md §5.3.
 *
 * Two-field OmniRoute profile -> three-tier intent:
 *   - reader field  (`openAiOmniRouteReaderRouteId`)   = LOW/9B reader; used only
 *     by `project-reader` workers (the sole READER_MODES member).
 *   - reasoner field (`openAiOmniRouteReasonerRouteId`) = HIGH/27B reader; shared
 *     by code workers AND `project-research` (which is deliberately NOT a reader
 *     mode, so it falls through to the reasoner field).
 */
export const READER_MODES: ReadonlySet<string> = new Set(["project-reader"])

/**
 * Resolve the default OmniRoute model id for a parallel worker by its role.
 *
 * Reader-role workers (see {@link READER_MODES}) use the configured
 * `openAiOmniRouteReaderRouteId` (LOW/9B tier); every other worker — including
 * `project-research` and code workers — uses `openAiOmniRouteReasonerRouteId`
 * (HIGH/27B tier). When the relevant field is unset this returns
 * `undefined`, so the caller falls back to the parent model id (single-model
 * behavior unchanged). This is a pure id pass-through — no tier or GPU math;
 * OmniRoute owns placement.
 */
export function roleDefault(mode: string, profile: ProviderSettings): string | undefined {
	return READER_MODES.has(mode) ? profile.openAiOmniRouteReaderRouteId : profile.openAiOmniRouteReasonerRouteId
}

/**
 * Resolve a parallel worker's effective `openAiModelId` with the three-tier
 * precedence (design §5.2): an explicit per-worker `route`, else the role default
 * for the worker's mode, else the parent's model id. Pure — no side effects,
 * no tier/GPU math.
 */
export function resolveWorkerModelId(
	route: string | null | undefined,
	mode: string,
	workerProfile: ProviderSettings,
	parentModelId: string | undefined,
): string | undefined {
	if (route) return route
	// A worker mode with its own saved profile runs on that profile's model.
	// Without this, a reader whose profile defines no role routes inherited the
	// parent orchestrator's model and did all its reading there.
	const ownModelId = workerProfile.openAiModelId
	if (ownModelId && ownModelId !== parentModelId) return ownModelId
	return roleDefault(mode, workerProfile) ?? parentModelId
}
