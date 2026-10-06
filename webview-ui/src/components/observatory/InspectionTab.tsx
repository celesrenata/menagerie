import React, { useState } from "react"
import type { ObservedTask, ObservationEvent, TimelineEvent } from "@roo-code/types"
import { SummaryHeader } from "./SummaryHeader"
import { DetailTabs } from "./DetailTabs"
import { VirtualTimeline } from "./VirtualTimeline"
import { ErrorBadge } from "./ErrorBadge"

interface InspectionTabProps {
	task: ObservedTask
	timeline: readonly TimelineEvent[]
	allEvents: readonly ObservationEvent[]
}

/**
 * Single inspection tab showing summary header + detail region for the selected task.
 */
export const InspectionTab: React.FC<InspectionTabProps> = ({ task, timeline, allEvents }) => {
	const [activeView, setActiveView] = useState<"activity" | "checklist" | "changes" | "evidence" | "metrics" | "raw">("activity")

	return (
		<div className="observatory-inspection-tab" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
			<SummaryHeader header={task.header} />

			{task.errorClassification && (
				<div style={{ padding: "4px 8px" }}>
					<ErrorBadge classification={task.errorClassification} />
				</div>
			)}

			<div role="tablist" style={{ display: "flex", gap: "4px", padding: "6px 8px", borderBottom: "1px solid var(--vscode-panel-border)" }}>
				{(["activity", "checklist", "changes", "evidence", "metrics", "raw"] as const).map((view) => (
					<button
						key={view}
						role="tab"
						type="button"
						aria-selected={view === activeView}
						onClick={() => setActiveView(view)}
						style={{
							background: view === activeView ? "var(--vscode-tab-activeBackground)" : "transparent",
							border: "none",
							cursor: "pointer",
							color: "inherit",
							padding: "4px 8px",
							borderRadius: "4px",
							fontSize: "0.85em",
							textTransform: "capitalize",
						}}>
						{view}
					</button>
				))}
			</div>

			<div style={{ flex: 1, overflow: "auto" }}>
				{activeView === "activity" && (
					<VirtualTimeline events={timeline} taskId={task.id} />
				)}
				{activeView !== "activity" && (
					<DetailTabs view={activeView} task={task} observationEvents={allEvents} />
				)}
			</div>
		</div>
	)
}
