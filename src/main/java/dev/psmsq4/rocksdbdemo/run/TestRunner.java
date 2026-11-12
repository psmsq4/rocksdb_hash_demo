package dev.psmsq4.rocksdbdemo.run;

import dev.psmsq4.rocksdbdemo.DemoProperties;
import dev.psmsq4.rocksdbdemo.catalog.TestCase;
import jakarta.annotation.PreDestroy;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Runs catalog commands one test at a time. RocksDB tests and benches are
 * CPU and memory heavy, so runs never overlap.
 */
@Service
public class TestRunner {

    private static final Pattern GTEST_SUMMARY =
            Pattern.compile("^\\[ *(PASSED|FAILED) *\\].*tests?.*$|^\\[==========\\].*ran\\..*$");

    private final DemoProperties props;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, RunResult> latest = new ConcurrentHashMap<>();
    private final Map<String, StringBuilder> liveOutput = new ConcurrentHashMap<>();

    public TestRunner(DemoProperties props) {
        this.props = props;
    }

    /** Queues a run. Returns false if this test is already queued or running. */
    public synchronized boolean submit(TestCase test) {
        RunResult current = latest.get(test.id());
        if (current != null && "RUNNING".equals(current.state())) {
            return false;
        }
        latest.put(test.id(), new RunResult(test.id(), "RUNNING", Instant.now(), null, null, "queued", ""));
        executor.submit(() -> run(test));
        return true;
    }

    public Optional<RunResult> latest(String testId) {
        RunResult r = latest.get(testId);
        if (r == null) {
            return Optional.empty();
        }
        StringBuilder live = liveOutput.get(testId);
        if ("RUNNING".equals(r.state()) && live != null) {
            synchronized (live) {
                r = new RunResult(r.testId(), r.state(), r.startedAt(), null, null, r.summary(), live.toString());
            }
        }
        return Optional.of(r);
    }

    private void run(TestCase test) {
        Instant start = Instant.now();
        StringBuilder out = new StringBuilder();
        liveOutput.put(test.id(), out);
        latest.put(test.id(), new RunResult(test.id(), "RUNNING", start, null, null, "running", ""));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(test.timeoutSec());
        String state = "PASSED";
        Integer exitCode = 0;
        try {
            for (List<String> argv : test.commands()) {
                List<String> resolved = resolve(argv);
                append(out, "$ " + String.join(" ", resolved) + "\n");
                Process p = new ProcessBuilder(resolved)
                        .directory(new File(props.rocksdbRoot()))
                        .redirectErrorStream(true)
                        .start();
                Thread reader = Thread.ofVirtual().start(() -> pump(p, out));
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0 || !p.waitFor(remaining, TimeUnit.NANOSECONDS)) {
                    p.descendants().forEach(ProcessHandle::destroyForcibly);
                    p.destroyForcibly();
                    reader.join(Duration.ofSeconds(5));
                    state = "TIMED_OUT";
                    exitCode = null;
                    break;
                }
                reader.join(Duration.ofSeconds(5));
                exitCode = p.exitValue();
                if (exitCode != 0) {
                    state = "FAILED";
                    break;
                }
            }
        } catch (IOException e) {
            append(out, "\n[runner] " + e.getMessage() + "\n");
            state = "FAILED";
            exitCode = null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            state = "FAILED";
            exitCode = null;
        }
        String output;
        synchronized (out) {
            output = out.toString();
        }
        latest.put(test.id(), new RunResult(test.id(), state, start,
                Duration.between(start, Instant.now()).toMillis(), exitCode,
                summarize(output, exitCode), output));
        liveOutput.remove(test.id());
    }

    private List<String> resolve(List<String> argv) {
        List<String> resolved = new ArrayList<>(argv.size());
        for (String arg : argv) {
            resolved.add(arg.replace("${root}", props.rocksdbRoot()).replace("${bench}", props.benchDir()));
        }
        return resolved;
    }

    private void pump(Process p, StringBuilder out) {
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                append(out, line + "\n");
            }
        } catch (IOException ignored) {
            // The process was killed; the run result records why.
        }
    }

    private void append(StringBuilder out, String s) {
        synchronized (out) {
            out.append(s);
            int excess = out.length() - props.maxOutput();
            if (excess > 0) {
                out.delete(0, excess);
            }
        }
    }

    static String summarize(String output, Integer exitCode) {
        List<String> lines = output.lines()
                .filter(l -> GTEST_SUMMARY.matcher(l).matches())
                .toList();
        if (!lines.isEmpty()) {
            return String.join(" / ", lines);
        }
        return exitCode == null ? "no exit code" : "exit code " + exitCode;
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }
}
