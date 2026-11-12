#!/usr/bin/env bash
# Compares the memo build with the single-prefix build: flush time and writes.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
libs=${WORK:-/tmp/otb_work}/libs
db=${WORK:-/tmp/otb_work}/single_db

run() {  # name lib memtable extra-args...
  local name=$1 lib=$2 mem=$3
  shift 3
  local out
  out=$(LD_LIBRARY_PATH="$libs/$lib" taskset -c 2-5 "$bin" --memtable="$mem" \
    --disable_wal --progress_ms=0 --db="$db" "$@" 2>&1 | grep "^RESULT")
  rm -rf "$db"
  echo "config=$name ${out#RESULT }"
}

flush_configs=("upstream:head_single:UPSTREAM" "memo:head_memo:HEAD"
               "single:head_single:HEAD" "skiplist:head_single:SKIPLIST")
for limit in 400000 3000000; do
  for r in $(seq 1 7); do
    n=${#flush_configs[@]}
    for i in $(seq 0 $((n - 1))); do
      IFS=: read -r name lib mem <<< "${flush_configs[$(( (i + r - 1) % n ))]}"
      echo -n "phase=flush round=$r "
      run "$name" "$lib" "$mem" --limit="$limit" --write_buffer_size=4GB --flush_at_end
    done
  done
done

write_configs=("upstream:head_single:UPSTREAM" "memo:head_memo:HEAD"
               "single:head_single:HEAD")
for r in $(seq 1 5); do
  n=${#write_configs[@]}
  for i in $(seq 0 $((n - 1))); do
    IFS=: read -r name lib mem <<< "${write_configs[$(( (i + r - 1) % n ))]}"
    echo -n "phase=write round=$r "
    run "$name" "$lib" "$mem" --limit=1500000 --write_buffer_size=512MB
  done
done
