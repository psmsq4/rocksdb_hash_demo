package dev.psmsq4.rocksdbdemo.bench;

import java.util.List;

/**
 * One card on the page.
 *
 * @param id        URL id
 * @param kind      what the page leads with: "flush" or "write"
 * @param title     card title
 * @param summary   one sentence on what the card measures
 * @param defaults  workload settings until the user changes them
 * @param fixedArgs op_trade_bench arguments the settings do not cover
 * @param targets   memtables run side by side
 */
public record Benchmark(String id, String kind, String title, String summary, RunSettings defaults,
                        List<String> fixedArgs, List<String> targets) {
}
