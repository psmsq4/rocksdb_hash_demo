// op_trade_bench: replays TPC-E Trade.txt rows as RocksDB writes through a
// producer/consumer queue and reports elapsed time, throughput and latency for
// the selected memtable.
//
//   op_trade_bench --memtable=HEAD|UPSTREAM|SKIPLIST [--limit=N]
//                  [--input=Trade.txt] [--db=path] [--queue=N]
//                  [--write_buffer_size=BYTES] [--disable_wal] [--flush_at_end]
//                  [--consumers=N] [--preload] [--batch=N] [--concurrent=0|1]
//                  [--shuffle] [--key_format=symb_tid|symb_acct_tid]
//                  [--progress_ms=N] [--metrics_port=N] [--metrics_dump=PATH]
//
// --metrics_port serves Prometheus text metrics at http://127.0.0.1:N/metrics
// while the program runs (0 picks a free port; the port is printed as
// "METRICS_PORT=<n>"). --metrics_dump writes the same text once more after
// the load and final flush, so the last values outlive the process.
//
// Key:   "trade_<t_s_symb>|<t_id>", or with --key_format=symb_acct_tid
//        "trade_<t_s_symb>|<t_ca_id>|<t_id>" (plus "#<pass>" once the file
//        wraps)
// Value: the remaining 14 columns of the row, '|'-separated
// Prefix extractor: everything up to and including the first '|'.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "rocksdb/db.h"
#include "rocksdb/listener.h"
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
using ROCKSDB_NAMESPACE::EventListener;
using ROCKSDB_NAMESPACE::FlushJobInfo;
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

// Records each flush: when it ended, how long it took and what it wrote.
// RocksDB calls these from its background flush threads.
class FlushTracker : public EventListener {
 public:
  struct Event {
    double end_s;  // seconds since program start
    double ms;
    uint64_t entries;
    uint64_t bytes;  // data block bytes written
    std::string reason;
  };

  explicit FlushTracker(uint64_t program_start) : program_start_(program_start) {}

  const char* Name() const override { return "OpTradeBench.FlushTracker"; }

  void OnFlushBegin(DB* /*db*/, const FlushJobInfo& info) override {
    std::lock_guard<std::mutex> lock(mu_);
    begin_ns_[info.job_id] = NowNanos();
  }

  void OnFlushCompleted(DB* /*db*/, const FlushJobInfo& info) override {
    const uint64_t now = NowNanos();
    std::lock_guard<std::mutex> lock(mu_);
    auto it = begin_ns_.find(info.job_id);
    double ms = it == begin_ns_.end() ? 0 : (now - it->second) / 1e6;
    if (it != begin_ns_.end()) {
      begin_ns_.erase(it);
    }
    events_.push_back(Event{(now - program_start_) / 1e9, ms,
                            info.table_properties.num_entries,
                            info.table_properties.data_size,
                            ROCKSDB_NAMESPACE::GetFlushReasonString(info.flush_reason)});
  }

  std::vector<Event> Events() const {
    std::lock_guard<std::mutex> lock(mu_);
    return events_;
  }

 private:
  const uint64_t program_start_;
  mutable std::mutex mu_;
  std::map<int, uint64_t> begin_ns_;
  std::vector<Event> events_;
};

// Serves GET /metrics on 127.0.0.1 from one thread, rendering the body on
// every request.
class MetricsServer {
 public:
  ~MetricsServer() { Stop(); }

  // Returns the bound port, or -1 on failure. Port 0 picks a free port.
  int Start(int port, std::function<std::string()> render) {
    fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0) {
      return -1;
    }
    int one = 1;
    setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<uint16_t>(port));
    socklen_t len = sizeof(addr);
    if (bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 ||
        listen(fd_, 16) != 0 ||
        getsockname(fd_, reinterpret_cast<sockaddr*>(&addr), &len) != 0) {
      close(fd_);
      fd_ = -1;
      return -1;
    }
    render_ = std::move(render);
    thread_ = std::thread([this] { Loop(); });
    return ntohs(addr.sin_port);
  }

  void Stop() {
    if (thread_.joinable()) {
      stop_ = true;
      thread_.join();
    }
    if (fd_ >= 0) {
      close(fd_);
      fd_ = -1;
    }
  }

 private:
  void Loop() {
    while (!stop_) {
      pollfd p{fd_, POLLIN, 0};
      if (poll(&p, 1, 100) <= 0) {
        continue;
      }
      int client = accept(fd_, nullptr, nullptr);
      if (client < 0) {
        continue;
      }
      Serve(client);
      close(client);
    }
  }

  void Serve(int client) {
    std::string request;
    char buf[2048];
    while (request.find("\r\n\r\n") == std::string::npos && request.size() < 8192) {
      pollfd p{client, POLLIN, 0};
      if (poll(&p, 1, 1000) <= 0) {
        return;
      }
      ssize_t n = recv(client, buf, sizeof(buf), 0);
      if (n <= 0) {
        return;
      }
      request.append(buf, static_cast<size_t>(n));
    }
    const bool metrics = request.rfind("GET /metrics", 0) == 0;
    std::string body = metrics ? render_() : "not found\n";
    std::string response = std::string("HTTP/1.1 ") +
                           (metrics ? "200 OK" : "404 Not Found") +
                           "\r\nContent-Type: text/plain; version=0.0.4\r\n"
                           "Content-Length: " + std::to_string(body.size()) +
                           "\r\nConnection: close\r\n\r\n" + body;
    size_t sent = 0;
    while (sent < response.size()) {
      ssize_t n = send(client, response.data() + sent, response.size() - sent,
                       MSG_NOSIGNAL);
      if (n <= 0) {
        return;
      }
      sent += static_cast<size_t>(n);
    }
  }

  int fd_ = -1;
  std::atomic<bool> stop_{false};
  std::thread thread_;
  std::function<std::string()> render_;
};

// CPU seconds, resident bytes and thread count of this process.
struct ProcessSample {
  double cpu_s = 0;
  uint64_t rss_bytes = 0;
  uint64_t threads = 0;
};

ProcessSample SampleProcess() {
  ProcessSample out;
  if (FILE* f = fopen("/proc/self/stat", "r")) {
    char buf[1024];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    // Fields after the parenthesised command name; utime and stime are
    // fields 14 and 15, num_threads is field 20.
    if (const char* p = strrchr(buf, ')')) {
      unsigned long long utime = 0, stime = 0, threads = 0;
      if (sscanf(p + 2,
                 "%*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %llu %llu "
                 "%*d %*d %*d %*d %llu",
                 &utime, &stime, &threads) == 3) {
        out.cpu_s = static_cast<double>(utime + stime) / sysconf(_SC_CLK_TCK);
        out.threads = threads;
      }
    }
  }
  if (FILE* f = fopen("/proc/self/statm", "r")) {
    unsigned long long size = 0, resident = 0;
    if (fscanf(f, "%llu %llu", &size, &resident) == 2) {
      out.rss_bytes = resident * static_cast<uint64_t>(sysconf(_SC_PAGESIZE));
    }
    fclose(f);
  }
  return out;
}

// Appends one Prometheus sample line.
void Metric(std::string* out, const std::string& name, double value,
            const std::string& labels = "") {
  char num[64];
  if (value == static_cast<double>(static_cast<long long>(value))) {
    snprintf(num, sizeof(num), "%lld", static_cast<long long>(value));
  } else {
    snprintf(num, sizeof(num), "%.6g", value);
  }
  out->append(name);
  if (!labels.empty()) {
    out->append("{").append(labels).append("}");
  }
  out->append(" ").append(num).append("\n");
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
  int metrics_port = -1;      // -1: no metrics server
  std::string metrics_dump;
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
          "[--progress_ms=N] [--metrics_port=N] [--metrics_dump=PATH]\n"
          "  --metrics_port=N  serve Prometheus metrics on 127.0.0.1:N "
          "(0: any free port)\n"
          "  --metrics_dump=PATH  write the final metrics to PATH\n"
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
    } else if (value_of("--metrics_port", &v)) {
      args->metrics_port = atoi(v.c_str());
      if (args->metrics_port < 0 || args->metrics_port > 65535) {
        fprintf(stderr, "--metrics_port must be 0..65535\n");
        return false;
      }
    } else if (value_of("--metrics_dump", &v)) {
      args->metrics_dump = v;
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
  auto flush_tracker = std::make_shared<FlushTracker>(program_start);
  options.listeners.push_back(flush_tracker);
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

  // 0 open, 1 preload, 2 load, 3 final flush, 4 done
  std::atomic<int> phase{0};
  std::atomic<uint64_t> load_start_ns{0};
  std::atomic<uint64_t> load_end_ns{0};
  std::atomic<double> final_flush_ms_live{-1};
  auto render_metrics = [&]() {
    std::string out;
    out.reserve(32768);
    const uint64_t now = NowNanos();
    Metric(&out, "otb_info", 1,
           "memtable=\"" + args.memtable + "\",rep=\"" +
               options.memtable_factory->Name() + "\",key_format=\"" +
               (args.with_account ? "symb_acct_tid" : "symb_tid") + "\"");
    Metric(&out, "otb_phase", phase.load());
    Metric(&out, "otb_uptime_seconds", (now - program_start) / 1e9);
    const uint64_t ls = load_start_ns.load();
    const uint64_t le = load_end_ns.load();
    Metric(&out, "otb_load_elapsed_seconds", ls == 0 ? 0 : ((le ? le : now) - ls) / 1e9);
    Metric(&out, "otb_limit", static_cast<double>(args.limit));
    Metric(&out, "otb_consumed_total",
           static_cast<double>(progress.load(std::memory_order_relaxed)));
    Metric(&out, "otb_queue_depth",
           args.preload ? 0 : static_cast<double>(queue.Size()));
    Metric(&out, "otb_write_buffer_size_bytes",
           static_cast<double>(options.write_buffer_size));

    using P = ROCKSDB_NAMESPACE::DB::Properties;
    const std::pair<const char*, const std::string*> props[] = {
        {"otb_memtable_active_bytes", &P::kCurSizeActiveMemTable},
        {"otb_memtable_all_bytes", &P::kCurSizeAllMemTables},
        {"otb_memtable_active_entries", &P::kNumEntriesActiveMemTable},
        {"otb_memtable_immutable_count", &P::kNumImmutableMemTable},
        {"otb_flush_pending", &P::kMemTableFlushPending},
        {"otb_flush_running", &P::kNumRunningFlushes},
        {"otb_compaction_running", &P::kNumRunningCompactions},
        {"otb_sst_bytes", &P::kTotalSstFilesSize},
        {"otb_write_stopped", &P::kIsWriteStopped},
        {"otb_delayed_write_rate", &P::kActualDelayedWriteRate},
    };
    for (const auto& [name, prop] : props) {
      uint64_t v = 0;
      if (db->GetIntProperty(*prop, &v)) {
        Metric(&out, name, static_cast<double>(v));
      }
    }
    std::string l0;
    if (db->GetProperty(P::kNumFilesAtLevelPrefix + "0", &l0)) {
      Metric(&out, "otb_l0_files", atof(l0.c_str()));
    }

    const std::vector<FlushTracker::Event> events = flush_tracker->Events();
    double flush_ms_sum = 0;
    for (size_t i = 0; i < events.size(); ++i) {
      const FlushTracker::Event& e = events[i];
      flush_ms_sum += e.ms;
      char end_s[32];
      snprintf(end_s, sizeof(end_s), "%.3f", e.end_s);
      const std::string labels = "seq=\"" + std::to_string(i + 1) + "\",end_s=\"" +
                                 end_s + "\",reason=\"" + e.reason + "\"";
      Metric(&out, "otb_flush_event_ms", e.ms, labels);
      Metric(&out, "otb_flush_event_entries", static_cast<double>(e.entries), labels);
      Metric(&out, "otb_flush_event_bytes", static_cast<double>(e.bytes), labels);
    }
    Metric(&out, "otb_flushes_total", static_cast<double>(events.size()));
    Metric(&out, "otb_flush_seconds_total", flush_ms_sum / 1e3);
    Metric(&out, "otb_flush_last_ms", events.empty() ? 0 : events.back().ms);
    Metric(&out, "otb_final_flush_ms", final_flush_ms_live.load());

    const ProcessSample proc = SampleProcess();
    Metric(&out, "otb_process_cpu_seconds_total", proc.cpu_s);
    Metric(&out, "otb_process_rss_bytes", static_cast<double>(proc.rss_bytes));
    Metric(&out, "otb_process_threads", static_cast<double>(proc.threads));

    // Non-zero RocksDB statistics: tickers, then histogram summaries.
    for (const auto& [ticker, name] : ROCKSDB_NAMESPACE::TickersNameMap) {
      const uint64_t v = options.statistics->getTickerCount(ticker);
      if (v != 0) {
        Metric(&out, "rocksdb_ticker", static_cast<double>(v), "name=\"" + name + "\"");
      }
    }
    for (const auto& [hist, name] : ROCKSDB_NAMESPACE::HistogramsNameMap) {
      HistogramData d;
      options.statistics->histogramData(hist, &d);
      if (d.count == 0) {
        continue;
      }
      const std::string base = "name=\"" + name + "\",stat=\"";
      Metric(&out, "rocksdb_histogram", static_cast<double>(d.count), base + "count\"");
      Metric(&out, "rocksdb_histogram", d.average, base + "avg\"");
      Metric(&out, "rocksdb_histogram", d.median, base + "p50\"");
      Metric(&out, "rocksdb_histogram", d.percentile95, base + "p95\"");
      Metric(&out, "rocksdb_histogram", d.percentile99, base + "p99\"");
      Metric(&out, "rocksdb_histogram", d.max, base + "max\"");
    }
    return out;
  };
  MetricsServer metrics_server;
  if (args.metrics_port >= 0) {
    const int port = metrics_server.Start(args.metrics_port, render_metrics);
    if (port < 0) {
      fprintf(stderr, "metrics server: cannot listen on port %d: %s\n",
              args.metrics_port, strerror(errno));
      return 1;
    }
    printf("METRICS_PORT=%d\n", port);
    fflush(stdout);
  }

  // With --preload the KVs are built before the timed load.
  std::vector<TradeKV> preloaded;
  if (args.preload) {
    phase = 1;
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
  load_start_ns = load_start;
  phase = 2;
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
  load_end_ns = load_end;
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
    phase = 3;
    const uint64_t flush_start = NowNanos();
    Status fs = db->Flush(ROCKSDB_NAMESPACE::FlushOptions());
    final_flush_ms = (NowNanos() - flush_start) / 1e6;
    final_flush_ms_live = final_flush_ms;
    if (!fs.ok()) {
      fprintf(stderr, "Flush: %s\n", fs.ToString().c_str());
      return 1;
    }
  }
  phase = 4;
  if (!args.metrics_dump.empty()) {
    const std::string text = render_metrics();
    FILE* f = fopen(args.metrics_dump.c_str(), "w");
    if (f == nullptr || fwrite(text.data(), 1, text.size(), f) != text.size()) {
      fprintf(stderr, "metrics dump %s: %s\n", args.metrics_dump.c_str(),
              strerror(errno));
    }
    if (f != nullptr) {
      fclose(f);
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

  metrics_server.Stop();
  s = db->Close();
  if (!s.ok()) {
    fprintf(stderr, "DB::Close: %s\n", s.ToString().c_str());
  }
  bool ok = producer_stats.error.empty() && consumer_stats.failed == 0 &&
            consumer_stats.consumed == args.limit;
  return ok ? 0 : 1;
}
