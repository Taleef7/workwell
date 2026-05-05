package com.workwell.measure;

import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.run.RunPersistenceService;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class HazwoperSurveillanceDemoService {
    private final RunPersistenceService runPersistenceService;

    public HazwoperSurveillanceDemoService(RunPersistenceService runPersistenceService) {
        this.runPersistenceService = runPersistenceService;
    }

    public GenericDemoRun run() {
        UUID runId = UUID.randomUUID();
        DemoRunPayload payload = buildPayload(runId.toString(), LocalDate.now());
        runPersistenceService.persistDemoRun(payload);
        return GenericDemoRun.fromPayload(payload);
    }

    public DemoRunPayload buildPayload(String runId, LocalDate evaluationDate) {
        List<Candidate> candidates = List.of(
                new Candidate("emp-003", 120, false),
                new Candidate("emp-008", 355, false),
                new Candidate("emp-013", 380, false),
                new Candidate("emp-018", null, false),
                new Candidate("emp-023", 440, true),
                new Candidate("emp-028", 200, false),
                new Candidate("emp-033", 365, false),
                new Candidate("emp-038", 410, false)
        );

        List<DemoOutcome> outcomes = candidates.stream().map(candidate -> {
            String outcome = evaluateOutcome(candidate);
            SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(candidate.subjectId());
            return new DemoOutcome(
                    candidate.subjectId(),
                    employee.name(),
                    employee.role(),
                    employee.site(),
                    outcome,
                    summary(outcome),
                    evidence(candidate, outcome, evaluationDate)
            );
        }).toList();

        return new DemoRunPayload(runId, "HAZWOPER Surveillance", "v1.0", evaluationDate.toString(), outcomes);
    }

    private String evaluateOutcome(Candidate candidate) {
        if (candidate.hasExemption()) return "EXCLUDED";
        if (candidate.daysSinceExam() == null) return "MISSING_DATA";
        if (candidate.daysSinceExam() <= 335) return "COMPLIANT";
        if (candidate.daysSinceExam() <= 365) return "DUE_SOON";
        return "OVERDUE";
    }

    private String summary(String outcome) {
        return switch (outcome) {
            case "COMPLIANT" -> "HAZWOPER surveillance is within the annual window.";
            case "DUE_SOON" -> "HAZWOPER surveillance is approaching the annual due date.";
            case "OVERDUE" -> "HAZWOPER surveillance is outside the annual compliance window.";
            case "MISSING_DATA" -> "No HAZWOPER surveillance completion date was found.";
            case "EXCLUDED" -> "A documented medical exemption exists for this period.";
            default -> "Status unavailable.";
        };
    }

    private Map<String, Object> evidence(Candidate candidate, String outcome, LocalDate evaluationDate) {
        SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(candidate.subjectId());
        Map<String, Object> whyFlagged = new LinkedHashMap<>();
        whyFlagged.put("last_exam_date", candidate.daysSinceExam() == null ? null : evaluationDate.minusDays(candidate.daysSinceExam()).toString());
        whyFlagged.put("compliance_window_days", 365);
        whyFlagged.put("days_overdue", candidate.daysSinceExam() == null ? null : Math.max(candidate.daysSinceExam() - 365, 0));
        whyFlagged.put("role_eligible", true);
        whyFlagged.put("site_eligible", true);
        whyFlagged.put("waiver_status", candidate.hasExemption() ? "active" : "none");
        whyFlagged.put("generated_at", Instant.now().toString());
        whyFlagged.put("outcome_status", outcome);

        return Map.of(
                "expressionResults", List.of(
                        Map.of("define", "HAZWOPER Role Eligible", "result", true),
                        Map.of("define", "Has Exemption", "result", candidate.hasExemption()),
                        Map.of("define", "Days Since Last Exam", "result", candidate.daysSinceExam())
                ),
                "evaluatedResource", Map.of(
                        "subjectId", employee.externalId(),
                        "employeeName", employee.name(),
                        "role", employee.role(),
                        "site", employee.site(),
                        "daysSinceLastHazwoperExam", candidate.daysSinceExam(),
                        "measurementWindowDays", 365
                ),
                "why_flagged", whyFlagged
        );
    }

    private record Candidate(String subjectId, Integer daysSinceExam, boolean hasExemption) {
    }
}
