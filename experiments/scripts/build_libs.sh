#!/usr/bin/env bash
# Builds a Release librocksdb.so for each step of the hash_skiplist_improvements
# branch into $WORK/libs/<name>/librocksdb.so.11, so that op_trade_bench can
# load any of them with LD_LIBRARY_PATH (its RUNPATH is overridden).
#
#   ROCKSDB_ROOT  checkout with the branch (default: the rocksdb submodule)
#   WORK          scratch directory (default: /tmp/otb_work)
#   JOBS          make -j (default: 3; more needs RAM, about 1GB per job)
#
# Names: step1 91549bab9, step2 4f8df92bc, head 42ac47a08 (before the memo),
# head_noprefix (head without AddPrefix, timing only: iterators and flush are
# wrong), head_memo 1888cce21, head_single (head_memo plus the reverted
# single-prefix variant in ../variants).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="${ROCKSDB_ROOT:-$(cd "$here/../../rocksdb" && pwd)}"
work="${WORK:-/tmp/otb_work}"
jobs="${JOBS:-3}"
wt="$work/wt"
libs="$work/libs"

if [[ ! -d "$wt" ]]; then
  git -C "$root" worktree add --detach "$wt" 91549bab9
fi
mkdir -p "$wt/build-rel" "$libs"
if [[ ! -f "$wt/build-rel/Makefile" ]]; then
  (cd "$wt/build-rel" && cmake .. -DCMAKE_BUILD_TYPE=Release -DWITH_TESTS=OFF \
    -DWITH_BENCHMARK_TOOLS=OFF -DWITH_TOOLS=OFF -DWITH_CORE_TOOLS=OFF \
    -DWITH_GFLAGS=OFF -DFAIL_ON_WARNINGS=OFF -DROCKSDB_BUILD_SHARED=ON >/dev/null)
fi

build_and_copy() {
  local name=$1
  (cd "$wt/build-rel" && make -j"$jobs" rocksdb-shared > "make_$name.log" 2>&1)
  mkdir -p "$libs/$name"
  cp -L "$wt/build-rel/librocksdb.so.11" "$libs/$name/librocksdb.so.11"
  echo "$name done $(date +%T)"
}

checkout() {
  git -C "$wt" checkout -q -- memtable/hash_skiplist_rep.cc 2>/dev/null || true
  git -C "$wt" checkout -q "$1"
}

checkout 91549bab9
build_and_copy step1

checkout 4f8df92bc
build_and_copy step2

checkout 42ac47a08
build_and_copy head

sed -i 's|^  AddPrefix(transformed, /\*concurrently=\*/false);|  // AddPrefix removed for measurement|' \
  "$wt/memtable/hash_skiplist_rep.cc"
grep -q "AddPrefix removed for measurement" "$wt/memtable/hash_skiplist_rep.cc"
build_and_copy head_noprefix

checkout 1888cce21
build_and_copy head_memo

cp "$here/../variants/hash_skiplist_rep_single_prefix.cc" "$wt/memtable/hash_skiplist_rep.cc"
build_and_copy head_single
checkout 1888cce21
