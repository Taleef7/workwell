package com.workwell.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.lang.management.ManagementFactory;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Minimal API version surface. The build identifier is read from the JAR
 * manifest Implementation-Version when present, falling back to "unknown"
 * (no git-properties plugin is configured).
 */
@RestController
@Tag(name = "Auth", description = "API metadata")
public class VersionController {

    @Operation(summary = "API version", description = "Returns the API version, build id, and process uptime.")
    @GetMapping("/api/version")
    public Map<String, Object> version() {
        String build = getClass().getPackage().getImplementationVersion();
        long uptimeSeconds = ManagementFactory.getRuntimeMXBean().getUptime() / 1000;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("api", "v1");
        body.put("build", build == null || build.isBlank() ? "unknown" : build);
        body.put("uptime", uptimeSeconds + "s");
        return body;
    }
}
