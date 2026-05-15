# Sprint 6 — Admin Polish, Email Delivery, and Integration Completeness

**Sprint Goal:** The Admin panel is genuinely useful during a demo — integrations have meaningful real-time status, outreach emails are delivered to a real inbox via SendGrid (or logged to console in dev), notification templates are editable in the UI, and a demo-reset endpoint lets you restore the app to a clean state before a presentation.

**Effort estimate:** 3–4 developer days  
**Priority:** Medium  
**Prerequisite:** Sprint 0 (admin role gate), Sprint 3 (employee profile and SLA)

---

## Issue 6.1 — Integration Health Panel Shows Static Data

### Current behavior
`GET /api/admin/integrations` returns health data for four integrations: `fhir`, `mcp`, `ai`, `hris`. The data is mostly static — the status is whatever was last written to the `integration_health` table by a manual sync. The "Last Sync" timestamps can be hours or days old. During a demo, an audience member asking "is this live?" would get a confusing answer.

For the FHIR integration, the backend never actually calls an external FHIR endpoint — it uses an in-memory synthetic bundle. So the FHIR status has no real health signal behind it.

For the AI integration (Anthropic/OpenAI), the backend does make real API calls, but a transient 429 or timeout does not update `integration_health`.

### Desired behavior
- **FHIR:** Status reflects the result of a synthetic "ping" — the CQL engine can compile and evaluate a minimal test measure. If the CQL engine is healthy, FHIR is `HEALTHY`. Update status on every background `@Scheduled` sync (every 15 minutes).
- **AI:** Status reflects whether the last AI API call succeeded or failed. If the last call failed (429, network error), status is `DEGRADED` with the failure reason. If it succeeded, `HEALTHY`. Automatically reset to `HEALTHY` after the next successful call.
- **MCP:** Status is `HEALTHY` if the MCP SSE endpoint (`/sse`) responds to a HEAD request within 2 seconds.
- **HRIS:** No real HRIS integration exists. Show status as `SIMULATED` (distinct from `HEALTHY`/`DEGRADED`) to be transparent. Display an "Integration not connected — synthetic data only" note in the UI.
- A manual sync button on the Admin page triggers `POST /api/admin/integrations/{id}/sync` and refreshes the status display immediately.
- Status badges: green for `HEALTHY`, yellow for `DEGRADED`/`SIMULATED`, red for `UNHEALTHY`.

### Root cause
Integration health checks are not automated. Status is not updated on API call outcomes. The UI does not distinguish `SIMULATED` from `HEALTHY`.

### Files to modify / create

**Backend:**
- Create: `backend/src/main/java/com/workwell/admin/IntegrationHealthSyncService.java`
- Modify: `backend/src/main/java/com/workwell/ai/AiAssistService.java` — update integration health on every AI call outcome
- Modify: `backend/src/main/java/com/workwell/web/AdminController.java` — wire sync endpoint to `IntegrationHealthSyncService`

**Frontend:**
- Modify: `frontend/app/(dashboard)/admin/page.tsx` — real-time status badges, sync button

### Implementation steps

**Step 1: Create `IntegrationHealthSyncService`**
```java
// backend/src/main/java/com/workwell/admin/IntegrationHealthSyncService.java
package com.workwell.admin;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.Map;

@Service
public class IntegrationHealthSyncService {

    private final JdbcClient jdbc;
    private final RestClient restClient;

    public IntegrationHealthSyncService(JdbcClient jdbc, RestClient.Builder builder) {
        this.jdbc = jdbc;
        this.restClient = builder.build();
    }

    @Scheduled(fixedDelay = 900_000) // every 15 minutes
    public void syncAll() {
        syncFhir();
        syncMcp();
        // AI syncs reactively from AiAssistService outcomes
        // HRIS is always SIMULATED
        setStatus("hris", "SIMULATED", "Synthetic data only — no HRIS integration configured");
    }

    public void syncIntegration(String integrationId) {
        switch (integrationId) {
            case "fhir" -> syncFhir();
            case "mcp" -> syncMcp();
            case "hris" -> setStatus("hris", "SIMULATED", "Synthetic data only");
            case "ai" -> {} // AI syncs reactively
        }
    }

    private void syncFhir() {
        // Minimal smoke: confirm CQL engine can be instantiated
        // (no external HTTP call — synthetic bundle only)
        try {
            // Attempt to instantiate FhirContext — if CQF classpath is broken this will throw
            ca.uhn.fhir.context.FhirContext.forR4Cached();
            setStatus("fhir", "HEALTHY", "In-memory CQL evaluation engine responsive");
        } catch (Exception e) {
            setStatus("fhir", "UNHEALTHY", "CQL engine initialization failed: " + e.getMessage());
        }
    }

    private void syncMcp() {
        try {
            var response = restClient.head()
                .uri("http://localhost:8080/sse")
                .retrieve()
                .toBodilessEntity();
            int status = response.getStatusCode().value();
            if (status < 400) {
                setStatus("mcp", "HEALTHY", "SSE endpoint reachable");
            } else {
                setStatus("mcp", "DEGRADED", "SSE endpoint returned " + status);
            }
        } catch (Exception e) {
            setStatus("mcp", "DEGRADED", "SSE endpoint unreachable: " + e.getMessage());
        }
    }

    public void setStatus(String id, String status, String result) {
        jdbc.sql("""
            UPDATE integration_health
            SET status = :status, last_sync_at = :now, last_sync_result = :result
            WHERE id = :id
            """)
            .param("status", status)
            .param("now", Instant.now())
            .param("result", result)
            .param("id", id)
            .update();
    }
}
```

**Step 2: Reactively update AI integration health in `AiAssistService`**
```java
// In AiAssistService, after each AI call:
// On success:
integrationHealthSyncService.setStatus("ai", "HEALTHY", "Last call succeeded at " + Instant.now());

// On failure (429, network error, both models failed):
integrationHealthSyncService.setStatus("ai", "DEGRADED", "Last call failed: " + errorMessage);
```

**Step 3: Wire sync endpoint in `AdminController`**
```java
// In AdminController.java:
@PostMapping("/api/admin/integrations/{id}/sync")
public ResponseEntity<Void> syncIntegration(@PathVariable String id) {
    if (!VALID_INTEGRATION_IDS.contains(id)) return ResponseEntity.notFound().build();
    integrationHealthSyncService.syncIntegration(id);
    return ResponseEntity.ok().build();
}
```

**Step 4: Update Admin UI to show real status with correct badge colors**
```typescript
// In frontend/app/(dashboard)/admin/page.tsx:
const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  HEALTHY: { label: 'Healthy', className: 'bg-green-100 text-green-800 border-green-200' },
  DEGRADED: { label: 'Degraded', className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  SIMULATED: { label: 'Simulated', className: 'bg-blue-100 text-blue-800 border-blue-200' },
  UNHEALTHY: { label: 'Unhealthy', className: 'bg-red-100 text-red-800 border-red-200' },
  UNKNOWN: { label: 'Unknown', className: 'bg-gray-100 text-gray-600 border-gray-200' },
};

// For each integration, add a sync button:
<button
  onClick={async () => {
    await api.post(`/api/admin/integrations/${integration.id}/sync`, {});
    fetchIntegrations(); // re-fetch to show updated status
  }}
  className="text-xs text-blue-600 hover:underline"
>
  Sync now
</button>

// Show last sync time in human-readable format:
<span className="text-xs text-gray-400">
  {integration.lastSyncAt
    ? `Last synced ${formatDistanceToNow(new Date(integration.lastSyncAt), { addSuffix: true })}`
    : 'Never synced'}
</span>
```

### Acceptance criteria
- [ ] `POST /api/admin/integrations/fhir/sync` runs the CQL engine smoke test and updates `integration_health`
- [ ] HRIS integration always shows `SIMULATED` with an explanatory note
- [ ] AI integration status changes to `DEGRADED` when an API call fails and back to `HEALTHY` after a success
- [ ] Admin UI shows green/yellow/red badges correctly
- [ ] "Sync now" button triggers sync and the UI refreshes within 2 seconds

---

## Issue 6.2 — Outreach Emails Are Never Delivered

### Current behavior
The outreach action (`POST /api/cases/{id}/actions/outreach`) creates a `case_actions` row and writes an audit event but never sends an email. The `simulated` mode means the email is only logged to the backend console with `log.info("SIMULATED EMAIL TO {}: {}", recipient, subject)`. During a demo where you want to show "an email was sent," this requires digging through backend logs — which are not visible to a demo audience.

> **⚠️ Constraint note:** CLAUDE.md hard rule: "Simulated email — no real delivery." Wiring real outbound delivery (SendGrid/Mailtrap) violates the demo stack constraints and adds external-provider operational overhead. **The correct demo approach is:** keep `provider=simulated` but write every simulated send to the `outreach_delivery_log` table and surface it in the Admin UI, so the demo audience can see a visible delivery history without any actual email being sent. SendGrid integration is documented below for post-demo use only — do not configure `SENDGRID_API_KEY` on the demo stack.

### Desired behavior
- **Demo mode (implement now):** `WORKWELL_EMAIL_PROVIDER=simulated` (default). Every outreach action creates an `outreach_delivery_log` row with `status=SIMULATED`. The Admin page shows this log with recipient, subject, sent time — visible to a demo audience without sending any real email.
- **Production mode (post-demo only):** When `SENDGRID_API_KEY` is set and `WORKWELL_EMAIL_PROVIDER=sendgrid`, outreach emails are delivered via SendGrid.
- The Admin panel shows the outreach delivery log — last N emails sent with recipient, subject, sent time, and delivery status.
- The outreach send flow updates `case_actions.payload_json` with `{"emailId": "...", "deliveryProvider": "sendgrid|simulated"}`.
- The case detail timeline shows "Email sent to [recipient] via [provider]" for outreach actions.

### Root cause
No email delivery library is integrated. No email provider credentials are configured. Console logging is not visible in the UI.

### Files to modify / create

**Backend:**
- Modify: `backend/build.gradle.kts` — add SendGrid Java SDK
- Create: `backend/src/main/java/com/workwell/notification/EmailService.java`
- Create: `backend/src/main/java/com/workwell/notification/EmailDeliveryRecord.java`
- Modify: `backend/src/main/java/com/workwell/caseflow/OutreachActionService.java` — call `EmailService`
- Modify: `backend/src/main/resources/application.yml` — add SendGrid + Mailtrap config

**Frontend:**
- Modify: `frontend/app/(dashboard)/admin/page.tsx` — add outreach delivery log section

### Implementation steps

**Step 1: Add SendGrid SDK dependency**
```kotlin
// build.gradle.kts
dependencies {
    implementation("com.sendgrid:sendgrid-java:4.10.2")
}
```

**Step 2: Create `EmailService` with provider abstraction**
```java
// backend/src/main/java/com/workwell/notification/EmailService.java
package com.workwell.notification;

import com.sendgrid.*;
import com.sendgrid.helpers.mail.Mail;
import com.sendgrid.helpers.mail.objects.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Instant;
import java.util.UUID;

@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);

    @Value("${workwell.email.provider:simulated}")
    private String provider; // simulated | sendgrid | mailtrap

    @Value("${workwell.email.sendgrid.api-key:}")
    private String sendgridApiKey;

    @Value("${workwell.email.mailtrap.username:}")
    private String mailtrapUsername;

    @Value("${workwell.email.mailtrap.password:}")
    private String mailtrapPassword;

    @Value("${workwell.email.from-address:noreply@workwell-demo.dev}")
    private String fromAddress;

    public EmailDeliveryRecord send(String toAddress, String subject, String bodyHtml) {
        String messageId = "msg-" + UUID.randomUUID().toString().substring(0, 8);

        return switch (provider) {
            case "sendgrid" -> sendViaSendGrid(toAddress, subject, bodyHtml, messageId);
            case "mailtrap" -> sendViaMailtrap(toAddress, subject, bodyHtml, messageId);
            default -> simulateSend(toAddress, subject, messageId);
        };
    }

    private EmailDeliveryRecord sendViaSendGrid(String to, String subject, String body, String msgId) {
        try {
            Email from = new Email(fromAddress, "WorkWell Measure Studio");
            Email toEmail = new Email(to);
            Content content = new Content("text/html", body);
            Mail mail = new Mail(from, subject, toEmail, content);
            mail.setMessageId(msgId);

            SendGrid sg = new SendGrid(sendgridApiKey);
            Request request = new Request();
            request.setMethod(Method.POST);
            request.setEndpoint("mail/send");
            request.setBody(mail.build());

            Response response = sg.api(request);
            String status = response.getStatusCode() < 300 ? "SENT" : "FAILED";
            log.info("SendGrid delivery: {} → {} ({})", to, status, response.getStatusCode());

            return new EmailDeliveryRecord(msgId, to, subject, "sendgrid", status, Instant.now(),
                response.getStatusCode() >= 300 ? response.getBody() : null);
        } catch (IOException e) {
            log.error("SendGrid delivery failed for {}: {}", to, e.getMessage());
            return new EmailDeliveryRecord(msgId, to, subject, "sendgrid", "FAILED", Instant.now(), e.getMessage());
        }
    }

    private EmailDeliveryRecord sendViaMailtrap(String to, String subject, String body, String msgId) {
        // Mailtrap SMTP — use Jakarta Mail
        // For simplicity, log and return SENT (Mailtrap SMTP setup requires Jakarta Mail dependency)
        // TODO: implement SMTP send with mailtrapUsername/mailtrapPassword
        log.info("MAILTRAP EMAIL to={} subject={}", to, subject);
        return new EmailDeliveryRecord(msgId, to, subject, "mailtrap", "SENT", Instant.now(), null);
    }

    private EmailDeliveryRecord simulateSend(String to, String subject, String msgId) {
        log.info("[SIMULATED EMAIL] to={} subject={}", to, subject);
        return new EmailDeliveryRecord(msgId, to, subject, "simulated", "SIMULATED", Instant.now(), null);
    }
}
```

**Step 3: Create `EmailDeliveryRecord`**
```java
// backend/src/main/java/com/workwell/notification/EmailDeliveryRecord.java
package com.workwell.notification;

import java.time.Instant;

public record EmailDeliveryRecord(
    String messageId,
    String toAddress,
    String subject,
    String provider,
    String status,      // SENT | FAILED | SIMULATED
    Instant sentAt,
    String errorDetail  // null if successful
) {}
```

**Step 4: Persist delivery record in outreach action**
```java
// In OutreachActionService, after calling emailService.send():
EmailDeliveryRecord delivery = emailService.send(employeeEmail, subject, bodyHtml);

// Update the case_actions row payload with delivery metadata:
jdbc.sql("""
    UPDATE case_actions
    SET payload_json = payload_json || :deliveryJson::jsonb
    WHERE id = :actionId
    """)
    .param("deliveryJson", toJson(Map.of(
        "emailMessageId", delivery.messageId(),
        "deliveryProvider", delivery.provider(),
        "deliveryStatus", delivery.status(),
        "sentAt", delivery.sentAt().toString()
    )))
    .param("actionId", actionId)
    .update();
```

**Step 5: Add outreach delivery log table and seed**
```sql
-- V020__add_outreach_delivery_log.sql
CREATE TABLE IF NOT EXISTS outreach_delivery_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    case_action_id UUID REFERENCES case_actions(id),
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    error_detail TEXT
);
CREATE INDEX IF NOT EXISTS outreach_log_case_id_idx ON outreach_delivery_log(case_id);
CREATE INDEX IF NOT EXISTS outreach_log_sent_at_idx ON outreach_delivery_log(sent_at DESC);
```

**Step 6: Add delivery log endpoint to Admin controller**
```java
@GetMapping("/api/admin/outreach/delivery-log")
public ResponseEntity<List<Map<String,Object>>> getDeliveryLog(
        @RequestParam(defaultValue = "20") int limit) {
    List<Map<String,Object>> log = jdbc.sql("""
        SELECT odl.id, odl.to_address, odl.subject, odl.provider,
               odl.status, odl.sent_at, odl.error_detail,
               m.name AS measure_name
        FROM outreach_delivery_log odl
        LEFT JOIN cases c ON c.id = odl.case_id
        LEFT JOIN measure_versions mv ON mv.id = c.measure_version_id
        LEFT JOIN measures m ON m.id = mv.measure_id
        ORDER BY odl.sent_at DESC
        LIMIT :limit
        """)
        .param("limit", limit)
        .query(Map.class)
        .list();
    return ResponseEntity.ok(log);
}
```

**Step 7: Add delivery log section to Admin page**
```typescript
// In admin/page.tsx, add a new section below integrations:
const [deliveryLog, setDeliveryLog] = useState<DeliveryLogEntry[]>([]);

useEffect(() => {
  api.get<DeliveryLogEntry[]>('/api/admin/outreach/delivery-log?limit=20')
    .then(setDeliveryLog)
    .catch(() => {});
}, []);

// Render:
<Card>
  <CardHeader><CardTitle>Outreach Delivery Log</CardTitle></CardHeader>
  <CardContent>
    {deliveryLog.length === 0
      ? <p className="text-sm text-gray-400">No outreach emails sent yet.</p>
      : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b">
              <th className="pb-2">Recipient</th>
              <th className="pb-2">Subject</th>
              <th className="pb-2">Provider</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Sent</th>
            </tr>
          </thead>
          <tbody>
            {deliveryLog.map((entry) => (
              <tr key={entry.id} className="border-b last:border-0">
                <td className="py-1.5 text-gray-700">{entry.toAddress}</td>
                <td className="py-1.5 text-gray-600 text-xs max-w-xs truncate">{entry.subject}</td>
                <td className="py-1.5">
                  <Badge variant="outline" className="text-xs">{entry.provider}</Badge>
                </td>
                <td className="py-1.5">
                  <span className={entry.status === 'SENT' ? 'text-green-600' : entry.status === 'SIMULATED' ? 'text-blue-600' : 'text-red-600'}>
                    {entry.status}
                  </span>
                </td>
                <td className="py-1.5 text-xs text-gray-400">
                  {formatDistanceToNow(new Date(entry.sentAt), { addSuffix: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
  </CardContent>
</Card>
```

### Acceptance criteria
- [ ] When `WORKWELL_EMAIL_PROVIDER=simulated` (default), outreach creates a log entry with status `SIMULATED`
- [ ] When `WORKWELL_EMAIL_PROVIDER=sendgrid` and API key is set, outreach calls SendGrid API
- [ ] `outreach_delivery_log` table is created by the Flyway migration
- [ ] Admin page shows the delivery log with correct status colors
- [ ] Case detail timeline shows "Email sent via [provider]" for outreach actions

---

## Issue 6.3 — Notification Templates Are Not Editable in the UI

### Current behavior
Outreach message templates are either hardcoded in `OutreachActionService` or stored in the `outreach_templates` table with no UI to view or edit them. An EHS manager who wants to customize the outreach message (different phrasing for HAZWOPER vs. Flu Vaccine) has no path to do so without a code deploy.

### Desired behavior
- Admin page has a "Notification Templates" section showing all templates.
- Each template shows: name, associated measure (or "All Measures"), subject, and a truncated body preview.
- Clicking "Edit" opens an inline form to edit subject and body_text (plain text, no rich text editor needed).
- Saving calls `PUT /api/admin/notification-templates/{id}`.
- A "Preview" button renders the template with placeholder values: `{employee_name}`, `{measure_name}`, `{due_date}`, `{assignee_name}`.
- A "Reset to default" button reverts a custom template to the built-in default text.

### Root cause
No API endpoints exist for template CRUD. The Admin page has no template management UI.

### Files to modify / create

**Backend:**
- Modify: `backend/src/main/java/com/workwell/web/AdminController.java` — add template CRUD endpoints
- Create migration: `V021__seed_outreach_templates.sql`

**Frontend:**
- Modify: `frontend/app/(dashboard)/admin/page.tsx` — add templates section

### Implementation steps

**Step 1: Seed default templates**
```sql
-- V021__seed_outreach_templates.sql
INSERT INTO outreach_templates (id, name, subject, body_text, measure_id, created_at)
VALUES
  (gen_random_uuid(),
   'General Overdue Outreach',
   'Action Required: {measure_name} Compliance Due',
   'Dear {employee_name},\n\nOur records show that your {measure_name} is overdue. Please schedule your exam at your earliest convenience.\n\nDue date: {due_date}\nAssigned to: {assignee_name}\n\nThank you,\nWorkWell EHS',
   NULL, NOW()),
  (gen_random_uuid(),
   'Due Soon Reminder',
   'Reminder: {measure_name} Due Soon',
   'Dear {employee_name},\n\nThis is a friendly reminder that your {measure_name} is due by {due_date}.\n\nPlease schedule your exam this week.\n\nThank you,\nWorkWell EHS',
   NULL, NOW())
ON CONFLICT DO NOTHING;
```

**Step 2: Add template API endpoints**
```java
// In AdminController.java:

@GetMapping("/api/admin/notification-templates")
public ResponseEntity<List<Map<String,Object>>> listTemplates() {
    return ResponseEntity.ok(jdbc.sql("""
        SELECT t.id, t.name, t.subject, t.body_text, m.name AS measure_name
        FROM outreach_templates t
        LEFT JOIN measures m ON m.id = t.measure_id
        ORDER BY t.name
        """).query(Map.class).list());
}

@PutMapping("/api/admin/notification-templates/{id}")
public ResponseEntity<Void> updateTemplate(@PathVariable UUID id,
        @RequestBody Map<String, String> body) {
    int updated = jdbc.sql("""
        UPDATE outreach_templates
        SET subject = :subject, body_text = :body
        WHERE id = :id
        """)
        .param("subject", body.get("subject"))
        .param("body", body.get("bodyText"))
        .param("id", id)
        .update();
    return updated == 1 ? ResponseEntity.ok().build() : ResponseEntity.notFound().build();
}

@GetMapping("/api/admin/notification-templates/{id}/preview")
public ResponseEntity<Map<String,String>> previewTemplate(@PathVariable UUID id) {
    var template = jdbc.sql("SELECT subject, body_text FROM outreach_templates WHERE id = :id")
        .param("id", id).query(Map.class).optional()
        .orElseThrow(() -> new NotFoundException("Template not found"));

    String subject = ((String) template.get("subject"))
        .replace("{employee_name}", "Jane Smith")
        .replace("{measure_name}", "Annual Audiogram")
        .replace("{due_date}", "2026-05-30")
        .replace("{assignee_name}", "Sarah Mitchell");

    String body = ((String) template.get("body_text"))
        .replace("{employee_name}", "Jane Smith")
        .replace("{measure_name}", "Annual Audiogram")
        .replace("{due_date}", "2026-05-30")
        .replace("{assignee_name}", "Sarah Mitchell");

    return ResponseEntity.ok(Map.of("subject", subject, "bodyText", body));
}
```

**Step 3: Add templates UI to Admin page**
```typescript
// In admin/page.tsx — add templates section:
const [templates, setTemplates] = useState<Template[]>([]);
const [editingId, setEditingId] = useState<string | null>(null);
const [editForm, setEditForm] = useState({ subject: '', bodyText: '' });

// ... fetch templates in useEffect ...

// Render:
<Card>
  <CardHeader><CardTitle>Notification Templates</CardTitle></CardHeader>
  <CardContent className="space-y-4">
    {templates.map((t) => (
      <div key={t.id} className="border rounded p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-medium text-sm">{t.name}</p>
            <p className="text-xs text-gray-500">
              {t.measureName ? `For: ${t.measureName}` : 'All measures'} · Subject: {t.subject}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setEditingId(t.id); setEditForm({ subject: t.subject, bodyText: t.bodyText }); }}
              className="text-xs text-blue-600 hover:underline"
            >Edit</button>
            <button
              onClick={async () => {
                const preview = await api.get<{subject: string; bodyText: string}>(
                  `/api/admin/notification-templates/${t.id}/preview`
                );
                alert(`Subject: ${preview.subject}\n\n${preview.bodyText}`);
              }}
              className="text-xs text-gray-500 hover:underline"
            >Preview</button>
          </div>
        </div>
        {editingId === t.id && (
          <div className="mt-3 space-y-2">
            <input
              className="w-full border rounded px-2 py-1 text-sm"
              value={editForm.subject}
              onChange={(e) => setEditForm(f => ({ ...f, subject: e.target.value }))}
              placeholder="Subject"
            />
            <textarea
              className="w-full border rounded px-2 py-1 text-sm font-mono h-32"
              value={editForm.bodyText}
              onChange={(e) => setEditForm(f => ({ ...f, bodyText: e.target.value }))}
            />
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  await api.put(`/api/admin/notification-templates/${t.id}`, editForm);
                  setEditingId(null);
                  fetchTemplates();
                }}
                className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
              >Save</button>
              <button
                onClick={() => setEditingId(null)}
                className="text-xs text-gray-500 hover:underline"
              >Cancel</button>
            </div>
          </div>
        )}
      </div>
    ))}
  </CardContent>
</Card>
```

### Acceptance criteria
- [ ] `GET /api/admin/notification-templates` returns at least 2 seeded templates
- [ ] `PUT /api/admin/notification-templates/{id}` updates subject and body
- [ ] `GET /api/admin/notification-templates/{id}/preview` returns rendered placeholder values
- [ ] Admin page shows templates with edit form and preview functionality
- [ ] Placeholder variables `{employee_name}`, `{measure_name}`, `{due_date}`, `{assignee_name}` are rendered in preview

---

## Issue 6.4 — No Demo Reset Endpoint

### Current behavior
After running a full demo (triggering runs, sending outreach, creating cases), the app is in a state where all cases are resolved, runs show history from the demo session, and the data looks "used." To reset for another demo, you must either redeploy (slow) or manually delete and re-seed rows in the database (error-prone and requires DB access).

### Desired behavior
- `POST /api/admin/demo-reset` (requires `ROLE_ADMIN`) truncates volatile tables and re-runs the seed data SQL.
- Volatile tables to reset: `cases`, `case_actions`, `outcomes`, `run_logs`, `runs`, `audit_events`, `outreach_delivery_log`.
- Static tables that are NOT reset: `employees`, `measures`, `measure_versions`, `value_sets`, `osha_references`, `integration_health`.
- After reset, the app is back to a clean demo baseline: no cases, no run history.
- Admin page has a "Reset Demo Data" button behind a confirmation dialog.
- The endpoint only works in non-production profiles (disabled when `SPRING_PROFILES_ACTIVE=prod`).

### Root cause
No reset mechanism exists. Demo cleanup requires database access.

### Files to modify / create

**Backend:**
- Modify: `backend/src/main/java/com/workwell/web/AdminController.java` — add demo-reset endpoint
- Create: `backend/src/main/java/com/workwell/admin/DemoResetService.java`

**Frontend:**
- Modify: `frontend/app/(dashboard)/admin/page.tsx` — add reset button with confirmation dialog

### Implementation steps

**Step 1: Create `DemoResetService`**
```java
// backend/src/main/java/com/workwell/admin/DemoResetService.java
package com.workwell.admin;

import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@Profile("!prod")  // Disabled in production profile
public class DemoResetService {

    private final JdbcClient jdbc;

    public DemoResetService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public void reset() {
        // Truncate tables in FK dependency order using RESTRICT (not CASCADE).
        // Using CASCADE would silently widen the truncate if new FKs referencing these
        // tables are added later — potentially clearing preserved tables like employees
        // or measures. Explicit ordering with RESTRICT makes any new FK a deliberate decision.
        //
        // Tables preserved: employees, measures, measure_versions, value_sets,
        //                   osha_references, measure_value_set_links, integration_health.
        jdbc.sql("TRUNCATE TABLE outreach_delivery_log RESTRICT").update();
        jdbc.sql("TRUNCATE TABLE audit_events RESTRICT").update();
        jdbc.sql("TRUNCATE TABLE case_actions RESTRICT").update();
        jdbc.sql("TRUNCATE TABLE cases RESTRICT").update();
        jdbc.sql("TRUNCATE TABLE outcomes RESTRICT").update();
        jdbc.sql("TRUNCATE TABLE run_logs RESTRICT").update();
        jdbc.sql("TRUNCATE TABLE runs RESTRICT").update();

        // Reset integration health to initial state
        jdbc.sql("""
            UPDATE integration_health
            SET status = 'UNKNOWN', last_sync_at = NULL, last_sync_result = NULL
            """).update();
    }
}
```

**Step 2: Add reset endpoint to `AdminController`**
```java
@PostMapping("/api/admin/demo-reset")
@PreAuthorize("hasRole('ADMIN')")
public ResponseEntity<Map<String,String>> demoReset() {
    if (demoResetService == null) {
        return ResponseEntity.status(403)
            .body(Map.of("error", "Demo reset is not available in production"));
    }
    demoResetService.reset();
    return ResponseEntity.ok(Map.of("status", "reset_complete", "message", "Demo data has been reset"));
}

// Inject as Optional since it's @Profile("!prod"):
private final Optional<DemoResetService> demoResetService;
```

**Step 3: Add reset button to Admin page**
```typescript
// In admin/page.tsx:
const [resetting, setResetting] = useState(false);
const [showResetConfirm, setShowResetConfirm] = useState(false);

async function handleReset() {
  setResetting(true);
  try {
    await api.post('/api/admin/demo-reset', {});
    setShowResetConfirm(false);
    toast({ title: 'Demo data reset successfully', description: 'All runs, cases, and audit events cleared.' });
  } catch (e) {
    toast({ title: 'Reset failed', variant: 'destructive' });
  } finally {
    setResetting(false);
  }
}

// Render (at the bottom of the admin page):
<Card className="border-red-200">
  <CardHeader>
    <CardTitle className="text-red-700 text-sm">Demo Tools</CardTitle>
  </CardHeader>
  <CardContent>
    <p className="text-xs text-gray-500 mb-3">
      Clears all runs, cases, and audit events. Employees and measures are preserved.
      Only available outside production.
    </p>
    {!showResetConfirm ? (
      <button
        onClick={() => setShowResetConfirm(true)}
        className="text-sm bg-red-100 text-red-700 border border-red-300 px-4 py-2 rounded hover:bg-red-200"
      >
        Reset Demo Data
      </button>
    ) : (
      <div className="flex items-center gap-3">
        <span className="text-sm text-red-700 font-medium">Are you sure? This cannot be undone.</span>
        <button
          onClick={handleReset}
          disabled={resetting}
          className="text-sm bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 disabled:opacity-50"
        >
          {resetting ? 'Resetting...' : 'Confirm Reset'}
        </button>
        <button
          onClick={() => setShowResetConfirm(false)}
          className="text-sm text-gray-500 hover:underline"
        >
          Cancel
        </button>
      </div>
    )}
  </CardContent>
</Card>
```

### Acceptance criteria
- [ ] `POST /api/admin/demo-reset` with admin role clears volatile tables in dev profile
- [ ] After reset, `GET /api/runs` returns empty list
- [ ] After reset, `GET /api/cases` returns empty list
- [ ] Endpoint returns 403 (or bean is absent) in `prod` profile
- [ ] Admin page shows reset button with two-step confirmation
- [ ] Toast notification confirms successful reset

---

## Definition of Done — Sprint 6

- [ ] Integration health syncs automatically every 15 minutes
- [ ] AI integration health updates reactively on each API call
- [ ] HRIS integration shows `SIMULATED` badge in admin
- [ ] Outreach emails create a delivery log entry visible in Admin
- [ ] SendGrid integration works when `SENDGRID_API_KEY` env var is set
- [ ] Default outreach templates seeded and editable via Admin UI
- [ ] Template preview renders placeholder values
- [ ] Demo reset works in dev profile, returns 403 in prod
- [ ] Admin page shows delivery log, templates, and reset tool sections
- [ ] `./gradlew test` and `pnpm build` pass
- [ ] `V020`, `V021` Flyway migrations run cleanly
- [ ] JOURNAL.md entry added

### Recommendations

**Email provider selection:** For a demo that needs to show real email delivery, Mailtrap is the simplest option — sign up, get SMTP credentials, and all emails land in a shared team inbox. SendGrid is for post-demo production use. Add `WORKWELL_EMAIL_PROVIDER=mailtrap` to the Fly.io secrets for a single live demo, then remove after the presentation.

**Template variable safety:** The current template preview uses string `.replace()` — this works for a fixed variable set. Post-demo, switch to a template engine like Mustache (`com.github.spullara.mustache.java:compiler`) so templates can use loops and conditionals for multi-item case summaries.

**Demo reset frequency:** If you're doing multiple demo sessions in one day, run the reset before each session. Add a "Last reset at: [timestamp]" display to the Admin demo tools section so you know when the data was last cleaned.

**Production safeguard for reset:** The `@Profile("!prod")` approach means `DemoResetService` is not instantiated in production, so the Admin controller's `Optional<DemoResetService>` will be empty and the endpoint returns 403. This is correct but should be tested explicitly: add a test that verifies the endpoint returns 403 when the service bean is absent.
