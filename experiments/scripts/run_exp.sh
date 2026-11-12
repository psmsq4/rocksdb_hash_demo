#!/usr/bin/env bash
# Experiment 1: concurrent memtable writes on/off with single-key writes.
# Experiment 2: WriteBatch sizes with N writers.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
db=${WORK:-/tmp/otb_work}/exp_db
rounds=${ROUNDS:-3}

run() {  # exp name memtable concurrent threads batch
  local out
  out=$(taskset -c 2-13 "$bin" --memtable="$3" --concurrent="$4" --consumers="$5" \
    --batch="$6" --preload --limit=2000000 --write_buffer_size=512MB --disable_wal \
    --progress_ms=0 --db="$db" 2>&1 | grep "^RESULT")
  rm -rf "$db"
  echo "exp=$1 config=$2 ${out#RESULT }"
}

exp1=("head_c1:HEAD:1" "head_c0:HEAD:0" "upstream:UPSTREAM:0"
      "skiplist_c1:SKIPLIST:1" "skiplist_c0:SKIPLIST:0")
for r in $(seq 1 "$rounds"); do
  for t in 1 4 8; do
    n=${#exp1[@]}
    for i in $(seq 0 $((n - 1))); do
      IFS=: read -r name mem conc <<< "${exp1[$(( (i + r + t) % n ))]}"
      run 1 "$name" "$mem" "$conc" "$t" 1
    done
  done
done

exp2=("head_c1:HEAD:1" "head_c0:HEAD:0" "upstream:UPSTREAM:0"
      "skiplist_c1:SKIPLIST:1")
for r in $(seq 1 "$rounds"); do
  for b in 16 64 256; do
    for t in 1 4 8; do
      n=${#exp2[@]}
      for i in $(seq 0 $((n - 1))); do
        IFS=: read -r name mem conc <<< "${exp2[$(( (i + r + t + b) % n ))]}"
        run 2 "$name" "$mem" "$conc" "$t" "$b"
      done
    done
  done
done
