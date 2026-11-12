#!/usr/bin/env bash
# Builds the bench programs against a RocksDB checkout's Release shared lib.
#   ROCKSDB_ROOT  checkout with build-rel/librocksdb.so (default: ~/rocksdb)
set -euo pipefail

root="${ROCKSDB_ROOT:-$HOME/rocksdb}"
here="$(cd "$(dirname "$0")" && pwd)"
lib="$root/build-rel"

if [[ ! -f "$lib/librocksdb.so" ]]; then
  echo "missing $lib/librocksdb.so; build it with:" >&2
  echo "  cd $lib && make -j3 rocksdb-shared" >&2
  exit 1
fi

mkdir -p "$here/out"
g++ -O2 -std=c++20 -DNDEBUG -I"$root/include" "$here/mem_bench.cc" \
  -o "$here/out/mem_bench" -L"$lib" -lrocksdb -Wl,-rpath,"$lib" -lpthread
echo "built $here/out/mem_bench against $lib"
