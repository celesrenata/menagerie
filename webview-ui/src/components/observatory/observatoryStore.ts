import type {
	ObservedTask,
	ObservationEvent,
	MastermindSummary,
	TimelineEvent,
	ObservatoryExtensionPayload,
} from "@roo-code/types"

export interface ObservatoryState {
	tasks: Map<string, ObservedTask>
	events: Map<string, ObservationEvent[]>
	timeline: Map<string, TimelineEvent[]>
	mastermind: Map<string, MastermindSummary>
	error: string | null
	subscribed: boolean
}

export function createInitialState(): ObservatoryState {
	return {
		tasks: new Map(),
		events: new Map(),
		timeline: new Map(),
		mastermind: new Map(),
		error: null,
		subscribed: false,
	}
}

export type ObservatoryAction =
	| { type: "update"; payload: Extract<ObservatoryExtensionPayload, { kind: "update" }> }
	| { type: "window"; payload: Extract<ObservatoryExtensionPayload, { kind: "window" }> }
	| { type: "persisted"; payload: Extract<ObservatoryExtensionPayload, { kind: "persisted" }> }
	| { type: "mastermind"; payload: Extract<ObservatoryExtensionPayload, { kind: "mastermind" }> }
	| { type: "error"; payload: Extract<ObservatoryExtensionPayload, { kind: "error" }> }
	| { type: "subscribed" }

/**
 * Reducer for Observatory state. Applies snapshot-wins reconciliation:
 * SNAPSHOT updates fully replace task state; event updates merge.
 * Groups LIVE/COMPLETED records under logicalWorkerId.
 */
export function observatoryReducer(state: ObservatoryState, action: ObservatoryAction): ObservatoryState {
	switch (action.type) {
		case "subscribed":
			return { ...state, subscribed: true }

		case "update": {
			const { reason, tasks: incomingTasks, events: incomingEvents } = action.payload
			const nextTasks = new Map(state.tasks)

			if (reason === "snapshot") {
				// Snapshot-wins: replace all tasks from this source
				for (const [key, existing] of nextTasks) {
					if (existing.source === "SNAPSHOT" || existing.source === "LIVE") {
						nextTasks.delete(key)
					}
				}
			}

			for (const task of incomingTasks) {
				const key = task.logicalWorkerId ?? task.id
				nextTasks.set(key, task)
			}

			const nextEvents = new Map(state.events)
			if (incomingEvents) {
				for (const event of incomingEvents) {
					const existing = nextEvents.get(event.taskId) ?? []
					// Apply in seq order, skip already-seen seqs
					const lastSeq = existing.at(-1)?.seq ?? 0
					if (event.seq > lastSeq) {
						nextEvents.set(event.taskId, [...existing, event])
					}
				}
			}

			return { ...state, tasks: nextTasks, events: nextEvents, error: null }
		}

		case "window": {
			const { taskId, events } = action.payload
			const nextTimeline = new Map(state.timeline)
			const existing = nextTimeline.get(taskId) ?? []
			// Append new window events (keyed by offset), cap at 500
			const merged = [...existing, ...events].slice(-500)
			nextTimeline.set(taskId, merged)
			return { ...state, timeline: nextTimeline }
		}

		case "persisted": {
			const { task, events } = action.payload
			const nextTasks = new Map(state.tasks)
			const key = task.logicalWorkerId ?? task.id
			nextTasks.set(key, task)
			const nextTimeline = new Map(state.timeline)
			nextTimeline.set(key, events)
			return { ...state, tasks: nextTasks, timeline: nextTimeline }
		}

		case "mastermind": {
			const { summary } = action.payload
			const nextMastermind = new Map(state.mastermind)
			nextMastermind.set(summary.parentTaskId, summary)
			return { ...state, mastermind: nextMastermind }
		}

		case "error":
			return { ...state, error: action.payload.message }
	}
}
