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
 * @param concurrent  allow_concurrent_memtable_write for HEAD and SKIPLIST
 *                    (RocksDB's default); UPSTREAM cannot, so it is always off
 * @param scanSeconds seconds of prefix scans and then of total-order scans after
 *                    the load; 0 for no scans
 * @param scanLength  entries each scan reads
 * @param getSeconds  seconds each of point lookups for written keys, missing keys
 *                    and unknown symbols after the load; 0 for none
 * @param verify      hash every (key, value) in key order before and after a full
 *                    flush, to show all memtables stored the same data
 */
public record RunSettings(long kv, int memtableMb, String keyFormat, boolean preload, boolean wal,
                          int consumers, int hashHeight, boolean concurrent, int scanSeconds,
                          int scanLength, int getSeconds, boolean verify) {

    public static final long KV_STEP = 100_000;
    public static final long KV_MIN = 100_000;
    public static final long KV_MAX = 30_000_000;
    public static final int MEMTABLE_MIN_MB = 64;
    public static final int MEMTABLE_STEP_MB = 128;
    public static final int MEMTABLE_MAX_MB = 2048;
    public static final int CONSUMERS_MAX = 8;
    public static final int SCAN_SECONDS_MAX = 30;
    public static final int GET_SECONDS_MAX = 30;
    public static final int SCAN_LENGTH_STEP = 10;
    public static final int SCAN_LENGTH_MAX = 1000;
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
            // Preload with several writers: UPSTREAM (no concurrent memtable
            // writes) becomes the slowest; 4 writers, 10M account keys, 512MB
            // took 30 s in all (26.7 s of writes).
            "multiWriterFactor", 0.6,
            // Verification: two full reads (about 3.7M KVs/s) and a flush of
            // what is still in the memtable (about 2.3M KVs/s, ~5,500 KVs
            // per MB of memtable).
            "verifyReadKvPerS", 3_700_000.0,
            "flushKvPerS", 2_300_000.0,
            "kvPerMemtableMb", 5_500.0,
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
        if (scanSeconds < 0 || scanSeconds > SCAN_SECONDS_MAX) {
            return "scan 시간은 0부터 " + SCAN_SECONDS_MAX + "초까지입니다.";
        }
        if (getSeconds < 0 || getSeconds > GET_SECONDS_MAX) {
            return "조회 시간은 0부터 " + GET_SECONDS_MAX + "초까지입니다.";
        }
        if (scanLength < SCAN_LENGTH_STEP || scanLength > SCAN_LENGTH_MAX
                || scanLength % SCAN_LENGTH_STEP != 0) {
            return "scan 길이는 " + SCAN_LENGTH_STEP + "부터 " + SCAN_LENGTH_MAX + "까지 "
                    + SCAN_LENGTH_STEP + " 단위입니다.";
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
        // Leaving it out keeps each memtable's default: on for HEAD and
        // SKIPLIST, off for UPSTREAM (which would reject --concurrent=1).
        if (!concurrent) {
            args.add("--concurrent=0");
        }
        if (scanSeconds > 0) {
            args.add("--scan_seconds=" + scanSeconds);
            args.add("--scan_length=" + scanLength);
        }
        if (getSeconds > 0) {
            args.add("--get_seconds=" + getSeconds);
        }
        if (verify) {
            args.add("--verify");
        }
        return args;
    }

    /** Rough wall time of the slowest memtable, in seconds. */
    public double estimateSeconds() {
        double rate = RATES.get((preload ? "preload" : "queue") + (wal ? "Wal" : ""));
        if ("symb_acct_tid".equals(keyFormat)) {
            rate *= RATES.get("accountKeyFactor");
        }
        if (preload && consumers > 1) {
            rate *= RATES.get("multiWriterFactor");
        }
        // Prefix scans, then total-order scans, each for scanSeconds; then
        // three kinds of point lookups, each for getSeconds.
        double verifySeconds = !verify ? 0
                : 2.0 * kv / RATES.get("verifyReadKvPerS")
                        + Math.min(kv, memtableMb * RATES.get("kvPerMemtableMb")) / RATES.get("flushKvPerS");
        return kv / rate + RATES.get("overheadSeconds") + 2.0 * scanSeconds + 3.0 * getSeconds
                + verifySeconds;
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
        m.put("scanSecondsMax", SCAN_SECONDS_MAX);
        m.put("getSecondsMax", GET_SECONDS_MAX);
        m.put("scanLengthStep", SCAN_LENGTH_STEP);
        m.put("scanLengthMax", SCAN_LENGTH_MAX);
        m.put("keyFormats", KEY_FORMATS);
        m.put("hashHeights", HASH_HEIGHTS);
        m.put("rates", RATES);
        return m;
    }
}
