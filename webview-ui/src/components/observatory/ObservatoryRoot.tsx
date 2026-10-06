import React, { useCallback, useEffect, useReducer } from "react"
import type { ExtensionMessage, ObservatoryExtensionPayload } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { observatoryReducer, createInitialState } from "./observatoryStore"
import { tabReducer, createInitialTabState, type TabAction } from "./tabStore"
import { TaskTree } from "./TaskTree"
import { AttentionQueue } from "./AttentionQueue"
import { MastermindDashboard } from "./MastermindDashboard"
import { InspectionTabBar } from "./InspectionTabBar"
import { InspectionTab } from "./InspectionTab"

/**
 * Root component for the Task Observatory.
 * Subscribes on mount, owns the store, applies incoming observatory messages.
 */
export const ObservatoryRoot: React.FC = () => {
	const [state, dispatch] = useReducer(observatoryReducer, undefined, createInitialState)
	const [tabState, tabDispatch] = useReducer(tabReducer, undefined, createInitialTabState)

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (!message.observatory) return

			const obs = message.observatory as ObservatoryExtensionPayload

			switch (obs.kind) {
				case "update":
					dispatch({ type: "update", payload: obs })
					break
				case "window":
					dispatch({ type: "window", payload: obs })
					break
				case "persisted":
					dispatch({ type: "persisted", payload: obs })
					break
				case "mastermind":
					dispatch({ type: "mastermind", payload: obs })
					break
				case "error":
					dispatch({ type: "error", payload: obs })
					break
			}
		},
		[],
	)

	useEffect(() => {
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [handleMessage])

	// Subscribe on mount
	useEffect(() => {
		if (!state.subscribed) {
			vscode.postMessage({ type: "observatorySubscribe", observatory: { kind: "subscribe" } })
			dispatch({ type: "subscribed" })
		}
	}, [state.subscribed])

	const tasks = Array.from(state.tasks.values())
	const waitingTasks = tasks.filter((t) => t.status === "waiting")

	const handleOpenTab = useCallback(
		(id: string, title: string) => {
			tabDispatch({ type: "open", id, title })
		},
		[],
	)

	const handleTabAction = useCallback((action: TabAction) => {
		tabDispatch(action)
	}, [])

	const activeTask = tabState.activeTabId ? state.tasks.get(tabState.activeTabId) : undefined
	const activeTimeline = tabState.activeTabId ? state.timeline.get(tabState.activeTabId) ?? [] : []

	return (
		<div className="observatory-root" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
			{state.error && (
				<div className="observatory-error" style={{ padding: "8px", color: "var(--vscode-errorForeground)", fontSize: "0.9em" }}>
					Observatory: {state.error}
				</div>
			)}

			<div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
				{/* Left panel: task tree + attention + mastermind */}
				<div style={{ width: "260px", borderRight: "1px solid var(--vscode-panel-border)", overflow: "auto", flexShrink: 0 }}>
					<TaskTree tasks={tasks} onSelectTask={handleOpenTab} />
					{waitingTasks.length > 0 && (
						<AttentionQueue tasks={waitingTasks} onSelectTask={handleOpenTab} />
					)}
					{Array.from(state.mastermind.values()).map((summary) => (
						<MastermindDashboard key={summary.parentTaskId} summary={summary} />
					))}
				</div>

				{/* Right panel: inspection tabs + detail */}
				<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
					<InspectionTabBar tabs={tabState.tabs} activeTabId={tabState.activeTabId} onAction={handleTabAction} />
					{activeTask ? (
						<InspectionTab task={activeTask} timeline={activeTimeline} allEvents={state.events.get(activeTask.id) ?? []} />
					) : (
						<div style={{ padding: "20px", color: "var(--vscode-descriptionForeground)" }}>
							Select a task to inspect
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
