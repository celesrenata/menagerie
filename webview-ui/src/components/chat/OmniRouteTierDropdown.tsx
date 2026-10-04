import React from "react"
import { DollarSign } from "lucide-react"

import { OMNIROUTE_TIER_COUNT, providerIdentifiers } from "@roo-code/types"

import { vscode } from "@/utils/vscode"

import { cn } from "@/lib/utils"
import { enabledSelectorTriggerClassName, selectorTriggerClassName } from "@/components/ui/selectorTriggerStyles"

import { useExtensionState } from "@/context/ExtensionStateContext"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { useRooPortal } from "@/components/ui/hooks/useRooPortal"

import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, Button } from "@/components/ui"

interface OmniRouteTierDropdownProps {
	disabled?: boolean
	triggerClassName?: string
}

/** Render the cost-tier label ($..$$$$$) for a 1-based tier. */
const tierLabel = (tier: number): string => "$".repeat(tier)

/**
 * Per-request OmniRoute cost-tier selector ($..$$$$$), shown beside the YOLO/auto-approve
 * control (FEAT-005). The selected tier is sent to OmniRoute as the `X-OmniRoute-Tier`
 * header so the request is granted routing up to that cost tier; "Default" clears it so no
 * header is sent and OmniRoute keeps its own default.
 *
 * The value is read from live extension state and saved immediately via `updateSettings`
 * (the same deliberate immediate-save flow the sibling AutoApproveDropdown uses for the
 * YOLO/auto-approve toggles). This control lives in the chat toolbar, not SettingsView, so
 * the SettingsView `cachedState` buffer does not apply here. The control renders only for an
 * OmniRoute profile.
 */
export const OmniRouteTierDropdown = ({ disabled = false, triggerClassName = "" }: OmniRouteTierDropdownProps) => {
	const [open, setOpen] = React.useState(false)
	const portalContainer = useRooPortal("roo-portal")
	const { t } = useAppTranslation()

	const { apiConfiguration, omniRouteTier } = useExtensionState()

	// Mirror the extension-side isOmniRoute discriminator (openai provider + opt-in flag).
	const isOmniRouteProfile =
		apiConfiguration?.apiProvider === providerIdentifiers.openai && apiConfiguration?.openAiIsOmniRoute === true

	const handleSelect = React.useCallback((tier: number | undefined) => {
		vscode.postMessage({ type: "updateSettings", updatedSettings: { omniRouteTier: tier } })
		setOpen(false)
	}, [])

	if (!isOmniRouteProfile) {
		return null
	}

	const tiers = Array.from({ length: OMNIROUTE_TIER_COUNT }, (_, index) => index + 1)
	const selectedLabel = typeof omniRouteTier === "number" ? tierLabel(omniRouteTier) : undefined

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="omniroute-tier-dropdown-root">
			<StandardTooltip content={t("chat:omniRouteTier.tooltip")}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="omniroute-tier-dropdown-trigger"
					className={cn(
						"inline-flex items-center gap-1.5 relative whitespace-nowrap px-1.5 py-1 text-xs",
						selectorTriggerClassName,
						"max-[300px]:shrink-0",
						disabled ? "opacity-50 cursor-not-allowed" : enabledSelectorTriggerClassName,
						triggerClassName,
					)}>
					<DollarSign className="size-3 flex-shrink-0" />
					<span className="truncate min-w-0">
						{selectedLabel ?? t("chat:omniRouteTier.triggerLabelDefault")}
					</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden w-[min(240px,calc(100vw-2rem))]"
				onOpenAutoFocus={(e) => e.preventDefault()}>
				<div className="flex flex-col w-full">
					<div className="p-3 border-b border-vscode-dropdown-border">
						<h4 className="m-0 font-bold text-base text-vscode-foreground">
							{t("chat:omniRouteTier.title")}
						</h4>
						<p className="m-0 mt-1 text-xs text-vscode-descriptionForeground">
							{t("chat:omniRouteTier.description")}
						</p>
					</div>
					<div className="flex flex-col p-1">
						<Button
							variant={selectedLabel === undefined ? "primary" : "ghost"}
							onClick={() => handleSelect(undefined)}
							data-testid="omniroute-tier-option-default"
							className="justify-start px-2 py-1.5 text-sm h-auto">
							{t("chat:omniRouteTier.optionDefault")}
						</Button>
						{tiers.map((tier) => (
							<Button
								key={tier}
								variant={omniRouteTier === tier ? "primary" : "ghost"}
								onClick={() => handleSelect(tier)}
								data-testid={`omniroute-tier-option-${tier}`}
								className="justify-start px-2 py-1.5 text-sm h-auto font-mono">
								{tierLabel(tier)}
							</Button>
						))}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
