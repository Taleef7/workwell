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
public class TBSurveillanceDemoService {
    private final RunPersistenceService runPersistenceService;

    public TBSurveillanceDemoService(RunPersistenceService runPersistenceService) {
        this.runPersistenceService = runPersistenceService;
    }

    public TBDemoRun run() {
        UUID runId = UUID.randomUUID();
        DemoRunPayload payload = buildPayload(runId.toString(), LocalDate.now());
        List<TBOutcome> outcomes = payload.outcomes().stream()
                .map(outcome -> new TBOutcome(
                        outcome.subjectId(),
                        outcome.outcome(),
                        outcome.summary(),
                        outcome.evidenceJson()
                ))
                .toList();
        long compliant = outcomes.stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        long dueSoon = outcomes.stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
        long overdue = outcomes.stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
        long missingData = outcomes.stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
        long excluded = outcomes.stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();
        TBDemoRun run = new TBDemoRun(
                payload.runId(),
                payload.measureName(),
                payload.measureVersion(),
                payload.evaluationDate(),
                new RunSummary(compliant, dueSoon, overdue, missingData, excluded),
                outcomes
        );
        runPersistenceService.persistDemoRun(payload);
        return run;
    }

    public DemoRunPayload buildPayload(String runId, LocalDate evaluationDate) {
        List<TBCandidate> candidates = List.of(
                new TBCandidate("emp-041", 120, false),
                new TBCandidate("emp-042", 240, false),
                new TBCandidate("emp-043", 310, false),
                new TBCandidate("emp-044", 330, false),
                new TBCandidate("emp-045", 365, false),
                new TBCandidate("emp-046", 380, false),
                new TBCandidate("emp-047", 450, false),
                new TBCandidate("emp-048", 200, false),
                new TBCandidate("emp-049", null, false),
                new TBCandidate("emp-050", 600, true)
        );

        List<DemoOutcome> payloadOutcomes = candidates.stream().map(candidate -> {
            TBOutcome outcome = evaluate(candidate, evaluationDate);
            SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(candidate.subjectId());
            return new DemoOutcome(
                    candidate.subjectId(),
                    employee.name(),
                    employee.role(),
                    employee.site(),
                    outcome.outcome(),
                    outcome.summary(),
                    outcome.evidenceJson()
            );
        }).toList();
        return new DemoRunPayload(
                runId,
                "TB Surveillance",
                "v1.3",
                evaluationDate.toString(),
                payloadOutcomes
        );
    }

    private TBOutcome evaluate(TBCandidate candidate, LocalDate evaluationDate) {
        String outcome;
        String reason;
        if (candidate.hasMedicalExemption()) {
            outcome = "EXCLUDED";
            reason = "Medical exemption on file for current TB window.";
        } else if (candidate.daysSinceTbScreen() == null) {
            outcome = "MISSING_DATA";
            reason = "No TB screening date found for eligible clinic employee.";
        } else if (candidate.daysSinceTbScreen() <= 330) {
            outcome = "COMPLIANT";
            reason = "TB screening completed within annual compliance window.";
        } else if (candidate.daysSinceTbScreen() <= 365) {
            outcome = "DUE_SOON";
            reason = "TB screening due soon within the annual window.";
        } else {
            outcome = "OVERDUE";
            reason = "TB screening is outside the annual compliance window.";
        }
        return new TBOutcome(candidate.subjectId(), outcome, reason, buildEvidence(candidate, outcome, evaluationDate));
    }

    private Map<String, Object> buildEvidence(TBCandidate candidate, String outcome, LocalDate evaluationDate) {
        SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(candidate.subjectId());
        Map<String, Object> evaluated = new LinkedHashMap<>();
        evaluated.put("subjectId", employee.externalId());
        evaluated.put("employeeName", employee.name());
        evaluated.put("role", employee.role());
        evaluated.put("site", employee.site());
        evaluated.put("daysSinceLastTbScreen", candidate.daysSinceTbScreen());
        evaluated.put("measurementWindowDays", 365);
        evaluated.put("hasMedicalExemption", candidate.hasMedicalExemption());

        Map<String, Object> whyFlagged = new LinkedHashMap<>();
        whyFlagged.put("last_exam_date", candidate.daysSinceTbScreen() == null
                ? null
                : evaluationDate.minusDays(candidate.daysSinceTbScreen()).toString());
        whyFlagged.put("compliance_window_days", 365);
        whyFlagged.put("days_overdue", candidate.daysSinceTbScreen() == null ? null : Math.max(candidate.daysSinceTbScreen() - 365, 0));
        whyFlagged.put("role_eligible", true);
        whyFlagged.put("site_eligible", true);
        whyFlagged.put("waiver_status", candidate.hasMedicalExemption() ? "active" : "none");
        whyFlagged.put("generated_at", Instant.now().toString());
        whyFlagged.put("outcome_status", outcome);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("expressionResults", List.of(
                expressionResult("TB Eligible Role", true),
                expressionResult("Clinic Site", true),
                expressionResult("Days Since Last TB Screen", candidate.daysSinceTbScreen())
        ));
        payload.put("evaluatedResource", evaluated);
        payload.put("why_flagged", whyFlagged);
        return payload;
    }

    private Map<String, Object> expressionResult(String define, Object result) {
        Map<String, Object> expressionResult = new LinkedHashMap<>();
        expressionResult.put("define", define);
        expressionResult.put("result", result);
        return expressionResult;
    }

    public record TBDemoRun(
            String runId,
            String measureName,
            String measureVersion,
            String evaluationDate,
            RunSummary summary,
            List<TBOutcome> outcomes
    ) {
    }

    public record RunSummary(
            long compliant,
            long dueSoon,
            long overdue,
            long missingData,
            long excluded
    ) {
    }

    public record TBOutcome(
            String subjectId,
            String outcome,
            String summary,
            Map<String, Object> evidenceJson
    ) {
    }

    private record TBCandidate(
            String subjectId,
            Integer daysSinceTbScreen,
            boolean hasMedicalExemption
    ) {
    }
}
