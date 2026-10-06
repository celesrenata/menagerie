import type { TodoItem } from "./todo.js"

/**
 * Shared Task Observatory data models.
 *
 * These types are the single source of truth consumed by both the extension host
 * (`src/services/observatory/*`) and the React webview
 * (`webview-ui/src/components/observatory/*`). They are referenced from the additive
 * Observatory `ExtensionMessage`/`WebviewMessage` variants in `vscode-extension-host.ts`.
 *
 * All models are read-only descriptions of observed task state; nothing here carries a
 * mutation path (see the Zero-Lifecycle-Side-Effect invariant in the design).
 */

/** Inspection source for a task (Requirement 9.3). */
export type ObservationSource = "LIVE" | "SNAPSHOT" | "COMPLETED"

/** Task state indicators (Requirement 2.3). Derived from Task fields. */
export type ObservedTaskStatus =
	| "queued"
	| "working"
	| "streaming"
	| "waiting" // waiting for user input
	| "completed"
	| "failed"
	| "cancelled" // cancelled or stopped

/** One inspected task (parent or worker), from any source. */
export interface ObservedTask {
	id: string // taskId
	parentId?: string // parallelParentTaskId ?? parentTaskId
	logicalWorkerId?: string // stable worker identity across live+persisted (Req 9.5)
	isParallelWorker: boolean
	status: ObservedTaskStatus
	source: ObservationSource
	header: SummaryHeader
	errorClassification?: ErrorClassification
}

/** Sticky summary header fields (Requirement 5.2). Empty-value sentinel, never omitted (5.3). */
export interface SummaryHeader {
	status: ObservedTaskStatus
	mode: string | null // getTaskMode() for LIVE
	route: string | null
	profile: string | null // getTaskApiConfigName() for LIVE
	model: string | null // api.getModel().id for LIVE
	reasoning: string | null
	contextUsed: number | null
	contextLimit: number | null
	startedAt: number | null
	lastActivityAt: number | null
	workspace: string | null // task.cwd
	parentId: string | null
	workerId: string | null
}

/** Transport-neutral normalization of a RooCodeEventName.* emission. */
export interface ObservationEvent {
	taskId: string
	kind:
		| "message" // RooCodeEventName.Message (created|updated)
		| "active"
		| "interactive"
		| "resumable"
		| "idle"
		| "started"
		| "aborted"
		| "askResponded"
		| "userMessage"
		| "tokenUsage"
		| "toolFailed"
		| "queued"
	committedAt: number // used to measure the <=500ms budget (Req 8.3)
	seq: number // monotonic per task; webview applies in order
	payload: unknown // kind-specific, normalized read-only snapshot
}

/**
 * Compact, read-only capability summary surfaced in the Observatory
 * (dynamic-capability-broker, Requirement 9.2). Carries only the mastermind-safe
 * identity of a Tool Capability — its namespaced id, risk class, access kind, and
 * current lease state. It intentionally omits tool-schema internals, server names,
 * transports, and tool IDs, matching the compact catalog view discipline.
 */
export interface CapabilitySummary {
	id: string // ToolCapabilityId (namespaced string, e.g. "cluster.deploy")
	risk: "low" | "elevated" | "high" // CapabilityRiskClass
	access: "read" | "write" | "execute" // CapabilityAccessKind
	state: "requested" | "active" | "released" | "denied" // LeaseState
}

/**
 * One read-only lease-history entry (dynamic-capability-broker, Requirement 9.4).
 * A compact projection of a lease event; carries no mutation path and no
 * schema/server/tool internals.
 */
export interface CapabilityLeaseHistoryEntry {
	capability: string // ToolCapabilityId
	state: "requested" | "active" | "released" | "denied" // LeaseState
	reason: string
	requestedBy: string // LeaseRequester
}

/**
 * Additive, read-only capability `ObservationEvent` variant
 * (dynamic-capability-broker, Requirements 9.2, 9.4). Delivered through the
 * existing `observatoryUpdate` channel, partitioned into exactly four sections —
 * ACTIVE, AVAILABLE (allowed-but-not-active), RELEASED, and DENIED — plus an
 * optional read-only lease event history. This adds NO mutation path and honors
 * the task-observatory Zero-Lifecycle-Side-Effect invariant.
 */
export interface CapabilityObservationEvent {
	taskId: string
	workerId: string
	kind: "capability"
	active: CapabilitySummary[]
	available: CapabilitySummary[] // allowed-but-not-active
	released: CapabilitySummary[]
	denied: CapabilitySummary[]
	history?: CapabilityLeaseHistoryEntry[]
	committedAt: number
}

/** One row in the virtualized timeline, with collapse/preview metadata (Req 7.4). */
export interface TimelineEvent {
	id: string
	taskId: string
	ts: number
	label: string // human-readable (e.g. "Menagerie · tool", "You")
	kind: "say" | "ask" | "tool" | "api" | "reasoning"
	outcome?: "success" | "error" | "pending"
	lineCount: number
	byteSize: number
	collapsedByDefault: boolean // true when lineCount > 50 || byteSize > 10000
	preview: string // compact summary shown while collapsed
	detailRef?: string // opaque ref; full detail fetched lazily on expand (Req 7.2)
}

/** Discriminated union for each detail view (Requirement 6). */
export type DetailView =
	| { view: "activity"; events: TimelineEvent[] }
	| { view: "checklist"; todos: TodoItem[] } // sourced from Task.todoList (Req 6.3)
	| { view: "changes"; files: ChangedFile[]; patchRefs: string[]; gitSummary: string }
	| { view: "evidence"; tests: EvidenceItem[]; commands: EvidenceItem[]; refs: EvidenceItem[] }
	| { view: "metrics"; metrics: TaskMetrics }
	| { view: "raw"; events: TimelineEvent[] } // complete underlying events (Req 6.7)

export interface ChangedFile {
	path: string
	status: string
	additions?: number
	deletions?: number
}

export interface EvidenceItem {
	label: string
	detailRef?: string
	outcome?: "success" | "error" | "pending"
}

export interface TaskMetrics {
	tokensIn: number | null
	tokensOut: number | null
	latencyMs: number | null
	route: string | null
	model: string | null
	contextPressure: number | null
	reasoningEscalation: string | null
	toolCounts: Record<string, number>
}

/** Parent batch overview (Requirement 10.2). */
export interface MastermindSummary {
	parentTaskId: string
	workerCounts: Record<ObservedTaskStatus, number>
	laneStatus: { workerId: string; status: ObservedTaskStatus }[]
	contextPercent: number | null
	tierCeiling: string | null
	artifacts: string[]
	blockers: string[]
}

/** Error categories (Requirement 12.1). */
export type ErrorClassification =
	| "TRANSIENT"
	| "MODEL"
	| "TOOL"
	| "VALIDATION"
	| "AUTH"
	| "INFRASTRUCTURE"
	| "LOOP"
	| "USER_INPUT_REQUIRED"
