package dev.psmsq4.rocksdbdemo.bench;

import dev.psmsq4.rocksdbdemo.DemoProperties;
import jakarta.annotation.PreDestroy;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Starts every memtable of a benchmark at once, each pinned to its own CPU
 * set, and scrapes their /metrics once a second. One run at a time, so runs
 * never compete for cores.
 */
@Service
public class RunService {

    private static final Logger log = LoggerFactory.getLogger(RunService.class);

    private final DemoProperties props;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(500))
            .build();
    private final ScheduledExecutorService scraper = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "metrics-scraper");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, BenchRun> latest = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private volatile BenchRun active;

    public RunService(DemoProperties props) {
        this.props = props;
        scraper.scheduleAtFixedRate(this::tick, 1000, 1000, TimeUnit.MILLISECONDS);
    }

    public Optional<BenchRun> latest(String benchmarkId) {
        return Optional.ofNullable(latest.get(benchmarkId));
    }

    /** Starts a run, or throws IllegalStateException while another is active. */
    public synchronized BenchRun start(Benchmark b) {
        BenchRun current = active;
        if (current != null && current.isActive()) {
            throw new IllegalStateException("'" + current.benchmark().title()
                    + "' 측정이 진행 중입니다. 끝난 뒤에 다시 시작하세요.");
        }
        Path binary = Path.of(props.benchBinary());
        if (!Files.isExecutable(binary)) {
            throw new IllegalStateException("op_trade_bench가 없습니다: " + binary
                    + " (op_trade_bench/build.sh로 빌드하세요)");
        }
        long id = ids.incrementAndGet();
        List<TargetRun> targets = new ArrayList<>();
        for (String m : b.targets()) {
            targets.add(new TargetRun(m, props.cpuSetFor(m), props.logLines()));
        }
        BenchRun run = new BenchRun(id, b, targets);
        Path dir = Path.of(props.workDir(), "run-" + id);
        for (TargetRun t : targets) {
            launch(run, t, dir.resolve(t.memtable().toLowerCase()), binary);
        }
        latest.put(b.id(), run);
        active = run;
        return run;
    }

    public synchronized void stop(String benchmarkId) {
        BenchRun run = latest.get(benchmarkId);
        if (run == null) {
            return;
        }
        for (TargetRun t : run.targets().values()) {
            t.stop("측정을 중단했습니다.", run.elapsed());
            Process p = t.process();
            if (p != null) {
                p.destroy();
            }
        }
    }

    private void launch(BenchRun run, TargetRun t, Path dir, Path binary) {
        try {
            Files.createDirectories(dir);
            Path dump = dir.resolve("final.prom");
            List<String> cmd = new ArrayList<>();
            String cpus = t.cpuSet();
            if (cpus != null && !cpus.isBlank()) {
                cmd.addAll(List.of("taskset", "-c", cpus));
            }
            cmd.add(binary.toString());
            cmd.add("--memtable=" + t.memtable());
            cmd.addAll(run.benchmark().args());
            cmd.add("--db=" + dir.resolve("db"));
            cmd.add("--progress_ms=0");
            cmd.add("--metrics_port=0");
            cmd.add("--metrics_dump=" + dump);
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            t.started(p);
            Thread.ofVirtual().name("out-" + run.id() + "-" + t.memtable()).start(() -> pump(p, t));
            p.onExit().thenAccept(done -> finished(run, t, done, dir, dump));
        } catch (IOException e) {
            t.fail("시작하지 못했습니다: " + e.getMessage(), run.elapsed());
        }
    }

    private static void pump(Process p, TargetRun t) {
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                t.output(line);
            }
        } catch (IOException ignored) {
            // The process ended.
        }
    }

    private void finished(BenchRun run, TargetRun t, Process p, Path dir, Path dump) {
        double at = run.elapsed();
        try {
            if (Files.exists(dump)) {
                t.ingest(Files.readString(dump), at);
            }
        } catch (IOException | UncheckedIOException e) {
            log.warn("cannot read {}: {}", dump, e.getMessage());
        }
        t.exited(p.exitValue(), at);
        deleteTree(dir.resolve("db"));
    }

    private void tick() {
        BenchRun run = active;
        if (run == null || !run.isActive()) {
            return;
        }
        double elapsed = run.elapsed();
        if (elapsed > run.benchmark().timeoutSeconds()) {
            for (TargetRun t : run.targets().values()) {
                if (t.isActive()) {
                    t.stop(run.benchmark().timeoutSeconds() + "초 제한을 넘어 중단했습니다.", elapsed);
                    Process p = t.process();
                    if (p != null) {
                        p.destroy();
                    }
                }
            }
            return;
        }
        for (TargetRun t : run.targets().values()) {
            int port = t.port();
            if (!t.isActive() || port < 0) {
                continue;
            }
            HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/metrics"))
                    .timeout(Duration.ofMillis(900))
                    .build();
            http.sendAsync(req, HttpResponse.BodyHandlers.ofString())
                    .thenAccept(resp -> {
                        if (resp.statusCode() == 200 && t.isActive()) {
                            t.ingest(resp.body(), run.elapsed());
                        }
                    })
                    .exceptionally(e -> null);  // The process may have just exited.
        }
    }

    private static void deleteTree(Path root) {
        if (!Files.exists(root)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // Best effort; the work dir is scratch space.
                }
            });
        } catch (IOException ignored) {
            // Best effort.
        }
    }

    @PreDestroy
    void shutdown() {
        scraper.shutdownNow();
        BenchRun run = active;
        if (run != null) {
            for (TargetRun t : run.targets().values()) {
                Process p = t.process();
                if (p != null && p.isAlive()) {
                    p.destroy();
                }
            }
        }
    }
}
