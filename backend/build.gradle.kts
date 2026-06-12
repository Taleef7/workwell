import org.gradle.api.file.FileTreeElement
import org.gradle.api.specs.Spec

plugins {
	java
	id("org.springframework.boot") version "3.3.5"
	id("io.spring.dependency-management") version "1.1.7"
}

group = "com.workwell"
version = "0.0.1-SNAPSHOT"

java {
	toolchain {
		languageVersion = JavaLanguageVersion.of(21)
	}
}

repositories {
	mavenCentral()
}

extra["testcontainersVersion"] = "1.21.4"

dependencies {
	implementation("org.opencds.cqf.fhir:cqf-fhir-cr:3.26.0")
	implementation("org.opencds.cqf.fhir:cqf-fhir-cql:3.26.0")
	implementation("org.opencds.cqf.fhir:cqf-fhir-utility:3.26.0")
	implementation("info.cqframework:model-jaxb:3.26.0")
	implementation("info.cqframework:elm-jackson:3.26.0")
	implementation("io.modelcontextprotocol.sdk:mcp:0.10.0")
	implementation("io.modelcontextprotocol.sdk:mcp-spring-webmvc:0.10.0")
	implementation("org.springframework.boot:spring-boot-starter-web")
	implementation("org.springframework.boot:spring-boot-starter-data-jpa")
	implementation("org.springframework.boot:spring-boot-starter-security")
	implementation("org.springframework.boot:spring-boot-starter-validation")
	implementation("org.springframework.boot:spring-boot-starter-actuator")
	implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.6.0")
	implementation("com.bucket4j:bucket4j-core:8.10.1")
	implementation("com.github.ben-manes.caffeine:caffeine:3.1.8")
	implementation("org.apache.tika:tika-core:2.9.2")
	implementation("org.springframework.ai:spring-ai-openai-spring-boot-starter:1.0.0-M6")
	implementation("com.sendgrid:sendgrid-java:4.10.2")
	implementation("org.mapstruct:mapstruct:1.6.3")
	annotationProcessor("org.mapstruct:mapstruct-processor:1.6.3")
	implementation("org.flywaydb:flyway-core")
	implementation("org.flywaydb:flyway-database-postgresql")
	runtimeOnly("org.postgresql:postgresql")
	runtimeOnly("org.eclipse.persistence:org.eclipse.persistence.moxy:4.0.2")
	runtimeOnly("ca.uhn.hapi.fhir:hapi-fhir-caching-caffeine:8.4.0")
	testImplementation("org.springframework.boot:spring-boot-starter-test")
	testImplementation("org.springframework.security:spring-security-test")
	testImplementation("org.testcontainers:junit-jupiter")
	testImplementation("org.testcontainers:postgresql")
	testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

dependencyManagement {
	imports {
		mavenBom("org.testcontainers:testcontainers-bom:${property("testcontainersVersion")}")
	}
}

tasks.register<JavaExec>("evaluateMeasure") {
	group = "application"
	description = "Headless: evaluate a patient FHIR bundle JSON against a measure YAML (no Spring, no DB)"
	classpath = sourceSets["main"].runtimeClasspath
	mainClass.set("com.workwell.engine.cli.HeadlessEvaluatorCli")
}

tasks.register<JavaExec>("generateElm") {
	group = "application"
	description = "Build-time CQL -> ELM JSON translator (Path C, #96); emits measure ELM + FHIRHelpers ELM"
	classpath = sourceSets["main"].runtimeClasspath
	mainClass.set("com.workwell.engine.cli.ElmCompilerCli")
}

tasks.withType<Test> {
	useJUnitPlatform()
	// CI forks 4-wide so heavy Spring/CQL/Testcontainers classes in a shard overlap
	// (ubuntu-latest has 4 vCPUs). Override via GRADLE_TEST_FORKS.
	maxParallelForks = System.getenv("GRADLE_TEST_FORKS")?.toIntOrNull()
		?: if (System.getenv("CI") == "true") 4 else 1
	// Cap per-fork heap so 4 JVMs + their Postgres containers fit the runner's RAM;
	// prod runs the app on 768m, so 1.5g per test fork is ample.
	if (System.getenv("CI") == "true") {
		maxHeapSize = "1536m"
	}

	// Optional CI matrix sharding: split the test classes across parallel runner jobs
	// by a stable path hash, so each class runs in exactly one shard and the union of
	// shards 0..TEST_SHARD_TOTAL-1 covers the whole suite. This is the lever that cuts
	// the CQL-heavy backend suite from ~44 min on one runner to a few minutes across
	// several. With no shard env set (local runs), the full suite runs as before.
	val shardTotal = System.getenv("TEST_SHARD_TOTAL")?.toIntOrNull()
	val shardIndex = System.getenv("TEST_SHARD_INDEX")?.toIntOrNull()
	if (shardTotal != null && shardTotal > 1 && shardIndex != null) {
		// FileTreeElement.path is always '/'-separated and relative to the test
		// classes root, so the hash is stable across OSes. Directories must pass so
		// the tree is traversed into; only .class candidates are assigned to a shard.
		include(Spec<FileTreeElement> { element ->
			element.isDirectory ||
				Math.floorMod(element.path.hashCode(), shardTotal) == shardIndex
		})
		doFirst {
			logger.lifecycle("Backend test shard $shardIndex/$shardTotal active")
		}
	}

	// Keep binary in-progress results outside the OneDrive tree so sync cannot
	// race against Gradle's rename of these short-lived files (NoSuchFileException).
	binaryResultsDirectory.set(
		file("${System.getProperty("java.io.tmpdir")}/workwell-test-binary-results/${name}")
	)
}
