package dev.psmsq4.rocksdbdemo.web;

import dev.psmsq4.rocksdbdemo.bench.Benchmark;
import dev.psmsq4.rocksdbdemo.bench.BenchmarkCatalog;
import dev.psmsq4.rocksdbdemo.bench.RunService;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/benchmarks")
public class BenchController {

    private final BenchmarkCatalog catalog;
    private final RunService runs;

    public BenchController(BenchmarkCatalog catalog, RunService runs) {
        this.catalog = catalog;
        this.runs = runs;
    }

    @GetMapping
    public List<Benchmark> list() {
        return catalog.all();
    }

    /** The latest run of a benchmark, live or finished; 204 before the first. */
    @GetMapping("/{id}/run")
    public ResponseEntity<Map<String, Object>> run(@PathVariable String id) {
        return runs.latest(id)
                .map(r -> ResponseEntity.ok(r.snapshot()))
                .orElse(ResponseEntity.noContent().build());
    }

    @PostMapping("/{id}/run")
    public ResponseEntity<Map<String, Object>> start(@PathVariable String id) {
        Benchmark b = catalog.find(id).orElse(null);
        if (b == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("error", "없는 벤치마크입니다: " + id));
        }
        try {
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(runs.start(b).snapshot());
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/{id}/stop")
    public ResponseEntity<Void> stop(@PathVariable String id) {
        runs.stop(id);
        return ResponseEntity.accepted().build();
    }
}
