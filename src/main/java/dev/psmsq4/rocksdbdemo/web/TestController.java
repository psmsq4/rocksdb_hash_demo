package dev.psmsq4.rocksdbdemo.web;

import dev.psmsq4.rocksdbdemo.catalog.TestCase;
import dev.psmsq4.rocksdbdemo.catalog.TestCatalog;
import dev.psmsq4.rocksdbdemo.run.RunResult;
import dev.psmsq4.rocksdbdemo.run.TestRunner;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/tests")
public class TestController {

    private final TestCatalog catalog;
    private final TestRunner runner;

    public TestController(TestCatalog catalog, TestRunner runner) {
        this.catalog = catalog;
        this.runner = runner;
    }

    @GetMapping
    public List<TestCase> list() {
        return catalog.all();
    }

    @GetMapping("/{id}")
    public TestCase get(@PathVariable String id) {
        return find(id);
    }

    @PostMapping("/{id}/run")
    public ResponseEntity<RunResult> run(@PathVariable String id) {
        TestCase test = find(id);
        if (!test.runnable()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Test has no commands: " + id);
        }
        if (!runner.submit(test)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Already running: " + id);
        }
        return ResponseEntity.accepted().body(runner.latest(id).orElseThrow());
    }

    @GetMapping("/{id}/run")
    public ResponseEntity<RunResult> latestRun(@PathVariable String id) {
        find(id);
        return runner.latest(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    private TestCase find(String id) {
        return catalog.find(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown test: " + id));
    }
}
