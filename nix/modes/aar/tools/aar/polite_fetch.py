#!/usr/bin/env python3
"""Polite, read-only page fetcher for AA&R (stdlib only).

Usage:
  python3 tools/aar/polite_fetch.py URL [--max-chars 20000] [--raw]

Rules enforced in code (not just in prompts):
  - http/https clearnet only; .onion/.i2p and non-web schemes are refused
  - robots.txt is checked for our user agent; disallowed URLs are refused
  - at least AAR_HOST_DELAY_S seconds (default 2) between requests to the same host,
    tracked across processes in $AAR_DIR/cache/fetch_state.json
  - honest User-Agent; GET only; no cookies, no forms, no logins
  - responses are cached by URL in $AAR_DIR/cache/pages/ and logged to logs/fetch_log.jsonl
Output: JSON {url, final_url, status, fetched_at, title, text, cached, refused_reason}
"""
import argparse, hashlib, html.parser, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request, urllib.robotparser
from datetime import datetime, timezone

AAR_DIR = os.environ.get("AAR_DIR", "aar_pilot")
SHARD = os.environ.get("AAR_SHARD", "main")
UA = os.environ.get("AAR_USER_AGENT", "AAR-Discovery/0.2 (read-only research; respects robots.txt)")
HOST_DELAY = float(os.environ.get("AAR_HOST_DELAY_S", "2"))
MAX_BYTES = 3_000_000
_robots = {}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _log(obj):
    p = os.path.join(AAR_DIR, "logs", f"fetch_log.{SHARD}.jsonl")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


class _Text(html.parser.HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self):
        super().__init__(); self.parts = []; self.title = ""; self._skip = 0; self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP: self._skip += 1
        if tag == "title": self._in_title = True
        if tag in ("p", "br", "li", "h1", "h2", "h3", "h4", "tr", "div", "section"): self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip: self._skip -= 1
        if tag == "title": self._in_title = False

    def handle_data(self, data):
        if self._in_title: self.title += data
        elif not self._skip: self.parts.append(data)


def _refuse(url):
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https"):
        return "non-web scheme"
    host = (u.hostname or "").lower()
    if not host or host.endswith(".onion") or host.endswith(".i2p"):
        return "non-clearnet host"
    if re.search(r"/(login|signin|sign-in|checkout|cart|account|oauth)(/|$|\?)", u.path.lower()):
        return "login/checkout path"
    return None


def _robots_ok(url):
    u = urllib.parse.urlparse(url)
    base = f"{u.scheme}://{u.netloc}"
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                rp.parse(r.read(200_000).decode("utf-8", "replace").splitlines())
        except urllib.error.HTTPError as e:
            rp.parse([] if e.code in (404, 410) else ["User-agent: *", "Disallow: /"])
        except Exception:
            rp.parse([])  # unreachable robots.txt: treat as allow, page fetch will surface errors
        _robots[base] = rp
    return _robots[base].can_fetch(UA, url)


def _wait_for_host(host):
    p = os.path.join(AAR_DIR, "cache", "fetch_state.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    try:
        state = json.load(open(p))
    except Exception:
        state = {}
    gap = time.time() - state.get(host, 0)
    if gap < HOST_DELAY:
        time.sleep(HOST_DELAY - gap)
    state[host] = time.time()
    tmp = p + ".tmp"; json.dump(state, open(tmp, "w")); os.replace(tmp, p)


def fetch(url, max_chars=20000, raw=False):
    key = hashlib.sha256(url.encode()).hexdigest()[:20]
    cpath = os.path.join(AAR_DIR, "cache", "pages", key + ".json")
    if os.path.exists(cpath):
        d = json.load(open(cpath, encoding="utf-8")); d["cached"] = True
        d["text"] = d.get("text", "")[:max_chars]
        return d
    out = {"url": url, "final_url": None, "status": None, "fetched_at": _now(), "title": "", "text": "",
           "cached": False, "refused_reason": None}
    reason = _refuse(url) or (None if _robots_ok(url) else "disallowed by robots.txt")
    if reason:
        out["refused_reason"] = reason
        _log({k: out[k] for k in ("fetched_at", "url", "refused_reason")})
        return out
    _wait_for_host(urllib.parse.urlparse(url).netloc)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json;q=0.9,*/*;q=0.5"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            out["status"], out["final_url"] = r.status, r.geturl()
            ctype = r.headers.get("content-type", "")
            body = r.read(MAX_BYTES).decode(r.headers.get_content_charset() or "utf-8", "replace")
    except urllib.error.HTTPError as e:
        out["status"] = e.code; body = ""; ctype = ""
    except Exception as e:
        out["refused_reason"] = f"network error: {e}"[:200]; body = ""; ctype = ""
    if body:
        if raw or "json" in ctype:
            out["text"] = body
        else:
            p = _Text(); p.feed(body)
            out["title"] = p.title.strip()
            out["text"] = re.sub(r"\n\s*\n+", "\n", re.sub(r"[ \t]+", " ", "".join(p.parts))).strip()
    _log({"fetched_at": out["fetched_at"], "url": url, "status": out["status"], "chars": len(out["text"]),
          "refused_reason": out["refused_reason"]})
    if out["status"] == 200:
        os.makedirs(os.path.dirname(cpath), exist_ok=True)
        json.dump(out, open(cpath, "w", encoding="utf-8"), ensure_ascii=False)
    out["text"] = out["text"][:max_chars]
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("url"); ap.add_argument("--max-chars", type=int, default=20000)
    ap.add_argument("--raw", action="store_true"); a = ap.parse_args()
    print(json.dumps(fetch(a.url, a.max_chars, a.raw), ensure_ascii=False, indent=1))
