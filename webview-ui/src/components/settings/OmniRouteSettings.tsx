import { useCallback, useMemo, useState } from "react"
import { useEvent } from "react-use"
import { Checkbox } from "vscrui"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ExtensionMessage,
	type OmniRouteCatalogEntry,
	type OmniRouteConnectionStatus,
	type ProviderSettings,
	OmniRouteCatalogMessageType,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Button, StandardTooltip } from "@src/components/ui"

import { inputEventTransform } from "./transforms"

type OmniRouteSettingsProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
}

/**
 * Dedicated OmniRoute settings section. Every input binds to the SettingsView's
 * local `cachedState` via `setApiConfigurationField` (never live state), per the
 * repo AGENTS.md Settings-View rule. The connection check / catalog fetch posts
 * the unsaved server root + key so an edit can be tested before Save; the four
 * OmniRoute provider-profile fields persist through the existing
 * `upsertApiConfiguration` save path.
 * See docs/architecture/omniroute-integration-design.md §2.
 */
export const OmniRouteSettings = ({ apiConfiguration, setApiConfigurationField }: OmniRouteSettingsProps) => {
	const { t } = useAppTranslation()

	const [status, setStatus] = useState<OmniRouteConnectionStatus>("unknown")
	const [statusError, setStatusError] = useState<string | undefined>(undefined)
	const [catalog, setCatalog] = useState<OmniRouteCatalogEntry[]>([])
	const [search, setSearch] = useState("")
	const [newRouteName, setNewRouteName] = useState("")
	const [newRouteModelId, setNewRouteModelId] = useState("")

	const isOmniRoute = apiConfiguration.openAiIsOmniRoute ?? false
	const customRoutes = useMemo(
		() => apiConfiguration.openAiOmniRouteCustomRoutes ?? [],
		[apiConfiguration.openAiOmniRouteCustomRoutes],
	)

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform as (event: E) => ProviderSettings[K],
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		if (message.type === OmniRouteCatalogMessageType.omniRouteCatalog && message.omniRouteCatalog) {
			setStatus(message.omniRouteCatalog.status)
			setStatusError(message.omniRouteCatalog.error)
			setCatalog(message.omniRouteCatalog.entries)
		}
	}, [])

	useEvent("message", onMessage)

	const requestCatalog = useCallback(() => {
		setStatus("connecting")
		setStatusError(undefined)
		vscode.postMessage({
			type: OmniRouteCatalogMessageType.requestOmniRouteCatalog,
			values: {
				serverUrl: apiConfiguration.openAiBaseUrl,
				apiKey: apiConfiguration.openAiApiKey,
			},
		})
	}, [apiConfiguration.openAiBaseUrl, apiConfiguration.openAiApiKey])

	const filteredCatalog = useMemo(() => {
		const query = search.trim().toLowerCase()
		if (!query) return catalog
		return catalog.filter(
			(entry) =>
				entry.id.toLowerCase().includes(query) ||
				(entry.name?.toLowerCase().includes(query) ?? false) ||
				(entry.family?.toLowerCase().includes(query) ?? false),
		)
	}, [catalog, search])

	const statusLabel = useMemo(() => {
		switch (status) {
			case "connecting":
				return t("settings:omniroute.status.connecting")
			case "connected":
				return t("settings:omniroute.status.connected", { count: catalog.length })
			case "error":
				return t("settings:omniroute.status.error", { error: statusError ?? "" })
			default:
				return t("settings:omniroute.status.unknown")
		}
	}, [status, statusError, catalog.length, t])

	const addCustomRoute = useCallback(() => {
		const name = newRouteName.trim()
		const modelId = newRouteModelId.trim()
		if (!name || !modelId) return
		setApiConfigurationField("openAiOmniRouteCustomRoutes", [...customRoutes, { name, modelId }])
		setNewRouteName("")
		setNewRouteModelId("")
	}, [newRouteName, newRouteModelId, customRoutes, setApiConfigurationField])

	const removeCustomRoute = useCallback(
		(index: number) => {
			setApiConfigurationField(
				"openAiOmniRouteCustomRoutes",
				customRoutes.filter((_, i) => i !== index),
			)
		},
		[customRoutes, setApiConfigurationField],
	)

	return (
		<div className="flex flex-col gap-4">
			<div className="text-sm text-vscode-descriptionForeground">{t("settings:omniroute.description")}</div>

			{/* Block 1: Endpoint setup */}
			<Checkbox
				checked={isOmniRoute}
				onChange={(checked: boolean) => setApiConfigurationField("openAiIsOmniRoute", checked)}>
				{t("settings:omniroute.useOmniRoute")}
			</Checkbox>

			{isOmniRoute && (
				<>
					<VSCodeTextField
						value={apiConfiguration.openAiBaseUrl || ""}
						type="url"
						onInput={handleInputChange("openAiBaseUrl")}
						placeholder={t("settings:omniroute.serverUrlPlaceholder")}
						className="w-full">
						<label className="block font-medium mb-1">{t("settings:omniroute.serverUrl")}</label>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground -mt-2">
						{t("settings:omniroute.serverUrlHint")}
					</div>

					<VSCodeTextField
						value={apiConfiguration.openAiApiKey || ""}
						type="password"
						onInput={handleInputChange("openAiApiKey")}
						placeholder={t("settings:omniroute.apiKeyPlaceholder")}
						className="w-full">
						<label className="block font-medium mb-1">{t("settings:omniroute.apiKey")}</label>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground -mt-2">
						{t("settings:omniroute.apiKeyHint")}
					</div>

					{/* Block 2: Connection check / refresh */}
					<div className="flex items-center gap-2">
						<Button variant="secondary" onClick={requestCatalog} data-testid="omniroute-check-connection">
							{t("settings:omniroute.checkConnection")}
						</Button>
						<Button variant="secondary" onClick={requestCatalog} data-testid="omniroute-refresh-catalog">
							{t("settings:omniroute.refreshCatalog")}
						</Button>
					</div>
					<div
						className={
							status === "error"
								? "text-sm text-vscode-errorForeground"
								: "text-sm text-vscode-descriptionForeground"
						}
						role="status"
						data-testid="omniroute-status">
						{statusLabel}
					</div>

					{/* Block 3: Catalog */}
					<div className="flex flex-col gap-2">
						<label className="block font-medium">{t("settings:omniroute.catalog")}</label>
						<VSCodeTextField
							value={search}
							onInput={(e: unknown) =>
								setSearch((e as { target: HTMLInputElement }).target.value)
							}
							placeholder={t("settings:omniroute.searchPlaceholder")}
							className="w-full"
							data-testid="omniroute-catalog-search"
						/>
						{filteredCatalog.length === 0 ? (
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:omniroute.noModels")}
							</div>
						) : (
							<ul className="flex flex-col gap-1 max-h-72 overflow-y-auto m-0 p-0 list-none">
								{filteredCatalog.map((entry) => {
									const selected = apiConfiguration.openAiModelId === entry.id
									return (
										<li key={entry.id}>
											<button
												type="button"
												data-testid={`omniroute-model-${entry.id}`}
												aria-pressed={selected}
												onClick={() => setApiConfigurationField("openAiModelId", entry.id)}
												className={
													"w-full text-left rounded px-2 py-1 hover:bg-vscode-list-hoverBackground focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder " +
													(selected ? "bg-vscode-list-activeSelectionBackground" : "")
												}>
												<span className="font-medium">{entry.name ?? entry.id}</span>
												{entry.family ? (
													<span className="text-vscode-descriptionForeground">
														{" · "}
														{entry.family}
													</span>
												) : null}
												<span className="block text-xs text-vscode-descriptionForeground">
													{entry.id}
												</span>
											</button>
										</li>
									)
								})}
							</ul>
						)}
					</div>

					{/* Block 4: Parallel worker defaults + custom routes */}
					<div className="flex flex-col gap-2">
						<label className="block font-medium">{t("settings:omniroute.parallelDefaults")}</label>
						<VSCodeTextField
							value={apiConfiguration.openAiOmniRouteReaderRouteId || ""}
							onInput={handleInputChange("openAiOmniRouteReaderRouteId")}
							placeholder={t("settings:omniroute.readerPlaceholder")}
							className="w-full"
							data-testid="omniroute-reader-route">
							<label className="block font-medium mb-1">{t("settings:omniroute.readerRoute")}</label>
						</VSCodeTextField>
						<VSCodeTextField
							value={apiConfiguration.openAiOmniRouteReasonerRouteId || ""}
							onInput={handleInputChange("openAiOmniRouteReasonerRouteId")}
							placeholder={t("settings:omniroute.reasonerPlaceholder")}
							className="w-full"
							data-testid="omniroute-reasoner-route">
							<label className="block font-medium mb-1">{t("settings:omniroute.reasonerRoute")}</label>
						</VSCodeTextField>
					</div>

					<div className="flex flex-col gap-2">
						<label className="block font-medium">{t("settings:omniroute.customRoutes")}</label>
						{customRoutes.length === 0 ? (
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:omniroute.noCustomRoutes")}
							</div>
						) : (
							customRoutes.map((route, index) => (
								<div key={index} className="flex items-center gap-2">
									<span className="flex-1">
										<span className="font-medium">{route.name}</span>
										<span className="text-vscode-descriptionForeground">
											{" → "}
											{route.modelId}
										</span>
									</span>
									<StandardTooltip content={t("settings:common.remove")}>
										<VSCodeButton
											appearance="icon"
											onClick={() => removeCustomRoute(index)}
											data-testid={`omniroute-remove-route-${index}`}>
											<span className="codicon codicon-trash"></span>
										</VSCodeButton>
									</StandardTooltip>
								</div>
							))
						)}
						<div className="flex items-center gap-2">
							<VSCodeTextField
								value={newRouteName}
								onInput={(e: unknown) =>
									setNewRouteName((e as { target: HTMLInputElement }).target.value)
								}
								placeholder={t("settings:omniroute.routeName")}
								className="flex-1"
								data-testid="omniroute-new-route-name"
							/>
							<VSCodeTextField
								value={newRouteModelId}
								onInput={(e: unknown) =>
									setNewRouteModelId((e as { target: HTMLInputElement }).target.value)
								}
								placeholder={t("settings:omniroute.routeModelId")}
								className="flex-1"
								data-testid="omniroute-new-route-model"
							/>
							<StandardTooltip content={t("settings:common.add")}>
								<VSCodeButton
									appearance="icon"
									onClick={addCustomRoute}
									data-testid="omniroute-add-route">
									<span className="codicon codicon-add"></span>
								</VSCodeButton>
							</StandardTooltip>
						</div>
					</div>
				</>
			)}
		</div>
	)
}
