#!/usr/bin/env bash
# Builds op_trade_bench against a RocksDB checkout's Release shared lib.
#   ROCKSDB_ROOT  checkout with build-rel/librocksdb.so (default: ~/rocksdb)
#
# upstream_hash_skiplist_rep.cc uses RocksDB internal headers, so this uses the
# same platform defines as the library build. The library is built with
# -fno-rtti, so classes derived from its types must be too.
set -euo pipefail

root="${ROCKSDB_ROOT:-$HOME/rocksdb}"
here="$(cd "$(dirname "$0")" && pwd)"
lib="$root/build-rel"

if [[ ! -f "$lib/librocksdb.so" ]]; then
  echo "missing $lib/librocksdb.so; build it with:" >&2
  echo "  cd $lib && make -j3 rocksdb-shared" >&2
  exit 1
fi

defines=(-DOS_LINUX -DROCKSDB_PLATFORM_POSIX -DROCKSDB_LIB_IO_POSIX
         -DROCKSDB_FALLOCATE_PRESENT -DROCKSDB_MALLOC_USABLE_SIZE
         -DROCKSDB_PTHREAD_ADAPTIVE_MUTEX -DROCKSDB_RANGESYNC_PRESENT
         -DROCKSDB_SCHED_GETCPU_PRESENT -DROCKSDB_AUXV_GETAUXVAL_PRESENT
         -DROCKSDB_IOURING_PRESENT)
flags=(-std=gnu++20 -O3 -DNDEBUG -march=native -fno-rtti -pthread
       -W -Wall -Wextra -Wno-unused-parameter)

mkdir -p "$here/out"
g++ "${flags[@]}" "${defines[@]}" -I"$root" -I"$root/include" \
  "$here/op_trade_bench.cc" "$here/upstream_hash_skiplist_rep.cc" \
  -o "$here/out/op_trade_bench" -L"$lib" -lrocksdb -Wl,-rpath,"$lib"
echo "built $here/out/op_trade_bench against $lib"
