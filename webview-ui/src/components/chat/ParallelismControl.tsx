import React from "react"
import { Zap } from "lucide-react"

import { PARALLELISM_MODES, type ParallelismMode } from "@roo-code/types"

import { vscode } from "@/utils/vscode"

import { cn } from "@/lib/utils"
import { enabledSelectorTriggerClassName, selectorTriggerClassName } from "@/components/ui/selectorTriggerStyles"

import { useRooPortal } from "@/components/ui/hooks/useRooPortal"

import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, Button } from "@/components/ui"

interface ParallelismControlProps {
	disabled?: boolean
	triggerClassName?: string
	/** Composer-local parallelism appetite (source of truth for the label). FEAT-011. */
	selectedParallelismMode: ParallelismMode | undefined
	/** Synchronous local-state setter owned by ChatView. */
	onSelect: (mode: ParallelismMode) => void
}

/**
 * Human-facing label for each parallelism appetite. The label reflects HOW
 * aggressively Menagerie may fan work out, never a GPU or worker count. The
 * `"max"` member intentionally reads as "MAXIMUM CHAOS".
 */
export const PARALLELISM_MODE_LABELS: Record<ParallelismMode, string> = {
	conservative: "Conservative",
	balanced: "Balanced",
	auto: "Auto",
	aggressive: "Aggressive",
	max: "MAXIMUM CHAOS",
}

/** Default appetite presented when no mode has been selected (unset => Auto). */
const DEFAULT_ACTIVE_MODE: ParallelismMode = "auto"

/**
 * Per-request parallelism appetite selector, shown beside the OmniRoute cost-tier
 * control (FEAT-011). The user picks how aggressively Menagerie may fan work out;
 * the resolved appetite becomes the request envelope's `parallelism` field so the
 * host can resolve the ceiling policy for the `BoundedElasticScheduler`.
 *
 * This is a controlled component: `selectedParallelismMode` and `onSelect` are owned
 * by `ChatView` as composer-local state so the appetite is captured synchronously at
 * submit time, eliminating any stale-value race. Selecting a mode calls `onSelect`
 * first (synchronous composer-local update), then posts `updateSettings` asynchronously
 * as a SEPARATE action to keep the saved default in sync. The displayed label and the
 * submit-time capture derive from `selectedParallelismMode`, never from the async echo.
 *
 * Unlike `OmniRouteTierDropdown`, this control is provider-agnostic: it renders for every
 * profile and has no OmniRoute gating.
 *
 * The trigger label derives from LOCAL state (the appetite label, e.g. "⚡ Auto") and
 * never a GPU/worker count. When `selectedParallelismMode` is unset, Auto is presented
 * as the active selection.
 */
export const ParallelismControl = ({
	disabled = false,
	triggerClassName = "",
	selectedParallelismMode,
	onSelect,
}: ParallelismControlProps) => {
	const [open, setOpen] = React.useState(false)
	const portalContainer = useRooPortal("roo-portal")

	const handleSelect = React.useCallback(
		(mode: ParallelismMode) => {
			// Capture the selection synchronously in composer-local state so a request
			// submitted immediately after carries this appetite without waiting on persist.
			onSelect(mode)
			// Persist the saved default asynchronously as a separate action; the label and
			// the per-request value do not depend on this round trip.
			vscode.postMessage({ type: "updateSettings", updatedSettings: { parallelismMode: mode } })
			setOpen(false)
		},
		[onSelect],
	)

	// Derive the active mode from composer-local state; unset presents Auto as active.
	const activeMode: ParallelismMode = selectedParallelismMode ?? DEFAULT_ACTIVE_MODE
	const selectedLabel = PARALLELISM_MODE_LABELS[activeMode]

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="parallelism-control-root">
			<StandardTooltip content="How aggressively Menagerie may fan work out">
				<PopoverTrigger
					disabled={disabled}
					data-testid="parallelism-control-trigger"
					className={cn(
						"inline-flex items-center gap-1.5 relative whitespace-nowrap px-1.5 py-1 text-xs",
						selectorTriggerClassName,
						"max-[300px]:shrink-0",
						disabled ? "opacity-50 cursor-not-allowed" : enabledSelectorTriggerClassName,
						triggerClassName,
					)}>
					<Zap className="size-3 flex-shrink-0" />
					<span className="truncate min-w-0">{selectedLabel}</span>
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
						<h4 className="m-0 font-bold text-base text-vscode-foreground">Parallelism</h4>
						<p className="m-0 mt-1 text-xs text-vscode-descriptionForeground">
							How aggressively Menagerie may fan work out
						</p>
					</div>
					<div className="flex flex-col p-1">
						{PARALLELISM_MODES.map((mode) => (
							<Button
								key={mode}
								variant={activeMode === mode ? "primary" : "ghost"}
								onClick={() => handleSelect(mode)}
								data-testid={`parallelism-control-option-${mode}`}
								className="justify-start px-2 py-1.5 text-sm h-auto">
								{PARALLELISM_MODE_LABELS[mode]}
							</Button>
						))}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
