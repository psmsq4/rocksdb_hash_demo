#!/usr/bin/env bash
# Write scaling with N writer threads, preloaded KVs, no flush, WAL off.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
db=${WORK:-/tmp/otb_work}/mt_db
limit=${LIMIT:-2000000}
rounds=${ROUNDS:-5}
mems=(HEAD UPSTREAM SKIPLIST)

for r in $(seq 1 "$rounds"); do
  for c in 1 2 4 8; do
    n=${#mems[@]}
    for i in $(seq 0 $((n - 1))); do
      mem=${mems[$(( (i + r + c) % n ))]}
      out=$(taskset -c 2-13 "$bin" --memtable="$mem" --consumers="$c" --preload \
        --limit="$limit" --write_buffer_size=512MB --disable_wal --progress_ms=0 \
        --db="$db" 2>&1 | grep "^RESULT")
      rm -rf "$db"
      echo "round=$r ${out#RESULT }"
    done
  done
done
