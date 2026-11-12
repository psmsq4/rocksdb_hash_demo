package dev.psmsq4.rocksdbdemo.catalog;

import java.util.List;

/**
 * One entry of the test catalog.
 *
 * @param status   "runnable" (has commands), "recorded" (results measured
 *                 earlier) or "planned" (demo scenario not built yet)
 * @param commands argv lists run in order; "${root}" and "${bench}" are
 *                 replaced with the configured directories
 * @param results  tables of results measured so far
 */
public record TestCase(
        String id,
        String category,
        String title,
        String description,
        String status,
        List<List<String>> commands,
        int timeoutSec,
        List<ResultTable> results,
        List<String> notes) {

    public boolean runnable() {
        return commands != null && !commands.isEmpty();
    }

    public record ResultTable(String caption, List<String> headers, List<List<String>> rows) {
    }
}
