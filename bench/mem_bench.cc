// Usage: mem_bench <hash|skiplist> <num_keys> <keys_per_prefix> <value_size>
//                  <db_path> [skiplist_height]
// Inserts num_keys 16-byte keys in random order without flushing, then prints
// the memtable size, the RSS growth caused by creating and positioning one
// total-order iterator, and the insert time.
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <random>
#include <string>
#include <vector>

#include "rocksdb/db.h"
#include "rocksdb/memtablerep.h"
#include "rocksdb/options.h"
#include "rocksdb/slice_transform.h"

using namespace ROCKSDB_NAMESPACE;

static long RssKB() {
  std::ifstream f("/proc/self/statm");
  long size, resident;
  f >> size >> resident;
  return resident * (sysconf(_SC_PAGESIZE) / 1024);
}

int main(int argc, char** argv) {
  if (argc != 6 && argc != 7) {
    fprintf(stderr,
            "usage: %s <hash|skiplist> num_keys keys_per_prefix value_size "
            "db_path [skiplist_height]\n",
            argv[0]);
    return 1;
  }
  std::string rep = argv[1];
  long n = atol(argv[2]);
  long kpp = atol(argv[3]);
  int vsz = atoi(argv[4]);
  std::string path = argv[5];
  int height = argc == 7 ? atoi(argv[6]) : 4;

  Options options;
  options.create_if_missing = true;
  options.write_buffer_size = 4L << 30;  // never flush
  options.arena_block_size = 64 << 10;   // fine-grained arena accounting
  options.max_write_buffer_number = 4;
  options.allow_concurrent_memtable_write = false;
  options.prefix_extractor.reset(NewFixedPrefixTransform(8));
  if (rep == "hash") {
    options.memtable_factory.reset(NewHashSkipListRepFactory(1000000, height));
  }
  DestroyDB(path, options);
  std::unique_ptr<DB> db;
  Status s = DB::Open(options, path, &db);
  if (!s.ok()) {
    fprintf(stderr, "%s\n", s.ToString().c_str());
    return 1;
  }

  std::vector<long> ids(n);
  for (long i = 0; i < n; i++) ids[i] = i;
  std::shuffle(ids.begin(), ids.end(), std::mt19937_64(42));
  std::string value(vsz, 'v');
  WriteOptions wo;
  wo.disableWAL = true;
  char key[32];
  auto t0 = std::chrono::steady_clock::now();
  for (long i : ids) {
    snprintf(key, sizeof(key), "%08ld%08ld", i / kpp, i % kpp);
    s = db->Put(wo, Slice(key, 16), value);
    if (!s.ok()) {
      fprintf(stderr, "%s\n", s.ToString().c_str());
      return 1;
    }
  }
  double insert_s = std::chrono::duration<double>(
                        std::chrono::steady_clock::now() - t0)
                        .count();

  uint64_t mem = 0;
  db->GetIntProperty("rocksdb.cur-size-active-mem-table", &mem);

  long rss0 = RssKB();
  ReadOptions ro;
  ro.total_order_seek = true;
  std::unique_ptr<Iterator> it(db->NewIterator(ro));
  it->SeekToFirst();
  long rss1 = RssKB();
  long cnt = 0;
  for (; it->Valid(); it->Next()) cnt++;
  it.reset();

  std::string label = rep == "hash" ? "hash height=" + std::to_string(height)
                                    : rep;
  printf("%s n=%ld kpp=%ld vsz=%d memtable_bytes=%llu "
         "bytes_per_entry=%.1f iter_rss_kb=%ld scanned=%ld insert_s=%.3f\n",
         label.c_str(), n, kpp, vsz, (unsigned long long)mem,
         double(mem) / n, rss1 - rss0, cnt, insert_s);
  db.reset();
  DestroyDB(path, options);
  return cnt == n ? 0 : 2;
}
