package com.workwell.measure;

import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.run.RunPersistenceService;
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

        List<TBOutcome> outcomes = candidates.stream().map(this::evaluate).toList();
        long compliant = outcomes.stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        long dueSoon = outcomes.stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
        long overdue = outcomes.stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
        long missingData = outcomes.stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
        long excluded = outcomes.stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();

        TBDemoRun run = new TBDemoRun(
                runId.toString(),
                "TB Surveillance",
                "v1.3",
                LocalDate.now().toString(),
                new RunSummary(compliant, dueSoon, overdue, missingData, excluded),
                outcomes
        );

        List<DemoOutcome> payloadOutcomes = outcomes.stream().map(outcome -> {
            SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(outcome.subjectId());
            return new DemoOutcome(
                    outcome.subjectId(),
                    employee.name(),
                    employee.role(),
                    employee.site(),
                    outcome.outcome(),
                    outcome.summary(),
                    outcome.evidenceJson()
            );
        }).toList();

        runPersistenceService.persistDemoRun(new DemoRunPayload(
                run.runId(),
                run.measureName(),
                run.measureVersion(),
                run.evaluationDate(),
                payloadOutcomes
        ));
        return run;
    }

    private TBOutcome evaluate(TBCandidate candidate) {
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
        return new TBOutcome(candidate.subjectId(), outcome, reason, buildEvidence(candidate));
    }

    private Map<String, Object> buildEvidence(TBCandidate candidate) {
        SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(candidate.subjectId());
        Map<String, Object> evaluated = new LinkedHashMap<>();
        evaluated.put("subjectId", employee.externalId());
        evaluated.put("employeeName", employee.name());
        evaluated.put("role", employee.role());
        evaluated.put("site", employee.site());
        evaluated.put("daysSinceLastTbScreen", candidate.daysSinceTbScreen());
        evaluated.put("measurementWindowDays", 365);
        evaluated.put("hasMedicalExemption", candidate.hasMedicalExemption());

        return Map.of(
                "expressionResults", List.of(
                        expressionResult("TB Eligible Role", true),
                        expressionResult("Clinic Site", true),
                        expressionResult("Days Since Last TB Screen", candidate.daysSinceTbScreen())
                ),
                "evaluatedResource", evaluated
        );
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
