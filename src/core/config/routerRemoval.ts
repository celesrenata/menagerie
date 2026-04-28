export const LEGACY_ROO_PROVIDER = "roo"

export const ROUTER_REMOVAL_MESSAGE =
	"Roo Code Router has been removed. Please select and configure a different provider."

export const ROUTER_REMOVAL_IMPORT_WARNING =
	"Roo Code Router was removed. The imported profile was downgraded and needs to be reconfigured."

type LegacyRooConfig = Record<string, unknown> & {
	apiProvider: typeof LEGACY_ROO_PROVIDER
}

export function isLegacyRooConfig(value: unknown): value is LegacyRooConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).apiProvider === LEGACY_ROO_PROVIDER
	)
}

export function downgradeLegacyRooConfig<T extends Record<string, unknown>>(
	config: T,
): { config: Omit<T, "apiProvider" | "apiModelId" | "rooApiKey">; migrated: boolean } {
	if (!isLegacyRooConfig(config)) {
		return { config: config as Omit<T, "apiProvider" | "apiModelId" | "rooApiKey">, migrated: false }
	}

	const { apiProvider: _apiProvider, apiModelId: _apiModelId, rooApiKey: _rooApiKey, ...rest } = config

	return {
		config: rest as Omit<T, "apiProvider" | "apiModelId" | "rooApiKey">,
		migrated: true,
	}
}
