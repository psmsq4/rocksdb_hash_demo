#!/usr/bin/env bash
# Time-ordered vs shuffled input, single-key writes, N writers.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
db=${WORK:-/tmp/otb_work}/sh_db
rounds=${ROUNDS:-3}
configs=("head_c1:HEAD:1" "head_c0:HEAD:0" "upstream:UPSTREAM:0" "skiplist_c1:SKIPLIST:1")

for r in $(seq 1 "$rounds"); do
  for order in ordered shuffled; do
    extra=()
    [[ $order == shuffled ]] && extra=(--shuffle)
    for t in 1 4 8; do
      n=${#configs[@]}
      for i in $(seq 0 $((n - 1))); do
        IFS=: read -r name mem conc <<< "${configs[$(( (i + r + t) % n ))]}"
        out=$(taskset -c 2-13 "$bin" --memtable="$mem" --concurrent="$conc" \
          --consumers="$t" --preload "${extra[@]}" --limit=2000000 \
          --write_buffer_size=512MB --disable_wal --progress_ms=0 --db="$db" 2>&1 |
          grep "^RESULT")
        rm -rf "$db"
        echo "order=$order config=$name ${out#RESULT }"
      done
    done
  done
done
