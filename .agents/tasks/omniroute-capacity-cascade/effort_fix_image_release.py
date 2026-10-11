#!/usr/bin/env python3
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

OLD = "registry.celestium.life/library/omniroute@sha256:3cada1d2af588261fc35183fb9fcf63ac91a72f4a243f10e20921562a0ed7486"
CANDIDATE = "registry.celestium.life/library/omniroute@sha256:299deb44f3169c5fe0fa6eef065580ecd0fee51610d64fce763ed41b1052bfe6"
REVISION = "ad45d990c9f17e857f0bd03aacd1ff29b1825658"
TREE = "71bf54d2a14efbe39ebe883e40aa9f3967d61b20"
DIFF = "772b914710206f7b87ded8622e382cb4c4321ebcdfba162e8f55eee6c64f26f9"
SOURCE_SHA256 = "7e814e4271368ffa64a873272c747554e57de3b28a216dafaccc1453b14072f8"
LABELS = {
    "org.opencontainers.image.revision": REVISION,
    "life.celestium.omniroute.candidate-tree": TREE,
    "life.celestium.omniroute.diff-sha256": DIFF,
}
KUBECTL = "/run/current-system/sw/bin/kubectl"
NS = "omniroute"
SOURCE = Path("/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py")
STATE = Path("/home/celes/.local/state/omniroute-routing")
PROVIDER_IDS = [
    "e9bd13fb-c6b6-4c18-b42f-3395266348ce",
    "b20e0770-3e14-40c1-87cd-85c34b34381a",
    "70b82fc9-6f96-41ac-aa16-8da6099dd7ac",
]
PROVIDER_NAMES = ["vllm", "ollama-local", "llama-cpp"]
CAPS = dict(zip(PROVIDER_IDS, [2, 1, 1]))
VOLATILE = [
    "connection.lastTested",
    "connection.providerSpecificData.apiKeyHealth",
    "connection.updatedAt",
    "connection.errorCode",
    "connection.lastError",
    "connection.lastErrorAt",
    "connection.lastErrorType",
    "connection.syncedModelsAt",
]
FIELDS = ("name", "description", "strategy", "models", "config", "context_length", "context_cache_protection")
API_PORT = 22438
API_KEY = ""
PF_PROCESS = None
BACKUP = None
JOURNAL = None
DEPLOY_ATTEMPTED = False


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def run(argv, timeout=900, record=True):
    result = subprocess.run(argv, capture_output=True, timeout=timeout)
    stdout = result.stdout.decode(errors="replace")
    stderr = result.stderr.decode(errors="replace")
    if record and JOURNAL is not None:
        journal({"event": "command", "argv": argv, "rc": result.returncode, "stdoutTail": stdout[-4000:], "stderrTail": stderr[-4000:]})
    if result.returncode:
        raise RuntimeError(f"command failed rc={result.returncode}: {argv!r}\n{stdout[-2000:]}\n{stderr[-2000:]}")
    return stdout


def atomic_bytes(path, value):
    temp = path.with_name(path.name + ".tmp")
    with temp.open("wb") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    temp.chmod(0o600)
    temp.replace(path)
    path.chmod(0o600)


def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode())


def journal(value):
    assert JOURNAL is not None
    event = {"ts": now(), **value}
    with JOURNAL.open("ab") as handle:
        handle.write((canonical(event) + "\n").encode())
        handle.flush()
        os.fsync(handle.fileno())
    JOURNAL.chmod(0o600)


def stop_forward():
    global PF_PROCESS
    if PF_PROCESS is not None:
        if PF_PROCESS.poll() is None:
            PF_PROCESS.terminate()
            try:
                PF_PROCESS.wait(timeout=10)
            except subprocess.TimeoutExpired:
                PF_PROCESS.kill()
                PF_PROCESS.wait(timeout=5)
        PF_PROCESS = None


def start_forward():
    global PF_PROCESS
    stop_forward()
    target = subprocess.DEVNULL
    handle = None
    if BACKUP is not None:
        handle = (BACKUP / "port-forward.log").open("ab")
        Path(handle.name).chmod(0o600)
        target = handle
    PF_PROCESS = subprocess.Popen(
        [KUBECTL, "-n", NS, "port-forward", "service/omniroute", f"{API_PORT}:20128"],
        stdin=subprocess.DEVNULL,
        stdout=target,
        stderr=subprocess.STDOUT,
    )
    if handle is not None:
        handle.close()
    deadline = time.time() + 45
    last_error = None
    while time.time() < deadline:
        if PF_PROCESS.poll() is not None:
            raise RuntimeError(f"port-forward exited rc={PF_PROCESS.returncode}")
        try:
            if str(api("/healthz", timeout=3)).strip() == "ok":
                return
        except Exception as error:
            last_error = error
        time.sleep(0.5)
    raise RuntimeError(f"port-forward did not become ready: {last_error!r}")


def api(path, data=None, method=None, timeout=65):
    verb = method or ("POST" if data is not None else "GET")
    body = None if data is None else canonical(data).encode()
    headers = {"Authorization": "Bearer " + API_KEY}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"http://127.0.0.1:{API_PORT}{path}", data=body, method=verb, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        status = response.status
    if status < 200 or status >= 300:
        raise RuntimeError(f"{verb} {path}: HTTP {status}")
    if not raw:
        return None
    text = raw.decode(errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def kube_json(*args):
    return json.loads(run([KUBECTL, "-n", NS, *args, "-o", "json"]))


def configured_image(deployment):
    images = [item["image"] for item in deployment["spec"]["template"]["spec"]["containers"] if item["name"] == "omniroute"]
    assert len(images) == 1
    return images[0]


def ready_runtime(expected):
    deployment = kube_json("get", "deployment", "omniroute")
    pods = kube_json("get", "pods", "-l", "app.kubernetes.io/name=omniroute")
    ready = []
    for pod in pods["items"]:
        statuses = [item for item in pod.get("status", {}).get("containerStatuses", []) if item["name"] == "omniroute"]
        if len(statuses) == 1 and statuses[0].get("ready"):
            ready.append((pod, statuses[0]))
    assert configured_image(deployment) == expected, configured_image(deployment)
    assert deployment.get("status", {}).get("readyReplicas") == 1
    assert len(ready) == 1, len(ready)
    assert ready[0][1].get("imageID") == expected, ready[0][1].get("imageID")
    return deployment, pods, ready[0][0]["metadata"]["name"]


def registry_labels():
    raw = run(["docker", "buildx", "imagetools", "inspect", "--format", "{{json .Image.Config.Labels}}", CANDIDATE])
    labels = json.loads(raw)
    for key, expected in LABELS.items():
        assert labels.get(key) == expected, (key, labels.get(key), expected)
    return {key: labels[key] for key in LABELS}


def combos_pages():
    pages, rows, offset, total = [], [], 0, None
    while True:
        page = api(f"/api/combos?limit=100&offset={offset}")
        assert isinstance(page, dict) and isinstance(page.get("combos"), list)
        if total is None:
            total = page["total"]
        assert page["total"] == total
        pages.append(page)
        rows.extend(page["combos"])
        offset = len(rows)
        if offset >= total:
            break
        assert page["combos"]
    assert len(rows) == total
    assert len({item["id"] for item in rows}) == total
    assert len({item["name"] for item in rows}) == total
    return pages, rows


def remove_path(value, dotted):
    parts = dotted.split(".")
    node = value
    for part in parts[:-1]:
        if not isinstance(node, dict) or part not in node:
            return
        node = node[part]
    if isinstance(node, dict):
        node.pop(parts[-1], None)


def sanitized_provider(value):
    result = copy.deepcopy(value)
    connection = result.get("connection", {})
    masked = connection.get("apiKey")
    assert masked in (None, "") or (isinstance(masked, str) and "****" in masked)
    connection["apiKey"] = None
    for path in VOLATILE:
        remove_path(result, path)
    lowered = canonical(result).lower()
    for forbidden in ("accesstoken", "refreshtoken", "idtoken", "authorization"):
        assert f'"{forbidden}"' not in lowered
    return result


def providers():
    return {ident: sanitized_provider(api("/api/providers/" + ident)) for ident in PROVIDER_IDS}


def combo_projection(value):
    return {key: copy.deepcopy(value[key]) for key in FIELDS if key in value}


def combo_map(rows):
    return {item["name"]: combo_projection(item) for item in rows}


def verify_policy(rows):
    assert len(rows) == 94
    live = {item["name"]: item for item in rows}
    expected_connections = [PROVIDER_IDS[0], PROVIDER_IDS[1], PROVIDER_IDS[0]]
    expected_models = ["vllm/qwen3.8-27b-nvfp4", "ollama-local/qwen3.8:27b-iq3-code144k", "vllm/qwen3.8-27b-nvfp4"]
    t1_config = {
        "concurrencyPerModel": 2,
        "queueDepth": 0,
        "queueTimeoutMs": 1000,
        "maxRetries": 0,
        "targetTimeoutMs": 600000,
        "disableSessionStickiness": True,
        "disablePromptCacheAffinity": True,
        "failFastOnAccountCapacity": True,
        "failoverBeforeRetry": True,
    }
    t1b_config = {**t1_config, "concurrencyPerModel": 1}
    for lane in ("code", "research"):
        tier1 = live[f"pool/tier1/{lane}"]
        assert tier1["strategy"] == "round-robin"
        assert [item.get("connectionId") for item in tier1["models"]] == expected_connections
        assert [item.get("model") for item in tier1["models"]] == expected_models
        for key, expected in t1_config.items():
            assert tier1["config"].get(key) == expected, (lane, key, tier1["config"].get(key))
        tier1b = live[f"pool/tier1b/{lane}"]
        assert tier1b["strategy"] == "round-robin"
        assert len(tier1b["models"]) == 1
        assert tier1b["models"][0].get("connectionId") == PROVIDER_IDS[2]
        assert tier1b["models"][0].get("model") == "llama-cpp/ds4-glm53"
        for key, expected in t1b_config.items():
            assert tier1b["config"].get(key) == expected, (lane, "tier1b", key, tier1b["config"].get(key))
        local_refs = [item.get("comboName") for item in live[f"local/{lane}"]["models"]]
        hybrid_refs = [item.get("comboName") for item in live[f"hybrid/{lane}"]["models"]]
        assert local_refs == [f"pool/tier1/{lane}", f"pool/tier1b/{lane}"]
        assert hybrid_refs == [f"pool/tier1/{lane}", f"pool/tier1b/{lane}", f"pool/tier2/{lane}", f"pool/tier3/{lane}", f"pool/tier4/{lane}", f"pool/tier5/{lane}"]
    clouds = [name for name in live if re.fullmatch(r"pool/tier[2-5]/[^/]+", name)]
    assert len(clouds) == 44
    assert all(live[name]["config"].get("targetTimeoutMs") == 60000 for name in clouds)
    return {"comboCount": 94, "cloudCount": 44, "cloudTimeoutMs": 60000, "topology": "5090/4070/5090 -> GLM -> cloud"}


def health():
    body = str(api("/healthz", timeout=15)).strip()
    assert body == "ok", body
    return {"http": 200, "body": body}


def source_hash():
    value = sha256_bytes(SOURCE.read_bytes())
    assert value == SOURCE_SHA256, value
    return value


def preflight():
    global API_KEY
    API_KEY = Path("/run/secrets/omniroute_management_api_key").read_text().strip()
    assert API_KEY
    labels = registry_labels()
    start_forward()
    _, _, pod = ready_runtime(OLD)
    health_result = health()
    _, rows = combos_pages()
    policy = verify_policy(rows)
    live_providers = providers()
    caps = [live_providers[ident]["connection"].get("maxConcurrent") for ident in PROVIDER_IDS]
    assert caps == [2, 1, 1], caps
    return {"liveDigest": OLD, "readyPod": pod, "health": health_result, "policy": policy, "caps": caps, "sourceSha256": source_hash(), "candidateLabels": labels, "reviewVerdict": "APPROVED", "volatileProviderExclusions": VOLATILE}


def validate_backup():
    assert BACKUP is not None and JOURNAL is not None
    assert (BACKUP.stat().st_mode & 0o777) == 0o700
    manifest = json.loads((BACKUP / "manifest.json").read_text())
    for name, expected in manifest["files"].items():
        path = BACKUP / name
        assert (path.stat().st_mode & 0o777) == 0o600, (name, oct(path.stat().st_mode & 0o777))
        assert path.stat().st_size == expected["bytes"]
        assert sha256_bytes(path.read_bytes()) == expected["sha256"]
    for path in BACKUP.iterdir():
        assert (path.stat().st_mode & 0o777) == 0o600, (path.name, oct(path.stat().st_mode & 0o777))
        data = path.read_bytes()
        assert API_KEY.encode() not in data, f"management key leaked into {path.name}"
        if path.suffix == ".json":
            json.loads(data)
        elif path.suffix == ".jsonl" and data:
            for line in data.splitlines():
                json.loads(line)
    return manifest


def create_backup(pre):
    global BACKUP, JOURNAL
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    BACKUP = STATE / f"{stamp}-effort-fix-image-only"
    BACKUP.mkdir(mode=0o700)
    BACKUP.chmod(0o700)
    JOURNAL = BACKUP / "journal.jsonl"
    atomic_bytes(JOURNAL, b"")
    journal({"event": "backup_initialized", "status": "pending", "providerExclusions": VOLATILE})
    pages, rows = combos_pages()
    verify_policy(rows)
    provider_values = providers()
    deployment = kube_json("get", "deployment", "omniroute")
    replicasets = kube_json("get", "replicasets")
    pods = kube_json("get", "pods", "-l", "app.kubernetes.io/name=omniroute")
    atomic_json(BACKUP / "combos.pages.json", pages)
    atomic_json(BACKUP / "combos.full.json", rows)
    atomic_json(BACKUP / "providers.sanitized.json", provider_values)
    atomic_bytes(BACKUP / "omniroute-mode.py", SOURCE.read_bytes())
    atomic_json(BACKUP / "deployment.json", deployment)
    atomic_json(BACKUP / "replicasets.json", replicasets)
    atomic_json(BACKUP / "pods.json", pods)
    atomic_json(BACKUP / "candidate-metadata.json", {"oldDigest": OLD, "candidateDigest": CANDIDATE, "labels": LABELS, "reviewVerdict": "APPROVED", "sourceSha256": SOURCE_SHA256, "preflight": pre})
    files = {}
    for path in BACKUP.iterdir():
        if path.name in {"manifest.json", "journal.jsonl"}:
            continue
        files[path.name] = {"sha256": sha256_bytes(path.read_bytes()), "bytes": path.stat().st_size}
    manifest = {"timestampUtc": stamp, "host": os.uname().nodename, "directoryMode": "0700", "fileMode": "0600", "comboCount": 94, "cloudCount": 44, "oldDigest": OLD, "candidateDigest": CANDIDATE, "candidateLabels": LABELS, "providerExclusions": VOLATILE, "sourceSha256": SOURCE_SHA256, "files": files}
    atomic_json(BACKUP / "manifest.json", manifest)
    validate_backup()
    journal({"event": "backup_validated", "status": "ok", "comboCount": 94, "secretScan": "clean"})
    validate_backup()
    return rows, provider_values


def assert_unchanged(backup_rows, backup_providers, expected_image):
    ready_runtime(expected_image)
    _, rows = combos_pages()
    verify_policy(rows)
    assert combo_map(rows) == combo_map(backup_rows)
    assert providers() == backup_providers
    assert SOURCE.read_bytes() == (BACKUP / "omniroute-mode.py").read_bytes()
    assert source_hash() == SOURCE_SHA256
    return rows


def deploy(image):
    global DEPLOY_ATTEMPTED
    if image == CANDIDATE:
        DEPLOY_ATTEMPTED = True
    patch = canonical({"spec": {"template": {"spec": {"containers": [{"name": "omniroute", "image": image}]}}}})
    run([KUBECTL, "-n", NS, "patch", "deployment", "omniroute", "--type=strategic", "-p", patch])
    run([KUBECTL, "-n", NS, "rollout", "status", "deployment/omniroute", "--timeout=600s"], timeout=660)
    _, _, pod = ready_runtime(image)
    start_forward()
    health_result = health()
    if image == CANDIDATE:
        registry_labels()
    journal({"event": "runtime_gate", "status": "ok", "image": image, "pod": pod, "health": health_result})
    return pod


def concurrency_state():
    value = api("/api/admin/concurrency", timeout=15)
    semaphores = value.get("semaphores", {})
    rates = value.get("rateLimits", {})
    state = {}
    for provider, ident in zip(PROVIDER_NAMES, PROVIDER_IDS):
        sem = semaphores.get(f"{provider}:{ident}", {})
        rate = rates.get(f"{provider}:{ident}", {})
        state[provider] = {"running": int(sem.get("running", 0)), "queued": int(sem.get("queued", 0)), "rateQueued": int(rate.get("queued", 0))}
    return state


def logs_since(start):
    return run([KUBECTL, "-n", NS, "logs", "deployment/omniroute", "--since-time=" + start], timeout=60)


def safe_headers(headers):
    allowed = {"content-type", "content-length", "date", "server", "x-request-id", "x-correlation-id", "traceparent", "tracestate"}
    return {key: str(value)[:500] for key, value in headers.items() if key.lower() in allowed or key.lower().startswith("x-omniroute-") or key.lower().startswith("x-ratelimit-")}


def chat_request(model, marker, effort_marker, tier_one=False):
    payload = {"model": model, "stream": False, "max_tokens": 2, "messages": [{"role": "user", "content": "Reply OK."}]}
    if effort_marker != "__omitted__":
        payload["reasoning_effort"] = effort_marker
    headers = {"Authorization": "Bearer " + API_KEY, "Content-Type": "application/json", "X-Request-ID": marker}
    if tier_one:
        headers["X-OmniRoute-Tier"] = "1"
    request = urllib.request.Request(f"http://127.0.0.1:{API_PORT}/v1/chat/completions", data=canonical(payload).encode(), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body = response.read()
            return response.status, body, safe_headers(dict(response.headers.items()))
    except urllib.error.HTTPError as error:
        return error.code, error.read(), safe_headers(dict(error.headers.items()) if error.headers else {})


def monitored_chat(model, marker, effort, tier_one=False):
    baseline = concurrency_state()
    assert all(item["queued"] == 0 and item["rateQueued"] == 0 for item in baseline.values()), baseline
    snapshots = []
    stop = threading.Event()
    def monitor():
        while not stop.wait(0.1):
            try:
                snapshots.append(concurrency_state())
            except Exception:
                pass
    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    started = now()
    status, body, headers = chat_request(model, marker, effort, tier_one=tier_one)
    stop.set()
    thread.join(timeout=5)
    deadline = time.time() + 45
    restored = concurrency_state()
    while restored != baseline and time.time() < deadline:
        time.sleep(0.25)
        restored = concurrency_state()
    assert restored == baseline, {"marker": marker, "baseline": baseline, "after": restored}
    max_account_queued = max((item["queued"] for state in snapshots for item in state.values()), default=0)
    max_rate_queued = max((item["rateQueued"] for state in snapshots for item in state.values()), default=0)
    assert all(item["queued"] == baseline[name]["queued"] for state in snapshots for name, item in state.items()), {"marker": marker, "baseline": baseline, "snapshots": snapshots[-20:]}
    time.sleep(1)
    logs = logs_since(started)
    return {"marker": marker, "status": status, "responseBytes": len(body), "responseSha256": sha256_bytes(body), "headers": headers, "baseline": baseline, "restored": restored, "snapshotCount": len(snapshots), "maxAccountQueued": max_account_queued, "maxRateQueued": max_rate_queued, "logs": logs}


def log_facts(logs, effort=None):
    lowered = logs.lower()
    omission = 0
    if effort is not None:
        phrase = f"omitted reasoning effort {effort} because the backend exposes its top tier only as the omitted default"
        omission = lowered.count(phrase.lower())
    return {
        "omissionCount": omission,
        "unexpectedReasoningEffort": lowered.count("unexpected reasoning effort"),
        "jinjaEnumError": sum(1 for line in lowered.splitlines() if "jinja" in line and ("enum" in line or "reasoning effort" in line)),
        "http500Evidence": len(re.findall(r"(?:status[=:\"' ]+|http\s+)500\b", lowered)),
        "queueTimeoutEvidence": lowered.count("semaphore_timeout") + lowered.count("queue timeout"),
    }


def run_canaries():
    canary_start = now()
    results = []
    for effort in ("__omitted__", "low", "medium", "high", "xhigh", "max"):
        marker = f"effort-fix-{effort.strip('_') or 'omitted'}-{time.time_ns()}"
        result = monitored_chat("ollama-local/qwen3.8:27b-iq3-code144k", marker, effort)
        facts = log_facts(result.pop("logs"), None if effort == "__omitted__" else effort)
        accepted = result["status"] not in (400, 404, 409, 415, 422)
        assert result["status"] < 500, (effort, result["status"])
        if effort in ("__omitted__", "low", "medium"):
            assert result["status"] == 200, (effort, result["status"])
            assert facts["omissionCount"] == 0, (effort, facts)
        elif effort == "high":
            assert result["status"] == 200, result["status"]
            assert facts["omissionCount"] >= 1, facts
        elif accepted:
            assert facts["omissionCount"] >= 1, (effort, facts)
        assert facts["unexpectedReasoningEffort"] == 0 and facts["jinjaEnumError"] == 0
        assert facts["http500Evidence"] == 0 and facts["queueTimeoutEvidence"] == 0
        entry = {"effort": "omitted" if effort == "__omitted__" else effort, "apiAccepted": accepted, **result, "logFacts": facts}
        results.append(entry)
        journal({"event": "direct_effort_canary", "status": "ok", **entry})

    hybrid_attempts = []
    selected_ollama = False
    for index in range(1, 5):
        marker = f"effort-fix-hybrid-code-{index}-{time.time_ns()}"
        result = monitored_chat("hybrid/code", marker, "high", tier_one=True)
        logs = result.pop("logs")
        facts = log_facts(logs, "high")
        lowered = logs.lower()
        selected = "ollama-local" if "provider: ollama-local" in lowered or "ollama-local/qwen3.8:27b-iq3-code144k" in lowered else "vllm" if "provider: vllm" in lowered or "vllm/qwen3.8-27b-nvfp4" in lowered else "unresolved"
        assert result["status"] == 200, result["status"]
        assert facts["unexpectedReasoningEffort"] == 0 and facts["jinjaEnumError"] == 0 and facts["http500Evidence"] == 0 and facts["queueTimeoutEvidence"] == 0
        attempt = {"attempt": index, "selectedProvider": selected, **result, "logFacts": facts}
        hybrid_attempts.append(attempt)
        journal({"event": "hybrid_code_canary", "status": "ok", **attempt})
        if selected == "ollama-local":
            assert facts["omissionCount"] >= 1, facts
            selected_ollama = True
            break
    assert selected_ollama, hybrid_attempts
    time.sleep(10)
    observed_logs = logs_since(canary_start)
    observation = log_facts(observed_logs)
    assert observation["unexpectedReasoningEffort"] == 0
    assert observation["jinjaEnumError"] == 0
    assert observation["http500Evidence"] == 0
    assert observation["queueTimeoutEvidence"] == 0
    final_state = concurrency_state()
    first_baseline = results[0]["baseline"]
    assert final_state == first_baseline, {"before": first_baseline, "after": final_state}
    journal({"event": "canaries_complete", "status": "ok", "direct": results, "hybrid": hybrid_attempts, "semaphoreBaseline": first_baseline, "semaphoreRestored": final_state, "logObservationSeconds": 10, "logObservation": observation, "paidCloudRequests": 0})
    return {"direct": results, "hybrid": hybrid_attempts, "semaphoreBaseline": first_baseline, "semaphoreRestored": final_state, "logObservationSeconds": 10, "logObservation": observation, "paidCloudRequests": 0}


def rollback(backup_rows, backup_providers, cause):
    deploy(OLD)
    assert_unchanged(backup_rows, backup_providers, OLD)
    validate_backup()
    journal({"event": "rollback_verified", "status": "ok", "cause": repr(cause), "image": OLD, "policy": "projection-identical", "source": "byte-identical", "health": 200})


def execute():
    global API_KEY
    API_KEY = Path("/run/secrets/omniroute_management_api_key").read_text().strip()
    pre = preflight()
    backup_rows = backup_providers = None
    try:
        backup_rows, backup_providers = create_backup(pre)
        assert_unchanged(backup_rows, backup_providers, OLD)
        pod = deploy(CANDIDATE)
        assert_unchanged(backup_rows, backup_providers, CANDIDATE)
        canaries = run_canaries()
        assert_unchanged(backup_rows, backup_providers, CANDIDATE)
        manifest = validate_backup()
        journal({"event": "final_acceptance", "status": "ok", "image": CANDIDATE, "pod": pod, "policy": "projection-identical", "providers": "identical excluding exactly eight volatile paths", "source": "byte-identical", "rollbackInvoked": False})
        final_journal_sha = sha256_bytes(JOURNAL.read_bytes())
        result = {"status": "SUCCESS", "preflight": pre, "backup": str(BACKUP), "manifestSha256": sha256_bytes((BACKUP / "manifest.json").read_bytes()), "journalSha256": final_journal_sha, "liveDigest": CANDIDATE, "pod": pod, "canaries": canaries, "rollbackInvoked": False, "manifest": manifest}
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        if JOURNAL is not None:
            journal({"event": "transaction_failed", "status": "rollback_started" if DEPLOY_ATTEMPTED else "failed_before_deploy", "error": repr(error)})
        rollback_error = None
        if DEPLOY_ATTEMPTED and backup_rows is not None and backup_providers is not None:
            try:
                rollback(backup_rows, backup_providers, error)
            except Exception as caught:
                rollback_error = repr(caught)
        result = {"status": "ROLLBACK_FAILED" if rollback_error else "ROLLED_BACK" if DEPLOY_ATTEMPTED else "FAILED_PREDEPLOY", "error": repr(error), "rollbackError": rollback_error, "backup": str(BACKUP) if BACKUP else None, "liveDigest": OLD if not rollback_error else "UNKNOWN", "rollbackInvoked": bool(DEPLOY_ATTEMPTED)}
        print(json.dumps(result, sort_keys=True))
        return 2 if rollback_error else 1
    finally:
        stop_forward()
        API_KEY = ""


def main():
    global API_KEY, BACKUP, JOURNAL
    if "--verify-live" in sys.argv:
        try:
            index = sys.argv.index("--verify-live")
            BACKUP = Path(sys.argv[index + 1])
            JOURNAL = BACKUP / "journal.jsonl"
            API_KEY = Path("/run/secrets/omniroute_management_api_key").read_text().strip()
            labels = registry_labels()
            start_forward()
            _, _, pod = ready_runtime(CANDIDATE)
            health_result = health()
            backup_rows = json.loads((BACKUP / "combos.full.json").read_text())
            backup_providers = json.loads((BACKUP / "providers.sanitized.json").read_text())
            rows = assert_unchanged(backup_rows, backup_providers, CANDIDATE)
            manifest = validate_backup()
            print(json.dumps({"status": "INDEPENDENT_READBACK_OK", "liveDigest": CANDIDATE, "pod": pod, "health": health_result, "policy": verify_policy(rows), "caps": [backup_providers[ident]["connection"]["maxConcurrent"] for ident in PROVIDER_IDS], "sourceSha256": source_hash(), "candidateLabels": labels, "backup": str(BACKUP), "manifestSha256": sha256_bytes((BACKUP / "manifest.json").read_bytes()), "journalSha256": sha256_bytes(JOURNAL.read_bytes()), "secretScan": "clean", "rollbackPending": False, "manifest": manifest}, sort_keys=True))
            return 0
        finally:
            stop_forward()
            API_KEY = ""
    if "--preflight" in sys.argv:
        try:
            API_KEY = Path("/run/secrets/omniroute_management_api_key").read_text().strip()
            print(json.dumps({"status": "PREFLIGHT_OK", **preflight()}, sort_keys=True))
            return 0
        finally:
            stop_forward()
            API_KEY = ""
    if "--execute" in sys.argv:
        return execute()
    print("use --preflight, --verify-live BACKUP, or --execute", file=sys.stderr)
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
