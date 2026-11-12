#!/usr/bin/env bash
# Regenerates upstream_hash_skiplist_rep.cc from a RocksDB checkout.
#   ROCKSDB_ROOT    checkout that contains the upstream commit (default: ~/rocksdb/rocksdb_hash)
#   UPSTREAM_COMMIT commit to copy from (default: e591f5f1a)
set -euo pipefail

root="${ROCKSDB_ROOT:-$HOME/rocksdb/rocksdb_hash}"
commit="${UPSTREAM_COMMIT:-e591f5f1a}"
here="$(cd "$(dirname "$0")" && pwd)"

{
  cat <<EOF
// Upstream HashSkipListRep, copied verbatim from facebook/rocksdb commit
// ${commit} (memtable/hash_skiplist_rep.cc) so that one binary can compare it
// with the modified rep in the linked librocksdb. Only the exported factory
// function and the factory names are renamed to avoid clashing with the
// library's HashSkipListRepFactory. Regenerate with gen_upstream.sh.
//
EOF
  git -C "$root" show "$commit:memtable/hash_skiplist_rep.cc" |
    sed -e 's/MemTableRepFactory\* NewHashSkipListRepFactory(/MemTableRepFactory* NewUpstreamHashSkipListRepFactory(/' \
        -e 's/return "HashSkipListRepFactory";/return "UpstreamHashSkipListRepFactory";/' \
        -e 's/return "prefix_hash";/return "upstream_prefix_hash";/'
} > "$here/upstream_hash_skiplist_rep.cc"
echo "wrote $here/upstream_hash_skiplist_rep.cc from $commit"
