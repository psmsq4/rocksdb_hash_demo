package dev.psmsq4.rocksdbdemo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.psmsq4.rocksdbdemo.catalog.TestCase;
import dev.psmsq4.rocksdbdemo.catalog.TestCatalog;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class RocksdbDemoApplicationTests {

    @Autowired
    TestCatalog catalog;

    @Autowired
    MockMvc mvc;

    @Test
    void catalogEntriesAreConsistent() {
        assertThat(catalog.all()).isNotEmpty();
        for (TestCase t : catalog.all()) {
            assertThat(t.status()).isIn("runnable", "recorded", "planned");
            assertThat(t.runnable()).as(t.id()).isEqualTo("runnable".equals(t.status()));
            if (t.runnable()) {
                assertThat(t.timeoutSec()).as(t.id()).isPositive();
            }
            for (TestCase.ResultTable table : t.results()) {
                for (var row : table.rows()) {
                    assertThat(row).as(t.id() + " / " + table.caption()).hasSameSizeAs(table.headers());
                }
            }
        }
    }

    @Test
    void listsTests() throws Exception {
        mvc.perform(get("/api/tests"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("unit-prefix-test"));
    }

    @Test
    void rejectsUnknownAndNonRunnableTests() throws Exception {
        mvc.perform(post("/api/tests/no-such-test/run")).andExpect(status().isNotFound());
        mvc.perform(post("/api/tests/demo-noop/run")).andExpect(status().isBadRequest());
    }
}
