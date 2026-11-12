package dev.psmsq4.rocksdbdemo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.psmsq4.rocksdbdemo.bench.Benchmark;
import dev.psmsq4.rocksdbdemo.bench.BenchmarkCatalog;
import dev.psmsq4.rocksdbdemo.bench.PromText;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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
        for (Benchmark b : all) {
            assertThat(b.targets()).isNotEmpty();
            assertThat(b.timeoutSeconds()).isLessThanOrEqualTo(30);
            assertThat(b.args()).noneMatch(a -> a.startsWith("--memtable") || a.startsWith("--db"));
        }
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
                .andExpect(jsonPath("$[0].targets.length()").value(3));
        mvc.perform(get("/api/benchmarks/flush/run")).andExpect(status().isNoContent());
        mvc.perform(post("/api/benchmarks/nope/run")).andExpect(status().isNotFound());
    }
}
