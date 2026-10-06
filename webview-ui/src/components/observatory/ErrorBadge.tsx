import React from "react"
import type { ErrorClassification } from "@roo-code/types"

interface ErrorBadgeProps {
	classification: ErrorClassification
}

const COLORS: Record<ErrorClassification, string> = {
	TRANSIENT: "var(--vscode-editorWarning-foreground)",
	MODEL: "var(--vscode-editorError-foreground)",
	TOOL: "var(--vscode-editorError-foreground)",
	VALIDATION: "var(--vscode-editorWarning-foreground)",
	AUTH: "var(--vscode-editorError-foreground)",
	INFRASTRUCTURE: "var(--vscode-editorError-foreground)",
	LOOP: "var(--vscode-editorError-foreground)",
	USER_INPUT_REQUIRED: "var(--vscode-editorInfo-foreground)",
}

/** Renders an ErrorClassification badge beside error detail. */
export const ErrorBadge: React.FC<ErrorBadgeProps> = ({ classification }) => (
	<span
		className="observatory-error-badge"
		style={{
			display: "inline-block",
			padding: "1px 6px",
			borderRadius: "4px",
			fontSize: "0.75em",
			fontWeight: "bold",
			border: `1px solid ${COLORS[classification]}`,
			color: COLORS[classification],
		}}>
		{classification}
	</span>
)
