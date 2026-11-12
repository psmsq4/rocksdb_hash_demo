package dev.psmsq4.rocksdbdemo.bench;

import dev.psmsq4.rocksdbdemo.DemoProperties;
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * What the Trade.txt workload looks like, from its first rows: how many
 * prefixes (symbols) there are, how KVs spread over them and how big keys and
 * values are. Computed once and cached.
 */
@Service
public class WorkloadProfile {

    static final int SAMPLE_ROWS = 2_000_000;
    // Trade.txt columns op_trade_bench uses.
    private static final int T_ID = 0;
    private static final int T_DTS = 1;
    private static final int T_S_SYMB = 5;
    private static final int T_CA_ID = 8;
    private static final int COLUMNS = 15;

    private final Path file;
    private volatile Map<String, Object> cached;

    public WorkloadProfile(DemoProperties props) {
        this.file = Path.of(props.tradeFile());
    }

    public Map<String, Object> get() {
        Map<String, Object> c = cached;
        if (c == null) {
            synchronized (this) {
                if (cached == null) {
                    cached = compute();
                }
                c = cached;
            }
        }
        return c;
    }

    private Map<String, Object> compute() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("file", file.toString());
        if (!Files.isReadable(file)) {
            m.put("available", false);
            m.put("error", "Trade.txt를 읽을 수 없습니다: " + file);
            return m;
        }
        Map<String, Integer> perSymbol = new HashMap<>();
        Set<String> accounts = new HashSet<>();
        long rows = 0;
        long bytes = 0;
        long valueBytes = 0;
        long keyBytes = 0;          // trade_<symb>|<t_id>
        long accountKeyBytes = 0;   // trade_<symb>|<ca_id>|<t_id>
        String firstTime = null;
        String lastTime = null;
        String[] f = new String[COLUMNS];
        try (BufferedReader r = Files.newBufferedReader(file, StandardCharsets.ISO_8859_1)) {
            for (String line; rows < SAMPLE_ROWS && (line = r.readLine()) != null; ) {
                if (!split(line, f)) {
                    continue;
                }
                rows++;
                bytes += line.length() + 1;
                perSymbol.merge(f[T_S_SYMB], 1, Integer::sum);
                accounts.add(f[T_CA_ID]);
                // The value is the row without the symbol column and one '|'.
                valueBytes += line.length() - f[T_S_SYMB].length() - 1;
                int key = "trade_".length() + f[T_S_SYMB].length() + 1 + f[T_ID].length();
                keyBytes += key;
                accountKeyBytes += key + f[T_CA_ID].length() + 1;
                if (firstTime == null) {
                    firstTime = f[T_DTS];
                }
                lastTime = f[T_DTS];
            }
            long size = Files.size(file);
            List<Integer> counts = new ArrayList<>(perSymbol.values());
            Collections.sort(counts);
            m.put("available", true);
            m.put("fileBytes", size);
            m.put("sampledRows", rows);
            m.put("estimatedRows", rows == 0 ? 0 : Math.round((double) size / bytes * rows));
            m.put("symbols", perSymbol.size());
            m.put("accounts", accounts.size());
            m.put("perSymbolMin", counts.isEmpty() ? 0 : counts.get(0));
            m.put("perSymbolMedian", counts.isEmpty() ? 0 : counts.get(counts.size() / 2));
            m.put("perSymbolMax", counts.isEmpty() ? 0 : counts.get(counts.size() - 1));
            m.put("avgValueBytes", rows == 0 ? 0 : Math.round((double) valueBytes / rows));
            m.put("avgKeyBytes", Map.of(
                    "symb_tid", rows == 0 ? 0 : Math.round((double) keyBytes / rows),
                    "symb_acct_tid", rows == 0 ? 0 : Math.round((double) accountKeyBytes / rows)));
            m.put("firstTime", firstTime);
            m.put("lastTime", lastTime);
        } catch (IOException e) {
            m.put("available", false);
            m.put("error", "Trade.txt를 읽지 못했습니다: " + e.getMessage());
        }
        return m;
    }

    private static boolean split(String line, String[] out) {
        int n = 0;
        int start = 0;
        while (n < COLUMNS) {
            int end = line.indexOf('|', start);
            out[n++] = end < 0 ? line.substring(start) : line.substring(start, end);
            if (end < 0) {
                break;
            }
            start = end + 1;
        }
        return n == COLUMNS && !out[T_S_SYMB].isEmpty();
    }
}
