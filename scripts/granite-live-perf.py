#!/usr/bin/env python3
"""Live performance probe for the Granite service (stdlib only).

Every request starts with a unique nonce, so the service's prefix/session reuse never serves a
prompt from cache unless a section says so on purpose. Sections:
  prefill      prompt-processing speed vs context length (max_tokens=1)
  decode       single-stream decode speed (long minus short generation, same prompt length)
  concurrency  1..4 simultaneous clients (the service has 3 slots; the 4th must wait)
  resume       the same prompt twice (prefix/session reuse on purpose)

Usage: granite-live-perf.py --base http://host:2701/v1 --out result.json [--sections prefill,decode,...]
"""
from __future__ import annotations

import argparse
import json
import random
import statistics
import threading
import time
import urllib.error
import urllib.request


def post(base: str, body: dict, timeout: float = 1800.0) -> tuple[dict, float]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{base}/chat/completions", data, {"content-type": "application/json"})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read()[:300]!r}") from None
    return payload, time.perf_counter() - started


def make_prompt(target_tokens: int, nonce: str) -> str:
    """Log-style filler (~0.29 tokens/char on this tokenizer), unique per call."""
    rng = random.Random(nonce)
    lines, chars = [], 0
    target_chars = int(target_tokens / 0.294)
    i = 0
    while chars < target_chars:
        line = f"Agent log {i}: module {rng.randint(100, 999)} reported load {rng.randint(1, 99)} percent."
        if i == 0:
            line = f"[run {nonce}] " + line  # unique first line => no shared prefix with any other request
        lines.append(line)
        chars += len(line) + 1
        i += 1
    return "\n".join(lines)


def chat(base: str, model: str, text: str, max_tokens: int, question: str) -> dict:
    payload, dt = post(
        base,
        {
            "model": model,
            "stream": False,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": "Follow the instruction exactly."},
                {"role": "user", "content": f"{text}\n\n{question}"},
            ],
        },
    )
    usage = payload["usage"]
    return {
        "seconds": dt,
        "prompt_tokens": usage["prompt_tokens"],
        "completion_tokens": usage["completion_tokens"],
        "finish": payload["choices"][0]["finish_reason"],
    }


def pct(values: list[float], p: float) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(p * (len(s) - 1)))))]


def prefill(base: str, model: str) -> list[dict]:
    rows = []
    for target in (1000, 3000, 8000, 16000, 32000, 55000):
        reps = 3 if target <= 8000 else 1
        secs, toks = [], 0
        for r in range(reps):
            res = chat(base, model, make_prompt(target, f"pf{target}-{r}-{time.time_ns()}"), 1, "Reply with the single word OK.")
            secs.append(res["seconds"])
            toks = res["prompt_tokens"]
        med = statistics.median(secs)
        rows.append({"prompt_tokens": toks, "seconds_median": round(med, 2), "prefill_tok_s": round(toks / med), "runs": reps})
        print(f"  prefill {toks:6d} tok: {med:7.2f}s -> {toks / med:7.0f} tok/s", flush=True)
    return rows


def decode(base: str, model: str) -> list[dict]:
    rows = []
    for ctx in (500, 8000):
        rates, longs = [], []
        for r in range(4):
            nonce = f"dc{ctx}-{r}-{time.time_ns()}"
            text = make_prompt(ctx, nonce)
            short = chat(base, model, text, 1, "Count upward from 1, one number per line, forever.")
            nonce2 = f"dc{ctx}-{r}-L-{time.time_ns()}"
            text2 = make_prompt(ctx, nonce2)
            long = chat(base, model, text2, 400, "Count upward from 1, one number per line, forever.")
            extra_tok = long["completion_tokens"] - short["completion_tokens"]
            extra_s = long["seconds"] - short["seconds"]
            if extra_tok > 50 and extra_s > 0:
                rates.append(extra_tok / extra_s)
                longs.append(long["completion_tokens"])
        if rates:
            row = {"context_tokens": short["prompt_tokens"], "decode_tok_s_median": round(statistics.median(rates), 1), "min": round(min(rates), 1), "max": round(max(rates), 1), "samples": len(rates), "avg_completion_tokens": round(statistics.mean(longs))}
            rows.append(row)
            print(f"  decode @ctx {row['context_tokens']}: median {row['decode_tok_s_median']} tok/s (min {row['min']}, max {row['max']})", flush=True)
    return rows


def concurrency(base: str, model: str) -> list[dict]:
    rows = []
    for n in (1, 2, 3, 4):
        walls, per_req, agg = [], [], []
        for rep in range(3):
            results: list[dict] = [{}] * n
            def worker(i: int) -> None:
                results[i] = chat(base, model, make_prompt(1000, f"cc{n}-{rep}-{i}-{time.time_ns()}"), 200, "Count upward from 1, one number per line, forever.")
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
            t0 = time.perf_counter()
            for t in threads: t.start()
            for t in threads: t.join()
            wall = time.perf_counter() - t0
            walls.append(wall)
            per_req += [r["seconds"] for r in results]
            agg.append(sum(r["completion_tokens"] for r in results) / wall)
        row = {"clients": n, "wall_s_median": round(statistics.median(walls), 2), "latency_p50_s": round(pct(per_req, 0.5), 2), "latency_max_s": round(max(per_req), 2), "aggregate_out_tok_s_median": round(statistics.median(agg), 1)}
        rows.append(row)
        print(f"  {n} client(s): wall {row['wall_s_median']}s, latency p50 {row['latency_p50_s']}s max {row['latency_max_s']}s, aggregate {row['aggregate_out_tok_s_median']} out-tok/s", flush=True)
    return rows


def resume(base: str, model: str) -> list[dict]:
    """Prefix/session reuse. Requests must FINISH naturally (finish_reason "stop"): a generation cut off at
    max_tokens=1 is not resumable, which an earlier version of this probe mistook for "no reuse"."""
    rows = []
    for target in (3000, 16000, 55000):
        text = make_prompt(target, f"rs{target}-{time.time_ns()}")
        first = chat(base, model, text, 40, "Reply with the single word OK.")
        same = chat(base, model, text, 40, "Reply with the single word OK.")
        new_q = chat(base, model, text, 40, "Now reply with the single word DONE.")
        rows.append({"prompt_tokens": first["prompt_tokens"], "first_s": round(first["seconds"], 2), "identical_repeat_s": round(same["seconds"], 2), "same_prefix_new_question_s": round(new_q["seconds"], 2), "speedup_x": round(first["seconds"] / max(new_q["seconds"], 1e-3), 1), "first_finish": first["finish"]})
        print(f"  resume {first['prompt_tokens']} tok: first {first['seconds']:.2f}s ({first['finish']}), identical repeat {same['seconds']:.2f}s, same prefix + new question {new_q['seconds']:.2f}s", flush=True)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--model", default="granite-4.2-8b")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sections", default="prefill,decode,concurrency,resume")
    args = ap.parse_args()
    fns = {"prefill": prefill, "decode": decode, "concurrency": concurrency, "resume": resume}
    out = {"started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "base": args.base}
    for name in args.sections.split(","):
        print(f"[{name}]", flush=True)
        out[name] = fns[name](args.base, args.model)
        json.dump(out, open(args.out, "w"), indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
