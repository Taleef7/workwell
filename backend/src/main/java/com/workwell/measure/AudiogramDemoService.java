package com.workwell.measure;

import com.workwell.run.RunPersistenceService;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class AudiogramDemoService {
    private final RunPersistenceService runPersistenceService;

    public AudiogramDemoService(RunPersistenceService runPersistenceService) {
        this.runPersistenceService = runPersistenceService;
    }

    public AudiogramDemoRun run() {
        UUID runId = UUID.randomUUID();
        List<AudiogramPatient> patients = List.of(
                new AudiogramPatient("emp-001", 120, false, true),
                new AudiogramPatient("emp-002", 350, false, true),
                new AudiogramPatient("emp-003", 420, false, true),
                new AudiogramPatient("emp-004", null, false, true),
                new AudiogramPatient("emp-005", 600, true, true),
                new AudiogramPatient("emp-006", 200, false, true),
                new AudiogramPatient("emp-007", 362, false, true),
                new AudiogramPatient("emp-008", 480, false, true),
                new AudiogramPatient("emp-009", null, false, true),
                new AudiogramPatient("emp-010", 700, true, true),
                new AudiogramPatient("emp-011", 340, false, true),
                new AudiogramPatient("emp-012", 366, false, true),
                new AudiogramPatient("emp-013", 40, false, true),
                new AudiogramPatient("emp-014", 371, false, true),
                new AudiogramPatient("emp-015", null, false, true)
        );

        List<AudiogramOutcome> outcomes = patients.stream().map(this::evaluate).toList();

        long compliant = outcomes.stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        long dueSoon = outcomes.stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
        long overdue = outcomes.stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
        long missingData = outcomes.stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
        long excluded = outcomes.stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();

        AudiogramDemoRun run = new AudiogramDemoRun(
                runId.toString(),
                "Audiogram",
                "v1.0",
                LocalDate.now().toString(),
                new RunSummary(compliant, dueSoon, overdue, missingData, excluded),
                outcomes
        );
        List<DemoOutcome> payloadOutcomes = outcomes.stream().map(outcome -> {
            SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(outcome.patientId());
            return new DemoOutcome(
                    outcome.patientId(),
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

    private AudiogramOutcome evaluate(AudiogramPatient patient) {
        String outcome;
        String reason;
        if (patient.hasActiveWaiver()) {
            outcome = "EXCLUDED";
            reason = "Active waiver document found.";
        } else if (!patient.inHearingProgram()) {
            outcome = "MISSING_DATA";
            reason = "Patient not enrolled in hearing conservation program.";
        } else if (patient.daysSinceAudiogram() == null) {
            outcome = "MISSING_DATA";
            reason = "No completed audiogram date found.";
        } else if (patient.daysSinceAudiogram() <= 335) {
            outcome = "COMPLIANT";
            reason = "Audiogram completed within compliant window.";
        } else if (patient.daysSinceAudiogram() <= 365) {
            outcome = "DUE_SOON";
            reason = "Audiogram nearing annual compliance deadline.";
        } else {
            outcome = "OVERDUE";
            reason = "Audiogram is outside annual compliance window.";
        }

        return new AudiogramOutcome(
                patient.patientId(),
                outcome,
                reason,
                buildEvidenceJson(patient)
        );
    }

    private Map<String, Object> buildEvidenceJson(AudiogramPatient patient) {
        List<Map<String, Object>> expressionResults = List.of(
                expressionResult("In Hearing Conservation Program", patient.inHearingProgram()),
                expressionResult("Has Active Waiver", patient.hasActiveWaiver()),
                expressionResult("Days Since Last Audiogram", patient.daysSinceAudiogram())
        );

        Map<String, Object> evaluatedResource = new LinkedHashMap<>();
        SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(patient.patientId());
        evaluatedResource.put("patientId", patient.patientId());
        evaluatedResource.put("employeeName", employee.name());
        evaluatedResource.put("role", employee.role());
        evaluatedResource.put("site", employee.site());
        evaluatedResource.put("daysSinceLastAudiogram", patient.daysSinceAudiogram());
        evaluatedResource.put("hasActiveWaiver", patient.hasActiveWaiver());
        evaluatedResource.put("measurementWindowDays", 365);

        Map<String, Object> evidenceJson = new LinkedHashMap<>();
        evidenceJson.put("expressionResults", expressionResults);
        evidenceJson.put("evaluatedResource", evaluatedResource);
        return evidenceJson;
    }

    private Map<String, Object> expressionResult(String define, Object result) {
        Map<String, Object> expressionResult = new LinkedHashMap<>();
        expressionResult.put("define", define);
        expressionResult.put("result", result);
        return expressionResult;
    }

    public record AudiogramDemoRun(
            String runId,
            String measureName,
            String measureVersion,
            String evaluationDate,
            RunSummary summary,
            List<AudiogramOutcome> outcomes
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

    public record AudiogramOutcome(
            String patientId,
            String outcome,
            String summary,
            Map<String, Object> evidenceJson
    ) {
    }

    private record AudiogramPatient(
            String patientId,
            Integer daysSinceAudiogram,
            boolean hasActiveWaiver,
            boolean inHearingProgram
    ) {
    }
}
