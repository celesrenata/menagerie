import type { ProviderSettings } from "@roo-code/types"

export type TaskExecutionContext = {
	mode: string
	apiConfigName: string | undefined
	apiConfiguration: ProviderSettings
	/**
	 * The Capability_Lane this delegated worker was assigned at dispatch, if any
	 * (omniroute-fleet-topology Requirement 17.4). One of the four exact
	 * capability-lanes-routing names (`reader.fast`, `reader.deep`,
	 * `coder.primary`, `reasoning.escalation`). The Task attaches it as request
	 * metadata on every request it makes on behalf of this worker, and on nothing
	 * else. Typed as `string` here so this handoff type stays free of a
	 * core/task/capabilityLanes dependency; the caller supplies a `CapabilityLane`.
	 */
	capabilityLane?: string
}

export type SavedModeProfile = {
	name?: string
	apiConfiguration: ProviderSettings
}

export function selectHandoffExecutionContext(
	parent: TaskExecutionContext,
	requestedMode: string,
	parentMode: string,
	lockApiConfigAcrossModes: boolean,
	savedModeProfile?: SavedModeProfile,
	preferSavedModeProfile = false,
): TaskExecutionContext {
	if (
		(requestedMode !== parentMode || preferSavedModeProfile) &&
		!lockApiConfigAcrossModes &&
		savedModeProfile?.apiConfiguration.apiProvider
	) {
		return {
			mode: requestedMode,
			apiConfigName: savedModeProfile.name,
			apiConfiguration: structuredClone(savedModeProfile.apiConfiguration),
		}
	}

	return {
		mode: requestedMode,
		apiConfigName: parent.apiConfigName,
		apiConfiguration: structuredClone(parent.apiConfiguration),
	}
}

export function getEffectiveTaskApiConfiguration(
	apiConfiguration: ProviderSettings,
	handoffExecutionContext?: TaskExecutionContext,
): ProviderSettings {
	return handoffExecutionContext?.apiConfiguration ?? apiConfiguration
}
