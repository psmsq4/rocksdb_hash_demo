#!/usr/bin/env bash
# Times memtable inserts per step: 512MB memtable, no flush, WAL off.
set -uo pipefail
bin=$HOME/rocksdb-demo/op_trade_bench/out/op_trade_bench
libs=${WORK:-/tmp/otb_work}/libs
limit=${LIMIT:-1500000}
rounds=${ROUNDS:-3}

# name:libdir:memtable
configs=(
  "upstream:head:UPSTREAM"
  "head:head:HEAD"
  "head_memo:head_memo:HEAD"
  "head_noprefix:head_noprefix:HEAD"
  "skiplist:head:SKIPLIST"
)

for r in $(seq 1 "$rounds"); do
  # Rotate the order each round so drift does not favour one config.
  n=${#configs[@]}
  for i in $(seq 0 $((n - 1))); do
    IFS=: read -r name lib mem <<< "${configs[$(( (i + r - 1) % n ))]}"
    db=${WORK:-/tmp/otb_work}/iso_db
    out=$(LD_LIBRARY_PATH="$libs/$lib" "$bin" --memtable="$mem" --limit="$limit" \
      --write_buffer_size=512MB --disable_wal --progress_ms=0 --db="$db" 2>&1 |
      grep "^RESULT")
    rm -rf "$db"
    echo "round=$r config=$name ${out#RESULT }"
  done
done
