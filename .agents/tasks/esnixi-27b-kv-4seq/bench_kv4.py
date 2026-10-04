#!/usr/bin/env python3
"""Baseline benchmark for the esnixi 27B vLLM backend (stdlib only).

Hits the vLLM backend directly (bypassing the authenticated switcher), builds
~50K-token prompts from real repo code plus tool definitions, and measures
single-request TTFT/prefill/decode and 2-4 way concurrency. Each request gets a
unique nonce at the very start of the prompt so prefix caching cannot hide
prefill cost.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

BASE = os.environ.get("BENCH_BASE", "http://127.0.0.1:8010")
MODEL = "qwen3.8-27b-nvfp4"
REPO = "/home/celes/sources/celesrenata/nix-flakes-refactored"
TARGET_TOKENS = int(os.environ.get("BENCH_TOKENS", "55000"))
# >0: the first N corpus tokens are identical across requests and the nonce sits
# after them (Zoo-like shared prefix); 0: nonce first, nothing shared.
SHARED_TOKENS = int(os.environ.get("BENCH_SHARED_TOKENS", "0"))
MAX_TOKENS = int(os.environ.get("BENCH_MAX_TOKENS", "512"))
OUT = os.environ.get("BENCH_OUT", "/tmp/qwen27b-bench.jsonl")

TOOLS = [
    {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": props,
                       "required": list(props)}}}
    for name, desc, props in [
        ("read_file", "Read a file from the repository.",
         {"path": {"type": "string", "description": "Repo-relative path"}}),
        ("write_file", "Create or overwrite a file.",
         {"path": {"type": "string"}, "content": {"type": "string"}}),
        ("str_replace", "Replace an exact string in a file.",
         {"path": {"type": "string"}, "old": {"type": "string"},
          "new": {"type": "string"}}),
        ("grep", "Search the repository with a regex.",
         {"pattern": {"type": "string"}, "glob": {"type": "string"}}),
        ("run", "Run a shell command and return stdout/stderr.",
         {"command": {"type": "string"}, "cwd": {"type": "string"}}),
    ]
]


def post(path, payload, timeout=900):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def count_tokens(text):
    with post("/tokenize", {"model": MODEL, "prompt": text}) as r:
        return json.load(r)["count"]


def build_corpus():
    files = subprocess.run(
        ["git", "-C", REPO, "ls-files", "*.nix", "*.py", "*.sh"],
        capture_output=True, text=True, check=True).stdout.split()
    parts, approx = [], 0
    for rel in sorted(files):
        try:
            with open(os.path.join(REPO, rel), encoding="utf-8") as f:
                body = f.read()
        except (OSError, UnicodeDecodeError):
            continue
        if len(body) > min(40000, TARGET_TOKENS * 2):
            continue
        parts.append(f"=== FILE: {rel} ===\n{body}\n")
        approx += len(body) // 3
        if approx > TARGET_TOKENS * 2:
            break
    # Trim to target using the real tokenizer.
    text = "".join(parts)
    lo, hi = 0, len(parts)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if count_tokens("".join(parts[:mid])) <= TARGET_TOKENS:
            lo = mid
        else:
            hi = mid - 1
    text = "".join(parts[:lo])
    cut = 0
    if SHARED_TOKENS:
        a, b = 0, lo
        while a < b:
            mid = (a + b + 1) // 2
            if count_tokens("".join(parts[:mid])) <= SHARED_TOKENS:
                a = mid
            else:
                b = mid - 1
        cut = len("".join(parts[:a]))
    return text, count_tokens(text), cut


SERVER_HISTS = [
    f"vllm:{name}_seconds_{agg}"
    for name in ("time_to_first_token", "request_queue_time", "request_prefill_time",
                 "request_decode_time", "e2e_request_latency")
    for agg in ("sum", "count")
] + ["vllm:generation_tokens_total", "vllm:prompt_tokens_total",
       "vllm:num_preemptions_total", "vllm:request_success_total"]


def metrics():
    with urllib.request.urlopen(BASE + "/metrics", timeout=10) as r:
        out = {}
        for line in r.read().decode().splitlines():
            if line.startswith("#"):
                continue
            for key in ("vllm:num_requests_running", "vllm:num_requests_waiting",
                        "vllm:kv_cache_usage_perc", "vllm:prefix_cache_queries_total",
                        "vllm:prefix_cache_hits_total", *SERVER_HISTS):
                if line.startswith(key + "{"):
                    out[key] = float(line.rsplit(" ", 1)[1])
        return out


def wait_idle(limit=600):
    start = time.time()
    while time.time() - start < limit:
        if metrics().get("vllm:num_requests_running", 0) == 0:
            return time.time() - start
        time.sleep(2)
    return None


def one_request(corpus, label, results):
    nonce = uuid.uuid4().hex
    payload = {
        "model": MODEL, "stream": True,
        "stream_options": {"include_usage": True},
        "max_tokens": MAX_TOKENS, "min_tokens": MAX_TOKENS,
        # tool_choice "none" makes this build buffer the whole reply into one
        # chunk (measured), so use "auto" and tell the model not to call tools.
        "temperature": 0.6, "tools": TOOLS, "tool_choice": "auto",
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [
            {"role": "system", "content":
             ("" if CUT else f"[session {nonce}] ") + "You are a senior Nix and Python engineer "
             "reviewing a NixOS flake repository. Answer in prose and code "
             "blocks only; do not call any tools for this answer."},
            {"role": "user", "content":
             f"Repository snapshot:\n\n{corpus[:CUT]}"
             + (f"[session {nonce}]\n" if CUT else "")
             + f"{corpus[CUT:]}\n\nReview the vLLM service "
             "definitions above and write a detailed refactoring plan with "
             "code examples."},
        ],
    }
    t0 = time.time()
    first = None
    usage = {}
    err = None
    tool_call_seen = False
    chunks = 0
    try:
        with post("/v1/chat/completions", payload) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                ev = json.loads(line[6:])
                if ev.get("usage"):
                    usage = ev["usage"]
                for ch in ev.get("choices", []):
                    d = ch.get("delta", {})
                    if d.get("tool_calls"):
                        tool_call_seen = True
                    if d.get("content") or d.get("tool_calls"):
                        chunks += 1
                    if first is None and (d.get("content") or d.get("reasoning_content")
                                          or d.get("reasoning") or d.get("tool_calls")):
                        first = time.time()
    except Exception as exc:  # record, don't crash the run
        err = repr(exc)
    t1 = time.time()
    pt = usage.get("prompt_tokens")
    ct = usage.get("completion_tokens")
    ttft = (first - t0) if first else None
    decode_s = (t1 - first) if first else None
    res = {
        "label": label, "start": t0, "end": t1, "ttft_s": ttft,
        "total_s": t1 - t0, "prompt_tokens": pt, "completion_tokens": ct,
        "cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
        "prefill_tok_s": (pt / ttft) if (pt and ttft) else None,
        "decode_tok_s": ((ct - 1) / decode_s) if (ct and decode_s) else None,
        "error": err, "tool_call_seen": tool_call_seen, "content_chunks": chunks,
    }
    results.append(res)
    return res


def gpu_sampler(stop, samples):
    while not stop.is_set():
        try:
            q = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used,memory.free,memory.total,utilization.gpu,power.draw",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10).stdout.strip()
            p = subprocess.run(
                ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10).stdout.strip()
            m = metrics()
            samples.append({"t": time.time(), "gpu": q, "apps": p, "vllm": m})
        except Exception as exc:
            samples.append({"t": time.time(), "error": repr(exc)})
        stop.wait(1)


def phase(corpus, n, log):
    idle_wait = wait_idle()
    m0 = metrics()
    results, threads = [], []
    t0 = time.time()
    for i in range(n):
        th = threading.Thread(target=one_request, args=(corpus, f"c{n}-r{i}", results))
        th.start()
        threads.append(th)
        time.sleep(0.05)
    for th in threads:
        th.join()
    t1 = time.time()
    m1 = metrics()
    ct = sum(r["completion_tokens"] or 0 for r in results)
    pt = sum(r["prompt_tokens"] or 0 for r in results)
    summary = {
        "phase": f"concurrency={n}", "idle_wait_s": idle_wait,
        "wall_s": t1 - t0, "agg_completion_tok_s": ct / (t1 - t0),
        "agg_prompt_tok_s": pt / (t1 - t0),
        "prefix_hits_delta": m1.get("vllm:prefix_cache_hits_total", 0) - m0.get("vllm:prefix_cache_hits_total", 0),
        "prefix_queries_delta": m1.get("vllm:prefix_cache_queries_total", 0) - m0.get("vllm:prefix_cache_queries_total", 0),
        "requests": sorted(results, key=lambda r: r["label"]),
        # Server-side histogram deltas (includes any live traffic in the window).
        "server_delta": {k.removeprefix("vllm:"): m1.get(k, 0) - m0.get(k, 0)
                         for k in SERVER_HISTS},
    }
    log.write(json.dumps(summary) + "\n")
    log.flush()
    print(json.dumps(summary, indent=1), flush=True)
    return summary


CUT = 0


def main():
    global CUT
    corpus, ntok, CUT = build_corpus()
    shared = count_tokens(corpus[:CUT]) if CUT else 0
    print(f"corpus tokens={ntok} chars={len(corpus)} shared_corpus_tokens={shared}", flush=True)
    stop, samples = threading.Event(), []
    sampler = threading.Thread(target=gpu_sampler, args=(stop, samples), daemon=True)
    sampler.start()
    phases = [int(x) for x in sys.argv[1:]] or [1, 1, 2, 3, 4]
    with open(OUT, "w") as log:
        log.write(json.dumps({"corpus_tokens": ntok, "shared_corpus_tokens": shared,
                              "max_tokens": MAX_TOKENS}) + "\n")
        for n in phases:
            phase(corpus, n, log)
        stop.set()
        sampler.join(timeout=15)
        log.write(json.dumps({"gpu_samples": samples}) + "\n")


if __name__ == "__main__":
    main()
