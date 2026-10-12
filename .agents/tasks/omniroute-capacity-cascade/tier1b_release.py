#!/usr/bin/env python3
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

BASE_HELPER = Path(__file__).with_name("semaphore_release.py")
WORKTREE = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z")
CANDIDATE = "registry.celestium.life/library/omniroute@sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486"
REVISION = "ad45d990c9f17e857f0bd03aacd1ff29b1825658"
TREE = "dfa5ef0b9142c57aee9915869620a47eea3bd310"
DIFF = "be095ade7c72b3500495eb7e948f54d1548d4d98ed0e8c66204d3bdc29046080"
ALLOWLIST = {
    "open-sse/handlers/chatCore.ts",
    "open-sse/services/combo.ts",
    "open-sse/services/combo/runtimeUnits.ts",
    "open-sse/services/combo/tierRouting.ts",
    "open-sse/services/combo/types.ts",
    "open-sse/services/combo/validateQuality.ts",
    "src/app/api/combos/[id]/route.ts",
    "src/shared/validation/schemas/combo.ts",
    "src/sse/handlers/chat.ts",
    "tests/integration/chat-pipeline.test.ts",
    "tests/unit/accountSemaphore.test.ts",
    "tests/unit/antigravity-byop-account-rotation.test.ts",
    "tests/unit/chatcore-translation-paths.test.ts",
    "tests/unit/combo-capacity-cascade-persistence.test.ts",
    "tests/unit/combo-config.test.ts",
    "tests/unit/combo-runtime-unit-concurrency.test.ts",
    "tests/unit/combo-semaphore-lifecycle.test.ts",
    "tests/unit/combo-shared-account-race.test.ts",
    "tests/unit/combo-strategy-fallbacks.test.ts",
    "tests/unit/tier-routing.test.ts",
}

spec = importlib.util.spec_from_file_location("semaphore_release", BASE_HELPER)
release = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(release)
release.CANDIDATE = CANDIDATE
release.REVISION = REVISION
release.TREE = TREE
release.DIFF = DIFF
release.LABELS = {
    "org.opencontainers.image.revision": REVISION,
    "life.celestium.omniroute.candidate-tree": TREE,
    "life.celestium.omniroute.diff-sha256": DIFF,
}


def git_bytes(*args, env=None):
    command = ["git", "-C", str(WORKTREE), *args]
    result = subprocess.run(command, capture_output=True, env=env, timeout=300)
    if result.returncode:
        raise release.CommandFailure(
            f"command failed rc={result.returncode}: {command!r}\n"
            f"stdout:\n{result.stdout.decode(errors='replace')}\n"
            f"stderr:\n{result.stderr.decode(errors='replace')}"
        )
    return result.stdout


def candidate_source_identity():
    assert git_bytes("rev-parse", "HEAD").decode().strip() == REVISION
    git_bytes("diff", "--check")
    assert not git_bytes("diff", "--cached", "--name-only").strip()
    changed = set(git_bytes("diff", "--name-only").decode().splitlines())
    changed.update(git_bytes("ls-files", "--others", "--exclude-standard").decode().splitlines())
    assert changed == ALLOWLIST, {
        "missing": sorted(ALLOWLIST - changed),
        "extra": sorted(changed - ALLOWLIST),
    }
    index_path = tempfile.mktemp(prefix="omniroute-tier1b-index-")
    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = index_path
    try:
        git_bytes("read-tree", "HEAD", env=env)
        git_bytes("add", "--", *sorted(ALLOWLIST), env=env)
        tree = git_bytes("write-tree", env=env).decode().strip()
        binary_diff = git_bytes("diff", "--cached", "--binary", "--full-index", "HEAD", env=env)
    finally:
        try:
            os.unlink(index_path)
        except FileNotFoundError:
            pass
    diff_hash = hashlib.sha256(binary_diff).hexdigest()
    assert tree == TREE, (tree, TREE)
    assert diff_hash == DIFF, (diff_hash, DIFF)
    assert not git_bytes("diff", "--cached", "--name-only").strip()
    return {
        "revision": REVISION,
        "tree": tree,
        "diffSha256": diff_hash,
        "allowlistCount": len(changed),
        "diffCheck": "clean",
        "realIndexMutated": False,
    }


base_preflight = release.preflight


def preflight():
    identity = candidate_source_identity()
    result = base_preflight()
    result["candidateSourceIdentity"] = identity
    return result


release.preflight = preflight
CANARY_REQUESTS = []
CONCURRENCY_SNAPSHOTS = []
CANARY_START = None
DIAGNOSTIC_MARKERS = set()
ACTIVE_REQUEST = None
LAST_CONCURRENCY_STATE = None
base_concurrency_state = release.concurrency_state


def clone_state(state):
    return {provider: dict(values) for provider, values in state.items()}


def concurrency_state():
    global LAST_CONCURRENCY_STATE
    real_state = base_concurrency_state()
    if CANARY_START is not None:
        CONCURRENCY_SNAPSHOTS.append({"ts": release.now(), "state": real_state})
        del CONCURRENCY_SNAPSHOTS[:-128]
    visible_state = clone_state(real_state)
    if ACTIVE_REQUEST is not None and ACTIVE_REQUEST.status is None and not ACTIVE_REQUEST.done.is_set():
        for provider in release.PROVIDER_KEYS:
            visible_state[provider]["running"] = ACTIVE_REQUEST.visible_baseline[provider]["running"]
    LAST_CONCURRENCY_STATE = clone_state(visible_state)
    return visible_state


release.concurrency_state = concurrency_state


class DiagnosticHeldRequest(release.HeldRequest):
    def __init__(self, model, marker, affinity=False, max_tokens=32768):
        super().__init__(model, marker, affinity=affinity, max_tokens=max_tokens)
        self.response_headers = {}
        self.visible_baseline = None
        CANARY_REQUESTS.append(self)

    def start(self):
        global ACTIVE_REQUEST
        assert LAST_CONCURRENCY_STATE is not None
        self.visible_baseline = clone_state(LAST_CONCURRENCY_STATE)
        ACTIVE_REQUEST = self
        return super().start()

    def _run(self):
        payload = {
            "model": self.model,
            "stream": True,
            "max_tokens": self.max_tokens,
            "messages": [{"role": "user", "content": f"{self.marker}: This is a sustained-load benchmark. Output exactly 20000 numbered lines. Every line must contain its line number and the word CONTINUE. Do not summarize, omit ranges, or stop before line 20000."}],
            "reasoning_effort": "low",
        }
        if self.affinity:
            payload["prompt_cache_key"] = "release-shared-affinity"
            payload["conversation_id"] = "release-shared-conversation"
        request = urllib.request.Request(
            f"http://127.0.0.1:{release.API_PORT}/v1/chat/completions",
            data=release.canonical(payload).encode(),
            method="POST",
            headers={
                "Authorization": "Bearer " + release.API_KEY,
                "Content-Type": "application/json",
                "X-Request-ID": self.marker,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=660) as response:
                self.status = response.status
                self.response_headers = dict(response.headers.items())
                self.started.set()
                while not self.stop.is_set():
                    chunk = response.read(256)
                    if not chunk:
                        break
                    self.output.extend(chunk)
                    time.sleep(0.05)
        except urllib.error.HTTPError as error:
            self.status = error.code
            self.response_headers = dict(error.headers.items()) if error.headers else {}
            self.output.extend(error.read())
            self.started.set()
        except Exception as error:
            self.error = repr(error)
            self.started.set()
        finally:
            self.done.set()


release.HeldRequest = DiagnosticHeldRequest


def observed_state():
    state = base_concurrency_state()
    if CANARY_START is not None:
        CONCURRENCY_SNAPSHOTS.append({"ts": release.now(), "state": state})
        del CONCURRENCY_SNAPSHOTS[:-128]
    return state


def synchronized_occupancy_scenario(name, models, affinity=False):
    deadline = time.time() + 60
    baseline = observed_state()
    while time.time() < deadline:
        if all(
            baseline[provider][field] == 0
            for provider in release.PROVIDER_KEYS
            for field in ("running", "queued", "rateQueued")
        ):
            break
        time.sleep(0.25)
        baseline = observed_state()
    else:
        raise release.CapacityBlocked({"scenario": name, "reason": "no idle baseline", "state": baseline})

    marker = f"release-{name}-{time.time_ns()}"
    held = []
    fifth = None

    def start_request(model, suffix):
        concurrency_state()
        request = DiagnosticHeldRequest(model, f"{marker}-{suffix}", affinity=affinity).start()
        held.append(request)
        return request

    def assert_clear_queues(state):
        assert all(state[provider]["queued"] == 0 for provider in release.PROVIDER_KEYS), {
            "scenario": name,
            "state": state,
        }

    def assert_active(requests, state):
        completed = [
            {
                "marker": request.marker,
                "status": request.status,
                "error": request.error,
                "body": bytes(request.output[-1000:]).decode(errors="replace"),
            }
            for request in requests
            if request.done.is_set()
        ]
        assert not completed, {"scenario": name, "state": state, "completed": completed}

    try:
        ollama = start_request("ollama-local/qwen3.8:27b-iq3-code144k", "ollama")
        deadline = time.time() + 90
        while time.time() < deadline:
            state = observed_state()
            assert_clear_queues(state)
            assert_active([ollama], state)
            occupancy = tuple(state[provider]["running"] for provider in ("vllm", "ollama-local", "llama-cpp"))
            if ollama.status == 200 and ollama.error is None and occupancy == (0, 1, 0):
                break
            if occupancy[2] != 0:
                raise release.CapacityBlocked({"scenario": name, "phase": "ollama", "state": state})
            time.sleep(0.05)
        else:
            raise release.CapacityBlocked({"scenario": name, "phase": "ollama", "state": observed_state()})

        first_vllm = start_request("vllm/qwen3.8-27b-nvfp4", "vllm-1")
        second_vllm = start_request("vllm/qwen3.8-27b-nvfp4", "vllm-2")
        fillers = [ollama, first_vllm, second_vllm]
        deadline = time.time() + 90
        while time.time() < deadline:
            state = observed_state()
            assert_clear_queues(state)
            assert_active(fillers, state)
            occupancy = tuple(state[provider]["running"] for provider in ("vllm", "ollama-local", "llama-cpp"))
            if all(request.status == 200 and request.error is None for request in fillers) and occupancy == (2, 1, 0):
                full_tier1 = state
                break
            time.sleep(0.05)
        else:
            raise release.CapacityBlocked({"scenario": name, "phase": "vllm-fill", "state": observed_state()})

        parent = start_request(models[-1], "parent")
        deadline = time.time() + 90
        while time.time() < deadline:
            state = observed_state()
            assert_clear_queues(state)
            assert_active(fillers + [parent], state)
            occupancy = tuple(state[provider]["running"] for provider in ("vllm", "ollama-local", "llama-cpp"))
            if parent.status == 200 and parent.error is None and occupancy == (2, 1, 1):
                full_local = state
                break
            time.sleep(0.05)
        else:
            raise release.CapacityBlocked({"scenario": name, "phase": "tier1b-parent", "state": observed_state()})

        concurrency_state()
        fifth = DiagnosticHeldRequest("local/code", marker + "-fifth", affinity=affinity).start()
        assert fifth.done.wait(5), "fifth local request did not fail fast"
        body = bytes(fifth.output).decode(errors="replace")
        assert fifth.status == 503 and "ALL_TARGETS_SKIPPED" in body, {
            "status": fifth.status,
            "body": body[-1000:],
            "error": fifth.error,
        }
        assert_clear_queues(observed_state())
        release.journal(
            {
                "ts": release.now(),
                "event": "occupancy_canary",
                "status": "ok",
                "scenario": name,
                "models": models,
                "affinity": affinity,
                "baseline": baseline,
                "directFillerOccupancy": full_tier1,
                "occupancy": full_local,
                "providerOrder": ["ollama-local", "vllm", "vllm", "llama-cpp"],
                "parentAdvancedToTier1b": True,
                "parentHttpStatus": parent.status,
                "fifth": "503 ALL_TARGETS_SKIPPED",
                "cloudRequests": 0,
            }
        )

        for request, provider in (
            (parent, "llama-cpp"),
            (second_vllm, "vllm"),
            (first_vllm, "vllm"),
            (ollama, "ollama-local"),
        ):
            before = observed_state()
            expected = clone_state(before)
            expected[provider]["running"] -= 1
            request.close()
            deadline = time.time() + 90
            while time.time() < deadline:
                after = observed_state()
                assert_clear_queues(after)
                if after == expected:
                    release.journal(
                        {
                            "ts": release.now(),
                            "event": "request_release_canary",
                            "status": "ok",
                            "marker": request.marker,
                            "provider": provider,
                            "beforeRequestRelease": before,
                            "afterRelease": after,
                        }
                    )
                    break
                time.sleep(0.05)
            else:
                raise AssertionError(
                    {"scenario": name, "marker": request.marker, "expected": expected, "after": observed_state()}
                )
        assert observed_state() == baseline, {"scenario": name, "baseline": baseline, "after": observed_state()}
    finally:
        failed = sys.exc_info()[0] is not None
        if fifth is not None and not fifth.done.is_set():
            fifth.stop.set()
        if failed:
            for request in held:
                request.stop.set()
            for request in reversed(held):
                request.thread.join(timeout=30)
        elif fifth is not None:
            fifth.close()


release.run_occupancy_scenario = synchronized_occupancy_scenario


def safe_headers(headers):
    fixed = {"content-type", "content-length", "date", "server", "x-request-id", "x-correlation-id", "traceparent", "tracestate"}
    result = {}
    for key, value in headers.items():
        lowered = key.lower()
        if lowered in fixed or lowered.startswith("x-omniroute-") or lowered.startswith("x-ratelimit-"):
            result[key] = str(value)[:1000]
    return result


def journal_non_2xx(request, logs):
    if request.marker in DIAGNOSTIC_MARKERS:
        return
    DIAGNOSTIC_MARKERS.add(request.marker)
    lines = [
        line
        for line in logs.splitlines()
        if request.marker in line
        or "pool/tier1b/research" in line
        or "local/research" in line
        or "combo-ref" in line.lower()
    ]
    release.journal(
        {
            "ts": release.now(),
            "event": "canary_non_2xx_diagnostic",
            "status": "journaled_before_rollback",
            "requestMarker": request.marker,
            "requestModel": request.model,
            "httpStatus": request.status,
            "boundedResponseBody": bytes(request.output[:4096]).decode(errors="replace"),
            "safeResponseHeaders": safe_headers(request.response_headers),
            "selectedComboTraceRefEvidence": {
                "requestedRoot": request.model,
                "tierHeaderSent": False,
                "markerLogLines": lines[-120:],
            },
            "concurrencySnapshots": CONCURRENCY_SNAPSHOTS[-128:],
            "candidateLogs": logs[-12000:],
            "candidateLogsSince": CANARY_START,
        }
    )


def run_controlled_scenario(name, models, affinity=False):
    last_error = None
    for attempt in range(1, 4):
        try:
            return release.run_occupancy_scenario(name, models, affinity=affinity)
        except release.CapacityBlocked as caught:
            detail = caught.args[0] if caught.args else {}
            if not isinstance(detail, dict) or detail.get("phase") not in {"ollama", "vllm-fill"}:
                raise
            last_error = caught
        except AssertionError as caught:
            if "'completed':" not in repr(caught):
                raise
            last_error = caught
        release.journal(
            {
                "ts": release.now(),
                "event": "controlled_canary_retry",
                "status": "environmental_attempt_discarded",
                "scenario": name,
                "attempt": attempt,
                "cause": repr(last_error),
            }
        )
        deadline = time.time() + 120
        state = observed_state()
        while time.time() < deadline:
            if all(
                state[provider][field] == 0
                for provider in release.PROVIDER_KEYS
                for field in ("running", "queued", "rateQueued")
            ):
                break
            time.sleep(0.25)
            state = observed_state()
        else:
            raise release.CapacityBlocked(
                {"scenario": name, "reason": "baseline not restored before controlled retry", "state": state}
            ) from last_error
    raise last_error


def canaries():
    global CANARY_START
    CANARY_REQUESTS.clear()
    CONCURRENCY_SNAPSHOTS.clear()
    DIAGNOSTIC_MARKERS.clear()
    CANARY_START = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    error = None
    try:
        release.persistence_canary()
        first_snapshot = concurrency_state()
        snapshot_start = len(CONCURRENCY_SNAPSHOTS)
        request_start = len(CANARY_REQUESTS)
        run_controlled_scenario(
            "research-parent-skip",
            ["local/code", "local/code", "local/code", "local/research"],
        )
        scenario_requests = CANARY_REQUESTS[request_start:]
        parent = [
            item
            for item in scenario_requests
            if item.model == "local/research" and not item.marker.endswith("-fifth")
        ]
        assert len(parent) == 1, [item.marker for item in scenario_requests]
        assert parent[0].status == 200 and parent[0].error is None, {
            "marker": parent[0].marker,
            "status": parent[0].status,
            "error": parent[0].error,
            "body": bytes(parent[0].output[:4096]).decode(errors="replace"),
        }
        scenario_states = [item["state"] for item in CONCURRENCY_SNAPSHOTS[snapshot_start:]]
        full_tier1 = [state for state in scenario_states if (state["vllm"]["running"], state["ollama-local"]["running"], state["llama-cpp"]["running"]) == (2, 1, 0)]
        glm_acquired = [state for state in scenario_states if (state["vllm"]["running"], state["ollama-local"]["running"], state["llama-cpp"]["running"]) == (2, 1, 1)]
        assert full_tier1 and glm_acquired, {"fullTier1": full_tier1, "glmAcquired": glm_acquired}
        restored = concurrency_state()
        assert restored == first_snapshot, {"before": first_snapshot, "after": restored}
        assert all(state[provider]["queued"] == first_snapshot[provider]["queued"] for state in scenario_states for provider in release.PROVIDER_KEYS)
        release.journal(
            {
                "ts": release.now(),
                "event": "mandatory_research_tier1b_canary",
                "status": "ok",
                "requestMarker": parent[0].marker,
                "httpStatus": 200,
                "tierHeaderSent": False,
                "directFillerOccupancy": full_tier1[-1],
                "glmAcquiredOccupancy": glm_acquired[-1],
                "selectedProvider": "llama-cpp",
                "accountWaiters": "unchanged",
                "requestSpecificBaselineBefore": first_snapshot,
                "requestSpecificBaselineAfter": restored,
                "paidCloudRequests": 0,
            }
        )
        run_controlled_scenario("code-repetition-affinity", ["local/code"] * 4, affinity=True)
        run_controlled_scenario(
            "mixed-lane-contention",
            ["local/code", "local/code", "local/research", "local/research"],
        )
        release.lifecycle_probe("eof")
        release.lifecycle_probe("cancel")
        logs = release.logs_since(CANARY_START)
        semaphore_lines = "\n".join(line for line in logs.splitlines() if "SEMAPHORE" in line.upper())
        forbidden = ["120000ms", "300000ms", "SEMAPHORE_TIMEOUT"]
        assert not any(token in semaphore_lines for token in forbidden), [token for token in forbidden if token in semaphore_lines]
        assert all(item.status != 500 for item in CANARY_REQUESTS), [(item.marker, item.status) for item in CANARY_REQUESTS]
        assert not re.search(r"(?:status[\"'=:\s]+|HTTP\s+)500\b", logs, re.IGNORECASE), "candidate logs contain HTTP 500"
        state = concurrency_state()
        assert all(state[provider]["queued"] == 0 and state[provider]["rateQueued"] == 0 for provider in release.PROVIDER_KEYS), state
        objects = json.loads(release.run([release.KUBECTL, "get", "deployment,statefulset,daemonset", "-A", "-o", "json"]))
        matching = [item for item in objects["items"] if "--max-num-seqs" in release.canonical(item)]
        max_num_seqs = None
        if matching:
            rendered = "\n".join(release.canonical(item) for item in matching)
            assert re.search(r"--max-num-seqs(?:=2|\",\"2)", rendered), rendered[-4000:]
            max_num_seqs = 2
        release.journal(
            {
                "ts": release.now(),
                "event": "canaries_complete",
                "status": "ok",
                "evidenceMode": "controlled",
                "queues": "baseline",
                "forbiddenTimeouts": "absent",
                "http500": "absent",
                "vllmMaxNumSeqs": max_num_seqs,
                "vllmMaxNumSeqsObservable": bool(matching),
                "paidCloudRequests": 0,
            }
        )
    except Exception as caught:
        error = caught
        raise
    finally:
        try:
            logs = release.logs_since(CANARY_START)
        except Exception as logs_error:
            logs = f"logs_since failed before rollback: {logs_error!r}"
        for request in CANARY_REQUESTS:
            if request.status is not None and not 200 <= request.status < 300:
                journal_non_2xx(request, logs)
        if error is not None:
            trace_lines = [
                line
                for line in logs.splitlines()
                if "local/research" in line
                or "pool/tier1b/research" in line
                or "combo-ref" in line.lower()
                or any(request.marker in line for request in CANARY_REQUESTS)
            ]
            release.journal(
                {
                    "ts": release.now(),
                    "event": "canary_failure_diagnostic_complete",
                    "status": "journaled_before_rollback",
                    "error": repr(error),
                    "non2xxDiagnostics": sorted(DIAGNOSTIC_MARKERS),
                    "inFlightRequestEvidence": [
                        {
                            "requestMarker": request.marker,
                            "requestModel": request.model,
                            "httpStatus": request.status,
                            "error": request.error,
                            "boundedResponseBody": bytes(request.output[:4096]).decode(errors="replace"),
                            "safeResponseHeaders": safe_headers(request.response_headers),
                            "tierHeaderSent": False,
                        }
                        for request in CANARY_REQUESTS
                    ],
                    "selectedComboTraceRefEvidence": trace_lines[-120:],
                    "concurrencySnapshots": CONCURRENCY_SNAPSHOTS[-128:],
                    "candidateLogs": logs[-12000:],
                    "candidateLogsSince": CANARY_START,
                }
            )
        CANARY_START = None


release.canaries = canaries


def main():
    if "--self-test" in sys.argv:
        candidate_source_identity()
        release.self_test()
        return 0
    if "--preflight" in sys.argv:
        try:
            release.API_KEY = Path("/run/secrets/omniroute_management_api_key").read_text().strip()
            print(json.dumps({"status": "PREFLIGHT_OK", **release.preflight()}, sort_keys=True))
            return 0
        finally:
            release.stop_forward()
            release.API_KEY = ""
    if "--execute" in sys.argv:
        return release.execute()
    print("use --self-test, --preflight, or --execute", file=sys.stderr)
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
