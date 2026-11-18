import { useCallback, useState } from "react"
import { Trans } from "react-i18next"
import { ArrowLeft, Brain } from "lucide-react"

import { openRouterDefaultModelId, providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { validateApiConfiguration } from "@src/utils/validate"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"

import ApiOptions from "../settings/ApiOptions"
import { OmniRouteSettings } from "../settings/OmniRouteSettings"
import { Tab, TabContent } from "../common/Tab"

import { WelcomeLanding } from "./WelcomeLanding"

const DEFAULT_WELCOME_API_CONFIGURATION: ProviderSettings = {
	apiProvider: providerIdentifiers.openrouter,
	openRouterModelId: openRouterDefaultModelId,
}

type WelcomeSetupKind = "omniroute" | "other"

const isOmniRouteConfiguration = (apiConfiguration?: ProviderSettings): boolean =>
	apiConfiguration?.apiProvider === providerIdentifiers.openai && apiConfiguration.openAiIsOmniRoute === true

/** OmniRoute is the OpenAI-compatible provider with the OmniRoute flag set; keep any entered OpenAI fields. */
const toOmniRouteConfiguration = (apiConfiguration: ProviderSettings): ProviderSettings => ({
	...(apiConfiguration.apiProvider === providerIdentifiers.openai ? apiConfiguration : {}),
	apiProvider: providerIdentifiers.openai,
	openAiIsOmniRoute: true,
})

const getWelcomeApiConfiguration = (
	apiConfiguration?: ProviderSettings,
	zooCodeIsAuthenticated?: boolean,
): ProviderSettings => {
	// validateApiConfiguration treats a missing apiProvider as valid (no switch case matches),
	// so we explicitly fall back here before delegating to it for incomplete-but-set configs.
	if (!apiConfiguration?.apiProvider) {
		return DEFAULT_WELCOME_API_CONFIGURATION
	}

	const validationError = validateApiConfiguration(apiConfiguration, undefined, undefined, zooCodeIsAuthenticated)
	if (validationError) {
		return DEFAULT_WELCOME_API_CONFIGURATION
	}

	return apiConfiguration
}

const WelcomeViewProvider = () => {
	const { apiConfiguration, currentApiConfigName, setApiConfiguration, uriScheme, zooCodeIsAuthenticated } =
		useExtensionState()
	const { t } = useAppTranslation()
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const [showProviderSetup, setShowProviderSetup] = useState(false)
	const [welcomeApiConfiguration, setWelcomeApiConfiguration] = useState<ProviderSettings>()
	const effectiveApiConfiguration =
		welcomeApiConfiguration ?? getWelcomeApiConfiguration(apiConfiguration, zooCodeIsAuthenticated)

	const setApiConfigurationFieldForApiOptions = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => {
			setWelcomeApiConfiguration((current) => ({
				...(current ?? effectiveApiConfiguration),
				[field]: value,
			}))
			setApiConfiguration({ [field]: value })
		},
		[effectiveApiConfiguration, setApiConfiguration],
	)

	const setupKind: WelcomeSetupKind = isOmniRouteConfiguration(effectiveApiConfiguration) ? "omniroute" : "other"

	const selectSetupKind = useCallback(
		(kind: WelcomeSetupKind) => {
			if (kind === setupKind) return
			const next =
				kind === "omniroute"
					? toOmniRouteConfiguration(effectiveApiConfiguration)
					: DEFAULT_WELCOME_API_CONFIGURATION
			setErrorMessage(undefined)
			setWelcomeApiConfiguration(next)
			setApiConfiguration(next)
		},
		[setupKind, effectiveApiConfiguration, setApiConfiguration],
	)

	const handleGetStarted = useCallback(() => {
		if (!showProviderSetup) {
			const initialApiConfiguration = getWelcomeApiConfiguration(apiConfiguration, zooCodeIsAuthenticated)
			setWelcomeApiConfiguration(initialApiConfiguration)

			setApiConfiguration(initialApiConfiguration)

			setShowProviderSetup(true)
			return
		}

		const error = validateApiConfiguration(effectiveApiConfiguration, undefined, undefined, zooCodeIsAuthenticated)

		if (error) {
			setErrorMessage(error)
			return
		}

		setErrorMessage(undefined)
		vscode.postMessage({
			type: "upsertApiConfiguration",
			text: currentApiConfigName,
			apiConfiguration: effectiveApiConfiguration,
		})
	}, [
		showProviderSetup,
		apiConfiguration,
		setApiConfiguration,
		effectiveApiConfiguration,
		currentApiConfigName,
		zooCodeIsAuthenticated,
	])

	if (!showProviderSetup) {
		return (
			<WelcomeLanding
				onGetStarted={handleGetStarted}
				onImportSettings={() => vscode.postMessage({ type: "importSettings" })}
			/>
		)
	}

	return (
		<Tab>
			<TabContent className="flex flex-col gap-4 p-6">
				<Brain className="size-8" strokeWidth={1.5} />
				<h2 className="mt-0 mb-0 text-xl">{t("welcome:providerSignup.heading")}</h2>

				<p className="text-base text-vscode-foreground">
					<Trans i18nKey="welcome:providerSignup.chooseProvider" />
				</p>

				<div className="flex gap-2" role="group" aria-label={t("welcome:providerSignup.setupKind")}>
					{(["omniroute", "other"] as const).map((kind) => (
						<button
							key={kind}
							type="button"
							aria-pressed={setupKind === kind}
							onClick={() => selectSetupKind(kind)}
							data-testid={`welcome-setup-${kind}`}
							className={
								"rounded px-3 py-1 border border-vscode-button-border focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder " +
								(setupKind === kind
									? "bg-vscode-button-background text-vscode-button-foreground"
									: "bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground hover:bg-vscode-button-secondaryHoverBackground")
							}>
							{t(
								kind === "omniroute"
									? "welcome:providerSignup.omniroute"
									: "welcome:providerSignup.otherProvider",
							)}
						</button>
					))}
				</div>
				<div className="mb-8">
					{setupKind === "omniroute" ? (
						<>
							<OmniRouteSettings
								compact
								apiConfiguration={effectiveApiConfiguration}
								setApiConfigurationField={setApiConfigurationFieldForApiOptions}
							/>
							{errorMessage && (
								<div className="mt-2 text-sm text-vscode-errorForeground" role="alert">
									{errorMessage}
								</div>
							)}
						</>
					) : (
						<ApiOptions
							fromWelcomeView
							apiConfiguration={effectiveApiConfiguration}
							uriScheme={uriScheme}
							setApiConfigurationField={setApiConfigurationFieldForApiOptions}
							errorMessage={errorMessage}
							setErrorMessage={setErrorMessage}
						/>
					)}
				</div>

				<div className="-mt-4 flex gap-2">
					<Button onClick={() => setShowProviderSetup(false)} variant="secondary">
						<ArrowLeft className="size-4" />
						{t("welcome:providerSignup.goBack")}
					</Button>
					<Button onClick={handleGetStarted} variant="primary">
						{t("welcome:providerSignup.finish")} →
					</Button>
				</div>
			</TabContent>
		</Tab>
	)
}

export default WelcomeViewProvider
