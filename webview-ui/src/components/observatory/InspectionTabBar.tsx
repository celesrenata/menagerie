import React from "react"
import type { InspectionTab, TabAction } from "./tabStore"

interface InspectionTabBarProps {
	tabs: readonly InspectionTab[]
	activeTabId: string | null
	onAction: (action: TabAction) => void
}

/**
 * Tab bar for multiple simultaneous inspection tabs. Pin and close are pure
 * webview store actions; closing sends NO host message that mutates a task.
 */
export const InspectionTabBar: React.FC<InspectionTabBarProps> = ({ tabs, activeTabId, onAction }) => {
	if (tabs.length === 0) return null

	return (
		<div
			className="observatory-tab-bar"
			role="tablist"
			style={{ display: "flex", borderBottom: "1px solid var(--vscode-panel-border)", overflowX: "auto", flexShrink: 0 }}>
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId
				return (
					<div
						key={tab.id}
						role="tab"
						aria-selected={isActive}
						style={{
							display: "flex",
							alignItems: "center",
							gap: "6px",
							padding: "6px 10px",
							cursor: "pointer",
							borderBottom: isActive ? "2px solid var(--vscode-focusBorder)" : "2px solid transparent",
							background: isActive ? "var(--vscode-tab-activeBackground)" : "transparent",
							whiteSpace: "nowrap",
						}}
						onClick={() => onAction({ type: "activate", id: tab.id })}>
						<span style={{ fontSize: "0.9em", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis" }}>
							{tab.pinned ? "📌 " : ""}
							{tab.id.slice(0, 10)}
						</span>
						<button
							type="button"
							aria-label={tab.pinned ? "Unpin tab" : "Pin tab"}
							onClick={(e) => {
								e.stopPropagation()
								onAction({ type: tab.pinned ? "unpin" : "pin", id: tab.id })
							}}
							style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0 }}>
							{tab.pinned ? "⚲" : "⚮"}
						</button>
						<button
							type="button"
							aria-label="Close tab"
							onClick={(e) => {
								e.stopPropagation()
								onAction({ type: "close", id: tab.id })
							}}
							style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0 }}>
							✕
						</button>
					</div>
				)
			})}
		</div>
	)
}
