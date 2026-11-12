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
                    "Flush 시간",
                    "거래 데이터를 memtable에 쓰면서, memtable이 찰 때마다 일어나는 flush의 소요 시간을 비교합니다. 적재가 끝나면 남은 memtable도 DB::Flush로 한 번 더 내립니다.",
                    new RunSettings(10_000_000, 64, "symb_tid", false, false, 1, 12),
                    List.of("--flush_at_end"),
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
