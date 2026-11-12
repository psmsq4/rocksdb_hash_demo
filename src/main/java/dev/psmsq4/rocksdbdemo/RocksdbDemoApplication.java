package dev.psmsq4.rocksdbdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class RocksdbDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(RocksdbDemoApplication.class, args);
    }
}
