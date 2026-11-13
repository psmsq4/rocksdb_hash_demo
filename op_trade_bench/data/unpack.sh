#!/usr/bin/env bash
# Restores op_trade_bench/Trade.txt (TPC-E EGen v1.14.0, 5,000 customers,
# scale factor 500, 300 initial trade days; 28,664,881 rows, 3.2GB) from the
# zstd-compressed parts kept in git, and checks its sha256.
#
# The parts were made with:
#   zstd -19 -T16 -c Trade.txt | split -b 90M -d -a 2 - data/Trade.txt.zst.part-
# (GitHub rejects files over 100MB, so the compressed file is split.)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../Trade.txt"

if [[ -f "$out" ]] && (cd "$here/.." && sha256sum -c --status "$here/Trade.txt.sha256"); then
  echo "$out is already in place"
  exit 0
fi
command -v zstd >/dev/null || { echo "zstd is required (e.g. dnf/apt install zstd)" >&2; exit 1; }
cat "$here"/Trade.txt.zst.part-* | zstd -d -q -o "$out.tmp" -f
mv "$out.tmp" "$out"
(cd "$here/.." && sha256sum -c "$here/Trade.txt.sha256")
echo "restored $out"
