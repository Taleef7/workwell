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
	implementation("org.springframework.ai:spring-ai-openai-spring-boot-starter:1.0.0-M6")
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

tasks.withType<Test> {
	useJUnitPlatform()
	// CI gets two forks so long-running Spring/Testcontainers classes can overlap
	// without turning the runner into a noisy stampede.
	maxParallelForks = if (System.getenv("CI") == "true") 2 else 1
	// Keep binary in-progress results outside the OneDrive tree so sync cannot
	// race against Gradle's rename of these short-lived files (NoSuchFileException).
	binaryResultsDirectory.set(
		file("${System.getProperty("java.io.tmpdir")}/workwell-test-binary-results/${name}")
	)
}
