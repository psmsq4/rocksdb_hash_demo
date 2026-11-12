package dev.psmsq4.rocksdbdemo.catalog;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/** Loads the test catalog from classpath:catalog.json. */
@Component
public class TestCatalog {

    private final Map<String, TestCase> byId = new LinkedHashMap<>();

    public TestCatalog(ObjectMapper mapper) throws IOException {
        try (InputStream in = new ClassPathResource("catalog.json").getInputStream()) {
            List<TestCase> cases = mapper.readValue(in, new TypeReference<>() {});
            for (TestCase c : cases) {
                if (byId.putIfAbsent(c.id(), c) != null) {
                    throw new IllegalStateException("Duplicate test id: " + c.id());
                }
            }
        }
    }

    public List<TestCase> all() {
        return List.copyOf(byId.values());
    }

    public Optional<TestCase> find(String id) {
        return Optional.ofNullable(byId.get(id));
    }
}
