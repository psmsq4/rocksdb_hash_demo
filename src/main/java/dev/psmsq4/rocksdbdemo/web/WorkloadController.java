package dev.psmsq4.rocksdbdemo.web;

import dev.psmsq4.rocksdbdemo.bench.WorkloadProfile;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WorkloadController {

    private final WorkloadProfile profile;

    public WorkloadController(WorkloadProfile profile) {
        this.profile = profile;
    }

    /** Shape of the Trade.txt workload, from its first rows. */
    @GetMapping("/api/workload")
    public Map<String, Object> workload() {
        return profile.get();
    }
}
