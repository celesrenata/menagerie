import { FormEvent, HTMLAttributes } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import {
	DCG_GUARD_LEVELS,
	DEFAULT_TENACITY_MAX_TRIES,
	DEFAULT_YOLO_APPROVE_OUTSIDE_WORKSPACE,
	DEFAULT_YOLO_AUTO_ANSWER_FOLLOWUPS,
	DEFAULT_YOLO_NO_COMMAND_TIMEOUT,
	DEFAULT_YOLO_SKIP_REQUEST_COST_PAUSES,
	DEFAULT_YOLO_WORKERS_ANY_TOOL,
	TENACITY_MAX_TRIES_LIMIT,
	type DcgGuardLevel,
} from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

const isChecked = (e: Event | FormEvent<HTMLElement>) => (e.target as HTMLInputElement).checked

type YoloSettingsProps = HTMLAttributes<HTMLDivElement> & {
	tenacityEnabled?: boolean
	tenacityMaxTries?: number
	tenacityUnlimited?: boolean
	dcgGuardLevel?: DcgGuardLevel
	yoloApproveOutsideWorkspace?: boolean
	yoloSkipRequestCostPauses?: boolean
	yoloAutoAnswerFollowups?: boolean
	yoloWorkersAnyTool?: boolean
	yoloNoCommandTimeout?: boolean
	setCachedStateField: SetCachedStateField<
		| "tenacityEnabled"
		| "tenacityMaxTries"
		| "tenacityUnlimited"
		| "dcgGuardLevel"
		| "yoloApproveOutsideWorkspace"
		| "yoloSkipRequestCostPauses"
		| "yoloAutoAnswerFollowups"
		| "yoloWorkersAnyTool"
		| "yoloNoCommandTimeout"
	>
}

export const YoloSettings = ({
	tenacityEnabled,
	tenacityMaxTries,
	tenacityUnlimited,
	dcgGuardLevel,
	yoloApproveOutsideWorkspace,
	yoloSkipRequestCostPauses,
	yoloAutoAnswerFollowups,
	yoloWorkersAnyTool,
	yoloNoCommandTimeout,
	setCachedStateField,
	...props
}: YoloSettingsProps) => {
	const { t } = useAppTranslation()

	const toggles = [
		{
			key: "yoloApproveOutsideWorkspace",
			id: "yolo-approve-outside-workspace",
			value: yoloApproveOutsideWorkspace ?? DEFAULT_YOLO_APPROVE_OUTSIDE_WORKSPACE,
		},
		{
			key: "yoloSkipRequestCostPauses",
			id: "yolo-skip-request-cost-pauses",
			value: yoloSkipRequestCostPauses ?? DEFAULT_YOLO_SKIP_REQUEST_COST_PAUSES,
		},
		{
			key: "yoloAutoAnswerFollowups",
			id: "yolo-auto-answer-followups",
			value: yoloAutoAnswerFollowups ?? DEFAULT_YOLO_AUTO_ANSWER_FOLLOWUPS,
		},
		{
			key: "yoloWorkersAnyTool",
			id: "yolo-workers-any-tool",
			value: yoloWorkersAnyTool ?? DEFAULT_YOLO_WORKERS_ANY_TOOL,
		},
		{
			key: "yoloNoCommandTimeout",
			id: "yolo-no-command-timeout",
			value: yoloNoCommandTimeout ?? DEFAULT_YOLO_NO_COMMAND_TIMEOUT,
		},
	] as const

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.yolo")}</SectionHeader>

			<Section>
				<div className="space-y-6">
					<div className="text-vscode-descriptionForeground text-sm">{t("settings:yolo.description")}</div>

					<div className="space-y-4">
						<h4 className="font-medium m-0">{t("settings:yolo.tenacity.heading")}</h4>

						<SearchableSetting
							settingId="yolo-tenacity-enabled"
							section="yolo"
							label={t("settings:yolo.tenacity.enabled.label")}>
							<VSCodeCheckbox
								checked={tenacityEnabled ?? false}
								onChange={(e: Event | FormEvent<HTMLElement>) =>
									setCachedStateField("tenacityEnabled", isChecked(e))
								}
								data-testid="tenacity-enabled-checkbox">
								<span className="font-medium">{t("settings:yolo.tenacity.enabled.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:yolo.tenacity.enabled.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="yolo-tenacity-max-tries"
							section="yolo"
							label={t("settings:yolo.tenacity.maxTries.label")}>
							<label className="block font-medium mb-1" htmlFor="tenacity-max-tries">
								{t("settings:yolo.tenacity.maxTries.label")}
							</label>
							<Input
								id="tenacity-max-tries"
								type="number"
								min={1}
								max={TENACITY_MAX_TRIES_LIMIT}
								value={tenacityMaxTries ?? DEFAULT_TENACITY_MAX_TRIES}
								onChange={(e) => {
									const parsed = Number.parseInt(e.target.value, 10)
									if (Number.isNaN(parsed)) {
										return
									}
									setCachedStateField(
										"tenacityMaxTries",
										Math.min(TENACITY_MAX_TRIES_LIMIT, Math.max(1, parsed)),
									)
								}}
								className="w-32"
								data-testid="tenacity-max-tries-input"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:yolo.tenacity.maxTries.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="yolo-tenacity-unlimited"
							section="yolo"
							label={t("settings:yolo.tenacity.unlimited.label")}>
							<VSCodeCheckbox
								checked={tenacityUnlimited ?? false}
								onChange={(e: Event | FormEvent<HTMLElement>) =>
									setCachedStateField("tenacityUnlimited", isChecked(e))
								}
								data-testid="tenacity-unlimited-checkbox">
								<span className="font-medium">{t("settings:yolo.tenacity.unlimited.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:yolo.tenacity.unlimited.description")}
							</div>
						</SearchableSetting>
					</div>

					<div className="space-y-4">
						<h4 className="font-medium m-0">{t("settings:yolo.guard.heading")}</h4>

						<SearchableSetting
							settingId="yolo-dcg-guard-level"
							section="yolo"
							label={t("settings:yolo.guard.level.label")}>
							<label className="block font-medium mb-1">{t("settings:yolo.guard.level.label")}</label>
							<Select
								value={dcgGuardLevel ?? "relaxed"}
								onValueChange={(value) => setCachedStateField("dcgGuardLevel", value as DcgGuardLevel)}>
								<SelectTrigger className="w-full" data-testid="dcg-guard-level-dropdown">
									<SelectValue placeholder={t("settings:common.select")} />
								</SelectTrigger>
								<SelectContent>
									{DCG_GUARD_LEVELS.map((level) => (
										<SelectItem key={level} value={level}>
											{t(`settings:yolo.guard.level.options.${level}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:yolo.guard.level.description")}
							</div>
						</SearchableSetting>
					</div>

					<div className="space-y-4">
						<h4 className="font-medium m-0">{t("settings:yolo.options.heading")}</h4>

						{toggles.map(({ key, id, value }) => (
							<SearchableSetting
								key={key}
								settingId={id}
								section="yolo"
								label={t(`settings:yolo.options.${key}.label`)}>
								<VSCodeCheckbox
									checked={value}
									onChange={(e: Event | FormEvent<HTMLElement>) =>
										setCachedStateField(key, isChecked(e))
									}
									data-testid={`${id}-checkbox`}>
									<span className="font-medium">{t(`settings:yolo.options.${key}.label`)}</span>
								</VSCodeCheckbox>
								<div className="text-vscode-descriptionForeground text-sm mt-1">
									{t(`settings:yolo.options.${key}.description`)}
								</div>
							</SearchableSetting>
						))}
					</div>
				</div>
			</Section>
		</div>
	)
}
