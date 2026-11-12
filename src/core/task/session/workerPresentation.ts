export const WORKER_PRESENTATION_VALUES = ["headless", "task-hub", "editor-tabs"] as const
export type WorkerPresentation = (typeof WORKER_PRESENTATION_VALUES)[number]
export const DEFAULT_WORKER_PRESENTATION: WorkerPresentation = "headless"

export function resolveWorkerPresentation(value: unknown): WorkerPresentation {
	return WORKER_PRESENTATION_VALUES.includes(value as WorkerPresentation)
		? (value as WorkerPresentation)
		: DEFAULT_WORKER_PRESENTATION
}

/** Headless and task-hub both skip auto-created editor tabs. editor-tabs creates one per worker. */
export function shouldCreateWorkerPanel(presentation: WorkerPresentation): boolean {
	return presentation === "editor-tabs"
}

/** Closing a worker tab never cancels the task, whatever the presentation. */
export function isDetachableWorkerPresentation(_presentation: WorkerPresentation): boolean {
	return true
}
