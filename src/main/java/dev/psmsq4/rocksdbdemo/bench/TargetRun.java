package dev.psmsq4.rocksdbdemo.bench;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * One memtable's process within a run, and everything scraped from it. All
 * methods are synchronized: the stdout reader, the scraper and HTTP readers
 * touch it from different threads.
 */
public final class TargetRun {

    public enum State { STARTING, RUNNING, DONE, FAILED, STOPPED }

    private final String memtable;
    private final String cpuSet;
    private final int logLines;

    private State state = State.STARTING;
    private Process process;
    private int port = -1;
    private Integer exitCode;
    private String error;
    private double endedAt = -1;

    private final List<Map<String, Object>> samples = new ArrayList<>();
    private final Map<Integer, Map<String, Object>> flushEvents = new TreeMap<>();
    private Map<String, Double> tickers = Map.of();
    private Map<String, Map<String, Double>> histograms = Map.of();
    private Map<String, String> result = Map.of();
    private Map<String, Double> perf = Map.of();
    private final Deque<String> log = new ArrayDeque<>();
    // Key-values op_trade_bench printed as it produced them (--print_samples).
    private final List<Map<String, Object>> kvSamples = new ArrayList<>();

    // For rates between scrapes.
    private double prevT = -1;
    private double prevConsumed;
    private double prevCpu;
    private double prevScans = -1;
    private double prevScanSec;
    private double prevGets = -1;
    private double prevGetSec;

    TargetRun(String memtable, String cpuSet, int logLines) {
        this.memtable = memtable;
        this.cpuSet = cpuSet;
        this.logLines = Math.max(20, logLines);
    }

    public String memtable() {
        return memtable;
    }

    public String cpuSet() {
        return cpuSet;
    }

    synchronized void started(Process p) {
        process = p;
        state = State.RUNNING;
    }

    synchronized Process process() {
        return process;
    }

    synchronized int port() {
        return port;
    }

    synchronized boolean isActive() {
        return state == State.STARTING || state == State.RUNNING;
    }

    synchronized void fail(String message, double t) {
        if (isActive()) {
            state = State.FAILED;
            endedAt = t;
        }
        if (error == null) {
            error = message;
        }
    }

    synchronized void stop(String message, double t) {
        if (isActive()) {
            state = State.STOPPED;
            endedAt = t;
            error = message;
        }
    }

    synchronized void exited(int code, double t) {
        exitCode = code;
        if (isActive()) {
            state = code == 0 ? State.DONE : State.FAILED;
            endedAt = t;
            if (code != 0 && error == null) {
                error = "op_trade_bench exited with code " + code;
            }
        }
    }

    /** One line of op_trade_bench output. */
    synchronized void output(String line) {
        if (line.startsWith("SAMPLE ")) {
            // SAMPLE <index> <key>\t<value>
            int sp = line.indexOf(' ', 7);
            int tab = line.indexOf('\t', sp + 1);
            if (sp > 0 && tab > sp && kvSamples.size() < 64) {
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("index", Long.parseLong(line.substring(7, sp)));
                s.put("key", line.substring(sp + 1, tab));
                s.put("value", line.substring(tab + 1));
                kvSamples.add(s);
            }
            return;
        }
        if (line.startsWith("METRICS_PORT=")) {
            try {
                port = Integer.parseInt(line.substring("METRICS_PORT=".length()).strip());
            } catch (NumberFormatException ignored) {
                // Leave the port unset; the run shows no live metrics.
            }
        } else if (line.startsWith("RESULT ")) {
            Map<String, String> r = new LinkedHashMap<>();
            for (String kv : line.substring(7).split(" ")) {
                int eq = kv.indexOf('=');
                if (eq > 0) {
                    r.put(kv.substring(0, eq), kv.substring(eq + 1));
                }
            }
            result = r;
        }
        log.addLast(line);
        while (log.size() > logLines) {
            log.removeFirst();
        }
    }

    /** Folds one /metrics scrape taken t seconds into the run. */
    synchronized void ingest(String text, double t) {
        Map<String, Double> g = new HashMap<>();
        Map<String, Double> newTickers = new TreeMap<>();
        Map<String, Map<String, Double>> newHistograms = new TreeMap<>();
        for (PromText.Line l : PromText.parse(text)) {
            switch (l.name()) {
                case "rocksdb_ticker" -> newTickers.put(l.label("name"), l.value());
                case "rocksdb_histogram" -> newHistograms
                        .computeIfAbsent(l.label("name"), k -> new LinkedHashMap<>())
                        .put(l.label("stat"), l.value());
                case "otb_flush_event_ms", "otb_flush_event_entries", "otb_flush_event_bytes" -> {
                    int seq = (int) parseOr(l.label("seq"), 0);
                    Map<String, Object> e = flushEvents.computeIfAbsent(seq, k -> new LinkedHashMap<>());
                    e.put("seq", seq);
                    e.put("t", parseOr(l.label("end_s"), 0));
                    e.put("reason", l.label("reason"));
                    String field = l.name().substring("otb_flush_event_".length());
                    e.put(field, l.value());
                }
                default -> {
                    if (l.labels().isEmpty()) {
                        g.put(l.name(), l.value());
                    }
                }
            }
        }
        if (!newTickers.isEmpty() || !newHistograms.isEmpty()) {
            tickers = newTickers;
            histograms = newHistograms;
        }
        double consumed = g.getOrDefault("otb_consumed_total", 0.0);
        double cpu = g.getOrDefault("otb_process_cpu_seconds_total", 0.0);
        // Rates only while loading: after the load (final flush, or the dump
        // read after exit) the delta would mix in idle time.
        boolean loading = g.getOrDefault("otb_phase", 0.0) == 2.0;
        double dt = prevT < 0 || !loading ? 0 : t - prevT;
        double scanDt = prevT < 0 ? 0 : t - prevT;
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("t", round(t, 3));
        s.put("phase", g.getOrDefault("otb_phase", 0.0).intValue());
        s.put("consumed", consumed);
        s.put("limit", g.getOrDefault("otb_limit", 0.0));
        s.put("ops", dt > 0.05 ? round((consumed - prevConsumed) / dt, 0) : null);
        s.put("cpu", dt > 0.05 ? round((cpu - prevCpu) / dt * 100, 1) : null);
        s.put("memMb", mb(g.get("otb_memtable_all_bytes")));
        s.put("activeMb", mb(g.get("otb_memtable_active_bytes")));
        s.put("immutable", g.get("otb_memtable_immutable_count"));
        s.put("flushRunning", g.get("otb_flush_running"));
        s.put("compactionRunning", g.get("otb_compaction_running"));
        s.put("l0", g.get("otb_l0_files"));
        s.put("sstMb", mb(g.get("otb_sst_bytes")));
        s.put("rssMb", mb(g.get("otb_process_rss_bytes")));
        s.put("queue", g.get("otb_queue_depth"));
        s.put("flushes", g.get("otb_flushes_total"));
        s.put("flushSec", g.get("otb_flush_seconds_total"));
        s.put("loadSec", g.get("otb_load_elapsed_seconds"));
        s.put("finalFlushMs", g.get("otb_final_flush_ms"));
        // Range scans: rate and average latency since the previous scrape.
        int phase = g.getOrDefault("otb_phase", 0.0).intValue();
        Double scans = g.get("otb_scans_total");
        Double scanSec = g.get("otb_scan_seconds_total");
        if (scans != null && scanSec != null) {
            s.put("scanMode", g.get("otb_scan_mode"));
            s.put("scanProgress", g.get("otb_scan_progress"));
            double ds = prevScans < 0 ? 0 : scans - prevScans;
            boolean scanning = phase == 5 || phase == 6;
            s.put("scanOps", scanning && scanDt > 0.05 && prevScans >= 0 ? round(ds / scanDt, 1) : null);
            s.put("scanAvgUs", scanning && ds > 0 ? round((scanSec - prevScanSec) / ds * 1e6, 2) : null);
            prevScans = scans;
            prevScanSec = scanSec;
        }
        // Point lookups: rate and average latency since the previous scrape.
        Double gets = g.get("otb_gets_total");
        Double getSec = g.get("otb_get_seconds_total");
        if (gets != null && getSec != null) {
            s.put("getMode", g.get("otb_get_mode"));
            s.put("getProgress", g.get("otb_get_progress"));
            double dg = prevGets < 0 ? 0 : gets - prevGets;
            boolean looking = phase >= 7 && phase <= 9;
            s.put("getOps", looking && scanDt > 0.05 && prevGets >= 0 ? round(dg / scanDt, 0) : null);
            s.put("getAvgUs", looking && dg > 0 ? round((getSec - prevGetSec) / dg * 1e6, 3) : null);
            prevGets = gets;
            prevGetSec = getSec;
        }
        Map<String, Double> write = newHistograms.get("rocksdb.db.write.micros");
        s.put("writeP99", write == null ? null : write.get("p99"));
        samples.add(s);
        prevT = t;
        prevConsumed = consumed;
        prevCpu = cpu;
    }

    synchronized void perf(Map<String, Double> counters) {
        perf = counters;
    }

    synchronized Map<String, Object> snapshot() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("memtable", memtable);
        m.put("cpuSet", cpuSet);
        m.put("state", state.name());
        m.put("exitCode", exitCode);
        m.put("error", error);
        m.put("endedAt", endedAt < 0 ? null : round(endedAt, 3));
        m.put("samples", new ArrayList<>(samples));
        m.put("flushEvents", new ArrayList<>(flushEvents.values()));
        m.put("tickers", tickers);
        m.put("histograms", histograms);
        m.put("result", result);
        m.put("perf", perf);
        m.put("log", new ArrayList<>(log));
        return m;
    }

    synchronized List<Map<String, Object>> kvSamples() {
        return new ArrayList<>(kvSamples);
    }

    private static double parseOr(String s, double fallback) {
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static Double mb(Double bytes) {
        return bytes == null ? null : round(bytes / (1024 * 1024), 2);
    }

    private static double round(double v, int digits) {
        double f = Math.pow(10, digits);
        return Math.round(v * f) / f;
    }
}
