package dev.psmsq4.rocksdbdemo.bench;

import dev.psmsq4.rocksdbdemo.bench.Benchmark.Spec;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Component;

@Component
public class BenchmarkCatalog {

    static final List<String> ALL_MEMTABLES = List.of("HEAD", "UPSTREAM", "SKIPLIST");

    // 10M trades: on the i9-12900K with the three runs side by side, SKIPLIST
    // (the slowest) finishes in about 21 s, HEAD and UPSTREAM in about 13 s.
    private final List<Benchmark> benchmarks = List.of(
            new Benchmark(
                    "flush",
                    "Flush 시간",
                    "거래 1,000만 건을 기본 64MB memtable에 쓰면서, memtable이 찰 때마다 일어나는 flush의 소요 시간을 비교합니다.",
                    List.of(new Spec("KV", "10,000,000"),
                            new Spec("memtable", "64MB"),
                            new Spec("key", "trade_종목|t_id"),
                            new Spec("WAL", "끔"),
                            new Spec("쓰기", "큐, 소비자 1개")),
                    List.of("--limit=10000000", "--disable_wal", "--flush_at_end"),
                    ALL_MEMTABLES,
                    25,
                    30));

    public List<Benchmark> all() {
        return benchmarks;
    }

    public Optional<Benchmark> find(String id) {
        return benchmarks.stream().filter(b -> b.id().equals(id)).findFirst();
    }
}
