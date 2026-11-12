package dev.psmsq4.rocksdbdemo.web;

import dev.psmsq4.rocksdbdemo.bench.Benchmark;
import dev.psmsq4.rocksdbdemo.bench.BenchmarkCatalog;
import dev.psmsq4.rocksdbdemo.bench.RunService;
import dev.psmsq4.rocksdbdemo.bench.RunSettings;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
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

    /** Every card with its current settings. */
    @GetMapping
    public List<Map<String, Object>> list() {
        return catalog.all().stream().map(this::describe).toList();
    }

    /** Current settings, the defaults and the allowed ranges. */
    @GetMapping("/{id}/settings")
    public ResponseEntity<Map<String, Object>> settings(@PathVariable String id) {
        return catalog.find(id)
                .map(b -> ResponseEntity.ok(describeSettings(b)))
                .orElse(ResponseEntity.notFound().build());
    }

    @PutMapping("/{id}/settings")
    public ResponseEntity<Map<String, Object>> updateSettings(@PathVariable String id,
                                                              @RequestBody RunSettings s) {
        Benchmark b = catalog.find(id).orElse(null);
        if (b == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("error", "없는 벤치마크입니다: " + id));
        }
        String problem = catalog.update(b, s);
        if (problem != null) {
            return ResponseEntity.badRequest().body(Map.of("error", problem));
        }
        return ResponseEntity.ok(describeSettings(b));
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
            return ResponseEntity.status(HttpStatus.ACCEPTED)
                    .body(runs.start(b, catalog.settings(b)).snapshot());
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/{id}/stop")
    public ResponseEntity<Void> stop(@PathVariable String id) {
        runs.stop(id);
        return ResponseEntity.accepted().build();
    }

    private Map<String, Object> describe(Benchmark b) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", b.id());
        m.put("kind", b.kind());
        m.put("title", b.title());
        m.put("summary", b.summary());
        m.put("targets", b.targets());
        m.put("settings", catalog.settings(b));
        return m;
    }

    private Map<String, Object> describeSettings(Benchmark b) {
        RunSettings s = catalog.settings(b);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("settings", s);
        m.put("defaults", b.defaults());
        m.put("limits", RunSettings.limits());
        m.put("estimateSeconds", Math.round(s.estimateSeconds() * 10) / 10.0);
        return m;
    }
}
