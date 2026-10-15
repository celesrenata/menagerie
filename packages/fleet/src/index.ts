// @roo-code/fleet — OmniRoute fleet topology toolkit.
//
// This barrel re-exports the toolkit's public surface. Modules are added by
// subsequent tasks (route compiler, reconciler, observer, evaluator).

export { type Result, ok, err } from "./result.js"

// Inventory parser (task 2.1): loose parse representation + syntax errors.
export { parse, inventoryParser, type InventoryParser } from "./inventory/parser.js"
export type {
	ParsedDocument,
	ParsedEntry,
	ParsedValue,
	ParseError,
	ParseErrorKind,
} from "./inventory/parsed-document.js"

// Inventory printer (task 2.2): typed model → canonical KDL.
export { inventoryPrinter, type InventoryPrinter } from "./inventory/printer.js"

// Inventory validator (task 2.3): grouped parsed document → typed model.
export {
	createInventoryValidator,
	DefaultInventoryValidator,
	type InventoryValidator,
	type ValidationResult,
	type Violation,
} from "./inventory/validator.js"
export {
	HttpOmniRouteClient,
	MissingSecretError,
	OmniRouteApiError,
	REDACTION_MARKER,
	type AdvertisedModel,
	type CallLogQuery,
	type CallLogRecord,
	type Combo,
	type ComboInput,
	type ComboModelRef,
	type ComboStrategy,
	type ComboTrace,
	type Connection,
	type ConnectionPatch,
	type ContextOverride,
	type ContextOverridePatch,
	type FetchInit,
	type FetchLike,
	type FetchResponse,
	type HttpOmniRouteClientOptions,
	type OmniRouteClient,
	type SecretResolver,
} from "./omniroute/client.js"
export { redactBodySummary, redactSecretValues, redactTokenizedSegments } from "./omniroute/redact.js"

// Secret resolution and missing-secret handling (task 6.4): use-time resolution
// with the non-empty + 10 s deadline rule, the unsent-read/unsent-write
// outcomes, and the production file/env resolver (Requirements 22.3, 22.8, 22.9).
export {
	CREDENTIAL_UNAVAILABLE_REASON,
	DEFAULT_SECRET_TIMEOUT_MS,
	FileAndEnvSecretResolver,
	SecretResolutionError,
	describeSecretFailure,
	nodeSecretSource,
	parseSecretRef,
	resolveSecret,
	resolveSecretOrThrow,
	secretFailure,
	unsentReadAsUnverified,
	unsentWriteAsError,
	type ParsedSecretRef,
	type ResolveSecretOptions,
	type ResolveSecretResult,
	type SecretFailure,
	type SecretFailureCause,
	type SecretRefKind,
	type SecretSource,
	type WriteSendOutcome,
} from "./omniroute/secrets.js"
export type {
	ParsedDocument as ValidatorParsedDocument,
	ParsedEntry as ValidatorParsedEntry,
	ParsedScalar as ValidatorParsedScalar,
	ParsedValue as ValidatorParsedValue,
} from "./inventory/types.js"

// Adapter (task 2.4): parser's loose document → validator's grouped document.
export { adapt } from "./inventory/adapt.js"

// Route_Compiler (tasks 3.1-3.4): pure inventory → Desired_Route_State per instance.
export {
	compile,
	routeCompiler,
	type CompileFailure,
	type CompileResult,
	type DesiredRouteState,
	type PublishedRouteMetadata,
	type ResidencySwapLatency,
	type Revision,
	type RouteCapacity,
	type RouteCompiler,
	type RouteKind,
	type RoutingSetting,
} from "./compile/compiler.js"
export {
	cloudEligibleForLane,
	cloudTargetId,
	eligibleCloudTargets,
	eligibleOfferingSlots,
	offeringSlots,
	slotEligibleForLane,
	slotTargetId,
	spendRank,
	targetId,
	type Slot,
	type Target,
} from "./compile/targets.js"
export {
	buildCloudSpill,
	dedupPools,
	orderLaneTargets,
	orderLocalSlots,
	poolName,
	reachablePools,
	type CloudSpill,
	type CloudSpillTier,
	type DispatchConfig,
	type ExcludedCloudTarget,
	type InternalPool,
	type OrderedLaneTargets,
	type PoolIdentity,
} from "./compile/order.js"
export {
	concurrencyPerModel,
	connectionMaxConcurrent,
	defaultAllocationLookup,
	deviceConcurrency,
	hardConcurrencyProvidersSetting,
	laneMaximumTier,
	laneTierRouting,
	localProviders,
	offeringConcurrency,
	OMNIROUTE_HARD_CONCURRENCY_PROVIDERS_SETTING,
	resolveDeviceAllocation,
	spendClassFirstTier,
	type DeviceAllocationLookup,
	type HardConcurrencyProvidersSetting,
	type MaximumTier,
	type TierRouting,
} from "./compile/capacity.js"

// Reconciler — drift detection (task 5.1): read-only Desired vs Live comparison.
export {
	detectDrift,
	type DifferenceKind,
	type DriftCounts,
	type DriftOptions,
	type DriftOutcome,
	type DriftReport,
	type FieldDifference,
	type InstanceDriftReport,
	type ModelIdFinding,
	type ModelIdFindingKind,
	type ObjectDifference,
	type ReadFailureReason,
	type UnverifiedRead,
} from "./reconcile/drift.js"

// Reconciler — scheduled drift run and alert write (task 5.2): one scheduled
// run + an interval scheduler, and the Alert_Destination writer.
export {
	AlertWriteError,
	HttpAlertWriter,
	MAX_SCHEDULE_INTERVAL_MS,
	runScheduledDrift,
	scheduleDrift,
	type AlertFetchLike,
	type AlertWriter,
	type HttpAlertWriterOptions,
	type RunScheduledDriftArgs,
	type ScheduleDriftArgs,
	type ScheduleHandle,
	type ScheduledDriftResult,
	type ScheduleTimers,
} from "./reconcile/schedule.js"

// Reconciler — Change_Plan builder (task 6.1): dry-run plan + connection-id resolution.
export {
	plan,
	type ChangeOp,
	type ChangePlan,
	type PlanError,
	type PlanOptions,
} from "./reconcile/plan.js"

// Reconciler — decommissioning and model replacement (task 7.2): compose the
// base Change_Plan with connection deactivations, context-override removals, the
// stale-reference report, and the per-route local-Slot loss report
// (Requirements 12.1-12.6).
export {
	decommission,
	offeringSlotTargetId,
	replacementEligibleLanes,
	type ConnectionDeactivation,
	type ContextOverrideRemoval,
	type DecommissionPlan,
	type RouteSlotLoss,
	type StaleReference,
} from "./reconcile/decommission.js"

// Reconciler — apply with backup, readback, and restore-on-failure (task 6.2):
// the ONLY writer path to OmniRoute (design §3, Requirement 9.3-9.6, 9.11-9.17,
// 22.2, 22.4-22.7).
export {
	apply,
	ApplyTimeoutError,
	ConcurrentOperationError,
	InMemoryAuditLog,
	InMemoryBackupStore,
	type ApplyCounts,
	type ApplyDeps,
	type ApplyOutcome,
	type ApplyResult,
	type AuditLog,
	type BackupStore,
	type DriftedObject,
	type InstanceLocks,
	type OperatorConfirmation,
	type PostApplyRecord,
	type RestoreResult,
	type RouteBackup,
} from "./reconcile/apply.js"

// Reconciler — rollback to a Route_Backup (task 6.3): the second writer path to
// OmniRoute. Checksum + drift verification before any write, reverse-order
// restore, restore-failure halt, and the retired/undeclared guard (design §3,
// Requirement 9.7, 9.8, 9.16, 10.5).
export {
	rollback,
	RollbackTimeoutError,
	type DriftedSinceApply,
	type InstanceRole,
	type InstanceRoleLookup,
	type RollbackDeps,
	type RollbackOutcome,
	type RollbackRestore,
	type RollbackResult,
} from "./reconcile/rollback.js"

// Reconciler — Preflight_Check and onboarding plan (task 7.1): read-only
// per-endpoint Preflight (reachability, auth, exact model ids, exposed context)
// with the 3×10 s retry, exclusion-and-recompile on failure (which may trip
// Requirement 5.7), and the ordered connection create→sync→activate lifecycle
// before any referencing combo (Requirements 11.1-11.7).
export {
	describePreflightFailure,
	onboardPlan,
	orderedSteps,
	preflightCheck,
	type ConnectionOp,
	type ConnectionOpStep,
	type EndpointPreflight,
	type ExcludedOffering,
	type OfferingPreflight,
	type OnboardOutcome,
	type OnboardPlan,
	type OnboardPlanArgs,
	type PreflightCheckKind,
	type PreflightFailureCause,
	type PreflightOptions,
} from "./reconcile/onboard.js"

// Fleet_Observer — attempt attribution (task 8.1): stable Device/Model_Offering
// or Cloud_Target, Public_Route, Lane_Definition, and Capability_Lane, anchored
// on the Fleet_Inventory_Revision live at the attempt start (Requirements 17.1,
// 17.2, 17.5, 17.6).
export {
	Attributor,
	UNATTRIBUTED,
	attemptStartMs,
	liveRevisionAt,
	type Attribution,
	type AttributionInput,
	type AuditOutcome,
	type ReconcilerAuditEntry,
	type RevisionResolver,
	type Unattributed,
	type UnattributedReason,
} from "./observe/attribution.js"

// Fleet_Observer — the ≥90-day, body-free metrics copy (task 8.1): the exact
// body-free field set of the baseline extract, idempotent/incremental, pruned
// beyond 90 days (Requirement 16.12).
export {
	COPY_COLUMNS,
	InMemoryObserverStore,
	RETENTION_MS,
	assertBodyFree,
	fromCallLog,
	rowIdOf,
	runCopy,
	type CopiedAttempt,
	type CopyRunResult,
	type ObserverStore,
	type SourceAttempt,
	type StoredRow,
} from "./observe/copy.js"
export { SqliteObserverStore } from "./observe/sqlite-store.js"

// Fleet_Observer — per-device and per-route metrics (task 8.2): per-Device,
// per-Model_Offering, per-input-bucket, per-Public_Route, Device busy-fraction,
// Local_Demand_Distribution, and Health_Probe metrics under the fixed
// conventions of Requirement 16 (2xx success, correlation-id requests,
// completion-anchored in-flight intervals, nearest-rank p50/p95 with sample
// counts, machine + human output), with partial / no-data / unreliable-TTFT
// marks (Requirements 16.1-16.11).
export {
	attributorFn,
	bucketOf,
	metrics,
	metricsOverWindow,
	nearestRank,
	type AttributeRow,
	type BucketMetrics,
	type DeviceMetrics,
	type FailureBreakdown,
	type FleetMetricsReport,
	type HealthProbeMetrics,
	type InputBucket,
	type InstanceCoverage,
	type LandingEntry,
	type LocalDemandMetrics,
	type MetricsOptions,
	type MetricsWindow,
	type ModelOfferingMetrics,
	type Percentile,
	type PerformanceMetrics,
	type PublicRouteMetrics,
	type ResidencySwitchMetrics,
} from "./observe/metrics.js"

// Fleet_Observer — runtime anomaly detection (task 8.3): the six Requirement 18
// detectors (Capacity_Leak, Dead_Target, cap overrun, rank inversion,
// Host_Preemption interval, route degradation vs the Preservation_Floor), one
// alert per occurrence with required names/values + evidence, the ≤5 min / 24 h
// retrying alert write, and the detection-gap alert for unreadable records
// (Requirements 18.1-18.10).
export {
	ALERT_GIVE_UP_MS,
	ALERT_RETRY_INTERVAL_MS,
	ALERT_WRITE_TIMEOUT_MS,
	CAPACITY_LEAK_SKIP_GAP_MS,
	CAPACITY_REJECTION_STATUSES,
	CAP_OVERRUN_MIN_MS,
	CLIENT_DISCONNECT_STATUS,
	DEAD_TARGET_CONSECUTIVE,
	DEAD_TARGET_SPAN_MS,
	DETECTION_GAP_MIN_MS,
	PREEMPTION_MAX_GAP_MS,
	PRESERVATION_FLOORS,
	RANK_INVERSION_MIN_SAMPLES,
	RANK_INVERSION_WINDOW_MS,
	ROUTE_DEGRADATION_MIN_REQUESTS,
	ROUTE_DEGRADATION_SPAN_MS,
	bucketOf as anomalyBucketOf,
	detectAnomalies,
	nearestRank as anomalyNearestRank,
	writeAlerts,
	type Anomaly,
	type AnomalyAlertWriter,
	type AnomalyEvidence,
	type AnomalyInput,
	type AnomalyKind,
	type AlertWriteOutcome,
	type BusySlotSkip,
	type ConcurrencyBounds,
	type NowFn,
	type RouteMembershipLookup,
	type SleepFn,
	type TargetKey,
	type TargetRouteMemberships,
	type UnreadableSpan,
	type WriteAlertsOptions,
} from "./observe/anomalies.js"

// Arrangement_Evaluator — pre-deployment estimate replay (task 9.1): the body-
// free, deterministic Requirement 21 free-local-slot replay over a fixed
// recorded window, plus an optional, clearly-separated speed-model extension for
// ranking/sizing (Requirements 21.1, 21.2, 21.5, 21.6).
export {
	BASELINE_SPEED_MODEL,
	INITIAL_BASELINE_LOCAL_DEMAND,
	estimateFreeLocalSlots,
	g5090,
	percentile,
	simulateSpeedModel,
	type DataCompleteness,
	type EstimateInput,
	type EstimateOutcome,
	type EstimateResult,
	type EstimateWindow,
	type ExcludedRequestedModel,
	type LocalDemandDistribution,
	type RouteFreeSlotResult,
	type SpeedModelParams,
	type SpeedRouteSummary,
	type SpeedSlot,
	type SpeedWorkItem,
} from "./evaluate/estimate.js"

// Arrangement_Evaluator — evaluation window, floors, objectives, ranking,
// re-measured baselines, the 24 h early check, and the rollback recommendation
// (task 9.2): the post-deployment half of the evaluator (design §5,
// Requirements 19, 20, 21.3, 21.4). It computes every Baseline_Metric over the
// measured window reusing the Requirement 16 observer conventions, applies the
// Preservation_Floors to Gated_Routes only, reports and ranks the improvement
// objectives, marks an evaluation incomplete on an intervening apply/rollback or
// partial data, and recommends (never performs) a rollback when a floor fails.
export {
	buildRollbackRecommendation,
	earlyCheck,
	evaluate,
	evaluationWindow,
	FINAL_SUCCESS_FLOORS,
	GATED_ROUTE_MIN_REQUESTS,
	INITIAL_BASELINE,
	LOCAL_SHARE_FLOOR,
	LOCAL_SHARE_ROUTES,
	MAX_WINDOW_HOURS,
	MIN_WINDOW_HOURS,
	P95_CEILINGS_SECONDS,
	rankCandidates,
	remeasureBaseline,
	RERANK_P50_CEILING_MS,
	RERANK_SUCCESS_FLOOR,
	WINDOW_END_SUFFICIENT_REQUESTS,
	type Baseline,
	type BaselineValue,
	type BackupRecord,
	type EarlyCheckInput,
	type EarlyCheckReport,
	type EvaluateInput,
	type EvaluationReport,
	type EvaluationWindowInput,
	type EvaluationWindowOutcome,
	type FloorOutcome,
	type MetricComparison,
	type MetricMark,
	type MetricUnit,
	type ObjectiveReport,
	type RankedCandidate,
	type RemeasureInput,
	type RemeasureOutcome,
	type RemeasureResult,
	type RollbackInstanceInfo,
	type RollbackRecommendation,
	type RouteRequestCount,
	type Window as EvaluationWindow,
} from "./evaluate/evaluate.js"

// fleetctl CLI (task 10.1): the command handlers and the commander program. The
// handlers take their side effects through an injectable `CliDeps` bag so the
// CLI smoke tests (task 10.2) drive validate/compile/drift/plan against a fake
// client, a scripted confirmation provider, and a captured output sink, and
// assert that apply/rollback refuse without the per-invocation operator
// confirmation (Requirements 22.1, 22.2, 22.7).
export {
	applyCommand,
	compileCommand,
	driftCommand,
	estimateCommand,
	evaluateCommand,
	metricsCommand,
	planCommand,
	rollbackCommand,
	validateCommand,
	type ApplyCommandOptions,
	type InventoryCommandOptions,
	type ObserverCommandOptions,
	type RollbackCommandOptions,
} from "./cli/commands.js"
export { buildProgram, main } from "./cli/index.js"
export {
	buildConfirmation,
	defaultCliDeps,
	defaultClientFactory,
	findInstance,
	loadInventory,
	primaryInstance,
	printViolations,
	processOutputSink,
	revisionOf,
	stdinConfirmationProvider,
	type CliDeps,
	type ClientFactory,
	type ConfirmationProvider,
	type ConfirmationRequest,
	type LoadResult,
	type OutputSink,
} from "./cli/shared.js"
