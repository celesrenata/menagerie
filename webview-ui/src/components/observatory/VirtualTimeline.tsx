import React, { useState, useMemo, useCallback, useRef, type ErrorInfo } from "react"
import type { TimelineEvent } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"

const MAX_IN_MEMORY = 500
const OVERSCAN = 20
const ROW_HEIGHT_PX = 32 // estimated row height

interface VirtualTimelineProps {
	events: readonly TimelineEvent[]
	taskId: string
	filter?: string
}

/**
 * Virtualized timeline with bounded windowing and lazy expansion.
 *
 * - Overscan ≤ 20 above/below viewport
 * - ≤ 500 events retained in memory (evict outside window)
 * - Lazy per-event full-detail fetch on expand via observatoryRequestWindow
 * - Tool-result collapse: collapsed iff lineCount > 50 or byteSize > 10000
 * - Timeline filtering shows exactly matching events
 */
export const VirtualTimeline: React.FC<VirtualTimelineProps> = ({ events, taskId, filter }) => {
	const containerRef = useRef<HTMLDivElement>(null)
	const [scrollTop, setScrollTop] = useState(0)
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

	// Apply filter
	const filtered = useMemo(() => {
		if (!filter) return events
		const lowerFilter = filter.toLowerCase()
		return events.filter(
			(e) => e.label.toLowerCase().includes(lowerFilter) || e.preview.toLowerCase().includes(lowerFilter),
		)
	}, [events, filter])

	// Bound to MAX_IN_MEMORY
	const bounded = useMemo(() => filtered.slice(-MAX_IN_MEMORY), [filtered])

	// Calculate visible window with overscan
	const containerHeight = containerRef.current?.clientHeight ?? 400
	const totalHeight = bounded.length * ROW_HEIGHT_PX
	const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN)
	const endIndex = Math.min(bounded.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT_PX) + OVERSCAN)
	const visibleEvents = bounded.slice(startIndex, endIndex)

	const handleScroll = useCallback(() => {
		if (containerRef.current) {
			setScrollTop(containerRef.current.scrollTop)
		}
	}, [])

	const handleExpand = useCallback(
		(eventId: string) => {
			setExpandedIds((prev) => {
				const next = new Set(prev)
				if (next.has(eventId)) {
					next.delete(eventId)
				} else {
					next.add(eventId)
					// Request full detail via lazy fetch
					const eventIndex = bounded.findIndex((e) => e.id === eventId)
					if (eventIndex >= 0) {
						vscode.postMessage({
							type: "observatoryRequestWindow",
							observatory: { kind: "requestWindow", taskId, offset: eventIndex, limit: 1 },
						})
					}
				}
				return next
			})
		},
		[bounded, taskId],
	)

	return (
		<div
			ref={containerRef}
			onScroll={handleScroll}
			style={{ height: "100%", overflow: "auto", position: "relative" }}>
			<div style={{ height: `${totalHeight}px`, position: "relative" }}>
				<div style={{ position: "absolute", top: `${startIndex * ROW_HEIGHT_PX}px`, width: "100%" }}>
					{visibleEvents.map((event) => (
						<TimelineRowBoundary key={event.id}>
							<TimelineRow
								event={event}
								expanded={expandedIds.has(event.id)}
								onToggle={() => handleExpand(event.id)}
							/>
						</TimelineRowBoundary>
					))}
				</div>
			</div>
		</div>
	)
}

interface TimelineRowProps {
	event: TimelineEvent
	expanded: boolean
	onToggle: () => void
}

const TimelineRow: React.FC<TimelineRowProps> = ({ event, expanded, onToggle }) => {
	const isCollapsed = event.collapsedByDefault || event.lineCount > 50 || event.byteSize > 10000

	return (
		<div
			style={{
				minHeight: `${ROW_HEIGHT_PX}px`,
				padding: "4px 8px",
				borderBottom: "1px solid var(--vscode-panel-border)",
				fontSize: "0.85em",
			}}>
			<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
				<span style={{ color: "var(--vscode-descriptionForeground)", flexShrink: 0 }}>
					{event.kind}
				</span>
				<span style={{ fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{event.label}
				</span>
				{event.outcome && (
					<span
						style={{
							color: event.outcome === "success" ? "var(--vscode-testing-iconPassed)" : event.outcome === "error" ? "var(--vscode-editorError-foreground)" : "inherit",
							flexShrink: 0,
						}}>
						{event.outcome}
					</span>
				)}
				{isCollapsed && !expanded && (
					<span style={{ color: "var(--vscode-descriptionForeground)", flexShrink: 0, fontSize: "0.8em" }}>
						({event.lineCount} lines, {formatBytes(event.byteSize)})
					</span>
				)}
				<button
					type="button"
					aria-label={expanded ? "Collapse" : "Expand"}
					onClick={onToggle}
					style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "inherit" }}>
					{expanded ? "▾" : "▸"}
				</button>
			</div>
			{!expanded && (
				<div style={{ color: "var(--vscode-descriptionForeground)", marginTop: "2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
					{event.preview}
				</div>
			)}
			{expanded && (
				<pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", marginTop: "4px", fontFamily: "var(--vscode-editor-font-family)" }}>
					{event.preview}
					{event.detailRef && (
						<div style={{ marginTop: "4px", color: "var(--vscode-descriptionForeground)" }}>
							(Full detail: {event.detailRef})
						</div>
					)}
				</pre>
			)}
		</div>
	)
}

/** React error boundary wrapping each timeline row (Requirement 7.8). */
class TimelineRowBoundary extends React.Component<
	{ children: React.ReactNode },
	{ hasError: boolean; error: string }
> {
	constructor(props: { children: React.ReactNode }) {
		super(props)
		this.state = { hasError: false, error: "" }
	}

	static getDerivedStateFromError(error: Error): { hasError: true; error: string } {
		return { hasError: true, error: error.message }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[Observatory] Timeline row render failure:", error, info)
	}

	render(): React.ReactNode {
		if (this.state.hasError) {
			return (
				<div style={{ padding: "4px 8px", color: "var(--vscode-editorError-foreground)", fontSize: "0.85em", borderBottom: "1px solid var(--vscode-panel-border)" }}>
					⚠ Render error: {this.state.error}
				</div>
			)
		}
		return this.props.children
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
