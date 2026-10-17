# ADR: Menagerie Next-Level Lift — Orchestration Boundaries

**Status:** Accepted
**Date:** 2026-10-16
**Supersedes:** nothing
**Companion docs:** `menagerie-lift-baseline.md`, `menagerie-lift-execution-plan.md`,
`menagerie-lift-results.md`, `native-parallel-tasks.md`

## Context

The native parallel-tasks runtime already decomposes a task into a bounded
logical-worker DAG, enforces a user parallelism policy, and routes each worker's
inference through OmniRoute's public routes. The Phase-0 baseline
(`menagerie-lift-baseline.md`) showed the orchestration layer was strong at
**decomposition** but carried five concrete problems in how it *managed* that
decomposition: (1) each worker opened its own editor tab and aborted on tab
close; (2) the task board was JSON-snapshot navigation with no command; (3)
background edits had no version/dirty check; (4) reader fan-out ignored the user
policy; (5) an inference lease was held for a worker's **entire lifetime**, not
per generation — so on a capacity-1 lane, N−1 workers could never generate while
one held the slot.

The design decision this ADR records is **what the lift changes and what it
deliberately does not**, given a hard constraint: OmniRoute is already the
physical capacity planner (it owns model placement, routing, queueing, and
thermal/resource backpressure). menagerie must not re-derive any physical
capacity.

## Decision

The lift keeps **all physical capacity planning in OmniRoute** and adds only
**orchestration-level** discipline in menagerie. Concretely:

### 1. One task = one logical entity (C1)
A task is identified by a stable `TaskRef { hostId, workspaceUri, taskId }`. The
task board is command-driven (reveal / open / inspect diff / resume / cancel /
new-task) and **navigation never mutates task state**. Each task owns at most
one persistent editor tab. Rationale: a tab is a *view* of a task, not the task;
coupling task lifetime to view lifetime (the baseline) caused accidental aborts
when a tab closed. Navigation is therefore pure state (no mutation), and the
view is disposable.

### 2. Background editing is versioned and conflict-checked (C3)
Before a background write, the integrator snapshots the on-disk bytes + mtime and
the in-editor buffer dirty flag; after the write it verifies the snapshot is
unchanged and that the buffer isn't dirty. A mismatch is reported to the
coordinator and **the write is never force-retried blindly**. Rationale: the
baseline `saveDirectly` wrote disk with no guard, so a dirty buffer could clobber
a concurrent edit. The snapshot/verify is a version check, not a physical
capability.

### 3. Additive DAG discipline (C4)
Worker specs gain optional, legacy-tolerant fields (`dependsOn`, `filesRead`,
`filesWrite`, `expectedOutput`, `deadlineMs`, `priority`). A spec list with none
of them is still a flat batch (byte-identical behavior); `buildExecutionPlan`
threads `dependsOn` into the admitted `TaskDag`, a dependent is admitted
`waiting-on-dependency` and unlocks on prerequisite `completed`, and a failed
prerequisite unlocks nothing. Rationale: making the fields **additive** (never a
re-plumbing) means legacy plans keep working while dependency ordering,
exclusive-write-ownership, and deadline enforcement can be adopted per-plan.

### 4. Reader fan-out honors the policy and spawns only useful work (C3)
Reader fan-out reads the `User_Parallelism_Policy` ceiling instead of the fixed
`DEFAULT_READER_SWARM = 1`. Readers are **named, bounded, read-only** jobs with
an explicit scope, byte budget, timeout, and structured result schema, ranked by
information gain; only readers with a concrete scope are spawned — never filler
"just to occupy a GPU." Rationale: the baseline ignored user policy and could
manufacture work; bounding scope/budget keeps the parent-visible return channel
small.

### 5. Leases are per-generation, not per-worker (C2)
The dispatch permit covers a worker's whole run, but the inference lease is held
only while **generating** (`InferenceLeasePool`, priority-ordered, critical-path
as a within-priority tiebreaker only). Rationale: holding a lease through a
tool wait serializes unrelated workers behind a single slot. The comparative
benchmark on the pinned 8-task suite shows this cuts lane completion from
40,800ms to 5,800ms (7.03×) at the same capacity-1 peak.

### 6. Backpressure is counted, not modeled, by the scheduler (C5)
The scheduler counts **new fan-out denied by backpressure** and **lease
starvation** as separate orchestration metrics. It never derives physical
capacity; it consults only OmniRoute's aggregate `sustainedPressure` and reports
capability/capacity samples. Rationale: keeping backpressure a *scheduler
decision* (counted) rather than a *capacity model* preserves the invariant that
OmniRoute is the single source of physical truth.

## Consequences

**Positive**
- No worker's lifetime is coupled to a view or to a lease held through a tool
  wait; navigation is side-effect-free.
- Background edits are safe against concurrent/dirty buffers (no silent
  clobber).
- Dependency ordering, write ownership, and deadlines are adoptable per-plan
  without breaking flat batches.
- A regression in the lease boundary is visible immediately in the
  `pnpm menagerie-lift:bench` table.

**Negative / accepted risks**
- `filesWrite` is validated and surfaced but **exclusive write-ownership
  enforcement** (rejecting overlapping writers) is the follow-up integration
  step, not wired into dispatch in this ADR's scope.
- Scout readers are a pure planner/builder; wiring them into the reader
  fan-out call site is the follow-up seam.
- The lift does not touch OmniRoute's physical capacity model by design; any
  capacity improvement must come from OmniRoute, not menagerie.

## Alternatives considered

- **Model physical capacity in menagerie** (re-derive route saturation, thermal,
  memory). Rejected: duplicates OmniRoute's job, drifts from the single source
  of truth, and violates the PAR-012/019 "orchestration-only" invariant.
- **Hold the lease for the worker's lifetime (status quo).** Rejected: the
  benchmark shows it serializes N−1 workers behind one slot on a capacity-1 lane.
- **Make the DAG fields required.** Rejected: would break every legacy flat
  batch; additive-with-legacy-defaults is strictly safer and byte-identical for
  the common case.
- **Spawn readers to fill available capacity.** Rejected: manufactures useless
  work and burns context; information-gain-ranked, scope-bounded readers are the
  bounded alternative.
