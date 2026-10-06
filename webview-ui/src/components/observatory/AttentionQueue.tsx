import React from "react"
import type { ObservedTask } from "@roo-code/types"

interface AttentionQueueProps {
	tasks: readonly ObservedTask[]
	onSelectTask: (id: string, title: string) => void
}

/**
 * "Needs You" list showing exactly waiting-for-input tasks.
 * Selecting an item opens an Inspection Tab but sends NO active-chat or mutating message.
 */
export const AttentionQueue: React.FC<AttentionQueueProps> = ({ tasks, onSelectTask }) => {
	if (tasks.length === 0) return null

	return (
		<div className="observatory-attention" style={{ padding: "8px", borderTop: "1px solid var(--vscode-panel-border)" }}>
			<div style={{ fontWeight: "bold", fontSize: "0.85em", marginBottom: "6px", color: "var(--vscode-editorWarning-foreground)" }}>
				NEEDS YOU ({tasks.length})
			</div>
			{tasks.map((task) => {
				const key = task.logicalWorkerId ?? task.id
				return (
					<div
						key={key}
						role="button"
						tabIndex={0}
						onClick={() => onSelectTask(key, task.header.workspace ?? task.id)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") onSelectTask(key, task.header.workspace ?? task.id)
						}}
						style={{ padding: "3px 4px", cursor: "pointer", fontSize: "0.9em", display: "flex", alignItems: "center", gap: "6px" }}>
						<span aria-hidden="true">⏸</span>
						<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
							{task.id.slice(0, 8)} · waiting
						</span>
					</div>
				)
			})}
		</div>
	)
}
