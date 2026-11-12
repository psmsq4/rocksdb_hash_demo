package dev.psmsq4.rocksdbdemo.bench;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/** The cards, and each card's current settings (in memory until restart). */
@Component
public class BenchmarkCatalog {

    static final List<String> ALL_MEMTABLES = List.of("HEAD", "UPSTREAM", "SKIPLIST");

    // Default 10M trades: on the i9-12900K with the three runs side by side,
    // SKIPLIST (the slowest) finishes in about 22 s, HEAD and UPSTREAM in
    // about 14 s.
    private final List<Benchmark> benchmarks = List.of(
            new Benchmark(
                    "flush",
                    "flush",
                    "Flush 시간",
                    "거래 데이터를 memtable에 쓰면서, memtable이 찰 때마다 일어나는 flush의 소요 시간을 비교합니다. 적재가 끝나면 남은 memtable도 DB::Flush로 한 번 더 내립니다.",
                    new RunSettings(10_000_000, 64, "symb_tid", false, false, 1, 12, true, 0, 100, 0),
                    List.of("--flush_at_end"),
                    ALL_MEMTABLES),
            // Account keys scatter inserts inside a bucket, the case where
            // concurrent memtable writes help; preload keeps the producer
            // queue (one lock) from being the bottleneck. 512MB keeps flushes
            // rare. Four writers fill the four CPUs each process gets. 8M:
            // UPSTREAM, the slowest here, finishes in about 25 s.
            new Benchmark(
                    "write",
                    "write",
                    "멀티 스레드 쓰기",
                    "거래 데이터를 미리 메모리에 만든 뒤, 소비자 스레드 여러 개가 동시에 Put합니다. HEAD와 SKIPLIST는 memtable에 동시에 넣고, UPSTREAM은 동시 쓰기를 지원하지 않아 RocksDB가 쓰기를 모아 한 스레드가 넣습니다.",
                    new RunSettings(8_000_000, 512, "symb_acct_tid", true, false, 4, 12, true, 0, 100, 0),
                    List.of(),
                    ALL_MEMTABLES),
            // 2M trades fit in a 512MB memtable with no flush, so scans read
            // the memtable only. UPSTREAM copies all 2M entries into a new
            // skiplist for every total-order iterator (about 0.3 s each).
            new Benchmark(
                    "scan",
                    "scan",
                    "Range scan",
                    "거래 데이터를 memtable에 넣은 뒤 flush 없이 range scan을 합니다. 먼저 한 종목 안에서 읽는 prefix scan, 다음에 종목을 넘나들며 key 순서대로 읽는 total-order scan을 정해진 시간 동안 반복하고, scan마다 iterator를 새로 엽니다.",
                    new RunSettings(2_000_000, 512, "symb_tid", true, false, 1, 12, true, 8, 100, 0),
                    List.of(),
                    ALL_MEMTABLES),
            // 5M account-key trades in a 2048MB memtable (no flush): buckets
            // of about 1,500 KVs, large enough that the lookups miss cache.
            // Then 4 s each of Get for written keys, missing keys in written
            // symbols and symbols never written.
            new Benchmark(
                    "get",
                    "get",
                    "점 조회",
                    "거래 데이터를 memtable에 넣은 뒤 flush 없이 DB::Get을 무작위로 반복합니다. 있는 key, 있는 종목 안의 없는 key, 없는 종목을 차례로 조회해 지연과 처리량을 비교합니다.",
                    new RunSettings(5_000_000, 2048, "symb_acct_tid", true, false, 1, 12, true, 0, 100, 4),
                    List.of(),
                    ALL_MEMTABLES));

    private final Map<String, RunSettings> settings = new ConcurrentHashMap<>();

    public List<Benchmark> all() {
        return benchmarks;
    }

    public Optional<Benchmark> find(String id) {
        return benchmarks.stream().filter(b -> b.id().equals(id)).findFirst();
    }

    public RunSettings settings(Benchmark b) {
        return settings.getOrDefault(b.id(), b.defaults());
    }

    /** Stores valid settings; returns the problem otherwise. */
    public String update(Benchmark b, RunSettings s) {
        String problem = s.problem();
        if (problem == null) {
            settings.put(b.id(), s);
        }
        return problem;
    }
}
