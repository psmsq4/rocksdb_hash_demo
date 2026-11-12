package dev.psmsq4.rocksdbdemo.bench;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** One press of a card's start button: every memtable started together. */
public final class BenchRun {

    private final long id;
    private final Benchmark benchmark;
    private final RunSettings settings;
    private final String perfNote;
    private final Instant startedAt = Instant.now();
    private final long startNanos = System.nanoTime();
    private final Map<String, TargetRun> targets = new LinkedHashMap<>();

    BenchRun(long id, Benchmark benchmark, RunSettings settings, List<TargetRun> targetRuns,
             String perfNote) {
        this.id = id;
        this.benchmark = benchmark;
        this.settings = settings;
        this.perfNote = perfNote;
        for (TargetRun t : targetRuns) {
            targets.put(t.memtable(), t);
        }
    }

    public long id() {
        return id;
    }

    public Benchmark benchmark() {
        return benchmark;
    }

    public RunSettings settings() {
        return settings;
    }

    public Map<String, TargetRun> targets() {
        return targets;
    }

    /** Seconds since the run started. */
    public double elapsed() {
        return (System.nanoTime() - startNanos) / 1e9;
    }

    public boolean isActive() {
        return targets.values().stream().anyMatch(TargetRun::isActive);
    }

    public Map<String, Object> snapshot() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("benchmark", benchmark.id());
        m.put("startedAt", startedAt.toString());
        m.put("active", isActive());
        m.put("elapsed", Math.round(elapsed() * 1000) / 1000.0);
        m.put("settings", settings);
        m.put("perfNote", perfNote);
        // Every memtable writes the same KVs; show the most complete list.
        m.put("kvSamples", targets.values().stream()
                .map(TargetRun::kvSamples)
                .max(java.util.Comparator.comparingInt(List::size))
                .orElse(List.of()));
        Map<String, Object> t = new LinkedHashMap<>();
        targets.forEach((k, v) -> t.put(k, v.snapshot()));
        m.put("targets", t);
        return m;
    }
}
