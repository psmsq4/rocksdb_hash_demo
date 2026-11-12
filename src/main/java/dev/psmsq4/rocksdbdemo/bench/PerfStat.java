package dev.psmsq4.rocksdbdemo.bench;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Hardware counters of a whole op_trade_bench process through
 * {@code perf stat}: counting mode only, so the run is not slowed down. The
 * counts include reading Trade.txt and opening the DB, which every memtable
 * does the same way.
 */
public final class PerfStat {

    /** Counter name in the result → perf event, in display order. */
    static final Map<String, String> EVENTS = new LinkedHashMap<>();

    static {
        EVENTS.put("cycles", "cycles");
        EVENTS.put("instructions", "instructions");
        EVENTS.put("l1Misses", "L1-dcache-load-misses");
        EVENTS.put("tlbMisses", "dTLB-load-misses");
        EVENTS.put("llcMisses", "cache-misses");
    }

    private PerfStat() {
    }

    /** The perf binary on PATH, or null. */
    public static Path find() {
        String path = System.getenv("PATH");
        if (path == null) {
            return null;
        }
        for (String dir : path.split(File.pathSeparator)) {
            Path p = Path.of(dir, "perf");
            if (Files.isExecutable(p)) {
                return p;
            }
        }
        return null;
    }

    /**
     * Arguments that run the rest of the command under perf stat, writing CSV
     * to {@code out}. On hybrid Intel CPUs the events must name the P-core PMU;
     * the runs are pinned to P-cores.
     */
    public static List<String> wrap(Path perf, Path out) {
        boolean hybrid = Files.isDirectory(Path.of("/sys/devices/cpu_core"));
        List<String> events = new ArrayList<>();
        for (String e : EVENTS.values()) {
            events.add(hybrid ? "cpu_core/" + e + "/u" : e + ":u");
        }
        return List.of(perf.toString(), "stat", "-x", ",", "-o", out.toString(),
                "-e", String.join(",", events), "--");
    }

    /**
     * Parses perf stat -x, output. Returns counter name → value; counters perf
     * could not read are left out.
     */
    public static Map<String, Double> parse(String csv) {
        Map<String, Double> out = new LinkedHashMap<>();
        for (String line : csv.split("\n")) {
            if (line.isBlank() || line.startsWith("#")) {
                continue;
            }
            String[] f = line.split(",", -1);
            if (f.length < 3) {
                continue;
            }
            String event = f[2];
            int slash = event.indexOf('/');
            if (slash >= 0) {                      // cpu_core/cycles/u
                event = event.substring(slash + 1, event.lastIndexOf('/'));
            } else if (event.contains(":")) {      // cycles:u
                event = event.substring(0, event.indexOf(':'));
            }
            for (Map.Entry<String, String> e : EVENTS.entrySet()) {
                if (e.getValue().equals(event)) {
                    try {
                        out.put(e.getKey(), Double.parseDouble(f[0]));
                    } catch (NumberFormatException ignored) {
                        // "<not counted>" or "<not supported>"
                    }
                }
            }
        }
        return out;
    }
}
