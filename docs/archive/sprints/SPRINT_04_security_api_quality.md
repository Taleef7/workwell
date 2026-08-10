# Sprint 4 — Security, API Quality, and Hardening

**Sprint Goal:** The API is defensible in a live demo: JWT refresh works end-to-end without silent logout, rate limiting prevents embarrassing self-DoS during the demo, all public endpoints are documented in Swagger UI, and uploaded evidence files are validated before storage.

**Effort estimate:** 2–3 developer days  
**Priority:** Medium  
**Prerequisite:** Sprint 0 complete; Sprint 3 (employee profile) helpful but not required

---

## Issue 4.1 — JWT Access Tokens Expire and Silently Log the User Out

### Current behavior
JWT access tokens are issued at login with a fixed expiry (e.g., 1 hour). When a token expires mid-session, the next API call returns HTTP 401. The frontend `ApiClient` catches the 401, calls `onUnauthorized()`, which redirects to `/login` — losing any unsaved work. There is no refresh token mechanism. During a live demo this is catastrophic: if a demo runs more than 60 minutes, the presenter gets silently ejected mid-flow.

### Desired behavior
- Short-lived access tokens (15 minutes) paired with long-lived refresh tokens (8 hours).
- When `ApiClient` receives a 401 on any request, it automatically attempts one silent refresh against `POST /api/auth/refresh`.
- If refresh succeeds, the original request is retried once with the new access token.
- If refresh fails (expired, invalid, or network error), the user is redirected to `/login`.
- The refresh token is stored in an `HttpOnly` secure cookie (not localStorage).
- A `/api/auth/logout` endpoint clears the refresh token cookie.
- Session inactivity of > 8 hours results in full re-login.

### Root cause
Only one token type is issued. The frontend does not retry on 401. Refresh infrastructure (endpoint, storage, silent retry) does not exist.

### Files to modify / create

**Backend:**
- Modify: `backend/src/main/java/com/workwell/security/JwtService.java` — add `generateRefreshToken()` and `validateRefreshToken()`
- Modify: `backend/src/main/java/com/workwell/web/AuthController.java` — add `/api/auth/refresh` and `/api/auth/logout` endpoints; set refresh token as `HttpOnly` cookie on login
- Modify: `backend/src/main/java/com/workwell/config/SecurityConfig.java` — permit `/api/auth/refresh` without auth

**Frontend:**
- Modify: `frontend/lib/api/client.ts` — add silent retry logic on 401
- Modify: `frontend/components/auth-provider.tsx` — consume refresh token from cookie, update `logout()` to call `/api/auth/logout`

### Implementation steps

**Step 1: Add refresh token generation to `JwtService`**

> **jjwt version check:** The API changed in jjwt 0.12.x. Confirm which version is on the classpath before implementing:
> - jjwt ≤ 0.11.x: use `Jwts.builder().setSubject(...)`, `setIssuedAt(...)`, `setExpiration(...)`
> - jjwt ≥ 0.12.x: use `Jwts.builder().subject(...)`, `issuedAt(...)`, `expiration(...)`
> The snippet below uses the 0.11.x API. Adjust to match the actual version in `build.gradle.kts`.

```java
// In JwtService.java, add:
private static final long REFRESH_EXPIRY_HOURS = 8;

public String generateRefreshToken(String username) {
    return Jwts.builder()
        .setSubject(username)
        .claim("refresh", true)  // custom claim — avoid shadowing the standard "typ" header
        .setIssuedAt(new Date())
        .setExpiration(new Date(System.currentTimeMillis() + REFRESH_EXPIRY_HOURS * 3_600_000L))
        .signWith(getSigningKey(), SignatureAlgorithm.HS256)
        .compact();
}

public boolean validateRefreshToken(String token) {
    try {
        Claims claims = parseClaims(token);
        return Boolean.TRUE.equals(claims.get("refresh", Boolean.class));
    } catch (JwtException e) {
        return false;
    }
}

public String extractUsernameFromRefresh(String token) {
    return parseClaims(token).getSubject();
}
```

**Step 2: Issue refresh token as HttpOnly cookie on login**
```java
// In AuthController.java, modify the login endpoint response:
@PostMapping("/api/auth/login")
public ResponseEntity<LoginResponse> login(@RequestBody LoginRequest req, HttpServletResponse response) {
    // ... existing authentication logic ...
    String accessToken = jwtService.generateToken(username, roles);
    String refreshToken = jwtService.generateRefreshToken(username);

    ResponseCookie refreshCookie = ResponseCookie.from("refresh_token", refreshToken)
        .httpOnly(true)
        .secure(true)
        .path("/api/auth")
        .maxAge(Duration.ofHours(8))
        .sameSite("Strict")
        .build();
    response.addHeader(HttpHeaders.SET_COOKIE, refreshCookie.toString());

    return ResponseEntity.ok(new LoginResponse(accessToken, username, roles));
}
```

**Step 3: Add refresh endpoint**
```java
@PostMapping("/api/auth/refresh")
public ResponseEntity<LoginResponse> refresh(HttpServletRequest request, HttpServletResponse response) {
    String refreshToken = Arrays.stream(Optional.ofNullable(request.getCookies()).orElse(new Cookie[0]))
        .filter(c -> "refresh_token".equals(c.getName()))
        .map(Cookie::getValue)
        .findFirst()
        .orElse(null);

    if (refreshToken == null || !jwtService.validateRefreshToken(refreshToken)) {
        return ResponseEntity.status(401).build();
    }

    String username = jwtService.extractUsernameFromRefresh(refreshToken);
    UserDetails user = userDetailsService.loadUserByUsername(username);
    List<String> roles = user.getAuthorities().stream()
        .map(GrantedAuthority::getAuthority)
        .toList();

    String newAccessToken = jwtService.generateToken(username, roles);
    // Rotate refresh token
    String newRefreshToken = jwtService.generateRefreshToken(username);
    ResponseCookie refreshCookie = ResponseCookie.from("refresh_token", newRefreshToken)
        .httpOnly(true).secure(true).path("/api/auth")
        .maxAge(Duration.ofHours(8)).sameSite("Strict").build();
    response.addHeader(HttpHeaders.SET_COOKIE, refreshCookie.toString());

    return ResponseEntity.ok(new LoginResponse(newAccessToken, username, roles));
}

@PostMapping("/api/auth/logout")
public ResponseEntity<Void> logout(HttpServletResponse response) {
    ResponseCookie clear = ResponseCookie.from("refresh_token", "")
        .httpOnly(true).secure(true).path("/api/auth")
        .maxAge(0).sameSite("Strict").build();
    response.addHeader(HttpHeaders.SET_COOKIE, clear.toString());
    return ResponseEntity.noContent().build();
}
```

**Step 4: Add silent retry in `ApiClient`**

> Use a boolean parameter `retried` rather than inspecting headers to guard against infinite retry loops. `HeadersInit` can be a `Headers` object, a record, or a tuple array — indexing with `['X-Retry']` only works for the plain-object form and will silently evaluate to `undefined` for `Headers` instances, potentially allowing unbounded retries.

```typescript
// In frontend/lib/api/client.ts, modify the fetch wrapper:

private async fetchWithAuth(
  url: string,
  init: RequestInit,
  retried = false   // boolean guard — never recurse more than once
): Promise<Response> {
  let res = await fetch(url, init);

  if (res.status === 401 && !retried) {
    // Attempt silent refresh
    const refreshRes = await fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',  // sends HttpOnly cookie
    });

    if (refreshRes.ok) {
      const { token } = await refreshRes.json();
      this.token = token;
      // Retry original request once with new token — pass retried=true to prevent recursion
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      res = await this.fetchWithAuth(url, { ...init, headers, credentials: 'include' }, true);
    } else {
      this.onUnauthorized?.();
    }
  }

  if (res.status === 401) {
    this.onUnauthorized?.();
  }

  return res;
}
```

**Step 5: Permit `/api/auth/refresh` and `/api/auth/logout` in `SecurityConfig`**
```java
// In SecurityConfig.java, add to the permitAll list:
.requestMatchers("/api/auth/refresh", "/api/auth/logout").permitAll()
```

### Acceptance criteria
- [ ] Login response sets `refresh_token` as `HttpOnly` cookie scoped to `/api/auth` path (covers both `/refresh` and `/logout`)
- [ ] `POST /api/auth/refresh` with a valid cookie returns a new access token
- [ ] When access token expires mid-session, `ApiClient` silently refreshes and retries — user never sees a logout
- [ ] `POST /api/auth/logout` clears the refresh token cookie
- [ ] Expired refresh token redirects to `/login`
- [ ] No refresh token in `localStorage` — only access token is stored client-side

---

## Issue 4.2 — No Rate Limiting on Any Endpoint

### Current behavior
All API endpoints accept unlimited requests. A demo attendee, curious developer, or misconfigured script can hammer `POST /api/runs/manual` and queue dozens of runs simultaneously, filling the Fly.io CPU and making the demo unresponsive. Similarly, `POST /api/auth/login` has no brute-force protection.

### Desired behavior
- Login endpoint: 10 attempts per IP per minute, then 429 with `Retry-After` header.
- Run trigger endpoint (`POST /api/runs/manual`): 5 triggers per user per hour.
- Export endpoints: 20 requests per user per 10 minutes.
- All other API endpoints: 200 requests per user per minute (generous enough for normal use).
- 429 responses include a JSON body: `{"error": "rate_limit_exceeded", "retryAfterSeconds": 42}`.

### Root cause
No rate limiting library is configured. No throttle middleware exists.

### Files to modify / create

**Backend:**
- Modify: `backend/build.gradle.kts` — add `bucket4j-spring-boot-starter` dependency
- Create: `backend/src/main/java/com/workwell/config/RateLimitConfig.java`
- Create: `backend/src/main/java/com/workwell/web/filter/RateLimitFilter.java`
- Modify: `backend/src/main/java/com/workwell/config/SecurityConfig.java` — register filter

### Implementation steps

**Step 1: Add bucket4j dependency**
```kotlin
// build.gradle.kts
dependencies {
    implementation("com.bucket4j:bucket4j-core:8.10.1")
    // No Spring Boot starter needed — use core + Caffeine in-memory
    implementation("com.github.ben-manes.caffeine:caffeine:3.1.8")
}
```

**Step 2: Create rate limit configuration**
```java
// backend/src/main/java/com/workwell/config/RateLimitConfig.java
package com.workwell.config;

import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Cache;
import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.Refill;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class RateLimitConfig {

    @Bean
    public Cache<String, Bucket> rateLimitCache() {
        return Caffeine.newBuilder()
            .expireAfterAccess(Duration.ofHours(1))
            .maximumSize(10_000)
            .build();
    }

    public static Bucket loginBucket() {
        return Bucket.builder()
            .addLimit(Bandwidth.classic(10, Refill.intervally(10, Duration.ofMinutes(1))))
            .build();
    }

    public static Bucket runTriggerBucket() {
        return Bucket.builder()
            .addLimit(Bandwidth.classic(5, Refill.intervally(5, Duration.ofHours(1))))
            .build();
    }

    public static Bucket exportBucket() {
        return Bucket.builder()
            .addLimit(Bandwidth.classic(20, Refill.intervally(20, Duration.ofMinutes(10))))
            .build();
    }

    public static Bucket defaultBucket() {
        return Bucket.builder()
            .addLimit(Bandwidth.classic(200, Refill.intervally(200, Duration.ofMinutes(1))))
            .build();
    }
}
```

**Step 3: Create rate limit filter**
```java
// backend/src/main/java/com/workwell/web/filter/RateLimitFilter.java
package com.workwell.web.filter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.benmanes.caffeine.cache.Cache;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.ConsumptionProbe;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Component
@Order(1)
public class RateLimitFilter implements Filter {

    private final Cache<String, Bucket> cache;
    private final ObjectMapper mapper;

    public RateLimitFilter(Cache<String, Bucket> rateLimitCache, ObjectMapper mapper) {
        this.cache = rateLimitCache;
        this.mapper = mapper;
    }

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest request = (HttpServletRequest) req;
        HttpServletResponse response = (HttpServletResponse) res;

        String key = buildKey(request);
        Bucket bucket = cache.get(key, k -> selectBucket(request));

        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            chain.doFilter(req, res);
        } else {
            long retryAfterSeconds = TimeUnit.NANOSECONDS.toSeconds(probe.getNanosToWaitForRefill());
            response.setStatus(429);
            response.setContentType("application/json");
            response.setHeader("Retry-After", String.valueOf(retryAfterSeconds));
            mapper.writeValue(response.getWriter(), Map.of(
                "error", "rate_limit_exceeded",
                "retryAfterSeconds", retryAfterSeconds
            ));
        }
    }

    private String buildKey(HttpServletRequest req) {
        String user = req.getRemoteUser() != null ? req.getRemoteUser() : req.getRemoteAddr();
        String uri = req.getRequestURI();
        // Per-endpoint buckets include the URI so each endpoint is tracked separately.
        // The default bucket keys by user only — so the 200 req/min limit applies across
        // the whole API per user, not per URI. Embedding the URI in the default key would
        // effectively give each endpoint its own 200/min quota instead of a shared one.
        if (uri.contains("/auth/login")) return "login:" + req.getRemoteAddr();
        if (uri.contains("/runs/manual")) return "runs-manual:" + user;
        if (uri.contains("/exports/")) return "exports:" + user;
        return "default:" + user;
    }

    private Bucket selectBucket(HttpServletRequest req) {
        String uri = req.getRequestURI();
        if (uri.contains("/auth/login")) return com.workwell.config.RateLimitConfig.loginBucket();
        if (uri.contains("/runs/manual")) return com.workwell.config.RateLimitConfig.runTriggerBucket();
        if (uri.contains("/exports/")) return com.workwell.config.RateLimitConfig.exportBucket();
        return com.workwell.config.RateLimitConfig.defaultBucket();
    }
}
```

### Acceptance criteria
- [ ] `POST /api/auth/login` returns 429 after 10 rapid attempts from the same IP
- [ ] `POST /api/runs/manual` returns 429 after 5 triggers within 1 hour from the same user
- [ ] 429 response body is JSON with `retryAfterSeconds`
- [ ] Normal usage (< 200 req/min) is not affected
- [ ] Filter does not break CORS preflight (OPTIONS) requests — skip filter for OPTIONS

---

## Issue 4.3 — No OpenAPI / Swagger Documentation

### Current behavior
The backend has no `/swagger-ui` or `/v3/api-docs` endpoint. There is no machine-readable API contract. Developers, the demo audience, and any integration partner must read source code to understand what endpoints exist, what they accept, and what they return. For a B2B SaaS product selling to enterprise buyers who expect integration capabilities, the absence of API documentation is a red flag.

### Desired behavior
- `GET /swagger-ui/index.html` renders the Swagger UI with all endpoints grouped by tag.
- `GET /v3/api-docs` returns the OpenAPI 3.1 JSON spec.
- Each endpoint has a summary, description, request/response schema, and example values.
- Groups: `Measures`, `Runs`, `Cases`, `Employees`, `Exports`, `Audit`, `Admin`, `Auth`.
- The Swagger UI is only accessible in non-production or when an explicit flag is set.

### Root cause
`springdoc-openapi` is not in the dependency list. No `@Operation` or `@Tag` annotations exist.

### Files to modify / create

**Backend:**
- Modify: `backend/build.gradle.kts` — add `springdoc-openapi-starter-webmvc-ui`
- Modify: `backend/src/main/resources/application.yml` — add springdoc config
- Create: `backend/src/main/java/com/workwell/config/OpenApiConfig.java`
- Annotate each `@RestController` with `@Tag` and key endpoints with `@Operation`

### Implementation steps

**Step 1: Add springdoc dependency**
```kotlin
// build.gradle.kts
dependencies {
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.5.0")
}
```

**Step 2: Configure springdoc in `application.yml`**
```yaml
springdoc:
  swagger-ui:
    path: /swagger-ui
    operations-sorter: alpha
    tags-sorter: alpha
    disable-swagger-default-url: true
  api-docs:
    path: /v3/api-docs
  show-actuator: false
  packages-to-scan: com.workwell.web

# Disable Swagger UI in production to reduce attack surface
workwell:
  swagger:
    enabled: ${SWAGGER_ENABLED:false}
```

**Step 3: Create `OpenApiConfig`**
```java
// backend/src/main/java/com/workwell/config/OpenApiConfig.java
package com.workwell.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.Components;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@ConditionalOnProperty(name = "workwell.swagger.enabled", havingValue = "true")
public class OpenApiConfig {

    @Bean
    public OpenAPI workwellOpenApi() {
        return new OpenAPI()
            .info(new Info()
                .title("WorkWell Measure Studio API")
                .version("1.0.0")
                .description("Occupational health compliance measure authoring, " +
                             "CQL evaluation, case management, and audit trail API.")
                .contact(new Contact().name("WorkWell Engineering")))
            .addSecurityItem(new SecurityRequirement().addList("bearerAuth"))
            .components(new Components()
                .addSecuritySchemes("bearerAuth",
                    new SecurityScheme()
                        .type(SecurityScheme.Type.HTTP)
                        .scheme("bearer")
                        .bearerFormat("JWT")));
    }
}
```

**Step 4: Annotate controllers — example for `RunController`**
```java
// Add to class level:
@Tag(name = "Runs", description = "Trigger and query compliance evaluation runs")

// Add to key endpoints:
@Operation(
    summary = "Trigger a manual run",
    description = "Starts an asynchronous evaluation run over the specified scope. " +
                  "Returns HTTP 202 immediately with the run ID for polling."
)
@ApiResponse(responseCode = "202", description = "Run accepted and queued")
@ApiResponse(responseCode = "400", description = "Invalid scope or missing measure ID")
@ApiResponse(responseCode = "429", description = "Rate limit exceeded")
@PostMapping("/api/runs/manual")
public ResponseEntity<RunStartedResponse> triggerManualRun(...) { ... }
```

Apply `@Tag` and `@Operation` to:
- `AuthController` (Auth)
- `MeasureController` / `MeasureStudioController` (Measures)
- `RunController` / `EvalController` (Runs)
- `CaseController` (Cases)
- `EmployeeProfileController` (Employees)
- `ExportController` (Exports)
- `AuditController` (Audit)
- `AdminController` (Admin)

**Step 5: Gate Swagger UI in `SecurityConfig`**
```java
// Permit Swagger paths only when swagger.enabled=true
// Otherwise block with 404:
@Value("${workwell.swagger.enabled:false}")
private boolean swaggerEnabled;

// In SecurityConfig, add before the main chain:
if (!swaggerEnabled) {
    http.requestMatchers(AntPathRequestMatcher.antMatcher("/swagger-ui/**"),
                         AntPathRequestMatcher.antMatcher("/v3/api-docs/**"))
        .authorizeHttpRequests(auth -> auth.anyRequest().denyAll());
}
```

### Acceptance criteria
- [ ] `SWAGGER_ENABLED=true ./gradlew bootRun` and navigate to `/swagger-ui` renders all endpoint groups
- [ ] `GET /v3/api-docs` returns valid OpenAPI 3.1 JSON
- [ ] When `SWAGGER_ENABLED=false` (production default), `/swagger-ui` returns 404
- [ ] At least `Runs`, `Cases`, `Measures`, and `Auth` groups have summaries and descriptions

---

## Issue 4.4 — Evidence File Upload Has No MIME Type Validation

### Current behavior
`POST /api/cases/{id}/evidence` accepts any file type. The only visible validation is likely a file size limit (if even that). Uploading a ZIP bomb, an executable, or a malformed PDF is accepted silently. This is a stored-XSS vector if the frontend ever renders uploaded content inline, and a storage waste issue regardless.

### Desired behavior
- Accepted MIME types: `image/jpeg`, `image/png`, `application/pdf`, `text/plain`, `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX).
- Validation is done on the actual file content (magic bytes), not the MIME type header sent by the client.
- File size hard limit: 10MB per upload.
- On rejection: HTTP 415 with `{"error": "unsupported_media_type", "accepted": [...]}`.
- Accepted content types listed in a config property so they can be changed without code.

### Root cause
No MIME validation exists. The upload endpoint trusts the client-supplied `Content-Type` header.

### Files to modify / create

**Backend:**
- Modify: `backend/build.gradle.kts` — add Apache Tika for magic byte detection
- Create: `backend/src/main/java/com/workwell/caseflow/EvidenceValidationService.java`
- Modify: `backend/src/main/java/com/workwell/web/EvidenceController.java` — call validator before persisting

### Implementation steps

**Step 1: Add Apache Tika dependency**
```kotlin
// build.gradle.kts
dependencies {
    implementation("org.apache.tika:tika-core:2.9.2")
}
```

**Step 2: Create `EvidenceValidationService`**
```java
// backend/src/main/java/com/workwell/caseflow/EvidenceValidationService.java
package com.workwell.caseflow;

import org.apache.tika.Tika;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.Set;

@Service
public class EvidenceValidationService {

    private static final Set<String> ALLOWED_MIME_TYPES = Set.of(
        "image/jpeg",
        "image/png",
        "application/pdf",
        "text/plain",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    private static final long MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024L; // 10MB

    private final Tika tika = new Tika();

    public void validate(MultipartFile file) throws EvidenceValidationException {
        if (file.getSize() > MAX_FILE_SIZE_BYTES) {
            throw new EvidenceValidationException(
                "File size " + file.getSize() + " exceeds 10MB limit", null
            );
        }

        String detectedType;
        try {
            detectedType = tika.detect(file.getInputStream(), file.getOriginalFilename());
        } catch (IOException e) {
            throw new EvidenceValidationException("Could not read file content", null);
        }

        if (!ALLOWED_MIME_TYPES.contains(detectedType)) {
            throw new EvidenceValidationException(
                "Unsupported file type: " + detectedType, ALLOWED_MIME_TYPES
            );
        }
    }

    // Records cannot extend classes other than java.lang.Record — use a regular class here.
    public static class EvidenceValidationException extends RuntimeException {
        private final Set<String> accepted;
        public EvidenceValidationException(String message, Set<String> accepted) {
            super(message);
            this.accepted = accepted;
        }
        public Set<String> accepted() { return accepted; }
    }
}
```

**Step 3: Wire into upload endpoint**
```java
// In EvidenceController.java, at the top of the upload handler:
@PostMapping("/api/cases/{caseId}/evidence")
public ResponseEntity<?> uploadEvidence(@PathVariable UUID caseId,
                                         @RequestParam("file") MultipartFile file) {
    try {
        evidenceValidationService.validate(file);
    } catch (EvidenceValidationService.EvidenceValidationException e) {
        return ResponseEntity.status(415).body(Map.of(
            "error", "unsupported_media_type",
            "message", e.getMessage(),
            "accepted", e.accepted() != null ? e.accepted() : Set.of()
        ));
    }
    // ... existing upload logic continues ...
}
```

**Step 4: Add global exception handler for validation exception**
```java
// In existing @ControllerAdvice or create one:
@ExceptionHandler(EvidenceValidationService.EvidenceValidationException.class)
public ResponseEntity<Map<String, Object>> handleEvidenceValidation(
        EvidenceValidationService.EvidenceValidationException ex) {
    return ResponseEntity.status(415).body(Map.of(
        "error", "unsupported_media_type",
        "message", ex.getMessage(),
        "accepted", ex.accepted() != null ? ex.accepted() : Set.of()
    ));
}
```

### Acceptance criteria
- [ ] Uploading a `.exe` file returns HTTP 415 with `accepted` list
- [ ] Uploading a file with a `.pdf` extension but actually containing a ZIP returns 415 (magic byte detection works)
- [ ] Uploading a valid PDF ≤ 10MB returns 200
- [ ] Uploading a valid PDF > 10MB returns 415 with size error message
- [ ] All accepted MIME types (JPEG, PNG, PDF, TXT, CSV, XLSX) upload successfully

---

## Issue 4.5 — No API Versioning Strategy

### Current behavior
All endpoints are unversioned (e.g., `GET /api/cases`). When a breaking change is made to a response shape (adding required fields, renaming properties), all clients break immediately with no migration path. For a product selling to enterprise customers who integrate with its API, this is a reliability risk.

### Desired behavior
- All current endpoints remain at `/api/v1/...` (no `/api/...` aliases — remove old paths or redirect).
- A routing convention is documented so future developers know where to add v2 endpoints when a breaking change is needed.
- `GET /api/version` returns `{"api": "v1", "build": "<git-sha>", "uptime": "..."}`.
- The OpenAPI spec (Issue 4.3) reflects the v1 prefix.

### Root cause
No versioning convention was established at project inception.

### Implementation steps

**Step 1: Add a request mapping prefix to the base path in `application.yml`**
```yaml
server:
  servlet:
    context-path: /
spring:
  mvc:
    pathmatch:
      use-suffix-pattern: false

# Option A (cleanest): Add a global prefix via annotation
# Option B: Rename each controller's @RequestMapping
```

The recommended approach for an existing codebase is **Option B** — update each controller's `@RequestMapping` to use `/api/v1/...`. This avoids Spring MVC context-path changes that affect Actuator, Swagger, and CORS.

**Step 2: Add `/api/version` endpoint**
```java
// In a new VersionController or added to an existing general controller:
@GetMapping("/api/version")
public ResponseEntity<Map<String, Object>> version(
        @Value("${git.commit.id.abbrev:unknown}") String gitSha) {
    return ResponseEntity.ok(Map.of(
        "api", "v1",
        "build", gitSha,
        "uptime", ManagementFactory.getRuntimeMXBean().getUptime() / 1000 + "s"
    ));
}
```

**Step 3: Document v1 API convention in ARCHITECTURE.md**
Add a section: "All REST endpoints use the `/api/v1/` prefix. Breaking changes that cannot be made backward-compatible require a new path prefix. Aliases from the old path to the new one must be maintained for one minor version cycle."

**Note for implementation:** This is a lower-priority issue than 4.1–4.4. For the demo, adding `/api/version` and the architecture doc is sufficient. Full controller prefix migration can be deferred to post-demo hardening.

### Acceptance criteria
- [ ] `GET /api/version` returns JSON with api, build, uptime fields
- [ ] ARCHITECTURE.md has a versioning convention section
- [ ] (Stretch) At least one controller has been migrated to `/api/v1/` prefix as a proof-of-concept

---

## Issue 4.6 — Integration Sync Endpoint Has No Whitelist

### Current behavior
`POST /api/admin/integrations/{id}/sync` triggers a sync operation for any integration ID passed in the path. There is no whitelist of valid integration IDs. An attacker (or mis-configured script) could pass arbitrary IDs and trigger undefined behavior.

### Desired behavior
- Valid integration IDs are defined as an enum or constant set: `{"fhir", "mcp", "ai", "hris"}`.
- Requests with any other ID return HTTP 404, not 400 or 500.
- The sync handler validates the ID before performing any database or network operation.

### Implementation steps

**Step 1: Add integration ID validation**
```java
// In AdminController.java or the integration service:
private static final Set<String> VALID_INTEGRATION_IDS = Set.of("fhir", "mcp", "ai", "hris");

@PostMapping("/api/admin/integrations/{id}/sync")
public ResponseEntity<?> syncIntegration(@PathVariable String id) {
    if (!VALID_INTEGRATION_IDS.contains(id)) {
        return ResponseEntity.notFound().build();
    }
    // ... existing sync logic ...
}
```

### Acceptance criteria
- [ ] `POST /api/admin/integrations/unknown/sync` returns 404
- [ ] `POST /api/admin/integrations/fhir/sync` returns 200 (existing behavior preserved)

---

## Definition of Done — Sprint 4

- [ ] JWT refresh works silently end-to-end: access token expires → frontend auto-refreshes → user never leaves the page
- [ ] Login endpoint returns 429 after 10 rapid attempts
- [ ] Run trigger returns 429 after 5 triggers per hour
- [ ] Evidence upload rejects executables and > 10MB files with HTTP 415
- [ ] `GET /api/version` returns build metadata
- [ ] Integration sync validates ID against whitelist
- [ ] `SWAGGER_ENABLED=true` in dev shows full Swagger UI; production keeps it off
- [ ] `./gradlew test` passes
- [ ] JOURNAL.md entry added

### Recommendations

**Stateless JWT vs. token revocation:** The current stub-auth stack uses stateless JWTs. Refresh token rotation (step 3, Step 2) partially mitigates the revocation gap. For production, add a `revoked_tokens` table keyed by `jti` (JWT ID) claim and check it on every request — the JWT remains the fast path, the revocation check adds a single indexed DB read.

**In-memory rate limiting vs. distributed:** The Caffeine-based rate limiter (Issue 4.2) is per-JVM. If you run multiple Fly.io machines, each machine has its own bucket and the effective limit is multiplied. For the demo with a single machine this is fine. Post-demo, switch to Redis-backed Bucket4j for distributed limiting.

**Tika vs. file-magic library:** Apache Tika adds ~5MB to the JAR. For a leaner alternative, use `file-magic` or just manually check the first 8 bytes (magic bytes) for common types. Tika is simpler to maintain and already handles edge cases — prefer it unless jar size is a constraint.
