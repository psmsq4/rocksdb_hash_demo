package dev.psmsq4.rocksdbdemo.run;

import java.time.Instant;

/**
 * State of the latest run of a test.
 *
 * @param state   RUNNING, PASSED, FAILED or TIMED_OUT
 * @param summary gtest summary line(s) when present, otherwise the exit code
 */
public record RunResult(
        String testId,
        String state,
        Instant startedAt,
        Long durationMs,
        Integer exitCode,
        String summary,
        String output) {
}
