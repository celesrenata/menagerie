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

OLD = "registry.celestium.life/library/omniroute@sha256:41a9b0a6ecc1f2d9a333adea2af62ae5f90079ec4bb93c5ddf6f48e1f3dabd87"
CANDIDATE = "registry.celestium.life/library/omniroute@sha256:fb059a4d0364f7afced60cf4d20b7644ef57bb14439bde1a3ca51b69202aaf9b"
REVISION = "ad45d990c9f17e857f0bd03aacd1ff29b1825658"
TREE = "aea994df380df929bee410618dfe5bd41ee9006e"
DIFF = "ecb660e179847f24d6dd8f71708405b19875fd3d2e45c6938dfd6a3ab48a3a2e"
LABELS = {"org.opencontainers.image.revision": REVISION, "life.celestium.omniroute.candidate-tree": TREE, "life.celestium.omniroute.diff-sha256": DIFF}
KUBECTL = "/run/current-system/sw/bin/kubectl"
NS = "omniroute"
SOURCE = Path("/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py")
STATE = Path("/home/celes/.local/state/omniroute-routing")
BASELINE = STATE / "20261011T003051Z-capacity-cascade"
PROVIDER_IDS = ["e9bd13fb-c6b6-4c18-b42f-3395266348ce", "b20e0770-3e14-40c1-87cd-85c34b34381a", "70b82fc9-6f96-41ac-aa16-8da6099dd7ac"]
CAPS = dict(zip(PROVIDER_IDS, [2, 1, 1]))
PROVIDER_KEYS = {"vllm": PROVIDER_IDS[0], "ollama-local": PROVIDER_IDS[1], "llama-cpp": PROVIDER_IDS[2]}
VOLATILE = ["connection.lastTested", "connection.providerSpecificData.apiKeyHealth", "connection.updatedAt", "connection.errorCode", "connection.lastError", "connection.lastErrorAt", "connection.lastErrorType", "connection.syncedModelsAt"]
FIELDS = ("name", "description", "strategy", "models", "config", "context_length", "context_cache_protection")
LANES = ["pool/tier1/code", "pool/tier1b/code", "hybrid/code", "local/code", "pool/tier1/research", "pool/tier1b/research", "hybrid/research", "local/research"]
TESTER = ["pool/tier1/tester", "pool/tier1b/tester", "hybrid/tester", "local/tester"]
JOURNAL = None
BACKUP = None
API_KEY = ""
WRITES = []
SOURCE_WRITTEN = False
DEPLOYED = False

API_PORT = 22129
PF_PROCESS = None

class CommandFailure(RuntimeError):
    pass

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def digest(value):
    data = value if isinstance(value, bytes) else canonical(value).encode()
    return hashlib.sha256(data).hexdigest()

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def run(argv, input_bytes=None, timeout=900, record=True):
    result = subprocess.run(argv, input=input_bytes, capture_output=True, timeout=timeout)
    stdout = result.stdout.decode(errors="replace")
    stderr = result.stderr.decode(errors="replace")
    if record and JOURNAL is not None:
        event = {"ts": now(), "event": "command", "argv": argv, "rc": result.returncode, "stdout": stdout[-12000:], "stderr": stderr[-12000:]}
        journal(event)
    if result.returncode:
        raise CommandFailure(f"command failed rc={result.returncode}: {argv!r}\nstdout:\n{stdout}\nstderr:\n{stderr}")
    return stdout

def self_test():
    output = run([sys.executable, "-c", "import json; print(json.dumps({'ok': True}))"], record=False)
    assert json.loads(output) == {"ok": True}
    try:
        run([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(7)"], record=False)
    except CommandFailure as error:
        text = str(error)
        assert "out" in text and "err" in text and "rc=7" in text
    else:
        raise AssertionError("failing command did not raise")
    print(json.dumps({"helper": "ok", "successJsonParsed": True, "failureRaised": True}))

def journal(event):
    assert JOURNAL is not None
    with JOURNAL.open("ab") as handle:
        handle.write((canonical(event) + "\n").encode())
        handle.flush()
        os.fsync(handle.fileno())
    JOURNAL.chmod(0o600)

def atomic_bytes(path, data):
    temp = path.with_name(path.name + ".tmp")
    with temp.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    temp.chmod(0o600)
    temp.replace(path)
    path.chmod(0o600)

def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode())

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
        path = BACKUP / "port-forward.log"
        handle = path.open("ab")
        path.chmod(0o600)
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
            raise RuntimeError(f"port-forward exited with {PF_PROCESS.returncode}")
        try:
            if str(api("/healthz", timeout=3)).strip() == "ok":
                if JOURNAL is not None:
                    journal({"ts": now(), "event": "port_forward_ready", "status": "ok", "pid": PF_PROCESS.pid, "port": API_PORT})
                return
        except Exception as error:
            last_error = error
        time.sleep(0.5)
    raise RuntimeError(f"port-forward health did not become ready: {last_error!r}")


def api(path, data=None, method=None, timeout=65):
    verb = method or ("POST" if data is not None else "GET")
    body = None if data is None else canonical(data).encode()
    headers = {"Authorization": "Bearer " + API_KEY}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"http://127.0.0.1:{API_PORT}" + path, data=body, method=verb, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read()
        raise RuntimeError(f"{verb} {path}: HTTP {error.code}: {raw.decode(errors='replace')[:3000]}") from error
    if status < 200 or status >= 300:
        raise RuntimeError(f"{verb} {path}: HTTP {status}")
    if not raw:
        return None
    text = raw.decode()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text

def health():
    value = api("/healthz", timeout=15)
    if str(value).strip() != "ok":
        raise AssertionError(f"health body is not ok: {value!r}")
    return 200

def combos_pages():
    pages, rows, offset, total = [], [], 0, None
    while True:
        page = api(f"/api/combos?limit=100&offset={offset}")
        assert isinstance(page, dict) and isinstance(page.get("combos"), list)
        reported = page.get("total")
        assert isinstance(reported, int)
        if total is None:
            total = reported
        assert total == reported
        pages.append(page)
        chunk = page["combos"]
        rows.extend(chunk)
        offset += len(chunk)
        if offset >= total:
            break
        assert chunk
    assert len(rows) == total
    assert len({x["id"] for x in rows}) == total
    assert len({x["name"] for x in rows}) == total
    return pages, rows

def providers():
    result = {}
    for ident in PROVIDER_IDS:
        value = api("/api/providers/" + ident)
        conn = value["connection"]
        masked = conn.get("apiKey")
        if masked not in (None, "") and (not isinstance(masked, str) or "****" not in masked):
            raise AssertionError("provider API returned unmasked credential material")
        clean = copy.deepcopy(value)
        clean["connection"]["apiKey"] = None
        text = canonical(clean).lower()
        for key in ("accesstoken", "refreshtoken", "idtoken", "authorization"):
            if f'"{key}"' in text:
                raise AssertionError(f"provider backup contains forbidden field {key}")
        result[ident] = clean
    return result

def remove_path(value, dotted):
    parts = dotted.split(".")
    node = value
    for part in parts[:-1]:
        if not isinstance(node, dict) or part not in node:
            return
        node = node[part]
    if isinstance(node, dict):
        node.pop(parts[-1], None)

def provider_projection(value):
    result = copy.deepcopy(value)
    for path in VOLATILE:
        remove_path(result, path)
    return result

def projection(combo):
    if combo is None:
        return None
    return {key: copy.deepcopy(combo[key]) for key in FIELDS if key in combo}

def kube_json(*args):
    output = run([KUBECTL, "-n", NS, *args, "-o", "json"])
    return json.loads(output)

def configured_image(deployment):
    matches = [c["image"] for c in deployment["spec"]["template"]["spec"]["containers"] if c["name"] == "omniroute"]
    assert len(matches) == 1
    return matches[0]

def ready_runtime(expected):
    deployment = kube_json("get", "deployment", "omniroute")
    pods = kube_json("get", "pods", "-l", "app.kubernetes.io/name=omniroute")
    ready = []
    for pod in pods["items"]:
        statuses = pod.get("status", {}).get("containerStatuses", [])
        target = [x for x in statuses if x["name"] == "omniroute"]
        if len(target) == 1 and target[0].get("ready"):
            ready.append((pod, target[0]))
    assert configured_image(deployment) == expected
    assert len(ready) == 1, f"expected one ready pod, got {len(ready)}"
    assert ready[0][1].get("imageID") == expected, ready[0][1].get("imageID")
    assert deployment.get("status", {}).get("readyReplicas") == 1
    return deployment, pods, ready[0][0]["metadata"]["name"]

def registry_labels():
    output = run(["docker", "buildx", "imagetools", "inspect", "--format", "{{json .Image.Config.Labels}}", CANDIDATE])
    labels = json.loads(output)
    for key, expected in LABELS.items():
        assert labels.get(key) == expected, (key, labels.get(key), expected)
    return labels

def preflight():
    global API_KEY
    API_KEY = Path("/run/secrets/omniroute_management_api_key").read_text().strip()
    assert API_KEY
    start_forward()
    registry_labels()
    deployment, pods, pod = ready_runtime(OLD)
    assert health() == 200
    pages, rows = combos_pages()
    assert len(rows) == 93
    old_rows = json.loads((BASELINE / "combos.full.json").read_text())
    assert [projection(x) for x in rows] == [projection(x) for x in old_rows]
    old_providers = json.loads((BASELINE / "providers.affected.json").read_text())
    live_providers = providers()
    for ident in PROVIDER_IDS:
        assert provider_projection(live_providers[ident]) == provider_projection(old_providers[ident])
        assert live_providers[ident]["connection"]["maxConcurrent"] == CAPS[ident]
    assert SOURCE.read_bytes() == (BASELINE / "omniroute-mode.py").read_bytes()
    offline = offline_plan_check(rows)
    output = run([KUBECTL, "-n", NS, "get", "deployment", "omniroute", "-o", "json"])
    assert configured_image(json.loads(output)) == OLD
    try:
        run([KUBECTL, "-n", NS, "get", "deployment", "definitely-absent-release-helper-smoke", "-o", "json"])
    except CommandFailure:
        pass
    else:
        raise AssertionError("kubectl failing helper smoke did not raise")
    return {"comboCount": len(rows), "pod": pod, "health": 200, "labels": {k: LABELS[k] for k in LABELS}, "helperJsonParsed": True, "helperFailureRaised": True, "offlinePlan": offline}

def create_backup():
    global BACKUP, JOURNAL
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    BACKUP = STATE / (stamp + "-capacity-cascade")
    BACKUP.mkdir(mode=0o700)
    BACKUP.chmod(0o700)
    JOURNAL = BACKUP / "journal.jsonl"
    atomic_bytes(JOURNAL, b"")
    journal({"ts": now(), "event": "backup_initialized", "status": "pending", "volatileProviderExclusions": VOLATILE})
    pages, rows = combos_pages()
    by_name = {x["name"]: x for x in rows}
    clouds = sorted(name for name in by_name if re.fullmatch(r"pool/tier[2-5]/[^/]+", name))
    assert len(rows) == 93 and len(clouds) == 44
    atomic_json(BACKUP / "combos.pages.json", pages)
    atomic_json(BACKUP / "combos.full.json", rows)
    atomic_json(BACKUP / "combos.affected.json", {"lanes": {n: by_name.get(n) for n in LANES}, "tester": {n: by_name[n] for n in TESTER}, "cloud": {n: by_name[n] for n in clouds}})
    live_providers = providers()
    atomic_json(BACKUP / "providers.affected.json", live_providers)
    atomic_bytes(BACKUP / "omniroute-mode.py", SOURCE.read_bytes())
    deployment = kube_json("get", "deployment", "omniroute")
    replicasets = kube_json("get", "replicasets")
    pods = kube_json("get", "pods", "-l", "app.kubernetes.io/name=omniroute")
    atomic_json(BACKUP / "deployment.json", deployment)
    runtime = {"oldDigest": OLD, "configuredImage": configured_image(deployment), "candidateDigest": CANDIDATE, "candidateRevision": REVISION, "candidateTree": TREE, "candidateDiffSha256": DIFF, "deploymentUid": deployment["metadata"]["uid"], "deploymentResourceVersion": deployment["metadata"]["resourceVersion"], "replicaSets": replicasets, "pods": pods}
    atomic_json(BACKUP / "runtime.json", runtime)
    files = {}
    for path in BACKUP.iterdir():
        if path.name in ("manifest.json", "journal.jsonl"):
            continue
        files[path.name] = {"sha256": digest(path.read_bytes()), "bytes": path.stat().st_size, "mode": oct(path.stat().st_mode & 0o777)}
    manifest = {"timestampUtc": stamp, "host": os.uname().nodename, "namespace": NS, "comboCount": len(rows), "cloudCount": len(clouds), "providerIds": PROVIDER_IDS, "affectedLaneNames": LANES, "testerNames": TESTER, "candidateDigestRef": CANDIDATE, "candidateRevision": REVISION, "candidateTree": TREE, "candidateDiffSha256": DIFF, "oldConfiguredImage": OLD, "providerPreconditionVolatileExclusions": VOLATILE, "initialJournalSha256": digest(JOURNAL.read_bytes()), "files": files}
    atomic_json(BACKUP / "manifest.json", manifest)
    validate_backup()
    journal({"ts": now(), "event": "backup_validated", "status": "ok", "comboCount": 93, "cloudCount": 44})
    return rows, live_providers

def validate_backup():
    assert (BACKUP.stat().st_mode & 0o777) == 0o700
    manifest = json.loads((BACKUP / "manifest.json").read_text())
    for name, expected in manifest["files"].items():
        path = BACKUP / name
        assert path.stat().st_size == expected["bytes"]
        assert oct(path.stat().st_mode & 0o777) == expected["mode"]
        assert digest(path.read_bytes()) == expected["sha256"]
    for path in BACKUP.iterdir():
        assert (path.stat().st_mode & 0o777) == 0o600, (path, oct(path.stat().st_mode & 0o777))
        if path.suffix in (".json", ".jsonl") and path.stat().st_size:
            if path.suffix == ".jsonl":
                for line in path.read_text().splitlines():
                    json.loads(line)
            else:
                json.loads(path.read_text())
    for path in BACKUP.iterdir():
        if API_KEY.encode() in path.read_bytes():
            raise AssertionError(f"management key leaked into {path}")

def strict_preconditions(backup_rows, backup_providers, expected_image=OLD):
    deployment, _, _ = ready_runtime(expected_image)
    pages, rows = combos_pages()
    assert len(rows) == len(backup_rows) == 93
    assert [projection(x) for x in rows] == [projection(x) for x in backup_rows]
    current = providers()
    for ident in PROVIDER_IDS:
        assert provider_projection(current[ident]) == provider_projection(backup_providers[ident])
    assert SOURCE.read_bytes() == (BACKUP / "omniroute-mode.py").read_bytes()
    journal({"ts": now(), "event": "strict_preconditions", "status": "ok", "image": expected_image, "comboCount": 93})

def deploy(image):
    patch = canonical({"spec": {"template": {"spec": {"containers": [{"name": "omniroute", "image": image}]}}}})
    run([KUBECTL, "-n", NS, "patch", "deployment", "omniroute", "--type=strategic", "-p", patch])
    run([KUBECTL, "-n", NS, "rollout", "status", "deployment/omniroute", "--timeout=600s"], timeout=660)
    deployment, pods, pod = ready_runtime(image)
    start_forward()
    assert health() == 200
    if image == CANDIDATE:
        registry_labels()
    journal({"ts": now(), "event": "runtime_gate", "status": "ok", "image": image, "pod": pod, "health": 200})

BUILD_FUNCTION = r'''def build(mode, existing):
    order, ceiling = MODES[mode]
    plan = {}
    cascade = {'code', 'research'}
    for category, (vllm, iq3, mlx, glm) in WEIGHTS.items():
        for tier in range(1, 6):
            name = f'pool/tier{tier}/{category}'
            if tier == 1 and category not in cascade and existing.get(name):
                plan[name] = projection(existing[name])
                continue
            if tier != 1 and existing.get(name):
                plan[name] = projection(existing[name])
                plan[name]['config']['targetTimeoutMs'] = 60000
                continue
            if tier == 1 and category in cascade:
                targets = [(QWEN5090, 1), (IQ3, 1), (QWEN5090, 1)]
            elif tier == 1 and category in TIER1_OVERRIDES:
                targets = list(TIER1_OVERRIDES[category])
            else:
                targets = [(QWEN5090,vllm), (MLX,mlx), (IQ3,iq3), (GLM,glm)] if tier == 1 else CLOUD[tier]
            targets = [(model, weight) for model, weight in targets if weight > 0]
            if tier != 1:
                targets = [(m,w) for m,w in targets if not m.startswith('kiro/')]
                if tier in order: targets = [(m,w) for m,w in targets if allowed_cloud(mode,m)]
                if category in FREE_ONLY_CLOUD_CATEGORIES: targets = [(m,w) for m,w in targets if is_free_cloud(m)]
            if not targets: continue
            if tier == 1 and (category in TIER1_OVERRIDES or category in cascade):
                target_policies = {model: copy.deepcopy(OVERRIDE_POLICIES[model]) for model, _ in targets}
            else:
                target_policies = copy.deepcopy(POLICIES)
            if category == 'planner':
                for policy in target_policies.values(): policy['maxInputTokens'] = PLANNER_RAW_WINDOW
            rr_gpu_pool = tier == 1 and category in cascade
            strategy = 'round-robin' if rr_gpu_pool else ('priority' if tier == 1 else 'round-robin')
            if tier == 1 and category == 'planner': description = 'Tier 1 planner: M5 DS4 GLM only'
            elif tier == 1 and category == 'reader': description = 'Tier 1 reader: 4070 Ti Super 9B ollama reader'
            elif tier == 1 and category in cascade: description = f'Tier 1 {category}: 5090 Qwen3.8 / 4070 Qwen3.8 IQ3 round-robin 2:1 interleave'
            elif tier == 1 and category in TIER1_OVERRIDES: description = f'Tier 1 {category}: 5090 Qwen3.8 > M5 GLM > 4070 Qwen3.8 IQ3 priority'
            else: description = f'Tier {tier} {category}: capacity-aware weighted round robin'
            overrides = {'concurrencyPerModel': TIER1_CONCURRENCY.get(category, 1) if tier == 1 else 4}
            if tier != 1: overrides.update(weightedRoundRobin=True, targetTimeoutMs=60000)
            elif rr_gpu_pool: overrides.update(queueDepth=0, queueTimeoutMs=1000, targetTimeoutMs=600000, concurrencyPerModel=2, disableSessionStickiness=True, disablePromptCacheAffinity=True, failFastOnAccountCapacity=True, failoverBeforeRetry=True)
            else: overrides['weightedTargetPolicies'] = target_policies
            plan[name] = {'name': name, 'description': description, 'strategy': strategy,
                'models': [model_step(category,tier,i,m,w) for i,(m,w) in enumerate(targets)],
                'context_length': (PLANNER_RAW_WINDOW if category == 'planner' else 163840) if tier == 1 else 1000000,
                'context_cache_protection': False, 'config': config_for(existing.get(name), **overrides)}
    for name, before in existing.items():
        parts = name.split('/')
        if len(parts) == 3 and parts[0] == 'pool' and parts[1] in {'tier2', 'tier3', 'tier4', 'tier5'} and name not in plan:
            plan[name] = projection(before)
            plan[name]['config']['targetTimeoutMs'] = 60000
    for category in ('code', 'research'):
        name = f'pool/tier1b/{category}'
        plan[name] = {'name': name, 'description': f'{category.capitalize()} high-context overflow: GLM-5.3 1M local before cloud',
            'strategy': 'round-robin', 'models': [model_step(category, '1b', 'glm', GLM, 100)],
            'context_length': PLANNER_RAW_WINDOW, 'context_cache_protection': False,
            'config': config_for(existing.get(name), concurrencyPerModel=1, queueDepth=0, queueTimeoutMs=1000, targetTimeoutMs=600000, disableSessionStickiness=True, disablePromptCacheAffinity=True, failFastOnAccountCapacity=True, failoverBeforeRetry=True)}
    if existing.get('pool/tier1b/tester'): plan['pool/tier1b/tester'] = projection(existing['pool/tier1b/tester'])
    for category in WEIGHTS:
        for family in ('local', 'hybrid'):
            name = f'{family}/{category}'
            if category != 'research' and existing.get(name):
                plan[name] = projection(existing[name]); continue
            tiers = [1] if family == 'local' else order
            refs = [t for t in tiers if f'pool/tier{t}/{category}' in plan]
            if category in cascade:
                models = [{'id': f'{family}-{category}-tier1', 'kind': 'combo-ref', 'comboName': f'pool/tier1/{category}', 'weight': 0}, {'id': f'{family}-{category}-tier1b', 'kind': 'combo-ref', 'comboName': f'pool/tier1b/{category}', 'weight': 0}]
                if family == 'hybrid': models += [{'id': f'{family}-{category}-tier{t}', 'kind': 'combo-ref', 'comboName': f'pool/tier{t}/{category}', 'weight': 0} for t in refs if t != 1]
            else:
                models = [{'id': f'{family}-{category}-tier{t}', 'kind': 'combo-ref', 'comboName': f'pool/tier{t}/{category}', 'weight': 0} for t in refs]
            root_overrides = {'nestedComboMode': 'execute', 'tierRouting': {'defaultTier': 1, 'maximumTier': ceiling if family == 'hybrid' else 1}}
            if category in cascade: root_overrides['failoverBeforeRetry'] = True
            plan[name] = {'name': name, 'description': f'{category} routing: {mode if family == "hybrid" else "local-only"}; per-task X-OmniRoute-Tier',
                'strategy': 'priority', 'models': models, 'context_length': 163840 if (family == 'local' or category == 'fast') else 262144,
                'context_cache_protection': False, 'config': config_for(existing.get(name), **root_overrides)}
    return plan
'''

def patched_source(old):
    text = old.decode()
    text = text.replace("OBSOLETE = {'healthCheckEnabled', 'healthCheckTimeoutMs', 'timeoutMs', 'queueDepth'}", "OBSOLETE = {'healthCheckEnabled', 'healthCheckTimeoutMs', 'timeoutMs'}")
    text = text.replace("CONNECTIONS['ollama-local']: {'maxConcurrent': 4}", "CONNECTIONS['ollama-local']: {'maxConcurrent': 1}")
    text = text.replace("    # PUT strips this legacy field. Weighted execution enforces zero queuing itself.\n    if isinstance(result.get('config'), dict): result['config'].pop('queueDepth', None)\n", "")
    start = text.index("def build(mode, existing):")
    end = text.index("def write_json(path, data):", start)
    text = text[:start] + BUILD_FUNCTION + text[end:]
    return text.encode()

def offline_plan_check(rows):
    namespace = {"__name__": "omniroute_mode_offline_check"}
    compiled = compile(patched_source(SOURCE.read_bytes()), str(SOURCE), "exec")
    exec(compiled, namespace)
    live = {x["name"]: x for x in rows}
    first = namespace["build"]("tiered", live)
    second = namespace["build"]("tiered", live)
    assert canonical(first) == canonical(second), "offline builds differ"
    clouds = {n for n in first if re.fullmatch(r"pool/tier[2-5]/[^/]+", n)}
    assert len(clouds) == 44, f"expected 44 clouds, got {len(clouds)}"
    assert all(first[n]["config"]["targetTimeoutMs"] == 60000 for n in clouds), "cloud timeout drift"
    expected = {"pool/tier1/code", "pool/tier1/research", "pool/tier1b/code", "pool/tier1b/research", "hybrid/research", "local/research"} | clouds
    changes = {name for name, desired in first.items() if projection(desired) != projection(live.get(name))}
    assert changes == expected, {"missing": sorted(expected - changes), "extra": sorted(changes - expected)}
    for name in TESTER:
        assert projection(first[name]) == projection(live[name]), f"tester drift: {name}"
    return {"managed": len(first), "changes": len(changes), "clouds": len(clouds)}


def load_generator(path):
    import importlib.util
    name = "omniroute_mode_release_" + str(time.time_ns())
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def reconcile_source_and_plan(live_rows):
    global SOURCE_WRITTEN
    old = SOURCE.read_bytes()
    new = patched_source(old)
    atomic_bytes(SOURCE, new)
    SOURCE_WRITTEN = True
    run([sys.executable, "-m", "py_compile", str(SOURCE)])
    module = load_generator(SOURCE)
    live = {x["name"]: x for x in live_rows}
    first = module.build("tiered", live)
    second = module.build("tiered", live)
    assert canonical(first) == canonical(second)
    clouds = [n for n in first if re.fullmatch(r"pool/tier[2-5]/[^/]+", n)]
    assert len(clouds) == 44 and all(first[n]["config"]["targetTimeoutMs"] == 60000 for n in clouds)
    for lane in ("code", "research"):
        t1 = first[f"pool/tier1/{lane}"]
        assert [m["connectionId"] for m in t1["models"]] == [PROVIDER_IDS[0], PROVIDER_IDS[1], PROVIDER_IDS[0]]
        assert t1["strategy"] == "round-robin"
        for key, expected in {"concurrencyPerModel": 2, "queueDepth": 0, "queueTimeoutMs": 1000, "maxRetries": 0, "targetTimeoutMs": 600000, "disableSessionStickiness": True, "disablePromptCacheAffinity": True, "failFastOnAccountCapacity": True}.items(): assert t1["config"][key] == expected
        t1b = first[f"pool/tier1b/{lane}"]
        assert t1b["strategy"] == "round-robin" and t1b["config"]["queueDepth"] == 0 and t1b["config"]["concurrencyPerModel"] == 1
        assert [m["comboName"] for m in first[f"local/{lane}"]["models"]] == [f"pool/tier1/{lane}", f"pool/tier1b/{lane}"]
        assert [m["comboName"] for m in first[f"hybrid/{lane}"]["models"]] == [f"pool/tier1/{lane}", f"pool/tier1b/{lane}", f"pool/tier2/{lane}", f"pool/tier3/{lane}", f"pool/tier4/{lane}", f"pool/tier5/{lane}"]
    for name in TESTER:
        assert projection(first[name]) == projection(live[name])
    expected_changes = {"pool/tier1/code", "pool/tier1/research", "pool/tier1b/code", "pool/tier1b/research", "hybrid/research", "local/research"} | set(clouds)
    changes = {name for name, desired in first.items() if projection(desired) != projection(live.get(name))}
    assert changes == expected_changes, {"missing": sorted(expected_changes - changes), "extra": sorted(changes - expected_changes)}
    journal({"ts": now(), "event": "durable_source_validated", "status": "ok", "sourceSha256": digest(new), "offlineBuilds": "identical", "managed": len(first), "intendedChanges": len(changes), "cloudCount": 44, "tester": "unchanged"})
    return first

def put_combo(name, desired, before):
    fresh = api("/api/combos/" + before["id"])
    assert projection(fresh) == projection(before), f"concurrent combo drift: {name}"
    actual = api("/api/combos/" + before["id"], desired, method="PUT")
    readback = api("/api/combos/" + before["id"])
    assert projection(readback) == projection(desired), f"combo readback mismatch: {name}"
    WRITES.append((name, before, readback, "PUT"))
    journal({"ts": now(), "event": "record_write", "status": "ok", "method": "PUT", "name": name, "id": before["id"], "beforeSha256": digest(projection(before)), "afterSha256": digest(projection(readback))})
    return readback

def apply_plan(plan, backup_rows, backup_providers):
    by_name = {x["name"]: x for x in backup_rows}
    current_providers = providers()
    for ident in PROVIDER_IDS:
        assert provider_projection(current_providers[ident]) == provider_projection(backup_providers[ident])
        assert current_providers[ident]["connection"]["maxConcurrent"] == CAPS[ident]
    cloud_names = sorted(n for n in plan if re.fullmatch(r"pool/tier[2-5]/[^/]+", n))
    order = ["pool/tier1/code", "pool/tier1/research", "pool/tier1b/code", "pool/tier1b/research"] + cloud_names + ["hybrid/research", "local/research"]
    for name in order:
        desired = plan[name]
        before = by_name.get(name)
        if before is None:
            assert name == "pool/tier1b/research"
            fresh_names = {x["name"] for x in combos_pages()[1]}
            assert name not in fresh_names
            actual = api("/api/combos", desired, method="POST")
            readback = api("/api/combos/" + actual["id"])
            assert projection(readback) == projection(desired)
            WRITES.append((name, None, readback, "POST"))
            journal({"ts": now(), "event": "record_write", "status": "ok", "method": "POST", "name": name, "id": readback["id"], "beforeSha256": digest(None), "afterSha256": digest(projection(readback))})
        else:
            put_combo(name, desired, before)
    rows = combos_pages()[1]
    assert len(rows) == 94
    verify_policy(plan, rows, backup_rows)
    journal({"ts": now(), "event": "live_policy_applied", "status": "ok", "writes": len(WRITES), "comboCount": 94})

def verify_policy(plan, rows, backup_rows):
    live = {x["name"]: x for x in rows}
    for name, desired in plan.items():
        assert projection(live.get(name)) == projection(desired), name
    clouds = [n for n in live if re.fullmatch(r"pool/tier[2-5]/[^/]+", n)]
    assert len(clouds) == 44 and all(live[n]["config"]["targetTimeoutMs"] == 60000 for n in clouds)
    old = {x["name"]: x for x in backup_rows}
    for name in TESTER:
        assert projection(live[name]) == projection(old[name])
    for lane in ("code", "research"):
        assert live[f"pool/tier1/{lane}"]["config"]["queueDepth"] == 0
        assert live[f"pool/tier1b/{lane}"]["config"]["queueDepth"] == 0

def persistence_canary():
    name = "release-canary-" + str(int(time.time()))
    body = {"name": name, "description": "temporary release persistence canary", "strategy": "round-robin", "models": [{"id": "canary-model", "kind": "model", "model": "vllm/qwen3.8-27b-nvfp4", "providerId": "vllm", "connectionId": PROVIDER_IDS[0], "weight": 1}], "config": {"maxRetries": 0, "targetTimeoutMs": 600000, "queueTimeoutMs": 1000, "queueDepth": 0, "disableSessionStickiness": True, "disablePromptCacheAffinity": True, "failFastOnAccountCapacity": True}, "context_length": 163840, "context_cache_protection": False}
    ident = None
    try:
        created = api("/api/combos", body, method="POST")
        ident = created["id"]
        first = api("/api/combos/" + ident)
        assert first["config"]["queueDepth"] == 0
        assert first["config"]["disablePromptCacheAffinity"] is True and first["config"]["failFastOnAccountCapacity"] is True
        changed = projection(first)
        changed["description"] = "temporary release persistence canary updated"
        api("/api/combos/" + ident, changed, method="PUT")
        second = api("/api/combos/" + ident)
        assert second["config"]["queueDepth"] == 0
        assert second["config"]["disablePromptCacheAffinity"] is True and second["config"]["failFastOnAccountCapacity"] is True
    finally:
        if ident:
            api("/api/combos/" + ident, method="DELETE")
    assert name not in {x["name"] for x in combos_pages()[1]}
    journal({"ts": now(), "event": "persistence_canary", "status": "ok", "queueDepth": 0, "booleans": "preserved", "cleanup": "ok"})

def concurrency_state():
    value = api("/api/admin/concurrency", timeout=15)
    sem = value.get("semaphores", {})
    state = {}
    for provider, ident in PROVIDER_KEYS.items():
        item = sem.get(f"{provider}:{ident}", {})
        state[provider] = {"running": int(item.get("running", 0)), "queued": int(item.get("queued", 0))}
    rates = value.get("rateLimits", {})
    for provider, ident in PROVIDER_KEYS.items():
        item = rates.get(f"{provider}:{ident}", {})
        state[provider]["rateQueued"] = int(item.get("queued", 0))
    return state

def wait_idle(timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = concurrency_state()
        if all(state[p]["running"] == 0 and state[p]["queued"] == 0 and state[p]["rateQueued"] == 0 for p in PROVIDER_KEYS):
            return
        time.sleep(2)
    raise AssertionError(f"local providers did not become idle: {concurrency_state()}")

class HeldRequest:
    def __init__(self, model, marker, affinity=False):
        self.model = model
        self.marker = marker
        self.affinity = affinity
        self.stop = threading.Event()
        self.started = threading.Event()
        self.done = threading.Event()
        self.status = None
        self.output = bytearray()
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)
    def start(self):
        self.thread.start()
        return self
    def _run(self):
        payload = {"model": self.model, "stream": True, "max_tokens": 32768, "messages": [{"role": "user", "content": f"{self.marker}: Emit an extremely long numbered sequence, one integer per line. Continue without summarizing until the token limit."}], "reasoning_effort": "low"}
        if self.affinity:
            payload["prompt_cache_key"] = "release-shared-affinity"
            payload["conversation_id"] = "release-shared-conversation"
        request = urllib.request.Request(f"http://127.0.0.1:{API_PORT}/v1/chat/completions", data=canonical(payload).encode(), method="POST", headers={"Authorization": "Bearer " + API_KEY, "Content-Type": "application/json", "X-Request-ID": self.marker})
        try:
            with urllib.request.urlopen(request, timeout=660) as response:
                self.status = response.status
                self.started.set()
                while not self.stop.is_set():
                    chunk = response.read(256)
                    if not chunk:
                        break
                    self.output.extend(chunk)
                    time.sleep(0.05)
        except urllib.error.HTTPError as error:
            self.status = error.code
            self.output.extend(error.read())
            self.started.set()
        except Exception as error:
            self.error = repr(error)
            self.started.set()
        finally:
            self.done.set()
    def close(self):
        self.stop.set()
        self.thread.join(timeout=15)

def wait_state(expected, requests, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = concurrency_state()
        current = tuple(state[p]["running"] for p in ("vllm", "ollama-local", "llama-cpp"))
        if current == expected:
            assert all(state[p]["queued"] == 0 and state[p]["rateQueued"] == 0 for p in PROVIDER_KEYS), state
            return state
        if any(r.done.is_set() for r in requests):
            raise AssertionError({"expected": expected, "state": state, "requests": [{"status": r.status, "error": r.error, "output": bytes(r.output[-500:]).decode(errors="replace")} for r in requests]})
        time.sleep(0.25)
    raise AssertionError({"expected": expected, "state": concurrency_state()})

def run_occupancy_scenario(name, models, affinity=False):
    wait_idle()
    marker = f"release-{name}-{int(time.time())}"
    requests = []
    expected_steps = [(1,0,0), (1,1,0), (2,1,0), (2,1,1)]
    try:
        for index, model in enumerate(models):
            request = HeldRequest(model, f"{marker}-{index}", affinity=affinity).start()
            requests.append(request)
            wait_state(expected_steps[index], requests)
        state = concurrency_state()
        assert state["vllm"]["running"] == 2 and state["ollama-local"]["running"] == 1 and state["llama-cpp"]["running"] == 1
        assert all(state[p]["queued"] == 0 and state[p]["rateQueued"] == 0 for p in PROVIDER_KEYS)
        fifth = HeldRequest("local/code", marker + "-fifth", affinity=affinity).start()
        assert fifth.done.wait(5), "fifth local request did not fail fast"
        body = bytes(fifth.output).decode(errors="replace")
        assert fifth.status == 503 and "ALL_TARGETS_SKIPPED" in body, {"status": fifth.status, "body": body[-1000:], "error": fifth.error}
        requests.append(fifth)
        journal({"ts": now(), "event": "occupancy_canary", "status": "ok", "scenario": name, "models": models, "affinity": affinity, "occupancy": state, "fifth": "503 ALL_TARGETS_SKIPPED", "cloudRequests": 0})
    finally:
        for request in requests:
            request.close()
        wait_idle(180)

def canaries():
    start = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    persistence_canary()
    run_occupancy_scenario("research-parent-skip", ["local/code", "local/code", "local/code", "local/research"])
    run_occupancy_scenario("code-repetition-affinity", ["local/code"] * 4, affinity=True)
    run_occupancy_scenario("mixed-lane-contention", ["local/code", "local/code", "local/research", "local/research"])
    logs = run([KUBECTL, "-n", NS, "logs", "deployment/omniroute", "--since-time=" + start], timeout=60)
    forbidden = ["120000ms", "300000ms", "SEMAPHORE_TIMEOUT"]
    assert not any(token in logs for token in forbidden), [token for token in forbidden if token in logs]
    assert not ("SEMAPHORE_QUEUE_FULL" in logs and "status\":500" in logs)
    all_objects = json.loads(run([KUBECTL, "get", "deployment,statefulset,daemonset", "-A", "-o", "json"]))
    matching = [item for item in all_objects["items"] if "--max-num-seqs" in canonical(item)]
    assert matching and any(re.search(r"--max-num-seqs(?:=|\s|\",\")+2", canonical(item)) for item in matching)
    journal({"ts": now(), "event": "canaries_complete", "status": "ok", "scenarios": 3, "queues": 0, "forbiddenTimeouts": "absent", "vllmMaxNumSeqs": 2, "paidCloudRequests": 0})

def final_acceptance(plan, backup_rows):
    rows = combos_pages()[1]
    assert len(rows) == 94
    verify_policy(plan, rows, backup_rows)
    module = load_generator(SOURCE)
    live = {x["name"]: x for x in rows}
    first = module.build("tiered", live)
    second = module.build("tiered", live)
    assert canonical(first) == canonical(second)
    assert all(projection(live.get(name)) == projection(desired) for name, desired in first.items())
    assert all(v == 60000 for n, x in live.items() if re.fullmatch(r"pool/tier[2-5]/[^/]+", n) for v in [x["config"]["targetTimeoutMs"]])
    run([sys.executable, "-m", "py_compile", str(SOURCE)])
    deployment, pods, pod = ready_runtime(CANDIDATE)
    assert health() == 200
    validate_backup()
    journal({"ts": now(), "event": "final_acceptance", "status": "ok", "image": CANDIDATE, "pod": pod, "health": 200, "comboCount": 94, "cloudCount": 44, "offlineBuilds": "identical_idempotent", "tester": "unchanged", "secretScan": "clean", "rollbackInvoked": False})
    return {"backup": str(BACKUP), "pod": pod, "comboCount": 94, "cloudCount": 44, "writes": len(WRITES), "sourceSha256": digest(SOURCE.read_bytes())}

def rollback(backup_rows, backup_providers, cause):
    global DEPLOYED
    errors = []
    try:
        deploy(OLD)
        DEPLOYED = False
    except Exception as error:
        errors.append("old runtime restore: " + repr(error))
        raise RuntimeError("rollback stopped because old runtime could not be restored: " + repr(error)) from error
    old = {x["name"]: x for x in backup_rows}
    try:
        current = {x["name"]: x for x in combos_pages()[1]}
        roots = [n for n in ("hybrid/code", "local/code", "hybrid/research", "local/research") if n in current and n in old]
        others = [n for n in current if n in old and projection(current[n]) != projection(old[n]) and n not in roots]
        for name in roots + others:
            if projection(current[name]) == projection(old[name]):
                continue
            api("/api/combos/" + current[name]["id"], projection(old[name]), method="PUT")
            check = api("/api/combos/" + current[name]["id"])
            assert projection(check) == projection(old[name])
            journal({"ts": now(), "event": "record_rollback", "status": "ok", "name": name})
        current = {x["name"]: x for x in combos_pages()[1]}
        if "pool/tier1b/research" not in old and "pool/tier1b/research" in current:
            api("/api/combos/" + current["pool/tier1b/research"]["id"], method="DELETE")
            journal({"ts": now(), "event": "record_rollback", "status": "ok", "name": "pool/tier1b/research", "method": "DELETE"})
        current_providers = providers()
        for ident in PROVIDER_IDS:
            if provider_projection(current_providers[ident]) != provider_projection(backup_providers[ident]):
                before = backup_providers[ident]["connection"]
                api("/api/providers/" + ident, {"maxConcurrent": before["maxConcurrent"]}, method="PUT")
        atomic_bytes(SOURCE, (BACKUP / "omniroute-mode.py").read_bytes())
        rows = combos_pages()[1]
        assert len(rows) == 93
        assert {n: projection(x) for n, x in ((r["name"], r) for r in rows)} == {n: projection(x) for n, x in ((r["name"], r) for r in backup_rows)}
        for ident, value in providers().items():
            assert provider_projection(value) == provider_projection(backup_providers[ident])
        assert SOURCE.read_bytes() == (BACKUP / "omniroute-mode.py").read_bytes()
        ready_runtime(OLD)
        assert health() == 200
        validate_backup()
        journal({"ts": now(), "event": "rollback_verified", "status": "ok", "cause": repr(cause), "image": OLD, "health": 200, "comboCount": 93, "source": "byte-identical", "providers": "exact modulo approved volatile paths", "secretScan": "clean"})
    except Exception as error:
        errors.append("policy/source verification: " + repr(error))
    if errors:
        raise RuntimeError("rollback incomplete: " + "; ".join(errors))

def execute():
    global API_KEY, DEPLOYED
    API_KEY = Path("/run/secrets/omniroute_management_api_key").read_text().strip()
    pre = preflight()
    backup_rows = backup_providers = None
    try:
        backup_rows, backup_providers = create_backup()
        strict_preconditions(backup_rows, backup_providers)
        deploy(CANDIDATE)
        DEPLOYED = True
        live_rows = combos_pages()[1]
        assert len(live_rows) == 93
        plan = reconcile_source_and_plan(live_rows)
        apply_plan(plan, backup_rows, backup_providers)
        canaries()
        result = final_acceptance(plan, backup_rows)
        print(json.dumps({"status": "SUCCESS", "preflight": pre, **result}, sort_keys=True))
        return 0
    except Exception as error:
        if JOURNAL is not None:
            journal({"ts": now(), "event": "transaction_failed", "status": "rollback_started", "error": repr(error)})
        if backup_rows is not None and backup_providers is not None:
            try:
                rollback(backup_rows, backup_providers, error)
            except Exception as rollback_error:
                print(json.dumps({"status": "ROLLBACK_FAILED", "backup": str(BACKUP), "error": repr(error), "rollbackError": repr(rollback_error)}, sort_keys=True))
                return 2
        print(json.dumps({"status": "ROLLED_BACK", "backup": str(BACKUP) if BACKUP else None, "error": repr(error)}, sort_keys=True))
        return 1
    finally:
        stop_forward()
        API_KEY = ""

if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    elif "--preflight" in sys.argv:
        try:
            print(json.dumps({"status": "PREFLIGHT_OK", **preflight()}, sort_keys=True))
        finally:
            stop_forward()
            API_KEY = ""
    elif "--execute" in sys.argv:
        raise SystemExit(execute())
    else:
        print("use --self-test or --execute", file=sys.stderr)
        raise SystemExit(64)
