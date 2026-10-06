import React from "react"
import type { MastermindSummary, ObservedTaskStatus } from "@roo-code/types"

interface MastermindDashboardProps {
	summary: MastermindSummary
}

const STATUS_LABELS: readonly ObservedTaskStatus[] = ["queued", "working", "streaming", "waiting", "completed", "failed", "cancelled"]

/**
 * Renders the parent-level Mastermind summary. Opening this sends only
 * observatoryRequestMastermind (read-only).
 */
export const MastermindDashboard: React.FC<MastermindDashboardProps> = ({ summary }) => {
	return (
		<div className="observatory-mastermind" style={{ padding: "8px", borderTop: "1px solid var(--vscode-panel-border)" }}>
			<div style={{ fontWeight: "bold", fontSize: "0.85em", marginBottom: "6px", color: "var(--vscode-descriptionForeground)" }}>
				MASTERMIND · {summary.parentTaskId.slice(0, 8)}
			</div>
			<div style={{ display: "flex", flexWrap: "wrap", gap: "6px", fontSize: "0.85em" }}>
				{STATUS_LABELS.map((status) => {
					const count = summary.workerCounts[status]
					if (count === 0) return null
					return (
						<span key={status} style={{ padding: "2px 6px", borderRadius: "4px", background: "var(--vscode-badge-background)", color: "var(--vscode-badge-foreground)" }}>
							{status}: {count}
						</span>
					)
				})}
			</div>
			{summary.contextPercent !== null && (
				<div style={{ fontSize: "0.85em", marginTop: "4px" }}>Context: {summary.contextPercent}%</div>
			)}
			{summary.blockers.length > 0 && (
				<div style={{ fontSize: "0.85em", marginTop: "4px", color: "var(--vscode-editorWarning-foreground)" }}>
					Blockers: {summary.blockers.join(", ")}
				</div>
			)}
		</div>
	)
}
