export interface InspectionTab {
	id: string // the task key being inspected (logicalWorkerId ?? taskId)
	title: string
	pinned: boolean
}

export interface TabState {
	tabs: InspectionTab[]
	activeTabId: string | null
}

export function createInitialTabState(): TabState {
	return { tabs: [], activeTabId: null }
}

export type TabAction =
	| { type: "open"; id: string; title: string }
	| { type: "close"; id: string }
	| { type: "activate"; id: string }
	| { type: "pin"; id: string }
	| { type: "unpin"; id: string }

/**
 * Reducer for inspection tabs. All actions are pure webview state changes.
 * NONE of these dispatch a host message that mutates a task (Requirement 4.8).
 */
export function tabReducer(state: TabState, action: TabAction): TabState {
	switch (action.type) {
		case "open": {
			const existing = state.tabs.find((t) => t.id === action.id)
			if (existing) {
				return { ...state, activeTabId: action.id }
			}
			const tab: InspectionTab = { id: action.id, title: action.title, pinned: false }
			return { tabs: [...state.tabs, tab], activeTabId: action.id }
		}
		case "close": {
			const tabs = state.tabs.filter((t) => t.id !== action.id)
			let activeTabId = state.activeTabId
			if (activeTabId === action.id) {
				activeTabId = tabs.at(-1)?.id ?? null
			}
			return { tabs, activeTabId }
		}
		case "activate":
			return { ...state, activeTabId: action.id }
		case "pin":
			return { ...state, tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, pinned: true } : t)) }
		case "unpin":
			return { ...state, tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, pinned: false } : t)) }
	}
}
