package dev.psmsq4.rocksdbdemo;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "demo")
public record DemoProperties(String rocksdbRoot, String benchDir, int maxOutput) {
}
