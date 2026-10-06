import React from "react"
import type { SummaryHeader as SummaryHeaderType } from "@roo-code/types"

interface SummaryHeaderProps {
	header: SummaryHeaderType
}

/** Renders `—` for null/undefined/empty values so the field count is constant. */
function displayValue(value: unknown): string {
	if (value === null || value === undefined || value === "") return "—"
	return String(value)
}

/**
 * Sticky summary header with the fixed 13-field set.
 * Any absent value renders an explicit empty-value indicator ("—"); no field is ever omitted.
 */
export const SummaryHeader: React.FC<SummaryHeaderProps> = ({ header }) => {
	const fields: [string, unknown][] = [
		["Status", header.status],
		["Mode", header.mode],
		["Route", header.route],
		["Profile", header.profile],
		["Model", header.model],
		["Reasoning", header.reasoning],
		["Context used", header.contextUsed],
		["Context limit", header.contextLimit],
		["Started", header.startedAt ? new Date(header.startedAt).toLocaleTimeString() : null],
		["Last activity", header.lastActivityAt ? new Date(header.lastActivityAt).toLocaleTimeString() : null],
		["Workspace", header.workspace],
		["Parent ID", header.parentId],
		["Worker ID", header.workerId],
	]

	return (
		<div
			className="observatory-summary-header"
			style={{
				position: "sticky",
				top: 0,
				zIndex: 10,
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
				gap: "4px 12px",
				padding: "8px",
				background: "var(--vscode-editor-background)",
				borderBottom: "1px solid var(--vscode-panel-border)",
				fontSize: "0.85em",
			}}>
			{fields.map(([label, value]) => (
				<div key={label}>
					<span style={{ color: "var(--vscode-descriptionForeground)" }}>{label}: </span>
					<span>{displayValue(value)}</span>
				</div>
			))}
		</div>
	)
}
