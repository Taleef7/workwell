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
public class FluVaccineDemoService {
    private final RunPersistenceService runPersistenceService;

    public FluVaccineDemoService(RunPersistenceService runPersistenceService) {
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
                new Candidate("emp-001", 20, false),
                new Candidate("emp-005", 90, false),
                new Candidate("emp-010", 150, false),
                new Candidate("emp-014", 330, false),
                new Candidate("emp-017", 370, false),
                new Candidate("emp-021", null, false),
                new Candidate("emp-027", 410, false),
                new Candidate("emp-032", 240, true),
                new Candidate("emp-041", 340, false),
                new Candidate("emp-047", null, false)
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

        return new DemoRunPayload(runId, "Flu Vaccine", "v1.0", evaluationDate.toString(), outcomes);
    }

    private String evaluateOutcome(Candidate candidate) {
        if (candidate.hasContraindication()) return "EXCLUDED";
        if (candidate.daysSinceVaccine() == null) return "MISSING_DATA";
        if (candidate.daysSinceVaccine() <= 300) return "COMPLIANT";
        if (candidate.daysSinceVaccine() <= 365) return "DUE_SOON";
        return "OVERDUE";
    }

    private String summary(String outcome) {
        return switch (outcome) {
            case "COMPLIANT" -> "Flu vaccine is documented for the current window.";
            case "DUE_SOON" -> "Flu vaccine recertification is approaching.";
            case "OVERDUE" -> "Flu vaccine is outside the expected compliance window.";
            case "MISSING_DATA" -> "No flu vaccine record was found for this employee.";
            case "EXCLUDED" -> "A documented contraindication is on file.";
            default -> "Status unavailable.";
        };
    }

    private Map<String, Object> evidence(Candidate candidate, String outcome, LocalDate evaluationDate) {
        SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(candidate.subjectId());
        Map<String, Object> whyFlagged = new LinkedHashMap<>();
        whyFlagged.put("last_exam_date", candidate.daysSinceVaccine() == null ? null : evaluationDate.minusDays(candidate.daysSinceVaccine()).toString());
        whyFlagged.put("compliance_window_days", 365);
        whyFlagged.put("days_overdue", candidate.daysSinceVaccine() == null ? null : Math.max(candidate.daysSinceVaccine() - 365, 0));
        whyFlagged.put("role_eligible", true);
        whyFlagged.put("site_eligible", true);
        whyFlagged.put("waiver_status", candidate.hasContraindication() ? "active" : "none");
        whyFlagged.put("generated_at", Instant.now().toString());
        whyFlagged.put("outcome_status", outcome);

        List<Map<String, Object>> expressionResults = List.of(
                Map.of("define", "Active Employee", "result", true),
                Map.of("define", "Has Contraindication", "result", candidate.hasContraindication()),
                Map.of("define", "Days Since Flu Vaccine", "result", candidate.daysSinceVaccine() == null ? "unknown" : candidate.daysSinceVaccine())
        );

        Map<String, Object> evaluatedResource = new LinkedHashMap<>();
        evaluatedResource.put("subjectId", employee.externalId());
        evaluatedResource.put("employeeName", employee.name());
        evaluatedResource.put("role", employee.role());
        evaluatedResource.put("site", employee.site());
        evaluatedResource.put("daysSinceLastFluVaccine", candidate.daysSinceVaccine());
        evaluatedResource.put("measurementWindowDays", 365);

        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("expressionResults", expressionResults);
        evidence.put("evaluatedResource", evaluatedResource);
        evidence.put("why_flagged", whyFlagged);
        return evidence;
    }

    private record Candidate(String subjectId, Integer daysSinceVaccine, boolean hasContraindication) {
    }
}
