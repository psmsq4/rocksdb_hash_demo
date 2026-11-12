package dev.psmsq4.rocksdbdemo.bench;

import java.util.List;

/**
 * One card on the page: op_trade_bench arguments shared by every memtable.
 *
 * @param id              URL id
 * @param title           card title
 * @param summary         one sentence on what the card measures
 * @param specs           workload facts shown as chips
 * @param args            op_trade_bench arguments, without --memtable, --db
 *                        and the metrics flags
 * @param targets         memtables run side by side
 * @param expectedSeconds rough wall time of the slowest memtable
 * @param timeoutSeconds  runs still alive after this are stopped
 */
public record Benchmark(String id, String title, String summary, List<Spec> specs,
                        List<String> args, List<String> targets, int expectedSeconds,
                        int timeoutSeconds) {

    public record Spec(String label, String value) {
    }
}
