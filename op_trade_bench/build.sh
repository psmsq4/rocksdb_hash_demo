#!/usr/bin/env bash
# Builds op_trade_bench against a RocksDB checkout's Release shared lib.
#   ROCKSDB_ROOT  checkout with build-rel/librocksdb.so (default: the rocksdb
#                 submodule of this repository)
#
# upstream_hash_skiplist_rep.cc uses RocksDB internal headers, so this uses the
# same platform defines as the library build. The library is built with
# -fno-rtti, so classes derived from its types must be too.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="${ROCKSDB_ROOT:-$(cd "$here/../rocksdb" && pwd)}"
lib="$root/build-rel"

if [[ ! -f "$lib/librocksdb.so" ]]; then
  echo "missing $lib/librocksdb.so; build it with:" >&2
  echo "  git submodule update --init   # if $root is empty" >&2
  echo "  mkdir -p $lib && cd $lib" >&2
  echo "  cmake .. -DCMAKE_BUILD_TYPE=Release -DWITH_TESTS=OFF -DWITH_BENCHMARK_TOOLS=OFF \\" >&2
  echo "    -DWITH_TOOLS=OFF -DWITH_CORE_TOOLS=OFF -DWITH_GFLAGS=OFF -DFAIL_ON_WARNINGS=OFF -DROCKSDB_BUILD_SHARED=ON" >&2
  echo "  make -j8 rocksdb-shared" >&2
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
