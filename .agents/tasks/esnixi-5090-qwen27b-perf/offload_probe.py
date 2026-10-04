#!/usr/bin/env python3
"""CPU KV-offload efficacy probe (plan step 6a), reusing bench.py's corpus and request.

A fixed-nonce 50K prompt A is sent cold, then again (GPU prefix hit), then 8
unique 50K prompts at c=4 evict it from the GPU pool, then A is sent a third
time. A CPU-tier hit shows up as a rise in vllm:external_prefix_cache_hits_total
and a short TTFT on the third send.
"""
import json
import threading
import urllib.request

import bench

KEYS = ("vllm:prefix_cache_queries_total", "vllm:prefix_cache_hits_total",
        "vllm:external_prefix_cache_queries_total", "vllm:external_prefix_cache_hits_total",
        "vllm:num_preemptions_total")


def counters():
    with urllib.request.urlopen(bench.BASE + "/metrics", timeout=10) as r:
        out = {}
        for line in r.read().decode().splitlines():
            for key in KEYS:
                if line.startswith(key + "{"):
                    out[key.removeprefix("vllm:")] = float(line.rsplit(" ", 1)[1])
        return out


class FixedNonce:
    hex = "offload-probe-fixed-prefix-a"


def send_a(corpus, label):
    real = bench.uuid.uuid4
    bench.uuid.uuid4 = lambda: FixedNonce
    try:
        return send(corpus, label)
    finally:
        bench.uuid.uuid4 = real


def send(corpus, label):
    bench.wait_idle()
    c0 = counters()
    res = bench.one_request(corpus, label, [])
    c1 = counters()
    res["counter_delta"] = {k: c1.get(k, 0) - c0.get(k, 0) for k in c1}
    print(json.dumps(res), flush=True)
    return res


def evict(corpus):
    bench.wait_idle()
    c0 = counters()
    for _ in range(2):
        threads = [threading.Thread(target=bench.one_request, args=(corpus, "evict", []))
                   for _ in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
    c1 = counters()
    print(json.dumps({"label": "evict-8x50k",
                      "counter_delta": {k: c1.get(k, 0) - c0.get(k, 0) for k in c1}}), flush=True)


def main():
    corpus, ntok = bench.build_corpus()
    print(json.dumps({"corpus_tokens": ntok}), flush=True)
    send_a(corpus, "A1-cold")
    send_a(corpus, "A2-gpu-hit")
    evict(corpus)
    send_a(corpus, "A3-after-evict")


if __name__ == "__main__":
    main()
