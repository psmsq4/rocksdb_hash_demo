#!/usr/bin/env bash
# Times one explicit flush of a memtable holding LIMIT trades.
set -uo pipefail
bin=$HOME/rocksdb-demo/op_trade_bench/out/op_trade_bench
lib=${WORK:-/tmp/otb_work}/libs/head_memo
rounds=${ROUNDS:-7}
configs=(UPSTREAM HEAD SKIPLIST)

for limit in 400000 3000000; do
  for r in $(seq 1 "$rounds"); do
    n=${#configs[@]}
    for i in $(seq 0 $((n - 1))); do
      mem=${configs[$(( (i + r - 1) % n ))]}
      db=${WORK:-/tmp/otb_work}/flush_db
      out=$(LD_LIBRARY_PATH="$lib" taskset -c 2-5 "$bin" --memtable="$mem" \
        --limit="$limit" --write_buffer_size=4GB --disable_wal --flush_at_end \
        --progress_ms=0 --db="$db" 2>&1 | grep "^RESULT")
      rm -rf "$db"
      echo "round=$r ${out#RESULT }"
    done
  done
done
