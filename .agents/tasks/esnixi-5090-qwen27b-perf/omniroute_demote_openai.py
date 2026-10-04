#!/usr/bin/env python3
"""Keep direct OpenAI (pay-as-you-go) out of the default fallback tiers.

Edits the live pool/tier{2..5}/* combos through the OmniRoute management API:
  tier 2: openai/gpt-5.6-luna      -> bedrock/global.openai.gpt-5.6-luna (same model via Bedrock)
  tier 3: openai/gpt-5.6-terra     -> dropped; its weight moves to bedrock/global.openai.gpt-5.6-terra
  tier 4: openai/gpt-5.6-sol       -> bedrock/global.anthropic.claude-opus-5-5
  tier 5: bedrock/us.anthropic.claude-opus-5 -> bedrock/global.anthropic.claude-opus-5-5,
          reweighted toward Opus 5.5; direct openai terra and sol stay as low-weight routes.
Dry run by default. --apply writes, then reads each combo back and checks it.
Reads the key from OMNIROUTE_API_KEY and never prints it.
"""
import argparse
import copy
import json
import os
import subprocess
import sys

BASE = "https://omniroute.celestium.life"
BEDROCK = ("bedrock", "d4a9a6e4-d054-498a-8fde-aa35dc4dc506")
FIELDS = ("name", "description", "strategy", "models", "config", "context_length",
          "context_cache_protection")
OPUS55 = "bedrock/global.anthropic.claude-opus-5-5"
TIER5_WEIGHTS = {OPUS55: 40, "bedrock/global.openai.gpt-5.6-sol": 25, "xai/grok-4.6": 15,
                 "openai/gpt-5.6-terra": 10, "openai/gpt-5.6-sol": 10}


def request(path, data=None):
    cmd = ["curl", "--fail-with-body", "-sS", "--max-time", "45", "-X", "PUT" if data else "GET",
           "-H", "Content-Type: application/json",
           "-H", "Authorization: Bearer " + os.environ["OMNIROUTE_API_KEY"], BASE + path]
    if data is not None:
        cmd += ["--data-binary", "@-"]
    out = subprocess.run(cmd, input=json.dumps(data).encode() if data else None,
                         capture_output=True)
    if out.returncode:
        raise RuntimeError(f"{path}: {(out.stdout + out.stderr).decode(errors='replace')[:800]}")
    return json.loads(out.stdout)


def live_combos():
    combos, offset = {}, 0
    while True:
        page = request(f"/api/combos?limit=100&offset={offset}")
        combos.update({c["name"]: c for c in page["combos"]})
        offset += len(page["combos"])
        if not page["combos"] or offset >= page.get("total", offset):
            return combos


def to_bedrock(entry, model):
    entry = dict(entry, model=model, providerId=BEDROCK[0], connectionId=BEDROCK[1])
    return entry


def transform(tier, models):
    models = copy.deepcopy(models)
    by_model = {m.get("model"): m for m in models if m.get("kind") == "model"}
    if tier == 2 and "openai/gpt-5.6-luna" in by_model:
        models = [to_bedrock(m, "bedrock/global.openai.gpt-5.6-luna")
                  if m.get("model") == "openai/gpt-5.6-luna" else m for m in models]
    elif tier == 3 and "openai/gpt-5.6-terra" in by_model:
        moved = by_model["openai/gpt-5.6-terra"].get("weight", 0)
        models = [m for m in models if m.get("model") != "openai/gpt-5.6-terra"]
        for m in models:
            if m.get("model") == "bedrock/global.openai.gpt-5.6-terra":
                m["weight"] = m.get("weight", 0) + moved
    elif tier == 4 and "openai/gpt-5.6-sol" in by_model:
        models = [to_bedrock(m, OPUS55) if m.get("model") == "openai/gpt-5.6-sol" else m
                  for m in models]
    elif tier == 5 and "bedrock/us.anthropic.claude-opus-5" in by_model:
        models = [to_bedrock(m, OPUS55) if m.get("model") == "bedrock/us.anthropic.claude-opus-5"
                  else m for m in models]
        present = {m.get("model") for m in models}
        if "openai/gpt-5.6-sol" not in present:
            prefix = models[0]["id"].rsplit("-", 1)[0]
            models.append({"id": prefix + "-osol", "kind": "model", "model": "openai/gpt-5.6-sol",
                           "providerId": "openai", "weight": 0})
        for m in models:
            if m.get("model") in TIER5_WEIGHTS:
                m["weight"] = TIER5_WEIGHTS[m["model"]]
    return models


def summary(models):
    return [f"{m.get('model')}:{m.get('weight')}" for m in models]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    combos = live_combos()
    plan = []
    for name, combo in sorted(combos.items()):
        parts = name.split("/")
        if len(parts) != 3 or parts[0] != "pool" or not parts[1].startswith("tier"):
            continue
        tier = int(parts[1][4:])
        new = transform(tier, combo["models"])
        if new != combo["models"]:
            plan.append((combo, new))
            print(f"{name}\n  - {summary(combo['models'])}\n  + {summary(new)}")
    print(f"{len(plan)} combos to change")
    if not args.apply:
        return
    failed = 0
    for combo, new in plan:
        body = {k: copy.deepcopy(combo[k]) for k in FIELDS if k in combo}
        body["models"] = new
        request("/api/combos/" + combo["id"], body)
        back = request("/api/combos/" + combo["id"])
        back = back.get("combo", back)
        ok = summary(back["models"]) == summary(new)
        failed += not ok
        print(("OK   " if ok else "DIFF ") + combo["name"])
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
