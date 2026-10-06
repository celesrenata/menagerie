import type { IndexingState } from "../../services/code-index/interfaces/manager"
import type { IndexAvailabilitySnapshot } from "./types"

/**
 * Minimal structural shape that `CodeIndexManager` satisfies.
 * Declared locally so the derivation stays testable without the real manager.
 */
export interface IndexManagerLike {
	readonly isConfigurationLoaded: boolean
	readonly isFeatureEnabled: boolean
	readonly isFeatureConfigured: boolean
	readonly isInitialized: boolean
	readonly state: IndexingState
}

/**
 * Pure derivation of an {@link IndexAvailabilitySnapshot} from a structural
 * `IndexManagerLike`.
 *
 * `available` is true only when every boolean getter is true **and** the
 * manager state is not `"Indexing"`.
 *
 * Requirements traced: 4.1, 4.2, 4.3, 4.4, 4.5
 */
export function deriveIndexAvailability(managerLike: IndexManagerLike): IndexAvailabilitySnapshot {
	const { isConfigurationLoaded, isFeatureEnabled, isFeatureConfigured, isInitialized, state } = managerLike

	const available =
		isConfigurationLoaded && isFeatureEnabled && isFeatureConfigured && isInitialized && state !== "Indexing"

	return {
		isConfigurationLoaded,
		isFeatureEnabled,
		isFeatureConfigured,
		isInitialized,
		state,
		available,
	}
}
