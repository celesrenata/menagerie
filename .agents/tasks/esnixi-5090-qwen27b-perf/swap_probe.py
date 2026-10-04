#!/usr/bin/env python3
"""Measure 5090 coder <-> reader swaps through the OmniRoute gateway.

Each request is sent the moment the previous one finishes, so a request's TTFT
is the gap from "end of one generation" to "first token from the other model".
Reads the inference key from OMNIROUTE_API_KEY (never printed).
"""
import json
import os
import ssl
import sys
import time
import urllib.request

URL = "https://omniroute.celestium.life/v1/chat/completions"
# Certificates are still verified; only Python 3.13's extra strict-X.509 check is
# relaxed, because the gateway's CA lacks a critical Basic Constraints flag.
TLS = ssl.create_default_context()
TLS.verify_flags &= ~ssl.VERIFY_X509_STRICT
MODELS = {"C": "vllm/qwen3.8-27b-nvfp4", "R": "vllm/qwen3.5-9b-nvfp4-reader"}


def run(model):
    payload = {
        "model": model, "stream": True, "max_tokens": 64,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "user", "content": "Write one sentence about GPUs."}],
    }
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + os.environ["OMNIROUTE_API_KEY"]})
    t0 = time.time()
    first, served, chunks, err, status = None, None, 0, None, None
    try:
        with urllib.request.urlopen(req, timeout=600, context=TLS) as r:
            status = r.status
            for raw in r:
                line = raw.decode(errors="replace").strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                ev = json.loads(line[6:])
                served = ev.get("model", served)
                for ch in ev.get("choices", []):
                    d = ch.get("delta", {})
                    if d.get("content") or d.get("reasoning_content") or d.get("reasoning"):
                        chunks += 1
                        first = first or time.time()
    except urllib.error.HTTPError as e:
        status, err = e.code, e.read()[:200].decode(errors="replace")
    except Exception as e:  # record, keep going
        err = repr(e)[:200]
    t1 = time.time()
    return {"model": model, "served": served, "status": status, "start": round(t0, 3),
            "ttft_s": round(first - t0, 3) if first else None, "total_s": round(t1 - t0, 3),
            "chunks": chunks, "error": err}


def main():
    for step in sys.argv[1]:
        print(json.dumps({"step": step, **run(MODELS[step])}), flush=True)


if __name__ == "__main__":
    main()
