package dev.psmsq4.rocksdbdemo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.psmsq4.rocksdbdemo.bench.Benchmark;
import dev.psmsq4.rocksdbdemo.bench.BenchmarkCatalog;
import dev.psmsq4.rocksdbdemo.bench.PerfStat;
import dev.psmsq4.rocksdbdemo.bench.PromText;
import dev.psmsq4.rocksdbdemo.bench.RunSettings;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class RocksdbDemoApplicationTests {

    @Autowired
    BenchmarkCatalog catalog;

    @Autowired
    MockMvc mvc;

    @Test
    void catalogStartsWithTheFlushCard() {
        List<Benchmark> all = catalog.all();
        assertThat(all).isNotEmpty();
        assertThat(all.get(0).id()).isEqualTo("flush");
        assertThat(all).extracting(Benchmark::id).containsExactly("flush", "write", "scan", "get");
        assertThat(all.get(3).defaults().toArgs()).contains("--get_seconds=4");
        // The insert cards verify what they wrote; the read cards do not.
        assertThat(all.get(0).defaults().toArgs()).contains("--verify");
        assertThat(all.get(1).defaults().toArgs()).contains("--verify");
        assertThat(all.get(2).defaults().toArgs()).doesNotContain("--verify");
        assertThat(all.get(2).defaults().toArgs()).contains("--scan_seconds=8", "--scan_length=100");
        assertThat(all.get(1).defaults().consumers()).isGreaterThan(1);
        for (Benchmark b : all) {
            assertThat(b.targets()).isNotEmpty();
            assertThat(b.defaults().problem()).isNull();
            // Defaults stay short enough to demo; the flush card (the first
            // requirement) within 30 s.
            assertThat(b.defaults().estimateSeconds()).isLessThanOrEqualTo(b.id().equals("flush") ? 30 : 40);
            assertThat(b.fixedArgs()).noneMatch(a -> a.startsWith("--memtable") || a.startsWith("--db"));
        }
    }

    @Test
    void settingsValidateAndBecomeArguments() {
        RunSettings ok = new RunSettings(2_300_000, 256, "symb_acct_tid", true, true, 4, 12, true, 0, 100, 0, false);
        assertThat(ok.problem()).isNull();
        assertThat(ok.toArgs()).containsExactly("--limit=2300000", "--write_buffer_size=256MB",
                "--key_format=symb_acct_tid", "--consumers=4", "--hash_height=12", "--preload");
        assertThat(new RunSettings(100_000, 64, "symb_tid", false, false, 1, 4, true, 0, 100, 0, false).problem()).isNull();
        // Concurrent writes off is passed explicitly; on keeps each default.
        assertThat(new RunSettings(100_000, 64, "symb_tid", false, false, 2, 12, false, 0, 100, 0, false).toArgs())
                .contains("--concurrent=0");
        assertThat(ok.toArgs()).noneMatch(a -> a.startsWith("--concurrent"));
        assertThat(ok.toArgs()).noneMatch(a -> a.startsWith("--scan"));
        assertThat(new RunSettings(100_000, 64, "symb_tid", true, false, 1, 12, true, 31, 100, 0, false).problem())
                .isNotNull();
        assertThat(new RunSettings(100_000, 64, "symb_tid", true, false, 1, 12, true, 5, 15, 0, false).problem())
                .isNotNull();
        assertThat(new RunSettings(100_000, 64, "symb_tid", false, false, 1, 7, true, 0, 100, 0, false).problem()).isNotNull();
        assertThat(new RunSettings(10_000_000, 64, "symb_tid", false, false, 1, 12, true, 0, 100, 0, false).toArgs())
                .contains("--disable_wal").doesNotContain("--preload");

        assertThat(new RunSettings(150_000, 64, "symb_tid", false, false, 1, 12, true, 0, 100, 0, false).problem()).isNotNull();
        assertThat(new RunSettings(100_000, 100, "symb_tid", false, false, 1, 12, true, 0, 100, 0, false).problem()).isNotNull();
        assertThat(new RunSettings(100_000, 4096, "symb_tid", false, false, 1, 12, true, 0, 100, 0, false).problem()).isNotNull();
        assertThat(new RunSettings(100_000, 64, "nope", false, false, 1, 12, true, 0, 100, 0, false).problem()).isNotNull();
        assertThat(new RunSettings(100_000, 64, "symb_tid", false, false, 9, 12, true, 0, 100, 0, false).problem()).isNotNull();
        // Larger and WAL-on workloads are estimated to take longer.
        assertThat(new RunSettings(30_000_000, 64, "symb_tid", false, false, 1, 12, true, 0, 100, 0, false).estimateSeconds())
                .isGreaterThan(new RunSettings(10_000_000, 64, "symb_tid", false, false, 1, 12, true, 0, 100, 0, false).estimateSeconds());
        assertThat(new RunSettings(10_000_000, 64, "symb_tid", false, true, 1, 12, true, 0, 100, 0, false).estimateSeconds())
                .isGreaterThan(new RunSettings(10_000_000, 64, "symb_tid", false, false, 1, 12, true, 0, 100, 0, false).estimateSeconds());
    }

    @Test
    void parsesPerfStatCsv() {
        var c = PerfStat.parse("""
                # started on Thu Nov 12 2026

                138955752527,,cpu_core/cycles/u,155161436,100.00,,
                134151215778,,cpu_core/instructions/u,155161436,100.00,0.97,insn per cycle
                <not counted>,,cpu_core/dTLB-load-misses/u,0,0.00,,
                1359592877,,cache-misses:u,155161436,100.00,,
                """);
        assertThat(c).containsEntry("cycles", 138955752527d)
                .containsEntry("instructions", 134151215778d)
                .containsEntry("llcMisses", 1359592877d)
                .doesNotContainKey("tlbMisses");
    }

    @Test
    void parsesPrometheusText() {
        List<PromText.Line> lines = PromText.parse("""
                # HELP x
                otb_phase 2
                otb_flush_event_ms{seq="3",end_s="1.250",reason="Write Buffer Full"} 153.5
                rocksdb_ticker{name="rocksdb.bytes.written"} 912622955
                """);
        assertThat(lines).hasSize(3);
        assertThat(lines.get(0).value()).isEqualTo(2);
        assertThat(lines.get(1).label("reason")).isEqualTo("Write Buffer Full");
        assertThat(lines.get(1).label("end_s")).isEqualTo("1.250");
        assertThat(lines.get(2).value()).isEqualTo(912622955d);
    }

    @Test
    void listsBenchmarksAndRejectsUnknownOnes() throws Exception {
        mvc.perform(get("/api/benchmarks"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("flush"))
                .andExpect(jsonPath("$[0].targets.length()").value(3))
                .andExpect(jsonPath("$[0].settings.kv").value(10_000_000))
                .andExpect(jsonPath("$[0].settings.hashHeight").value(12));
        mvc.perform(get("/api/benchmarks/flush/run")).andExpect(status().isNoContent());
        // Profiles Trade.txt when present, otherwise says why not.
        mvc.perform(get("/api/workload"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.available").exists())
                .andExpect(jsonPath("$.file").exists());
        mvc.perform(post("/api/benchmarks/nope/run")).andExpect(status().isNotFound());
    }

    @Test
    @DirtiesContext
    void updatesSettingsAndRejectsBadOnes() throws Exception {
        mvc.perform(get("/api/benchmarks/flush/settings"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.limits.kvStep").value(100_000))
                .andExpect(jsonPath("$.limits.memtableStepMb").value(128));
        mvc.perform(put("/api/benchmarks/flush/settings").contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"kv":500000,"memtableMb":128,"keyFormat":"symb_acct_tid",
                                 "preload":true,"wal":true,"consumers":2,"hashHeight":4,"concurrent":false,"scanSeconds":0,"scanLength":100,"getSeconds":0,"verify":false}"""))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.settings.memtableMb").value(128));
        mvc.perform(get("/api/benchmarks"))
                .andExpect(jsonPath("$[0].settings.keyFormat").value("symb_acct_tid"));
        mvc.perform(put("/api/benchmarks/flush/settings").contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"kv":123,"memtableMb":128,"keyFormat":"symb_tid",
                                 "preload":false,"wal":false,"consumers":1,"hashHeight":12,"concurrent":true,"scanSeconds":0,"scanLength":100,"getSeconds":0,"verify":false}"""))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").exists());
    }
}
