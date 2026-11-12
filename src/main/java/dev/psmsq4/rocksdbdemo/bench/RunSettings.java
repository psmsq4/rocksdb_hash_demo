package dev.psmsq4.rocksdbdemo.bench;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Workload knobs a card's settings dialog can change.
 *
 * @param kv          key-values to write (--limit), a multiple of {@link #KV_STEP}
 * @param memtableMb  write_buffer_size in MB: 64 (the RocksDB default) or a
 *                    multiple of {@link #MEMTABLE_STEP_MB}
 * @param keyFormat   one of {@link #KEY_FORMATS}
 * @param preload     build every KV in memory first and time only the writes
 * @param wal         write-ahead log on
 * @param consumers   writer threads
 * @param hashHeight  skiplist height in each HEAD/UPSTREAM bucket, one of
 *                    {@link #HASH_HEIGHTS}; SKIPLIST always uses 12
 */
public record RunSettings(long kv, int memtableMb, String keyFormat, boolean preload, boolean wal,
                          int consumers, int hashHeight) {

    public static final long KV_STEP = 100_000;
    public static final long KV_MIN = 100_000;
    public static final long KV_MAX = 30_000_000;
    public static final int MEMTABLE_MIN_MB = 64;
    public static final int MEMTABLE_STEP_MB = 128;
    public static final int MEMTABLE_MAX_MB = 2048;
    public static final int CONSUMERS_MAX = 8;
    // 4 is the RocksDB default for HashSkipList buckets. It keeps searches
    // logarithmic only up to about 4^4 = 256 entries per bucket; with large
    // memtables buckets grow far past that. 12 matches the default SkipList.
    public static final Map<Integer, String> HASH_HEIGHTS = ordered(
            4, "4 (RocksDB 기본)",
            12, "12 (SKIPLIST와 같음)");

    private static <K> Map<K, String> ordered(K k1, String v1, K k2, String v2) {
        Map<K, String> m = new LinkedHashMap<>();
        m.put(k1, v1);
        m.put(k2, v2);
        return java.util.Collections.unmodifiableMap(m);
    }
    // Insertion order is the order the settings dialog shows.
    public static final Map<String, String> KEY_FORMATS = ordered(
            "symb_tid", "trade_종목|t_id",
            "symb_acct_tid", "trade_종목|계좌|t_id");

    // KV/s of the slowest memtable (SKIPLIST) from program start to the last
    // write, measured with the three runs side by side on the i9-12900K at
    // 2M KVs. More consumers barely changed it. Used for the time estimate
    // shown in the settings dialog only; runs are never cut short.
    static final Map<String, Double> RATES = Map.of(
            "queue", 470_000.0,
            "queueWal", 300_000.0,
            "preload", 640_000.0,
            "preloadWal", 380_000.0,
            "accountKeyFactor", 0.87,   // trade_종목|계좌|t_id is slower
            "overheadSeconds", 1.0);    // start, open, final flush

    /** Returns null when valid, otherwise what is wrong, for the user. */
    public String problem() {
        if (kv < KV_MIN || kv > KV_MAX || kv % KV_STEP != 0) {
            return String.format("KV 개수는 %,d부터 %,d까지 %,d 단위입니다.", KV_MIN, KV_MAX, KV_STEP);
        }
        if (memtableMb < MEMTABLE_MIN_MB || memtableMb > MEMTABLE_MAX_MB
                || (memtableMb != MEMTABLE_MIN_MB && memtableMb % MEMTABLE_STEP_MB != 0)) {
            return String.format("memtable 크기는 %dMB 또는 %dMB 단위(최대 %dMB)입니다.",
                    MEMTABLE_MIN_MB, MEMTABLE_STEP_MB, MEMTABLE_MAX_MB);
        }
        if (keyFormat == null || !KEY_FORMATS.containsKey(keyFormat)) {
            return "key 형식은 " + String.join(", ", KEY_FORMATS.keySet()) + " 중 하나입니다.";
        }
        if (consumers < 1 || consumers > CONSUMERS_MAX) {
            return "소비자 개수는 1부터 " + CONSUMERS_MAX + "까지입니다.";
        }
        if (!HASH_HEIGHTS.containsKey(hashHeight)) {
            return "bucket 높이는 4 또는 12입니다.";
        }
        return null;
    }

    /** op_trade_bench arguments for these settings. */
    public List<String> toArgs() {
        List<String> args = new ArrayList<>();
        args.add("--limit=" + kv);
        args.add("--write_buffer_size=" + memtableMb + "MB");
        args.add("--key_format=" + keyFormat);
        args.add("--consumers=" + consumers);
        args.add("--hash_height=" + hashHeight);
        if (preload) {
            args.add("--preload");
        }
        if (!wal) {
            args.add("--disable_wal");
        }
        return args;
    }

    /** Rough wall time of the slowest memtable, in seconds. */
    public double estimateSeconds() {
        double rate = RATES.get((preload ? "preload" : "queue") + (wal ? "Wal" : ""));
        if ("symb_acct_tid".equals(keyFormat)) {
            rate *= RATES.get("accountKeyFactor");
        }
        return kv / rate + RATES.get("overheadSeconds");
    }

    public static Map<String, Object> limits() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kvStep", KV_STEP);
        m.put("kvMin", KV_MIN);
        m.put("kvMax", KV_MAX);
        m.put("memtableMinMb", MEMTABLE_MIN_MB);
        m.put("memtableStepMb", MEMTABLE_STEP_MB);
        m.put("memtableMaxMb", MEMTABLE_MAX_MB);
        m.put("consumersMax", CONSUMERS_MAX);
        m.put("keyFormats", KEY_FORMATS);
        m.put("hashHeights", HASH_HEIGHTS);
        m.put("rates", RATES);
        return m;
    }
}
