#!/usr/bin/env bash
# Bucket skiplist height 4 vs 12 for HEAD/UPSTREAM (SKIPLIST is always 12),
# with the three memtables running side by side like the web dashboard.
# Account keys, preload, WAL off, 10M KVs; a 2048MB memtable holds all of
# them, a 64MB one flushes about every 350K.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
work=${WORK:-/tmp/otb_work}/height
rounds=${ROUNDS:-2}

run() {  # write_buffer_size height round
  local i=0 pids=()
  for m in HEAD UPSTREAM SKIPLIST; do
    local c=$((2 + 4 * i))
    taskset -c "$c-$((c + 3))" "$bin" --memtable="$m" --limit=10000000 \
      --write_buffer_size="$1" --key_format=symb_acct_tid --consumers=1 --preload \
      --disable_wal --flush_at_end --hash_height="$2" --progress_ms=0 \
      --db="$work/$m" > "$work/$m.out" 2>&1 &
    pids+=($!)
    i=$((i + 1))
  done
  wait "${pids[@]}"
  for m in HEAD UPSTREAM SKIPLIST; do
    echo "wbs=$1 height=$2 round=$3 $(grep '^RESULT' "$work/$m.out" | sed 's/^RESULT //')"
  done
  rm -rf "$work/HEAD" "$work/UPSTREAM" "$work/SKIPLIST"
}

mkdir -p "$work"
for r in $(seq 1 "$rounds"); do
  for wbs in 2048MB 64MB; do
    # Alternate which height goes first each round.
    if (( r % 2 )); then heights="4 12"; else heights="12 4"; fi
    for h in $heights; do run "$wbs" "$h" "$r"; done
  done
done
