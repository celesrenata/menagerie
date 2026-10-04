#!/usr/bin/env python3
"""Print SSE chunk arrival times to see whether the backend streams incrementally."""
import json
import sys
import time
import urllib.request

with_tools = sys.argv[1] == "tools"
payload = {
    "model": "qwen3.8-27b-nvfp4", "stream": True, "max_tokens": 64, "min_tokens": 64,
    "chat_template_kwargs": {"enable_thinking": False},
    "messages": [{"role": "user", "content": "Write a Python function that parses a CSV line."}],
}
if with_tools:
    payload["tools"] = [{"type": "function", "function": {
        "name": "run", "description": "Run a command",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}}]
    payload["tool_choice"] = sys.argv[2] if len(sys.argv) > 2 else "none"
req = urllib.request.Request("http://127.0.0.1:8010/v1/chat/completions",
                             data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json"})
t0 = time.time()
n = 0
with urllib.request.urlopen(req, timeout=300) as r:
    for raw in r:
        line = raw.decode().strip()
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        ev = json.loads(line[6:])
        for ch in ev.get("choices", []):
            d = {k: v for k, v in ch.get("delta", {}).items() if v}
            if d and (n < 3 or n % 20 == 0):
                print(f"{time.time() - t0:7.3f}s chunk{n} keys={list(d)}")
            n += 1
print(f"total {time.time() - t0:.3f}s chunks={n}")
