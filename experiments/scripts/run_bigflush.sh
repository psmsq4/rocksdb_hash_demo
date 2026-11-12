#!/usr/bin/env bash
# Time one explicit flush of a ~87% full memtable, account key format.
set -uo pipefail
bin=$HOME/rocksdb-demo/op_trade_bench/out/op_trade_bench
db=${WORK:-/tmp/otb_work}/bf_db
rounds=${ROUNDS:-5}
mems=(HEAD UPSTREAM SKIPLIST)

for spec in 512MB:2800000 1024MB:5600000; do
  wbs=${spec%%:*}
  limit=${spec#*:}
  for r in $(seq 1 "$rounds"); do
    n=${#mems[@]}
    for i in $(seq 0 $((n - 1))); do
      mem=${mems[$(( (i + r) % n ))]}
      out=$(taskset -c 2-13 "$bin" --memtable="$mem" --key_format=symb_acct_tid \
        --disable_wal --write_buffer_size="$wbs" --limit="$limit" --flush_at_end \
        --progress_ms=0 --db="$db" 2>&1 | grep "^RESULT")
      rm -rf "$db"
      echo "round=$r ${out#RESULT }"
    done
  done
done
