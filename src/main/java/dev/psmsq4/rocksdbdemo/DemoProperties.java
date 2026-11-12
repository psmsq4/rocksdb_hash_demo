package dev.psmsq4.rocksdbdemo;

import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @param benchBinary op_trade_bench built by op_trade_bench/build.sh
 * @param workDir     scratch directory for databases and metric dumps
 * @param cpuSets     taskset CPU list per memtable (lower-case key), so the
 *                    three concurrent runs do not share cores
 * @param logLines    output lines kept per run
 * @param tradeFile   TPC-E Trade.txt that op_trade_bench reads by default,
 *                    profiled for the workload description
 * @param perfCounters run each process under perf stat for hardware counters
 */
@ConfigurationProperties(prefix = "demo")
public record DemoProperties(String benchBinary, String workDir, Map<String, String> cpuSets,
                             int logLines, String tradeFile, boolean perfCounters) {

    public String cpuSetFor(String memtable) {
        return cpuSets == null ? null : cpuSets.get(memtable.toLowerCase());
    }
}
