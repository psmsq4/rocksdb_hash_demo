#!/usr/bin/env bash
# One writer, default write_buffer_size, both key formats.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
db=${WORK:-/tmp/otb_work}/st_db
rounds=${ROUNDS:-5}
mems=(HEAD UPSTREAM SKIPLIST)

for mode in queue_wal preload_nowal; do
  extra=()
  [[ $mode == preload_nowal ]] && extra=(--preload --disable_wal)
  for r in $(seq 1 "$rounds"); do
    for fmt in symb_tid symb_acct_tid; do
      n=${#mems[@]}
      for i in $(seq 0 $((n - 1))); do
        mem=${mems[$(( (i + r) % n ))]}
        out=$(taskset -c 2-13 "$bin" --memtable="$mem" --key_format="$fmt" \
          "${extra[@]}" --limit=2000000 --progress_ms=0 --db="$db" 2>&1 |
          grep "^RESULT")
        rm -rf "$db"
        echo "mode=$mode ${out#RESULT }"
      done
    done
  done
done
