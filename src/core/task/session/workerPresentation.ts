export const WORKER_PRESENTATION_VALUES = ["headless", "task-hub", "editor-tabs"] as const
export type WorkerPresentation = (typeof WORKER_PRESENTATION_VALUES)[number]
export const DEFAULT_WORKER_PRESENTATION: WorkerPresentation = "headless"

export function resolveWorkerPresentation(value: unknown): WorkerPresentation {
	return WORKER_PRESENTATION_VALUES.includes(value as WorkerPresentation)
		? (value as WorkerPresentation)
		: DEFAULT_WORKER_PRESENTATION
}

/** Headless and task-hub both skip auto-created editor tabs. Only editor-tabs is legacy abort-on-close. */
export function shouldCreateWorkerPanel(presentation: WorkerPresentation): boolean {
	return presentation === "editor-tabs"
}

export function isDetachableWorkerPresentation(presentation: WorkerPresentation): boolean {
	return presentation !== "editor-tabs"
}
