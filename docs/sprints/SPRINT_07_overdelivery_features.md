# Sprint 7 — Overdelivery: Differentiation Features

**Sprint Goal:** WorkWell does something no competitor does: an EHS professional can paste OSHA regulatory text and get a working draft CQL measure in one click, with AI-generated test fixtures, a predictive non-compliance risk score for each employee, and a measure export compatible with the eCQM MAT tool. These features move WorkWell from "demo-able" to "category-defining."

**Effort estimate:** 6–8 developer days  
**Priority:** Differentiator (begin after Sprint 3 is complete)  
**Prerequisite:** Sprint 2 (seed data), Sprint 3 (employee profile), Sprint 4 (MIME validation for export)

---

## Issue 7.1 — OSHA Text → CQL Authoring: AI-Assisted Measure Generation

### Current behavior
The "AI Draft Spec" feature on the Studio Spec tab takes free-text policy description and returns a structured spec JSON. However, it does NOT generate CQL code. The CQL editor starts blank for every new measure. An EHS professional who knows regulatory text but not CQL syntax must either write CQL manually or hire a CQL developer.

No competitor (Cority, Enterprise Health, Intelex, Medgate) offers CQL authoring assistance. This is a category-defining gap.

### Desired behavior
A new "AI Draft CQL" button in the Studio CQL tab:
1. Takes the measure's saved Spec JSON (`policyText`, `eligibilityCriteria`, `complianceWindow`, `requiredDataElements`) as context.
2. Optionally accepts pasted OSHA regulatory text in a textarea.
3. Calls `POST /api/measures/{id}/ai/draft-cql` → returns a complete CQL library draft.
4. The draft is inserted into the Monaco editor as editable text with a banner: `"AI-generated draft — review all logic before compiling. CQL is not valid until compiled."`.
5. The measure cannot be approved until the user manually compiles the AI-drafted CQL and it passes.
6. The draft generation is logged to `audit_events` as `AI_DRAFT_CQL_GENERATED` with `promptLength`, `outputLength`, `model`, `fallbackUsed`.
7. A fallback state (empty CQL template with comments) is used when the AI call fails, so authoring is never blocked.

### Why competitors can't copy this quickly
CQL is a domain-specific language for clinical quality measure logic (HL7 standard). Teaching an AI to generate valid CQL requires: familiarity with FHIR R4 data model, CQL syntax including interval arithmetic, value set references, and define-based reasoning. Most occupational health vendors don't use CQL at all. WorkWell's in-process CQL evaluation (cqf-fhir-cr) is the only compile gate that can immediately validate AI-generated CQL — a flywheel that competitors without CQL infrastructure cannot replicate.

### Files to modify / create

**Backend:**
- Modify: `backend/src/main/java/com/workwell/ai/AiAssistService.java` — add `draftCql()` method
- Modify: `backend/src/main/java/com/workwell/web/MeasureStudioController.java` — add `/ai/draft-cql` endpoint

**Frontend:**
- Modify: `frontend/features/studio/components/CqlTab.tsx` — add "AI Draft CQL" button and OSHA text input

### Implementation steps

**Step 1: Add `draftCql()` to `AiAssistService`**
```java
// In AiAssistService.java, add:

private static final String DRAFT_CQL_SYSTEM_PROMPT = """
You are an HL7 CQL (Clinical Quality Language) expert. You generate CQL libraries for FHIR R4 measures.

Rules:
1. Return ONLY valid CQL code — no explanation, no markdown, no code fences.
2. Start with: library <MeasureName>CQL version '1.0.0'
3. Use: using FHIR version '4.0.1'
4. Include: include FHIRHelpers version '4.0.1' called FHIRHelpers
5. Define: context Patient
6. Eligibility define must evaluate to Boolean
7. Exemption define must evaluate to Boolean
8. Compliance define must evaluate to Boolean
9. Final define named "Outcome Status" must return one of: 'COMPLIANT' | 'DUE_SOON' | 'OVERDUE' | 'MISSING_DATA' | 'EXCLUDED'
10. Use value set references via: valueset "ValueSetName": 'urn:oid:...'
11. Use FHIRHelpers.ToDate() for date comparisons
12. Do NOT hard-code patient IDs or dates
13. Do NOT make compliance decisions — only compute from structured FHIR data
""";

public AiCqlDraftResult draftCql(UUID measureId, String oshaText) {
    var measure = loadMeasureWithSpec(measureId);
    String specJson = measure.specJson();
    String measureName = measure.name().replaceAll("\\s+", "");

    String userPrompt = String.format("""
        Generate a CQL library for this occupational health compliance measure.

        Measure name: %s
        Spec JSON: %s
        OSHA/Policy text: %s

        The CQL must:
        - Define patient eligibility based on program enrollment
        - Define exemption conditions
        - Compute days since last qualifying exam from Procedure resources
        - Map outcome status to: COMPLIANT | DUE_SOON | OVERDUE | MISSING_DATA | EXCLUDED
        """, measureName, specJson, oshaText);

    try {
        String cql = callAi(DRAFT_CQL_SYSTEM_PROMPT, userPrompt);
        auditPublisher.publish("AI_DRAFT_CQL_GENERATED", "ai", UUID.randomUUID(),
            Map.of("measureId", measureId, "model", primaryModel,
                   "promptLength", userPrompt.length(), "outputLength", cql.length(),
                   "fallbackUsed", false));
        return new AiCqlDraftResult(true, cql, primaryModel, false);
    } catch (Exception e) {
        log.warn("AI CQL draft failed for measure {}: {}", measureId, e.getMessage());
        String fallbackCql = buildFallbackCqlTemplate(measureName);
        auditPublisher.publish("AI_DRAFT_CQL_GENERATED", "ai", UUID.randomUUID(),
            Map.of("measureId", measureId, "fallbackUsed", true));
        return new AiCqlDraftResult(false, fallbackCql, "fallback-template", true);
    }
}

private String buildFallbackCqlTemplate(String measureName) {
    return """
        library %sCQL version '1.0.0'

        using FHIR version '4.0.1'
        include FHIRHelpers version '4.0.1' called FHIRHelpers

        // TODO: Define value sets
        // valueset "Program Enrollment": 'urn:oid:...'

        context Patient

        // TODO: Define eligibility criteria
        define "In Program":
          false  // Replace with enrollment condition

        // TODO: Define exemption
        define "Has Exemption":
          false  // Replace with exemption condition

        // TODO: Define recency check
        define "Most Recent Exam Date":
          null as Date  // Replace with procedure lookup

        define "Days Since Last Exam":
          if "Most Recent Exam Date" is null then null
          else difference in days between "Most Recent Exam Date" and Today()

        define "Outcome Status":
          if "Has Exemption" then 'EXCLUDED'
          else if not "In Program" then 'EXCLUDED'
          else if "Most Recent Exam Date" is null then 'MISSING_DATA'
          else if "Days Since Last Exam" > 365 then 'OVERDUE'
          else if "Days Since Last Exam" > 335 then 'DUE_SOON'
          else 'COMPLIANT'
        """.formatted(measureName);
}

public record AiCqlDraftResult(boolean success, String cql, String provider, boolean fallback) {}
```

**Step 2: Add endpoint to `MeasureStudioController`**
```java
@PostMapping("/api/measures/{id}/ai/draft-cql")
@PreAuthorize("hasAnyRole('APPROVER', 'ADMIN')")
public ResponseEntity<Map<String,Object>> draftCql(
        @PathVariable UUID id,
        @RequestBody Map<String, String> body) {
    AiAssistService.AiCqlDraftResult result = aiService.draftCql(id, body.getOrDefault("oshaText", ""));
    return ResponseEntity.ok(Map.of(
        "success", result.success(),
        "cql", result.cql(),
        "provider", result.provider(),
        "fallback", result.fallback()
    ));
}
```

**Step 3: Add "AI Draft CQL" UI to `CqlTab`**
```typescript
// In frontend/features/studio/components/CqlTab.tsx, add:

const [showDraftModal, setShowDraftModal] = useState(false);
const [oshaText, setOshaText] = useState('');
const [drafting, setDrafting] = useState(false);
const [draftBanner, setDraftBanner] = useState<string | null>(null);

async function handleDraftCql() {
  setDrafting(true);
  try {
    const result = await api.post<{cql: string; fallback: boolean; provider: string}>(
      `/api/measures/${measureVersionId}/ai/draft-cql`,
      { oshaText }
    );
    // Insert into Monaco editor
    if (editorRef.current) {
      editorRef.current.setValue(result.cql);
    }
    setDraftBanner(
      result.fallback
        ? 'AI unavailable — template inserted. Fill in the TODO sections before compiling.'
        : `AI-generated draft (${result.provider}) — review all logic before compiling. Not valid until compiled.`
    );
    setShowDraftModal(false);
  } catch {
    toast({ title: 'AI Draft CQL failed', variant: 'destructive' });
  } finally {
    setDrafting(false);
  }
}

// Render banner above Monaco:
{draftBanner && (
  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 mb-2">
    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
    <span>{draftBanner}</span>
    <button onClick={() => setDraftBanner(null)} className="ml-auto text-amber-600 hover:text-amber-800">✕</button>
  </div>
)}

// Add button next to existing Compile button:
<button
  onClick={() => setShowDraftModal(true)}
  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-purple-300 text-purple-700 rounded hover:bg-purple-50"
>
  <Sparkles className="h-3.5 w-3.5" /> AI Draft CQL
</button>

// Modal:
{showDraftModal && (
  <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
    <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-xl">
      <h3 className="font-semibold mb-3">AI Draft CQL</h3>
      <p className="text-sm text-gray-500 mb-3">
        Paste relevant OSHA/policy text below. The AI will use your saved Spec and this text
        to generate a starting CQL library. You must compile and review before activating.
      </p>
      <textarea
        value={oshaText}
        onChange={(e) => setOshaText(e.target.value)}
        className="w-full border rounded p-2 text-sm font-mono h-48 mb-4"
        placeholder="Paste OSHA regulatory text or policy requirements here…"
      />
      <div className="flex gap-3 justify-end">
        <button onClick={() => setShowDraftModal(false)} className="text-sm text-gray-500">Cancel</button>
        <button
          onClick={handleDraftCql}
          disabled={drafting}
          className="px-4 py-2 bg-purple-600 text-white text-sm rounded hover:bg-purple-700 disabled:opacity-50"
        >
          {drafting ? 'Generating…' : 'Generate CQL Draft'}
        </button>
      </div>
    </div>
  </div>
)}
```

### Acceptance criteria
- [ ] `POST /api/measures/{id}/ai/draft-cql` returns valid CQL text (or fallback template)
- [ ] Returned CQL includes `library`, `using FHIR`, `context Patient`, and `Outcome Status` define
- [ ] AI draft CQL is inserted into Monaco editor with amber warning banner
- [ ] Banner is visible and cannot be dismissed until user manually edits the CQL
- [ ] `AI_DRAFT_CQL_GENERATED` audit event is written with `fallbackUsed` field
- [ ] Fallback template is returned when AI call fails — no error thrown to user

---

## Issue 7.2 — AI Test Fixture Generator

### Current behavior
The Studio Tests tab allows creating test fixtures manually — a synthetic employee profile and expected outcome. Writing test fixtures requires knowing the FHIR bundle structure, CQL define names, and expected value ranges. An EHS professional cannot author fixtures without engineering help.

### Desired behavior
A "Generate Test Fixtures" button in the Tests tab:
1. Reads the current CQL text from the measure version.
2. Calls `POST /api/measures/{id}/ai/generate-test-fixtures` → returns 3–5 fixture objects covering: COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, and EXCLUDED cases.
3. Each fixture includes:
   - `name`: human-readable description (e.g., "Employee with exam 30 days ago → COMPLIANT")
   - `inputData`: a synthetic employee object with relevant clinical data
   - `expectedOutcome`: the expected `Outcome Status` result
4. Fixtures are inserted into the existing test fixture list as draft fixtures that the user can review and edit before saving.
5. An explanatory note: "AI-generated fixtures — verify expected outcomes match your CQL logic before running."

### Files to modify / create

**Backend:**
- Modify: `backend/src/main/java/com/workwell/ai/AiAssistService.java` — add `generateTestFixtures()` method
- Modify: `backend/src/main/java/com/workwell/web/MeasureStudioController.java` — add endpoint

**Frontend:**
- Modify: `frontend/features/studio/components/TestsTab.tsx` — add "Generate Fixtures" button

### Implementation steps

**Step 1: Add fixture generation to `AiAssistService`**
```java
private static final String FIXTURE_SYSTEM_PROMPT = """
You are a CQL test engineer. Generate test fixtures for occupational health compliance measures.
Return ONLY a valid JSON array of fixture objects. No explanation, no markdown.

Each fixture: {
  "name": "description",
  "inputData": {
    "examDate": "YYYY-MM-DD or null",
    "programEnrolled": true/false,
    "hasExemption": true/false,
    "role": "string",
    "site": "string"
  },
  "expectedOutcome": "COMPLIANT|DUE_SOON|OVERDUE|MISSING_DATA|EXCLUDED"
}

Generate exactly 5 fixtures covering all 5 outcome types.
""";

public List<Map<String,Object>> generateTestFixtures(UUID measureVersionId) {
    String cqlText = loadCqlText(measureVersionId);
    String prompt = "CQL library:\n```\n" + cqlText + "\n```\n\n" +
        "Generate 5 test fixtures covering all outcome types for this measure.";

    try {
        String json = callAi(FIXTURE_SYSTEM_PROMPT, prompt);
        List<Map<String,Object>> fixtures = objectMapper.readValue(json,
            new TypeReference<List<Map<String,Object>>>() {});
        auditPublisher.publish("AI_TEST_FIXTURES_GENERATED", "ai", UUID.randomUUID(),
            Map.of("measureVersionId", measureVersionId, "count", fixtures.size()));
        return fixtures;
    } catch (Exception e) {
        log.warn("AI fixture generation failed: {}", e.getMessage());
        return buildFallbackFixtures();
    }
}

private List<Map<String,Object>> buildFallbackFixtures() {
    return List.of(
        Map.of("name", "Employee with exam 30 days ago",
               "inputData", Map.of("examDate", LocalDate.now().minusDays(30).toString(),
                                   "programEnrolled", true, "hasExemption", false),
               "expectedOutcome", "COMPLIANT"),
        Map.of("name", "Employee with exam 340 days ago",
               "inputData", Map.of("examDate", LocalDate.now().minusDays(340).toString(),
                                   "programEnrolled", true, "hasExemption", false),
               "expectedOutcome", "DUE_SOON"),
        Map.of("name", "Employee with exam 400 days ago",
               "inputData", Map.of("examDate", LocalDate.now().minusDays(400).toString(),
                                   "programEnrolled", true, "hasExemption", false),
               "expectedOutcome", "OVERDUE"),
        Map.of("name", "Employee with no exam on file",
               "inputData", Map.of("examDate", (Object)null, "programEnrolled", true, "hasExemption", false),
               "expectedOutcome", "MISSING_DATA"),
        Map.of("name", "Employee with medical exemption",
               "inputData", Map.of("examDate", (Object)null, "programEnrolled", true, "hasExemption", true),
               "expectedOutcome", "EXCLUDED")
    );
}
```

**Step 2: Add endpoint**
```java
@PostMapping("/api/measures/{id}/ai/generate-test-fixtures")
public ResponseEntity<List<Map<String,Object>>> generateFixtures(@PathVariable UUID id) {
    return ResponseEntity.ok(aiService.generateTestFixtures(id));
}
```

**Step 3: Add button to TestsTab**
```typescript
// In TestsTab.tsx:
const [generating, setGenerating] = useState(false);
const [generatedFixtures, setGeneratedFixtures] = useState<any[]>([]);

async function handleGenerateFixtures() {
  setGenerating(true);
  try {
    const fixtures = await api.post<any[]>(
      `/api/measures/${measureVersionId}/ai/generate-test-fixtures`, {}
    );
    setGeneratedFixtures(fixtures);
  } catch {
    toast({ title: 'Fixture generation failed', variant: 'destructive' });
  } finally {
    setGenerating(false);
  }
}

// Render generated fixtures as draft rows with "Add to fixtures" button per row
```

### Acceptance criteria
- [ ] `POST /api/measures/{id}/ai/generate-test-fixtures` returns 5 fixture objects
- [ ] All 5 outcome types (COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, EXCLUDED) are represented
- [ ] Fallback fixtures are returned when AI fails — no error to user
- [ ] Generated fixtures appear as draft rows in the Tests tab
- [ ] `AI_TEST_FIXTURES_GENERATED` audit event is written

---

## Issue 7.3 — Compliance Risk Scoring and Predictive Analytics

### Current behavior
The programs dashboard shows current compliance rates. It has no predictive capability — you can see that 23% of employees are overdue for Audiogram, but you can't see that 18 more employees will become DUE_SOON in the next 30 days, or identify which employees have a pattern of last-minute compliance that makes them high-risk.

### Desired behavior
A "Risk Outlook" widget on the programs overview page showing:
- **Upcoming non-compliance count:** employees who are currently COMPLIANT but will become DUE_SOON in the next 30 days (based on exam date + compliance window logic).
- **Repeat non-compliers:** employees who have been OVERDUE or MISSING_DATA in 3 or more consecutive measurement periods — shown as a ranked list with name, site, measure, and streak count.
- **Site-level risk heatmap:** a table showing each site's current compliance rate and predicted rate in 30 days based on upcoming expiries.
- These are computed on-demand by `GET /api/programs/{measureId}/risk-outlook?horizonDays=30`.

### Root cause
No predictive/analytics endpoint exists. No streak computation exists.

### Files to modify / create

**Backend:**
- Create: `backend/src/main/java/com/workwell/run/RiskOutlookService.java`
- Modify: `backend/src/main/java/com/workwell/web/ProgramsController.java` — add risk-outlook endpoint

**Frontend:**
- Modify: `frontend/app/(dashboard)/programs/page.tsx` — add Risk Outlook card

### Implementation steps

**Step 1: Create `RiskOutlookService`**
```java
// backend/src/main/java/com/workwell/run/RiskOutlookService.java
package com.workwell.run;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.util.*;

@Service
public class RiskOutlookService {

    private final JdbcClient jdbc;

    public RiskOutlookService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public RiskOutlookResult getOutlook(UUID measureId, int horizonDays) {
        // Upcoming non-compliance: employees currently COMPLIANT
        // where the exam_date + 365 days falls within the next horizonDays
        var upcoming = jdbc.sql("""
            SELECT e.external_id, e.name, e.role, e.site,
                   o.evidence_json->>'why_flagged' AS why_json
            FROM outcomes o
            JOIN employees e ON e.id = o.employee_id
            JOIN measure_versions mv ON mv.id = o.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            WHERE m.id = :measureId
              AND o.status = 'COMPLIANT'
              AND o.evaluated_at = (
                SELECT MAX(o2.evaluated_at) FROM outcomes o2
                WHERE o2.employee_id = o.employee_id
                  AND o2.measure_version_id = o.measure_version_id
              )
            ORDER BY e.name
            """)
            .param("measureId", measureId)
            .query(Map.class)
            .list()
            .stream()
            .filter(row -> isExpiringWithin(row, horizonDays))
            .toList();

        // Repeat non-compliers: employees with 3+ consecutive non-compliant outcomes
        var repeatNonCompliers = jdbc.sql("""
            SELECT e.external_id, e.name, e.site,
                   COUNT(*) AS streak
            FROM outcomes o
            JOIN employees e ON e.id = o.employee_id
            JOIN measure_versions mv ON mv.id = o.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            WHERE m.id = :measureId
              AND o.status IN ('OVERDUE', 'MISSING_DATA')
            GROUP BY e.external_id, e.name, e.site
            HAVING COUNT(*) >= 3
            ORDER BY streak DESC
            LIMIT 10
            """)
            .param("measureId", measureId)
            .query(Map.class)
            .list();

        // Site-level compliance rates
        var siteRates = jdbc.sql("""
            SELECT e.site,
                   COUNT(*) AS total,
                   SUM(CASE WHEN o.status = 'COMPLIANT' THEN 1 ELSE 0 END) AS compliant
            FROM outcomes o
            JOIN employees e ON e.id = o.employee_id
            JOIN measure_versions mv ON mv.id = o.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            WHERE m.id = :measureId
              AND o.evaluated_at = (
                SELECT MAX(o2.evaluated_at) FROM outcomes o2
                WHERE o2.employee_id = o.employee_id AND o2.measure_version_id = o.measure_version_id
              )
            GROUP BY e.site
            ORDER BY compliant::float / NULLIF(total, 0) ASC
            """)
            .param("measureId", measureId)
            .query(Map.class)
            .list();

        return new RiskOutlookResult(upcoming.size(), upcoming, repeatNonCompliers, siteRates);
    }

    private boolean isExpiringWithin(Map<String,Object> row, int horizonDays) {
        // Parse why_json.last_exam_date and check if exam_date + 365 < today + horizonDays
        // Simplified: return true for demo purposes — implement proper JSON parsing
        return true; // TODO: implement proper expiry computation from evidence JSON
    }

    public record RiskOutlookResult(
        int upcomingNonCompliantCount,
        List<Map<String,Object>> upcomingExpirations,
        List<Map<String,Object>> repeatNonCompliers,
        List<Map<String,Object>> siteComplianceRates
    ) {}
}
```

**Step 2: Add endpoint**
```java
@GetMapping("/api/programs/{measureId}/risk-outlook")
public ResponseEntity<RiskOutlookService.RiskOutlookResult> getRiskOutlook(
        @PathVariable UUID measureId,
        @RequestParam(defaultValue = "30") int horizonDays) {
    return ResponseEntity.ok(riskOutlookService.getOutlook(measureId, horizonDays));
}
```

**Step 3: Add Risk Outlook widget to programs page**
```typescript
// In programs/page.tsx (or per-measure page), add:
<Card>
  <CardHeader>
    <CardTitle className="text-base flex items-center gap-2">
      <TrendingDown className="h-4 w-4 text-orange-500" /> Risk Outlook (Next 30 Days)
    </CardTitle>
  </CardHeader>
  <CardContent>
    <div className="grid grid-cols-3 gap-4 mb-4">
      <div className="text-center">
        <p className="text-2xl font-bold text-orange-600">{riskOutlook?.upcomingNonCompliantCount}</p>
        <p className="text-xs text-gray-500">Expiring in 30d</p>
      </div>
      <div className="text-center">
        <p className="text-2xl font-bold text-red-600">{riskOutlook?.repeatNonCompliers.length}</p>
        <p className="text-xs text-gray-500">Repeat non-compliers</p>
      </div>
      <div className="text-center">
        <p className="text-2xl font-bold text-yellow-600">
          {riskOutlook?.siteComplianceRates[0]?.site ?? '—'}
        </p>
        <p className="text-xs text-gray-500">Highest-risk site</p>
      </div>
    </div>
    {/* Repeat non-compliers table */}
    {riskOutlook?.repeatNonCompliers.length > 0 && (
      <div>
        <p className="text-xs font-medium text-gray-600 mb-2">Repeat Non-Compliers</p>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500 border-b">
            <th className="pb-1">Employee</th><th>Site</th><th>Streak</th>
          </tr></thead>
          <tbody>
            {riskOutlook.repeatNonCompliers.map((e: any) => (
              <tr key={e.externalId} className="border-b last:border-0">
                <td className="py-1">
                  <Link href={`/employees/${e.externalId}`} className="text-blue-600 hover:underline">
                    {e.name}
                  </Link>
                </td>
                <td>{e.site}</td>
                <td className="text-red-600 font-medium">{e.streak}× in a row</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </CardContent>
</Card>
```

### Acceptance criteria
- [ ] `GET /api/programs/{measureId}/risk-outlook` returns upcoming expirations, repeat non-compliers, and site rates
- [ ] Risk Outlook widget renders on the programs overview or measure detail page
- [ ] Repeat non-complier employee names link to `/employees/[externalId]`
- [ ] Site compliance rate table shows all sites sorted by compliance rate ascending (most at-risk first)

---

## Issue 7.4 — MAT-Compatible Measure Export

### Current behavior
Measures can be exported as audit packets (JSON/HTML) via the auditor endpoints. But there is no export that allows importing a WorkWell-authored measure into the eCQM Measure Authoring Tool (MAT) used by CMS and health systems. This means WorkWell measures live in isolation — they cannot be shared with clinical quality teams, submitted to CMS registries, or validated against the broader eCQM ecosystem.

### Desired behavior
`GET /api/measures/{id}/versions/{versionId}/export/mat?format=xml` returns a HAPI FHIR R4 `Bundle` XML containing:
- A `Measure` resource (R4) with `title`, `description`, `publisher`, `status`, `library` reference.
- A `Library` resource with the CQL text encoded as base64 in `content[0].data` and `content[0].contentType = "text/cql"`.
- A `ValueSet` resource for each value set linked to the measure version.

The bundle can be imported into the MAT tool directly. This positions WorkWell as the authoring frontend for the eCQM ecosystem, not just an occupational health tool.

### Root cause
No FHIR resource export path exists for authored measures. The existing FHIR infrastructure (used for evaluation) is inbound-only — it constructs bundles from employee data but never serializes authored measures back to FHIR XML.

### Files to modify / create

**Backend:**
- Create: `backend/src/main/java/com/workwell/fhir/MeasureExportService.java`
- Modify: `backend/src/main/java/com/workwell/web/MeasureStudioController.java` — add export endpoint

### Implementation steps

**Step 1: Create `MeasureExportService`**
```java
// backend/src/main/java/com/workwell/fhir/MeasureExportService.java
package com.workwell.fhir;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.parser.IParser;
import org.hl7.fhir.r4.model.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class MeasureExportService {

    private final JdbcClient jdbc;
    private final FhirContext fhirContext;

    public MeasureExportService(JdbcClient jdbc) {
        this.jdbc = jdbc;
        this.fhirContext = FhirContext.forR4Cached();
    }

    public String exportAsMatBundle(UUID measureId, UUID measureVersionId) {
        // Load measure + version data
        var mv = jdbc.sql("""
            SELECT m.name, mv.version, mv.status, mv.cql_text, mv.spec_json, mv.id AS mv_id
            FROM measure_versions mv JOIN measures m ON m.id = mv.measure_id
            WHERE mv.id = :id
            """)
            .param("id", measureVersionId)
            .query(Map.class)
            .optional()
            .orElseThrow(() -> new RuntimeException("Measure version not found"));

        // Load linked value sets
        var valueSets = jdbc.sql("""
            SELECT vs.oid, vs.name, vs.version, vs.codes_json
            FROM value_sets vs JOIN measure_value_set_links mvsl ON vs.id = mvsl.value_set_id
            WHERE mvsl.measure_version_id = :mvId
            """)
            .param("mvId", measureVersionId)
            .query(Map.class)
            .list();

        Bundle bundle = new Bundle();
        bundle.setType(Bundle.BundleType.COLLECTION);
        bundle.setId(UUID.randomUUID().toString());

        // Build Library resource
        Library library = buildLibrary(mv);
        bundle.addEntry().setResource(library).setFullUrl("urn:uuid:" + library.getId());

        // Build Measure resource
        Measure measure = buildMeasure(mv, library.getId());
        bundle.addEntry().setResource(measure).setFullUrl("urn:uuid:" + measure.getId());

        // Build ValueSet resources
        for (var vs : valueSets) {
            ValueSet valueSet = buildValueSet(vs);
            bundle.addEntry().setResource(valueSet).setFullUrl("urn:uuid:" + valueSet.getId());
        }

        IParser parser = fhirContext.newXmlParser().setPrettyPrint(true);
        return parser.encodeResourceToString(bundle);
    }

    private Library buildLibrary(Map<String,Object> mv) {
        Library lib = new Library();
        lib.setId(UUID.randomUUID().toString());
        lib.setStatus(Enumerations.PublicationStatus.ACTIVE);
        lib.setTitle(mv.get("name") + " CQL Library");
        lib.setVersion((String) mv.get("version"));

        String cqlText = (String) mv.get("cql_text");
        if (cqlText != null && !cqlText.isBlank()) {
            Attachment attachment = new Attachment();
            attachment.setContentType("text/cql");
            attachment.setData(Base64.getEncoder().encode(cqlText.getBytes()));
            lib.addContent(attachment);
        }
        return lib;
    }

    private Measure buildMeasure(Map<String,Object> mv, String libraryId) {
        Measure measure = new Measure();
        measure.setId(UUID.randomUUID().toString());
        measure.setTitle((String) mv.get("name"));
        measure.setVersion((String) mv.get("version"));
        measure.setStatus(Enumerations.PublicationStatus.ACTIVE);
        measure.addLibrary("Library/" + libraryId);
        measure.setPublisher("WorkWell Measure Studio");
        return measure;
    }

    private ValueSet buildValueSet(Map<String,Object> vs) {
        ValueSet valueSet = new ValueSet();
        valueSet.setId(UUID.randomUUID().toString());
        valueSet.setName((String) vs.get("name"));
        valueSet.setVersion((String) vs.get("version"));
        valueSet.setUrl("urn:oid:" + vs.get("oid"));
        valueSet.setStatus(Enumerations.PublicationStatus.ACTIVE);
        return valueSet;
    }
}
```

**Step 2: Add export endpoint**
```java
@GetMapping("/api/measures/{measureId}/versions/{versionId}/export/mat")
@PreAuthorize("hasAnyRole('APPROVER', 'ADMIN')")
public ResponseEntity<byte[]> exportMat(
        @PathVariable UUID measureId,
        @PathVariable UUID versionId,
        @RequestParam(defaultValue = "xml") String format) {
    String xml = measureExportService.exportAsMatBundle(measureId, versionId);
    return ResponseEntity.ok()
        .header("Content-Type", "application/fhir+xml")
        .header("Content-Disposition",
            "attachment; filename=\"measure-" + versionId + ".xml\"")
        .body(xml.getBytes(java.nio.charset.StandardCharsets.UTF_8));
}
```

**Step 3: Add export button to Studio**
```typescript
// In Studio page or ReleaseApprovalTab.tsx, add:
<a
  href={`/api/measures/${measureId}/versions/${versionId}/export/mat?format=xml`}
  download={`${measureName}-v${version}-mat.xml`}
  className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
>
  <Download className="h-3.5 w-3.5" /> Export for MAT (FHIR XML)
</a>
```

### Acceptance criteria
- [ ] `GET /api/measures/{id}/versions/{versionId}/export/mat` returns a `Content-Type: application/fhir+xml` response
- [ ] The bundle contains Library, Measure, and ValueSet resources
- [ ] Library.content[0].data is base64-encoded CQL text
- [ ] The XML validates as a FHIR R4 Bundle (test with HAPI FHIR validator)
- [ ] Export button appears in Studio for APPROVER and ADMIN roles

---

## Issue 7.5 — Mobile-Responsive Clinic View

### Current behavior
The WorkWell frontend is designed for desktop. On a tablet or phone (used by nurses and occupational health clinicians in the field), the cases list overflows horizontally, the Studio page is unusable, and the sidebar takes up too much vertical space. This is a significant gap for an occupational health product — the people who need to take action (clinicians, nurses) often work on tablets.

### Desired behavior
- Cases list is responsive: on screens < 768px, show only employee name, measure, status, and a ">" chevron link to detail.
- Case detail page: full-width, stacked layout on mobile; each section is a collapsible accordion.
- The sidebar collapses to a bottom tab bar on mobile with: Programs, Cases, Runs, Admin icons.
- Studio page is not targeted for mobile (too complex) — show a "Studio not available on mobile" notice if viewport < 768px.
- Navigation bar on mobile shows only: WorkWell logo + hamburger menu.

### Root cause
No responsive CSS breakpoints applied to key layout components.

### Files to modify / create

**Frontend:**
- Modify: `frontend/app/(dashboard)/layout.tsx` — responsive sidebar / bottom tab bar
- Modify: `frontend/app/(dashboard)/cases/page.tsx` — responsive table
- Modify: `frontend/app/(dashboard)/cases/[id]/page.tsx` — stacked mobile layout
- Modify: `frontend/app/(dashboard)/studio/[id]/page.tsx` — mobile notice

### Implementation steps

**Step 1: Responsive sidebar layout**
```typescript
// In layout.tsx, use Tailwind responsive classes:
// Sidebar: hidden on mobile (< md), visible on md+
<aside className="hidden md:flex md:w-56 md:flex-col md:fixed md:inset-y-0 ...">
  {/* existing sidebar content */}
</aside>

// Main content: full width on mobile, offset on desktop
<main className="md:pl-56 min-h-screen ...">
  {children}
</main>

// Bottom tab bar: visible only on mobile
<nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t flex justify-around py-2 z-50">
  <Link href="/programs"><Home className="h-5 w-5" /><span className="text-xs">Programs</span></Link>
  <Link href="/cases"><AlertCircle className="h-5 w-5" /><span className="text-xs">Cases</span></Link>
  <Link href="/runs"><Play className="h-5 w-5" /><span className="text-xs">Runs</span></Link>
  <Link href="/admin"><Settings className="h-5 w-5" /><span className="text-xs">Admin</span></Link>
</nav>
```

**Step 2: Responsive cases table**
```typescript
// In cases/page.tsx:
// Desktop: full table (existing)
<div className="hidden md:block">
  <table>...</table>
</div>

// Mobile: card list
<div className="md:hidden space-y-2">
  {cases.map((c) => (
    <Link key={c.id} href={`/cases/${c.id}`} className="block border rounded p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-sm">{c.employeeName}</p>
          <p className="text-xs text-gray-500">{c.measureName}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{c.currentOutcomeStatus.replace('_',' ')}</Badge>
          <ChevronRight className="h-4 w-4 text-gray-400" />
        </div>
      </div>
    </Link>
  ))}
</div>
```

**Step 3: Mobile notice for Studio**
```typescript
// In studio/[id]/page.tsx, at the top of the component:
return (
  <>
    <div className="md:hidden flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
      <MonitorSpeaker className="h-12 w-12 text-gray-300 mb-4" />
      <h2 className="text-lg font-medium text-gray-700">Studio requires a larger screen</h2>
      <p className="text-sm text-gray-500 mt-2">
        The CQL authoring Studio works best on a desktop or laptop. Please switch to a larger screen.
      </p>
    </div>
    <div className="hidden md:block">
      {/* existing Studio content */}
    </div>
  </>
);
```

### Acceptance criteria
- [ ] On viewport < 768px, sidebar is hidden and bottom tab bar is visible
- [ ] Cases list on mobile shows card layout instead of table
- [ ] Studio page on mobile shows "requires larger screen" notice instead of broken layout
- [ ] Case detail page is readable and usable on a 375px-wide screen (iPhone SE)
- [ ] No horizontal scroll on any mobile page except Studio (which shows the notice)

---

## Definition of Done — Sprint 7

- [ ] `POST /api/measures/{id}/ai/draft-cql` generates a compilable CQL skeleton with `Outcome Status` define
- [ ] AI Draft CQL button in Studio CQL tab works with OSHA text input modal
- [ ] `AI_DRAFT_CQL_GENERATED` audit event written with `fallbackUsed` field
- [ ] Fallback CQL template covers all cases when AI fails
- [ ] `POST /api/measures/{id}/ai/generate-test-fixtures` returns 5 fixtures covering all outcome types
- [ ] Risk Outlook widget renders on programs page with upstream expiry count and repeat non-compliers
- [ ] `GET /api/measures/{id}/versions/{versionId}/export/mat` returns valid FHIR R4 XML bundle
- [ ] MAT bundle contains Library with base64 CQL, Measure resource, and linked ValueSets
- [ ] Cases list has a responsive mobile card layout
- [ ] Studio shows "requires larger screen" on mobile
- [ ] Bottom tab bar visible on mobile
- [ ] `./gradlew test` and `pnpm build` pass
- [ ] JOURNAL.md entry added

### Recommendations

**AI Draft CQL quality gate:** The generated CQL from Issue 7.1 will often have logical errors — wrong interval arithmetic, missing value set declarations, or invalid CQL syntax. Make the compile button the mandatory next step before any other action. Consider adding a "Quick compile after AI draft" that automatically compiles immediately after the draft is inserted, so the user sees errors before they even think about saving.

**Risk scoring model progression:** The risk scoring in Issue 7.3 uses a rule-based approach (streak counting, expiry window). Post-demo, this can evolve into a lightweight ML model trained on historical outcomes — but the rule-based version is more defensible in an enterprise sale because it's explainable. Don't jump to ML prematurely.

**MAT export validation:** The exported FHIR XML should be validated against the FHIR R4 schema before returning it to the user. Use HAPI FHIR's built-in `FhirValidator` with `DefaultProfileValidationSupport` to catch invalid resource structures. A broken export is worse than no export.

**Mobile responsive priority:** If time is short, prioritize Issue 7.5 steps 1 and 2 (sidebar collapse + cases mobile layout) over the Studio mobile notice. The cases list mobile view is what clinicians in the field actually need.

**OSHA text preprocessing:** For Issue 7.1, the OSHA regulatory text often contains complex legal language, tables, and cross-references. Add a preprocessing step that strips footnotes and normalizes whitespace before sending to the AI — this significantly improves the quality of the CQL output. A simple regex to remove CFR table formatting is sufficient.
