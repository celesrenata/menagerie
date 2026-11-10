#!/usr/bin/env python3
"""KV-cache quantization simulator for Granite 4.2 8B (MEN-GRANITE-SDD-001 serving study).

Answers "how much accuracy does an N-bit KV cache cost?" without writing a CUDA kernel.
It runs the bf16 reference model with K and V fake-quantized exactly as the serving engine
stores them (engine/src/kernel_math.h): symmetric, ONE scale per 128-element row
(per token, per KV head), scale = amax / qmax, code = clamp(round(x / scale), -qmax, qmax),
qmax = 2^(bits-1) - 1 (int4: 7, int5: 15, int8: 127). K is quantized AFTER RoPE (that is what the
cache holds); every position the attention reads is quantized, as in decode.

For each prompt it teacher-forces a real completion and compares each setting to the bf16
reference on the completion positions: mean KL(ref || quant) and the top-1 flip rate.
Lower is better; 16 means unquantized. K and V bit-widths are independent.

Usage (venv from the serving repo has torch + transformers):
  granite-4-rtx-4070-ti-super/.gt/gt-venv/bin/python kv_quant_sim.py \\
      --data /tmp/kvsim/data.json --serving-repo <path> --ckpt <path> --out /tmp/kvsim/result.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import torch

QUANT_STATE = {"k_bits": 16, "v_bits": 16}


def fake_quant_rows(x: torch.Tensor, bits: int) -> torch.Tensor:
    """Quantize-dequantize along the last dim (one scale per row of 128). bits >= 16 is a no-op."""
    if bits >= 16:
        return x
    qmax = float(2 ** (bits - 1) - 1)
    xf = x.float()
    amax = xf.abs().amax(dim=-1, keepdim=True)
    scale = amax / qmax
    safe = torch.where(scale == 0, torch.ones_like(scale), scale)
    # round half away from zero, as the device kernels do (torch.round is half-to-even)
    r = xf / safe
    q = torch.sign(r) * torch.floor(r.abs() + 0.5)
    q = q.clamp(-qmax, qmax)
    out = torch.where(scale == 0, torch.zeros_like(xf), q * scale)
    return out.to(x.dtype)


def install_hooks(model):
    import transformers.models.granite.modeling_granite as mg

    original_rope = mg.apply_rotary_pos_emb

    def rope_then_quant(q, k, cos, sin, *args, **kwargs):
        q_embed, k_embed = original_rope(q, k, cos, sin, *args, **kwargs)
        return q_embed, fake_quant_rows(k_embed, QUANT_STATE["k_bits"])  # [b, kv_heads, t, 128]

    mg.apply_rotary_pos_emb = rope_then_quant

    head_dim = model.config.hidden_size // model.config.num_attention_heads

    def v_hook(_module, _inputs, output):
        b, t, _ = output.shape
        rows = output.view(b, t, -1, head_dim)  # per (token, kv head) rows of 128
        return fake_quant_rows(rows, QUANT_STATE["v_bits"]).view(b, t, -1)

    for layer in model.model.layers:
        layer.self_attn.v_proj.register_forward_hook(v_hook)


@torch.no_grad()
def completion_logprobs(model, ids: torch.Tensor, start: int) -> torch.Tensor:
    logits = model(ids, use_cache=False).logits[0, start - 1 : ids.shape[1] - 1].float()
    return torch.log_softmax(logits, dim=-1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--serving-repo", required=True)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--configs", default="8:8,6:6,5:5,4:4,8:4,4:8,5:4,4:5,6:4,4:6")
    args = ap.parse_args()

    sys.path.insert(0, f"{args.serving_repo}/frontend")
    import chat_template as ct
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(args.ckpt)
    model = AutoModelForCausalLM.from_pretrained(args.ckpt, dtype=torch.bfloat16).to(device).eval()
    install_hooks(model)

    configs = [tuple(int(b) for b in c.split(":")) for c in args.configs.split(",")]
    data = json.load(open(args.data))
    if args.limit:
        data = data[: args.limit]

    acc = {c: {"kl": 0.0, "flips": 0, "n": 0, "ref_margin_lt_1": 0, "flips_lowmargin": 0} for c in configs}
    started = time.time()
    for idx, item in enumerate(data):
        prompt = ct.render(item["messages"])
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
        c_ids = tok(item["completion"], add_special_tokens=False)["input_ids"]
        if not c_ids:
            continue
        ids = torch.tensor([p_ids + c_ids], device=device)
        start = len(p_ids)

        QUANT_STATE.update(k_bits=16, v_bits=16)
        ref = completion_logprobs(model, ids, start)
        ref_top2 = ref.topk(2, dim=-1).values
        ref_arg = ref.argmax(-1)
        low_margin = (ref_top2[:, 0] - ref_top2[:, 1]) < 1.0  # a near-tie in the reference

        for cfg in configs:
            QUANT_STATE.update(k_bits=cfg[0], v_bits=cfg[1])
            q = completion_logprobs(model, ids, start)
            kl = (ref.exp() * (ref - q)).sum(-1)
            flip = q.argmax(-1) != ref_arg
            a = acc[cfg]
            a["kl"] += kl.sum().item()
            a["flips"] += int(flip.sum().item())
            a["n"] += int(flip.numel())
            a["ref_margin_lt_1"] += int(low_margin.sum().item())
            a["flips_lowmargin"] += int((flip & low_margin).sum().item())
        QUANT_STATE.update(k_bits=16, v_bits=16)
        print(f"[{idx + 1}/{len(data)}] {item['id']} prompt={len(p_ids)} completion={len(c_ids)} t={time.time() - started:.0f}s", flush=True)

    result = []
    for cfg, a in acc.items():
        n = max(1, a["n"])
        result.append(
            {
                "k_bits": cfg[0],
                "v_bits": cfg[1],
                "positions": a["n"],
                "mean_kl": a["kl"] / n,
                "top1_flip_rate": a["flips"] / n,
                "flip_rate_on_near_ties": a["flips_lowmargin"] / max(1, a["ref_margin_lt_1"]),
                "flip_rate_on_confident": (a["flips"] - a["flips_lowmargin"]) / max(1, a["n"] - a["ref_margin_lt_1"]),
            }
        )
    json.dump(result, open(args.out, "w"), indent=1)
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
