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
			{summary.spec?.map((spec) => (
				<div
					key={`${spec.specId}:${spec.revisionId}`}
					data-testid="observatory-spec-status"
					style={{ fontSize: "0.85em", marginTop: "6px", paddingTop: "6px", borderTop: "1px solid var(--vscode-panel-border)" }}>
					<div>
						SPEC {spec.specId} · rev {spec.revisionId.slice(7, 15)} ·{" "}
						<span data-testid="observatory-spec-phase">{spec.phase}</span> · requirements{" "}
						<span data-testid="observatory-spec-coverage">{spec.requirementsCovered}</span>
					</div>
					{spec.reasons.length > 0 && (
						<ul style={{ margin: "2px 0 0 16px", color: "var(--vscode-editorWarning-foreground)" }}>
							{spec.reasons.map((reason, index) => (
								<li key={index}>{reason}</li>
							))}
						</ul>
					)}
					{spec.criteria && spec.criteria.length > 0 && (
						<ul data-testid="observatory-spec-criteria" style={{ margin: "2px 0 0 16px" }}>
							{spec.criteria.map((c) => (
								<li key={c.acceptanceId} data-testid={`observatory-criterion-${c.acceptanceId}`}>
									{c.acceptanceId}
									{c.required ? "" : " (optional)"}: {c.state}
								</li>
							))}
						</ul>
					)}
					{spec.fixer && (
						<div data-testid="observatory-spec-fixer" style={{ color: "var(--vscode-editorWarning-foreground)" }}>
							{spec.fixer.exhausted
								? `fixer attempts exhausted (${spec.fixer.maxAttempts}); needs your attention`
								: `fix advised: attempt ${spec.fixer.attempt}/${spec.fixer.maxAttempts} for ${spec.fixer.links.map((l) => l.acceptanceId).join(", ")}`}
						</div>
					)}
					{spec.analysis && (
						<div data-testid="observatory-analysis-metrics" style={{ color: "var(--vscode-descriptionForeground)" }}>
							analysis: {spec.analysis.requests} req · {spec.analysis.cacheHits} cached · {spec.analysis.retries} retries ·{" "}
							{spec.analysis.escalations} escalations · queue {spec.analysis.queueActive} active / {spec.analysis.queueWaiting} waiting ·
							wait avg {spec.analysis.queueWaitMsAvg}ms (max {spec.analysis.queueWaitMsMax}) · latency avg {spec.analysis.latencyMsAvg}ms
						</div>
					)}
				</div>
			))}
			{summary.blockers.length > 0 && (
				<div style={{ fontSize: "0.85em", marginTop: "4px", color: "var(--vscode-editorWarning-foreground)" }}>
					Blockers: {summary.blockers.join(", ")}
				</div>
			)}
		</div>
	)
}
