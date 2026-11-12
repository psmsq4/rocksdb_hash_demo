#!/usr/bin/env bash
# Point lookups (DB::Get) after the load, one memtable at a time: hit,
# miss inside a written symbol, and symbols never written. Bucket height 12
# unless noted. The web dashboard uses the same cores (2-13): do not run both.
set -uo pipefail
bin=${OTB_BIN:-"$(cd "$(dirname "$0")/../.." && pwd)/op_trade_bench/out/op_trade_bench"}
work=${WORK:-/tmp/otb_work}/get
mkdir -p "$work"
for cfg in "2000000 512MB symb_tid 12" "2000000 512MB symb_acct_tid 12" \
           "10000000 2048MB symb_tid 12" "10000000 2048MB symb_acct_tid 12" \
           "10000000 2048MB symb_acct_tid 4"; do
  set -- $cfg
  for m in HEAD UPSTREAM SKIPLIST; do
    out=$(taskset -c 2-5 "$bin" --memtable="$m" --limit="$1" --write_buffer_size="$2" \
      --key_format="$3" --hash_height="$4" --preload --disable_wal --get_seconds=3 \
      --progress_ms=0 --db="$work/db" 2>&1 | grep '^RESULT')
    rm -rf "$work/db"
    echo "kv=$1 wbs=$2 key=$3 height=$4 ${out#RESULT }"
  done
done
