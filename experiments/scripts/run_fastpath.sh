#!/usr/bin/env bash
# Time-ordered vs account keys, HEAD vs UPSTREAM, 2048MB memtable (no flush
# during the load), preload, WAL off, bucket height 12, one process at a time
# under perf stat. Shows where InlineSkipList helps: only when inserts search.
# The web dashboard uses the same cores (2-13): do not run both at once.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
work=${WORK:-/tmp/otb_work}/fastpath
rounds=${ROUNDS:-2}
mkdir -p "$work"
for r in $(seq 1 "$rounds"); do
  for kf in symb_tid symb_acct_tid; do
    if (( r % 2 )); then order="HEAD UPSTREAM"; else order="UPSTREAM HEAD"; fi
    for m in $order; do
      taskset -c 2-5 perf stat -x, -o "$work/perf.csv" \
        -e cpu_core/cycles/u,cpu_core/instructions/u,cpu_core/L1-dcache-load-misses/u \
        "$bin" --memtable="$m" --limit=10000000 --write_buffer_size=2048MB \
        --key_format="$kf" --consumers=1 --preload --disable_wal --hash_height=12 \
        --progress_ms=0 --db="$work/db" > "$work/out.txt" 2>&1
      counters=$(grep -v '^#' "$work/perf.csv" | grep . | awk -F, '{split($3,e,"/"); printf "%s=%s ", e[2], $1}')
      echo "round=$r $counters$(grep '^RESULT' "$work/out.txt" | sed 's/^RESULT //')"
      rm -rf "$work/db"
    done
  done
done
