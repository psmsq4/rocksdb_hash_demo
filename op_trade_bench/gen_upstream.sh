#!/usr/bin/env bash
# Regenerates upstream_hash_skiplist_rep.cc from a RocksDB checkout.
#   ROCKSDB_ROOT    checkout that contains the upstream commit (default: the
#                   rocksdb submodule of this repository)
#   UPSTREAM_COMMIT commit to copy from (default: e591f5f1a)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="${ROCKSDB_ROOT:-$(cd "$here/../rocksdb" && pwd)}"
commit="${UPSTREAM_COMMIT:-e591f5f1a}"

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
