// op_trade_bench: replays TPC-E Trade.txt rows as RocksDB writes through a
// producer/consumer queue and reports elapsed time, throughput and latency for
// the selected memtable.
//
//   op_trade_bench --memtable=HEAD|UPSTREAM|SKIPLIST [--limit=N]
//                  [--input=Trade.txt] [--db=path] [--queue=N]
//                  [--write_buffer_size=BYTES] [--disable_wal] [--flush_at_end]
//                  [--consumers=N] [--preload] [--batch=N] [--concurrent=0|1]
//                  [--shuffle] [--key_format=symb_tid|symb_acct_tid]
//                  [--progress_ms=N]
//
// Key:   "trade_<t_s_symb>|<t_id>", or with --key_format=symb_acct_tid
//        "trade_<t_s_symb>|<t_ca_id>|<t_id>" (plus "#<pass>" once the file
//        wraps)
// Value: the remaining 14 columns of the row, '|'-separated
// Prefix extractor: everything up to and including the first '|'.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <random>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "rocksdb/db.h"
#include "rocksdb/memtablerep.h"
#include "rocksdb/options.h"
#include "rocksdb/slice_transform.h"
#include "rocksdb/statistics.h"
#include "rocksdb/write_batch.h"

namespace ROCKSDB_NAMESPACE {
// Defined in upstream_hash_skiplist_rep.cc.
MemTableRepFactory* NewUpstreamHashSkipListRepFactory(
    size_t bucket_count, int32_t skiplist_height,
    int32_t skiplist_branching_factor);
}  // namespace ROCKSDB_NAMESPACE

using ROCKSDB_NAMESPACE::DB;
using ROCKSDB_NAMESPACE::HistogramData;
using ROCKSDB_NAMESPACE::Options;
using ROCKSDB_NAMESPACE::Slice;
using ROCKSDB_NAMESPACE::SliceTransform;
using ROCKSDB_NAMESPACE::Status;
using ROCKSDB_NAMESPACE::WriteBatch;
using ROCKSDB_NAMESPACE::WriteOptions;

namespace {

// $TPCE_DIR/flat_out/Trade.txt, with TPCE_DIR defaulting to $HOME/tpc-e.
std::string DefaultInput() {
  if (const char* dir = getenv("TPCE_DIR"); dir != nullptr && *dir != '\0') {
    return std::string(dir) + "/flat_out/Trade.txt";
  }
  const char* home = getenv("HOME");
  return std::string(home != nullptr ? home : ".") + "/tpc-e/flat_out/Trade.txt";
}
constexpr int kTradeColumns = 15;
constexpr int kTradeIdColumn = 0;
constexpr int kSymbolColumn = 5;
constexpr int kAccountColumn = 8;

uint64_t NowNanos() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

std::string WithCommas(uint64_t v) {
  std::string s = std::to_string(v);
  for (int i = static_cast<int>(s.size()) - 3; i > 0; i -= 3) {
    s.insert(static_cast<size_t>(i), ",");
  }
  return s;
}

// Variable-length prefix: everything up to and including the first
// delimiter. Including the delimiter keeps prefixes in the same bytewise
// order as their keys, which HashSkipListRep's total-order iterator needs.
class DelimiterPrefixTransform : public SliceTransform {
 public:
  explicit DelimiterPrefixTransform(char delimiter) : delimiter_(delimiter) {}

  const char* Name() const override { return "OpTradeBench.DelimiterPrefix"; }

  Slice Transform(const Slice& key) const override {
    const char* end = Find(key);
    return Slice(key.data(), static_cast<size_t>(end - key.data()) + 1);
  }

  bool InDomain(const Slice& key) const override {
    return Find(key) != nullptr;
  }

  // Appending to a prefix keeps its prefix only if its first delimiter is
  // its last byte.
  bool SameResultWhenAppended(const Slice& prefix) const override {
    const char* end = Find(prefix);
    return end != nullptr && end == prefix.data() + prefix.size() - 1;
  }

 private:
  const char* Find(const Slice& s) const {
    return static_cast<const char*>(memchr(s.data(), delimiter_, s.size()));
  }

  const char delimiter_;
};

struct TradeKV {
  std::string key;
  std::string value;
  uint64_t enqueued_ns = 0;
};

// Blocking FIFO with a fixed capacity, so a fast producer cannot buffer the
// whole input in memory.
template <class T>
class BoundedQueue {
 public:
  explicit BoundedQueue(size_t capacity) : capacity_(capacity) {}

  void Push(T item) {
    std::unique_lock<std::mutex> lock(mu_);
    not_full_.wait(lock, [&] { return items_.size() < capacity_; });
    items_.push_back(std::move(item));
    lock.unlock();
    not_empty_.notify_one();
  }

  // Returns false once the queue is closed and drained.
  bool Pop(T* out) {
    std::unique_lock<std::mutex> lock(mu_);
    not_empty_.wait(lock, [&] { return !items_.empty() || closed_; });
    if (items_.empty()) {
      return false;
    }
    *out = std::move(items_.front());
    items_.pop_front();
    lock.unlock();
    not_full_.notify_one();
    return true;
  }

  void Close() {
    {
      std::lock_guard<std::mutex> lock(mu_);
      closed_ = true;
    }
    not_empty_.notify_all();
  }

  size_t Size() {
    std::lock_guard<std::mutex> lock(mu_);
    return items_.size();
  }

 private:
  const size_t capacity_;
  std::mutex mu_;
  std::condition_variable not_empty_;
  std::condition_variable not_full_;
  std::deque<T> items_;
  bool closed_ = false;
};

// Log-linear latency histogram in nanoseconds: exact below 64 ns, then each
// power of two is split into 64 buckets (under 1.6% error).
class LatencyHistogram {
 public:
  void Add(uint64_t ns) {
    ++buckets_[Index(ns)];
    ++count_;
    sum_ += ns;
    max_ = std::max(max_, ns);
  }

  void Merge(const LatencyHistogram& other) {
    for (int i = 0; i < kBuckets; ++i) {
      buckets_[i] += other.buckets_[i];
    }
    count_ += other.count_;
    sum_ += other.sum_;
    max_ = std::max(max_, other.max_);
  }

  uint64_t count() const { return count_; }
  double AverageNanos() const {
    return count_ == 0 ? 0 : static_cast<double>(sum_) / count_;
  }
  uint64_t MaxNanos() const { return max_; }

  // Value at quantile q in [0, 1], reported as the middle of its bucket.
  uint64_t PercentileNanos(double q) const {
    if (count_ == 0) {
      return 0;
    }
    uint64_t rank = std::max<uint64_t>(1, static_cast<uint64_t>(q * count_ + 0.5));
    uint64_t seen = 0;
    for (int i = 0; i < kBuckets; ++i) {
      seen += buckets_[i];
      if (seen >= rank) {
        return std::min(max_, BucketMiddle(i));
      }
    }
    return max_;
  }

 private:
  static constexpr int kSubBits = 6;
  static constexpr int kSub = 1 << kSubBits;
  static constexpr int kBuckets = (64 - kSubBits + 1) * kSub;

  static int Index(uint64_t v) {
    if (v < kSub) {
      return static_cast<int>(v);
    }
    int msb = 63 - __builtin_clzll(v);
    int shift = msb - kSubBits;
    return (shift + 1) * kSub + static_cast<int>((v >> shift) & (kSub - 1));
  }

  static uint64_t BucketMiddle(int index) {
    if (index < kSub) {
      return static_cast<uint64_t>(index);
    }
    int shift = index / kSub - 1;
    uint64_t low = static_cast<uint64_t>(kSub + index % kSub) << shift;
    return low + ((uint64_t{1} << shift) >> 1);
  }

  uint64_t buckets_[kBuckets] = {};
  uint64_t count_ = 0;
  uint64_t sum_ = 0;
  uint64_t max_ = 0;
};

struct ProducerStats {
  uint64_t produced = 0;
  uint64_t rows_read = 0;
  uint64_t malformed = 0;
  uint64_t passes = 0;  // passes started over the file
  std::string error;
};

// Splits a '|'-separated line into exactly kTradeColumns fields.
bool SplitTrade(std::string_view line, std::string_view* fields) {
  int n = 0;
  size_t start = 0;
  while (true) {
    size_t end = line.find('|', start);
    if (n == kTradeColumns) {
      return false;
    }
    fields[n++] = line.substr(start, end == std::string_view::npos
                                         ? std::string_view::npos
                                         : end - start);
    if (end == std::string_view::npos) {
      break;
    }
    start = end + 1;
  }
  return n == kTradeColumns;
}

// Reads Trade.txt and passes exactly `limit` key-values to `sink`. When the
// file has fewer rows than `limit`, it starts over from the first row and
// keeps going; keys from later passes get a "#<pass>" suffix so they stay
// unique.
//
// Keys are "trade_<t_s_symb>|<t_id>", in time order within a symbol, or with
// with_account "trade_<t_s_symb>|<t_ca_id>|<t_id>", grouped by account within
// a symbol, so trades of a symbol do not arrive in key order.
template <class Sink>
ProducerStats ReadTrades(const std::string& path, uint64_t limit,
                         bool with_account, Sink&& sink) {
  ProducerStats stats;
  char* line = nullptr;
  size_t line_cap = 0;
  std::string_view fields[kTradeColumns];

  while (stats.produced < limit) {
    FILE* f = fopen(path.c_str(), "r");
    if (f == nullptr) {
      stats.error = "cannot open " + path + ": " + strerror(errno);
      break;
    }
    const uint64_t pass = stats.passes++;
    const uint64_t produced_before = stats.produced;
    ssize_t len;
    while (stats.produced < limit && (len = getline(&line, &line_cap, f)) > 0) {
      ++stats.rows_read;
      std::string_view row(line, static_cast<size_t>(len));
      while (!row.empty() && (row.back() == '\n' || row.back() == '\r')) {
        row.remove_suffix(1);
      }
      if (!SplitTrade(row, fields) || fields[kSymbolColumn].empty() ||
          (with_account && fields[kAccountColumn].empty())) {
        ++stats.malformed;
        continue;
      }

      TradeKV kv;
      kv.key.reserve(6 + fields[kSymbolColumn].size() + 1 +
                     fields[kAccountColumn].size() + 1 +
                     fields[kTradeIdColumn].size() + 8);
      kv.key.append("trade_").append(fields[kSymbolColumn]).push_back('|');
      if (with_account) {
        kv.key.append(fields[kAccountColumn]).push_back('|');
      }
      kv.key.append(fields[kTradeIdColumn]);
      if (pass > 0) {
        kv.key.push_back('#');
        kv.key.append(std::to_string(pass));
      }
      kv.value.reserve(row.size());
      for (int i = 0; i < kTradeColumns; ++i) {
        if (i == kSymbolColumn) {
          continue;
        }
        if (!kv.value.empty()) {
          kv.value.push_back('|');
        }
        kv.value.append(fields[i]);
      }
      sink(std::move(kv));
      ++stats.produced;
    }
    fclose(f);
    if (stats.produced == produced_before) {
      stats.error = "no valid trade rows in " + path;
      break;
    }
  }
  free(line);
  return stats;
}

// Producer: pushes `limit` trades into `queue`, then closes it.
ProducerStats produce_trade_transaction(const std::string& path,
                                        uint64_t limit, bool with_account,
                                        BoundedQueue<TradeKV>& queue) {
  ProducerStats stats = ReadTrades(path, limit, with_account, [&](TradeKV&& kv) {
    kv.enqueued_ns = NowNanos();
    queue.Push(std::move(kv));
  });
  queue.Close();
  return stats;
}

struct ConsumerStats {
  uint64_t consumed = 0;
  uint64_t failed = 0;
  std::string first_error;
  LatencyHistogram put_latency;
  LatencyHistogram end_to_end_latency;

  void Merge(const ConsumerStats& other) {
    consumed += other.consumed;
    failed += other.failed;
    if (first_error.empty()) {
      first_error = other.first_error;
    }
    put_latency.Merge(other.put_latency);
    end_to_end_latency.Merge(other.end_to_end_latency);
  }
};

// Writes one key-value, recording its latency. Returns the time it ended.
uint64_t PutTrade(DB* db, const WriteOptions& write_options, const TradeKV& kv,
                  std::atomic<uint64_t>& progress, ConsumerStats* stats) {
  uint64_t start = NowNanos();
  Status s = db->Put(write_options, kv.key, kv.value);
  uint64_t end = NowNanos();
  if (!s.ok()) {
    if (stats->failed++ == 0) {
      stats->first_error = s.ToString();
    }
    return end;
  }
  stats->put_latency.Add(end - start);
  ++stats->consumed;
  progress.fetch_add(1, std::memory_order_relaxed);
  return end;
}

// Pops key-values until the queue is closed and drained, writing each one.
void consume_trades(DB* db, const WriteOptions& write_options,
                    BoundedQueue<TradeKV>& queue,
                    std::atomic<uint64_t>& progress, ConsumerStats* stats) {
  TradeKV kv;
  while (queue.Pop(&kv)) {
    uint64_t failed = stats->failed;
    uint64_t end = PutTrade(db, write_options, kv, progress, stats);
    if (stats->failed == failed) {
      stats->end_to_end_latency.Add(end - kv.enqueued_ns);
    }
  }
}

// Writes kvs[begin, end) as one WriteBatch, recording the latency of the
// write.
void WriteTrades(DB* db, const WriteOptions& write_options,
                 const std::vector<TradeKV>& kvs, size_t begin, size_t end,
                 std::atomic<uint64_t>& progress, ConsumerStats* stats) {
  WriteBatch batch;
  for (size_t i = begin; i < end; ++i) {
    Status s = batch.Put(kvs[i].key, kvs[i].value);
    if (!s.ok()) {
      if (stats->failed++ == 0) {
        stats->first_error = s.ToString();
      }
      return;
    }
  }
  uint64_t start = NowNanos();
  Status s = db->Write(write_options, &batch);
  uint64_t elapsed = NowNanos() - start;
  if (!s.ok()) {
    stats->failed += end - begin;
    if (stats->first_error.empty()) {
      stats->first_error = s.ToString();
    }
    return;
  }
  stats->put_latency.Add(elapsed);
  stats->consumed += end - begin;
  progress.fetch_add(end - begin, std::memory_order_relaxed);
}

// Writes preloaded key-values, taking chunks of them until none are left.
// With batch > 1, each write is a WriteBatch of up to `batch` key-values.
void consume_preloaded(DB* db, const WriteOptions& write_options,
                       const std::vector<TradeKV>& kvs, size_t batch,
                       std::atomic<size_t>& next, std::atomic<uint64_t>& progress,
                       ConsumerStats* stats) {
  const size_t chunk = std::max<size_t>(256, batch);
  for (size_t begin = next.fetch_add(chunk); begin < kvs.size();
       begin = next.fetch_add(chunk)) {
    size_t end = std::min(kvs.size(), begin + chunk);
    if (batch <= 1) {
      for (size_t i = begin; i < end; ++i) {
        PutTrade(db, write_options, kvs[i], progress, stats);
      }
    } else {
      for (size_t i = begin; i < end; i += batch) {
        WriteTrades(db, write_options, kvs, i, std::min(end, i + batch),
                    progress, stats);
      }
    }
  }
}

struct Args {
  std::string memtable;
  uint64_t limit = 1000000;
  std::string input = DefaultInput();
  std::string db;
  size_t queue = 100000;
  bool disable_wal = false;
  bool flush_at_end = false;
  int progress_ms = 1000;
  size_t write_buffer_size = 0;  // 0 keeps the RocksDB default
  int consumers = 1;
  bool preload = false;
  size_t batch = 1;
  int concurrent = -1;  // -1: the memtable's default
  bool shuffle = false;
  bool with_account = false;  // --key_format=symb_acct_tid
};

// Parses a byte count with an optional K, M or G suffix (powers of 1024),
// e.g. "512MB", "512M" or "536870912". Returns false on malformed input.
bool ParseBytes(const std::string& s, size_t* out) {
  char* end = nullptr;
  unsigned long long n = strtoull(s.c_str(), &end, 10);
  if (end == s.c_str()) {
    return false;
  }
  std::string suffix(end);
  for (char& c : suffix) {
    c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
  }
  if (suffix == "K" || suffix == "KB") {
    n <<= 10;
  } else if (suffix == "M" || suffix == "MB") {
    n <<= 20;
  } else if (suffix == "G" || suffix == "GB") {
    n <<= 30;
  } else if (!suffix.empty() && suffix != "B") {
    return false;
  }
  *out = static_cast<size_t>(n);
  return n > 0;
}

void Usage(const char* prog) {
  fprintf(stderr,
          "usage: %s --memtable=HEAD|UPSTREAM|SKIPLIST [--limit=N] "
          "[--input=PATH] [--db=PATH] [--queue=N] [--write_buffer_size=BYTES] "
          "[--disable_wal] [--flush_at_end] [--consumers=N] [--preload] "
          "[--batch=N] [--concurrent=0|1] [--shuffle] [--key_format=F] "
          "[--progress_ms=N]\n"
          "  --consumers=N  writer threads (default 1)\n"
          "  --batch=N      key-values per WriteBatch (needs --preload)\n"
          "  --concurrent=0|1  set allow_concurrent_memtable_write\n"
          "  --key_format=symb_tid|symb_acct_tid\n"
          "                 trade_<symb>|<t_id> (default) or "
          "trade_<symb>|<ca_id>|<t_id>\n"
          "  --shuffle      write preloaded key-values in random order (fixed "
          "seed)\n"
          "  --preload      build all KVs in memory before the timed load and "
          "let the\n"
          "                 writers take them without the queue, so that only "
          "the\n"
          "                 writes are timed\n"
          "  HEAD      modified HashSkipList (InlineSkipList buckets) from "
          "the linked librocksdb\n"
          "  UPSTREAM  upstream HashSkipList (SkipList buckets) built into "
          "this binary\n"
          "  SKIPLIST  default memtable\n",
          prog);
}

bool ParseArgs(int argc, char** argv, Args* args) {
  for (int i = 1; i < argc; ++i) {
    std::string_view arg(argv[i]);
    auto value_of = [&](std::string_view name, std::string* out) {
      if (arg.substr(0, name.size()) == name && arg.size() > name.size() &&
          arg[name.size()] == '=') {
        *out = std::string(arg.substr(name.size() + 1));
        return true;
      }
      return false;
    };
    std::string v;
    if (value_of("--memtable", &v)) {
      args->memtable = v;
    } else if (value_of("--limit", &v)) {
      args->limit = strtoull(v.c_str(), nullptr, 10);
    } else if (value_of("--input", &v)) {
      args->input = v;
    } else if (value_of("--db", &v)) {
      args->db = v;
    } else if (value_of("--queue", &v)) {
      args->queue = std::max<size_t>(1, strtoull(v.c_str(), nullptr, 10));
    } else if (value_of("--write_buffer_size", &v)) {
      if (!ParseBytes(v, &args->write_buffer_size)) {
        fprintf(stderr, "bad --write_buffer_size: %s\n", v.c_str());
        return false;
      }
    } else if (value_of("--consumers", &v)) {
      args->consumers = atoi(v.c_str());
      if (args->consumers < 1) {
        fprintf(stderr, "--consumers must be at least 1\n");
        return false;
      }
    } else if (value_of("--key_format", &v)) {
      if (v != "symb_tid" && v != "symb_acct_tid") {
        fprintf(stderr, "--key_format must be symb_tid or symb_acct_tid\n");
        return false;
      }
      args->with_account = v == "symb_acct_tid";
    } else if (value_of("--batch", &v)) {
      args->batch = std::max<size_t>(1, strtoull(v.c_str(), nullptr, 10));
    } else if (value_of("--concurrent", &v)) {
      if (v != "0" && v != "1") {
        fprintf(stderr, "--concurrent must be 0 or 1\n");
        return false;
      }
      args->concurrent = v == "1" ? 1 : 0;
    } else if (value_of("--progress_ms", &v)) {
      args->progress_ms = atoi(v.c_str());
    } else if (arg == "--disable_wal") {
      args->disable_wal = true;
    } else if (arg == "--flush_at_end") {
      args->flush_at_end = true;
    } else if (arg == "--preload") {
      args->preload = true;
    } else if (arg == "--shuffle") {
      args->shuffle = true;
    } else {
      fprintf(stderr, "unknown argument: %s\n", argv[i]);
      return false;
    }
  }
  if (args->memtable != "HEAD" && args->memtable != "UPSTREAM" &&
      args->memtable != "SKIPLIST") {
    fprintf(stderr, "--memtable must be HEAD, UPSTREAM or SKIPLIST\n");
    return false;
  }
  if ((args->batch > 1 || args->shuffle) && !args->preload) {
    fprintf(stderr, "--batch and --shuffle need --preload\n");
    return false;
  }
  if (args->db.empty()) {
    args->db = "/tmp/op_trade_bench_" + args->memtable;
  }
  return true;
}

void PrintLatency(const char* label, const LatencyHistogram& h) {
  printf("%s (us): avg %.2f | p50 %.2f | p95 %.2f | p99 %.2f | p99.9 %.2f | max %.2f\n",
         label, h.AverageNanos() / 1e3, h.PercentileNanos(0.50) / 1e3,
         h.PercentileNanos(0.95) / 1e3, h.PercentileNanos(0.99) / 1e3,
         h.PercentileNanos(0.999) / 1e3, h.MaxNanos() / 1e3);
}

}  // namespace

int main(int argc, char** argv) {
  const uint64_t program_start = NowNanos();

  Args args;
  if (!ParseArgs(argc, argv, &args)) {
    Usage(argv[0]);
    return 2;
  }

  Options options;
  options.create_if_missing = true;
  options.prefix_extractor = std::make_shared<DelimiterPrefixTransform>('|');
  options.statistics = ROCKSDB_NAMESPACE::CreateDBStatistics();
  if (args.write_buffer_size > 0) {
    options.write_buffer_size = args.write_buffer_size;
  }
  if (args.memtable == "HEAD") {
    options.memtable_factory.reset(ROCKSDB_NAMESPACE::NewHashSkipListRepFactory());
  } else if (args.memtable == "UPSTREAM") {
    // Same defaults as NewHashSkipListRepFactory().
    options.memtable_factory.reset(
        ROCKSDB_NAMESPACE::NewUpstreamHashSkipListRepFactory(1000000, 4, 4));
  }
  // DB::Open rejects concurrent memtable writes for reps that do not support
  // them: upstream HashSkipListRep, and HEAD when it runs against a library
  // built before concurrent write support.
  if (!options.memtable_factory->IsInsertConcurrentlySupported()) {
    if (args.concurrent == 1) {
      fprintf(stderr, "%s does not support concurrent memtable writes\n",
              options.memtable_factory->Name());
      return 2;
    }
    options.allow_concurrent_memtable_write = false;
  } else if (args.concurrent >= 0) {
    options.allow_concurrent_memtable_write = args.concurrent == 1;
  }

  // use_existing_db=false: start from an empty database every run.
  Status s = ROCKSDB_NAMESPACE::DestroyDB(args.db, options);
  if (!s.ok()) {
    fprintf(stderr, "DestroyDB(%s): %s\n", args.db.c_str(), s.ToString().c_str());
    return 1;
  }
  std::unique_ptr<DB> db;
  s = DB::Open(options, args.db, &db);
  if (!s.ok()) {
    fprintf(stderr, "DB::Open(%s): %s\n", args.db.c_str(), s.ToString().c_str());
    return 1;
  }

  printf("== op_trade_bench ==\n");
  printf("memtable          : %s (%s)\n", args.memtable.c_str(),
         options.memtable_factory->Name());
  printf("write_buffer_size : %s bytes\n", WithCommas(options.write_buffer_size).c_str());
  printf("prefix extractor  : %s (up to and including the first '|')\n",
         options.prefix_extractor->Name());
  printf("concurrent writes : %s\n",
         options.allow_concurrent_memtable_write ? "allowed" : "disabled");
  printf("WAL               : %s\n", args.disable_wal ? "disabled" : "enabled");
  printf("input             : %s\n", args.input.c_str());
  printf("limit             : %s\n", WithCommas(args.limit).c_str());
  printf("db                : %s\n", args.db.c_str());
  printf("consumers         : %d%s\n", args.consumers,
         args.preload ? " (preloaded, no queue)" : "");
  printf("batch             : %zu key-values per write\n", args.batch);
  printf("key format        : %s\n", args.with_account
                                          ? "trade_<symb>|<ca_id>|<t_id>"
                                          : "trade_<symb>|<t_id>");
  fflush(stdout);

  WriteOptions write_options;
  write_options.disableWAL = args.disable_wal;
  BoundedQueue<TradeKV> queue(args.queue);
  std::atomic<uint64_t> progress{0};
  ProducerStats producer_stats;
  std::vector<ConsumerStats> per_consumer(static_cast<size_t>(args.consumers));

  // With --preload the KVs are built before the timed load.
  std::vector<TradeKV> preloaded;
  if (args.preload) {
    const uint64_t preload_start = NowNanos();
    preloaded.reserve(args.limit);
    producer_stats = ReadTrades(args.input, args.limit, args.with_account,
                                [&](TradeKV&& kv) {
      preloaded.push_back(std::move(kv));
    });
    if (args.shuffle) {
      std::shuffle(preloaded.begin(), preloaded.end(), std::mt19937_64(42));
    }
    printf("preload           : %s KVs%s in %.3f s\n",
           WithCommas(preloaded.size()).c_str(),
           args.shuffle ? " (shuffled)" : "",
           (NowNanos() - preload_start) / 1e9);
    fflush(stdout);
  }

  const uint64_t load_start = NowNanos();
  std::atomic<size_t> next_preloaded{0};
  std::vector<std::thread> consumers;
  for (int i = 0; i < args.consumers; ++i) {
    ConsumerStats* stats = &per_consumer[static_cast<size_t>(i)];
    consumers.emplace_back([&, stats] {
      if (args.preload) {
        consume_preloaded(db.get(), write_options, preloaded, args.batch,
                          next_preloaded, progress, stats);
      } else {
        consume_trades(db.get(), write_options, queue, progress, stats);
      }
    });
  }
  std::thread producer;
  if (!args.preload) {
    producer = std::thread([&] {
      producer_stats = produce_trade_transaction(args.input, args.limit,
                                                 args.with_account, queue);
    });
  }

  std::atomic<bool> loading{true};
  std::mutex report_mu;
  std::condition_variable report_cv;
  std::thread reporter([&] {
    if (args.progress_ms <= 0) {
      return;
    }
    uint64_t last = 0;
    uint64_t last_ns = load_start;
    std::unique_lock<std::mutex> lock(report_mu);
    while (!report_cv.wait_for(lock, std::chrono::milliseconds(args.progress_ms),
                               [&] { return !loading.load(); })) {
      uint64_t now = NowNanos();
      uint64_t done = progress.load(std::memory_order_relaxed);
      double rate = (done - last) / ((now - last_ns) / 1e9);
      printf("[%7.1fs] consumed %s / %s (%s ops/s, queue %s)\n",
             (now - load_start) / 1e9, WithCommas(done).c_str(),
             WithCommas(args.limit).c_str(),
             WithCommas(static_cast<uint64_t>(rate)).c_str(),
             args.preload ? "-" : WithCommas(queue.Size()).c_str());
      fflush(stdout);
      last = done;
      last_ns = now;
    }
  });

  if (producer.joinable()) {
    producer.join();
  }
  for (std::thread& t : consumers) {
    t.join();
  }
  const uint64_t load_end = NowNanos();
  ConsumerStats consumer_stats;
  for (const ConsumerStats& c : per_consumer) {
    consumer_stats.Merge(c);
  }
  {
    std::lock_guard<std::mutex> lock(report_mu);
    loading = false;
  }
  report_cv.notify_all();
  reporter.join();

  const double total_s = (load_end - program_start) / 1e9;
  const double load_s = (load_end - load_start) / 1e9;
  const double ops = load_s > 0 ? consumer_stats.consumed / load_s : 0;

  // Flushes and stalls during the load only, before any final flush.
  HistogramData flush_time;
  options.statistics->histogramData(ROCKSDB_NAMESPACE::FLUSH_TIME, &flush_time);
  const uint64_t stall_us =
      options.statistics->getTickerCount(ROCKSDB_NAMESPACE::STALL_MICROS);

  // Times flushing everything still in memtables. With a write buffer large
  // enough to hold all KVs, this is the flush of exactly one memtable.
  double final_flush_ms = -1;
  if (args.flush_at_end) {
    const uint64_t flush_start = NowNanos();
    Status fs = db->Flush(ROCKSDB_NAMESPACE::FlushOptions());
    final_flush_ms = (NowNanos() - flush_start) / 1e6;
    if (!fs.ok()) {
      fprintf(stderr, "Flush: %s\n", fs.ToString().c_str());
      return 1;
    }
  }

  printf("== result ==\n");
  if (!producer_stats.error.empty()) {
    printf("producer error    : %s\n", producer_stats.error.c_str());
  }
  printf("produced          : %s (rows read %s, malformed %s, passes %s)\n",
         WithCommas(producer_stats.produced).c_str(),
         WithCommas(producer_stats.rows_read).c_str(),
         WithCommas(producer_stats.malformed).c_str(),
         WithCommas(producer_stats.passes).c_str());
  printf("consumed          : %s (failed puts %s)\n",
         WithCommas(consumer_stats.consumed).c_str(),
         WithCommas(consumer_stats.failed).c_str());
  if (consumer_stats.failed > 0) {
    printf("first put error   : %s\n", consumer_stats.first_error.c_str());
  }
  printf("total time        : %.3f s (program start -> all KVs consumed)\n", total_s);
  printf("load time         : %.3f s (%s -> all KVs consumed)\n", load_s,
         args.preload ? "first write" : "first produce");
  printf("throughput        : %s ops/s (consumed / load time)\n",
         WithCommas(static_cast<uint64_t>(ops)).c_str());
  PrintLatency(args.batch > 1 ? "write latency     " : "put latency       ",
               consumer_stats.put_latency);
  if (!args.preload) {
    PrintLatency("queue+put latency ", consumer_stats.end_to_end_latency);
  }
  printf("flushes completed : %s (avg %.1f ms)\n",
         WithCommas(flush_time.count).c_str(), flush_time.average / 1e3);
  printf("write stall       : %.3f s\n", stall_us / 1e6);
  if (args.flush_at_end) {
    printf("final flush       : %.1f ms (DB::Flush after the load)\n",
           final_flush_ms);
  }

  // One line for scripts: key=value pairs, times in seconds or microseconds.
  const LatencyHistogram& put = consumer_stats.put_latency;
  printf("RESULT memtable=%s write_buffer_size=%zu consumers=%d preload=%d "
         "batch=%zu concurrent=%d shuffle=%d key_format=%s "
         "limit=%llu consumed=%llu total_s=%.3f load_s=%.3f "
         "ops_per_s=%.0f put_avg_us=%.2f put_p50_us=%.2f put_p99_us=%.2f "
         "put_p999_us=%.2f put_max_us=%.2f flushes=%llu flush_avg_ms=%.1f "
         "stall_s=%.3f final_flush_ms=%.1f\n",
         args.memtable.c_str(), options.write_buffer_size, args.consumers,
         args.preload ? 1 : 0, args.batch,
         options.allow_concurrent_memtable_write ? 1 : 0, args.shuffle ? 1 : 0,
         args.with_account ? "symb_acct_tid" : "symb_tid",
         static_cast<unsigned long long>(args.limit),
         static_cast<unsigned long long>(consumer_stats.consumed), total_s,
         load_s, ops, put.AverageNanos() / 1e3, put.PercentileNanos(0.50) / 1e3,
         put.PercentileNanos(0.99) / 1e3, put.PercentileNanos(0.999) / 1e3,
         put.MaxNanos() / 1e3, static_cast<unsigned long long>(flush_time.count),
         flush_time.average / 1e3, stall_us / 1e6, final_flush_ms);
  fflush(stdout);

  s = db->Close();
  if (!s.ok()) {
    fprintf(stderr, "DB::Close: %s\n", s.ToString().c_str());
  }
  bool ok = producer_stats.error.empty() && consumer_stats.failed == 0 &&
            consumer_stats.consumed == args.limit;
  return ok ? 0 : 1;
}
