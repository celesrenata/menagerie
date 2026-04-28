import {
	type ProviderSettings,
	type OrganizationAllowList,
	type RouterModels,
	rooDefaultModelId,
} from "@roo-code/types"

import { ModelPicker } from "../ModelPicker"

type RooProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const Roo = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: RooProps) => (
	<ModelPicker
		apiConfiguration={apiConfiguration}
		setApiConfigurationField={setApiConfigurationField}
		defaultModelId={rooDefaultModelId}
		models={routerModels?.roo ?? {}}
		modelIdKey="apiModelId"
		serviceName="Roo Code Router"
		serviceUrl="https://app.roocode.com"
		organizationAllowList={organizationAllowList}
		errorMessage={modelValidationError}
		simplifySettings={simplifySettings}
	/>
)
