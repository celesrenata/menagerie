#!/usr/bin/env python3
"""OmniRoute client for AA&R (stdlib only).

Usage:
  python3 tools/aar/omniroute.py health
  python3 tools/aar/omniroute.py search "query text" [--provider duckduckgo-free] [--max 10] [--lane github]
  python3 tools/aar/omniroute.py chat --role extract --prompt-file in.txt [--max-tokens 2048]

Environment:
  OMNIROUTE_BASE_URL  default https://omniroute.celestium.life/v1
  OMNIROUTE_API_KEY   required (never printed or logged)
  AAR_DIR             default aar_pilot

Every search is appended to $AAR_DIR/logs/search_log.$AAR_SHARD.jsonl and cached in
$AAR_DIR/cache/search/ so the same query is never sent twice.
"""
import argparse, hashlib, json, os, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

BASE = os.environ.get("OMNIROUTE_BASE_URL", "https://omniroute.celestium.life/v1").rstrip("/")
AAR_DIR = os.environ.get("AAR_DIR", "aar_pilot")
SHARD = os.environ.get("AAR_SHARD", "main")  # one log shard per parallel worker

# Role -> ordered route list (primary first). Verified 2026-10-04; re-check with `health`.
ROLES = {
    "plan":    ["hybrid/planner", "pool/tier1/planner", "hybrid/research"],
    "research":["hybrid/research", "pool/tier1/research", "hybrid/long"],
    "extract": ["hybrid/reader", "hybrid/tiny"],
    "qualify": ["hybrid/reviewer", "pool/tier1/planner", "hybrid/frontier"],
    "report":  ["hybrid/frontier", "hybrid/research"],
}
SEARCH_PROVIDERS = ["duckduckgo-free", "context7"]
MIN_SEARCH_GAP_S = 4.0
_last_search = [0.0]


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _key():
    k = os.environ.get("OMNIROUTE_API_KEY", "").strip()
    if not k:
        sys.exit("OMNIROUTE_API_KEY is not set")
    return k


def _req(method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method, headers={
        "Authorization": "Bearer " + _key(), "Content-Type": "application/json",
        "User-Agent": "AAR-Discovery/0.2"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {"error": {"message": str(e)}}
    except Exception as e:  # network error
        return 0, {"error": {"message": str(e)}}


def _append(rel, obj):
    p = os.path.join(AAR_DIR, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def chat(role, messages, max_tokens=2048, temperature=0.2, json_mode=False):
    """Try each route for the role; one retry per route on 429/5xx; returns (text, route, model)."""
    routes = ROLES[role]
    last = None
    for route in routes:
        for attempt in range(2):
            body = {"model": route, "messages": messages, "max_tokens": max(max_tokens, 512),
                    "temperature": temperature}
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            t0 = time.time()
            code, d = _req("POST", "/chat/completions", body, timeout=300)
            ok = code == 200 and d.get("choices")
            text = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") if ok else None
            _append(f"logs/model_log.{SHARD}.jsonl", {"ts": _now(), "role": role, "route": route, "status": code,
                     "model": d.get("model"), "latency_s": round(time.time() - t0, 2),
                     "usage": d.get("usage"), "error": (d.get("error") or {}).get("message", "")[:200]})
            if ok and text:
                return text, route, d.get("model")
            last = (d.get("error") or {}).get("message") or "empty response"
            if code in (429, 500, 502, 503, 504, 0) and attempt == 0:
                time.sleep(5)
                continue
            break
    raise RuntimeError(f"all routes failed for role {role}: {last}")


def search(query, provider="duckduckgo-free", max_results=10, lane=""):
    qhash = hashlib.sha256(f"{provider}|{query}".encode()).hexdigest()[:16]
    cache = os.path.join(AAR_DIR, "cache", "search", qhash + ".json")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            return json.load(f), True
    gap = time.time() - _last_search[0]
    if gap < MIN_SEARCH_GAP_S:
        time.sleep(MIN_SEARCH_GAP_S - gap)
    for attempt in range(3):
        _last_search[0] = time.time()
        code, d = _req("POST", "/search", {"query": query, "provider": provider, "max_results": max_results}, timeout=60)
        if code == 200 and "results" in d:
            break
        if code == 429 or "throttl" in json.dumps(d).lower():
            time.sleep(60)
            continue
        if attempt < 2:
            time.sleep(5)
    results = [{"title": r.get("title"), "url": r.get("url"), "snippet": r.get("snippet"),
                "published_at": r.get("published_at")} for r in (d.get("results") or [])]
    out = {"query": query, "provider": provider, "lane": lane, "status": code, "retrieved_at": _now(),
           "results": results, "error": (d.get("error") or {}).get("message", "")[:200]}
    _append(f"logs/search_log.{SHARD}.jsonl", {k: out[k] for k in ("retrieved_at", "lane", "provider", "query", "status", "error")} | {"n_results": len(results), "hash": qhash})
    if code == 200:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    return out, False


def health():
    root = BASE[:-3] if BASE.endswith("/v1") else BASE
    try:
        with urllib.request.urlopen(root + "/api/health", timeout=20) as r:
            gw = json.loads(r.read() or b"{}").get("status")
    except Exception as e:
        gw = f"unreachable: {e}"
    code_m, m = _req("GET", "/models", timeout=60)
    ids = {x.get("id") for x in (m.get("data") or [])}
    report = {"ts": _now(), "base": BASE, "gateway": gw, "models_status": code_m, "model_count": len(ids), "roles": {}}
    for role, routes in ROLES.items():
        report["roles"][role] = [{"route": r, "listed": r in ids} for r in routes]
    for p in SEARCH_PROVIDERS:
        code_s, d = _req("POST", "/search", {"query": "github seeking new maintainer", "provider": p, "max_results": 2}, timeout=60)
        report.setdefault("search", {})[p] = {"status": code_s, "n": len(d.get("results") or []),
                                                 "error": (d.get("error") or {}).get("message", "")[:120]}
    for role in ROLES:
        try:
            _, route, model = chat(role, [{"role": "user", "content": "Reply with exactly: OK"}], max_tokens=512)
            report["roles"][role].append({"smoke": "ok", "route": route, "model": model})
        except Exception as e:
            report["roles"][role].append({"smoke": "fail", "error": str(e)[:200]})
    return report


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("health")
    s = sub.add_parser("search"); s.add_argument("query"); s.add_argument("--provider", default="duckduckgo-free")
    s.add_argument("--max", type=int, default=10); s.add_argument("--lane", default="")
    c = sub.add_parser("chat"); c.add_argument("--role", choices=ROLES, required=True)
    c.add_argument("--prompt-file", required=True); c.add_argument("--system", default="")
    c.add_argument("--max-tokens", type=int, default=2048); c.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if a.cmd == "health":
        print(json.dumps(health(), indent=1))
    elif a.cmd == "search":
        out, cached = search(a.query, a.provider, a.max, a.lane)
        out["cached"] = cached
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        msgs = ([{"role": "system", "content": a.system}] if a.system else []) + \
               [{"role": "user", "content": open(a.prompt_file, encoding="utf-8").read()}]
        text, route, model = chat(a.role, msgs, a.max_tokens, json_mode=a.json)
        print(json.dumps({"route": route, "model": model, "text": text}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
