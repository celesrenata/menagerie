import React from "react"
import type { ObservedTask, ObservationEvent } from "@roo-code/types"

interface DetailTabsProps {
	view: "checklist" | "changes" | "evidence" | "metrics" | "raw"
	task: ObservedTask
	observationEvents: readonly ObservationEvent[]
}

/**
 * Renders the non-activity detail views: Checklist, Changes, Evidence,
 * Metrics, and Raw (complete underlying events). Compact-by-default API
 * metadata with a raw toggle.
 */
export const DetailTabs: React.FC<DetailTabsProps> = ({ view, task, observationEvents }) => {
	switch (view) {
		case "checklist":
			return <ChecklistView />
		case "changes":
			return <ChangesView />
		case "evidence":
			return <EvidenceView />
		case "metrics":
			return <MetricsView header={task.header} />
		case "raw":
			return <RawView events={observationEvents} />
	}
}

const ChecklistView: React.FC = () => (
	<div style={{ padding: "12px" }}>
		<div style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.9em" }}>
			Checklist items will be populated from the task&#39;s todoList.
		</div>
	</div>
)

const ChangesView: React.FC = () => (
	<div style={{ padding: "12px" }}>
		<div style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.9em" }}>
			Changed files, patches, and git summary will appear here when available.
		</div>
	</div>
)

const EvidenceView: React.FC = () => (
	<div style={{ padding: "12px" }}>
		<div style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.9em" }}>
			Test results, commands, and references will appear here when available.
		</div>
	</div>
)

const MetricsView: React.FC<{ header: ObservedTask["header"] }> = ({ header }) => {
	const metrics = [
		["Model", header.model ?? "—"],
		["Route", header.route ?? "—"],
		["Profile", header.profile ?? "—"],
		["Context used", header.contextUsed !== null ? String(header.contextUsed) : "—"],
		["Context limit", header.contextLimit !== null ? String(header.contextLimit) : "—"],
	]

	return (
		<div style={{ padding: "12px" }}>
			{metrics.map(([label, value]) => (
				<div key={label} style={{ marginBottom: "4px", fontSize: "0.9em" }}>
					<span style={{ color: "var(--vscode-descriptionForeground)" }}>{label}: </span>
					<span>{value}</span>
				</div>
			))}
		</div>
	)
}

const RawView: React.FC<{ events: readonly ObservationEvent[] }> = ({ events }) => (
	<div style={{ padding: "12px", fontFamily: "var(--vscode-editor-font-family)", fontSize: "0.85em" }}>
		{events.length === 0 ? (
			<div style={{ color: "var(--vscode-descriptionForeground)" }}>No raw events recorded.</div>
		) : (
			<pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
				{JSON.stringify(events, null, 2)}
			</pre>
		)}
	</div>
)
