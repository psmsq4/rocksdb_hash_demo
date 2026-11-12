package dev.psmsq4.rocksdbdemo.bench;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Parses the Prometheus text exposition format that op_trade_bench serves. */
public final class PromText {

    public record Line(String name, Map<String, String> labels, double value) {
        public String label(String key) {
            return labels.getOrDefault(key, "");
        }
    }

    private PromText() {
    }

    public static List<Line> parse(String text) {
        List<Line> out = new ArrayList<>();
        for (String raw : text.split("\n")) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int brace = line.indexOf('{');
            int valueStart;
            String name;
            Map<String, String> labels = new LinkedHashMap<>();
            if (brace >= 0) {
                int close = line.lastIndexOf('}');
                if (close < brace) {
                    continue;
                }
                name = line.substring(0, brace);
                parseLabels(line.substring(brace + 1, close), labels);
                valueStart = close + 1;
            } else {
                valueStart = line.indexOf(' ');
                if (valueStart < 0) {
                    continue;
                }
                name = line.substring(0, valueStart);
            }
            String rest = line.substring(valueStart).strip();
            int end = rest.indexOf(' ');
            try {
                double value = Double.parseDouble(end < 0 ? rest : rest.substring(0, end));
                out.add(new Line(name, labels, value));
            } catch (NumberFormatException ignored) {
                // Skip malformed samples.
            }
        }
        return out;
    }

    private static void parseLabels(String s, Map<String, String> out) {
        int i = 0;
        while (i < s.length()) {
            int eq = s.indexOf('=', i);
            if (eq < 0 || eq + 1 >= s.length() || s.charAt(eq + 1) != '"') {
                return;
            }
            String key = s.substring(i, eq).strip();
            StringBuilder value = new StringBuilder();
            int j = eq + 2;
            for (; j < s.length() && s.charAt(j) != '"'; j++) {
                char c = s.charAt(j);
                if (c == '\\' && j + 1 < s.length()) {
                    c = s.charAt(++j);
                }
                value.append(c);
            }
            out.put(key, value.toString());
            i = j + 1;
            if (i < s.length() && s.charAt(i) == ',') {
                i++;
            }
        }
    }
}
