#!/usr/bin/env bash
# Apply ONE serving-config experiment variant to granite4-rtx on the GPU host, then wait for health.
# Run ON the GPU host (gremlin-1) with sudo:
#     sudo bash granite-serving-experiment.sh <A|B|C|D|E|K|I>
# Revert at any time (also happens automatically on reboot or nixos-rebuild, since the drop-in lives in /run):
#     sudo bash granite-serving-experiment.sh A
#
# Original (verified live 2026-11-09): G4_KV8=4 G4_DRAFT_KV=4 GRANITE4_EAGLE_K=4 GRANITE4_SESSIONS=3
#   GRANITE4_MAX_CONTEXT=65536 GRANITE4_KV_POOL_TOKENS=122880 (EAGLE head r12).
#
#   A  declared config   remove the drop-in (= whatever /etc/nixos declares; K5:V4 since generation 793, int4 before)
#   I  int4 A/B          G4_KV8=4, pool 122880 on the CURRENT engine (same binary, only the KV format differs)
#   B  force re-prefill  G4_FORCE_REPREFILL=1 (removes resumed-session rounding; docs/phases.md)
#   C  int8 KV           G4_KV8=1, 2 sessions x 16384, pool 32768, bf16 draft KV
#   D  bf16 KV           G4_KV8=0, 2 sessions x 8192,  pool 16384, bf16 draft KV
#   K  K5:V4 KV (engine from a staging build)  G4_KV8=5, pool K5_POOL (default 109568); needs K5_ENGINE=<store path>/bin/granite4-infer
#   E  int8 KV, 64K slots  G4_KV8=1 G4_DRAFT_KV=8, 3 sessions x 65536, pool 65536 (docs: ~64K int8 positions fit; NOT yet run)
#
# The service restarts (parity gate + model load, several minutes): requests fail while it is down.
set -euo pipefail

variant="${1:-}"
unit="granite4-rtx.service"
dir="/run/systemd/system/${unit}.d"
file="${dir}/10-experiment.conf"
url="${GRANITE_HEALTH_URL:-http://127.0.0.1:2701/health}"

if [[ $EUID -ne 0 ]]; then echo "run with sudo" >&2; exit 1; fi

case "$variant" in
A) rm -f "$file"; rmdir "$dir" 2>/dev/null || true ;;
B) mkdir -p "$dir"; printf '[Service]\nEnvironment=G4_FORCE_REPREFILL=1\n' >"$file" ;;
C) mkdir -p "$dir"; printf '[Service]\nEnvironment=G4_KV8=1 G4_DRAFT_KV=16 GRANITE4_SESSIONS=2 GRANITE4_MAX_CONTEXT=16384 GRANITE4_KV_POOL_TOKENS=32768\n' >"$file" ;;
D) mkdir -p "$dir"; printf '[Service]\nEnvironment=G4_KV8=0 G4_DRAFT_KV=16 GRANITE4_SESSIONS=2 GRANITE4_MAX_CONTEXT=8192 GRANITE4_KV_POOL_TOKENS=16384\n' >"$file" ;;
E) mkdir -p "$dir"; printf '[Service]\nEnvironment=G4_KV8=1 G4_DRAFT_KV=8 GRANITE4_KV_POOL_TOKENS=65536\n' >"$file" ;;
K)
	: "${K5_ENGINE:?set K5_ENGINE=/nix/store/...-granite4-engine-cuda-.../bin/granite4-infer}"
	[[ -x "$K5_ENGINE" ]] || { echo "K5_ENGINE is not executable: $K5_ENGINE" >&2; exit 2; }
	rm -f "$file"; systemctl daemon-reload   # read the PRISTINE unit below
	rm_line=$(systemctl cat "$unit" | grep -m1 '^ExecStartPre=/.*rm -f')
	gate_line=$(systemctl cat "$unit" | grep -m1 '^ExecStartPre=-' | sed "s|--engine [^ ]*|--engine ${K5_ENGINE}|")
	[[ -n "$rm_line" && -n "$gate_line" ]] || { echo "could not read the unit's ExecStartPre lines" >&2; exit 2; }
	mkdir -p "$dir"
	printf '[Service]\nEnvironment=G4_KV8=5 GRANITE4_KV_POOL_TOKENS=%s\nExecStartPre=\n%s\n%s\n' "${K5_POOL:-109568}" "$rm_line" "$gate_line" >"$file" ;;
I) mkdir -p "$dir"; printf '[Service]\nEnvironment=G4_KV8=4 GRANITE4_KV_POOL_TOKENS=122880\n' >"$file" ;;
*) echo "usage: sudo bash $0 <A|B|C|D|E|K|I>" >&2; exit 2 ;;
esac

systemctl daemon-reload
systemctl restart "$unit"

echo "waiting for $url (up to 15 min: parity gate + load)..."
for _ in $(seq 1 180); do
	if curl -fsS -m 3 "$url" 2>/dev/null | grep -q '"inference":"available"'; then
		echo "variant $variant is healthy:"
		systemctl show "$unit" -p Environment --no-pager | tr ' ' '\n' | grep -E '^(Environment=)?(G4_|GRANITE4_(SESSIONS|MAX_CONTEXT|KV_POOL|EAGLE_K))' || true
		exit 0
	fi
	sleep 5
done
echo "variant $variant did NOT become healthy; check: journalctl -u $unit -n 80. Revert with: sudo bash $0 A" >&2
exit 1
