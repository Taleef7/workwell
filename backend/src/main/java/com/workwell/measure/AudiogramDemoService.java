package com.workwell.measure;

import com.workwell.run.RunPersistenceService;
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
                new AudiogramPatient("patient-001", 120, false, true),
                new AudiogramPatient("patient-002", 350, false, true),
                new AudiogramPatient("patient-003", 420, false, true),
                new AudiogramPatient("patient-004", null, false, true),
                new AudiogramPatient("patient-005", 600, true, true)
        );

        List<AudiogramOutcome> outcomes = patients.stream().map(this::evaluate).toList();

        long compliant = outcomes.stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        long dueSoon = outcomes.stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
        long overdue = outcomes.stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
        long missingData = outcomes.stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
        long excluded = outcomes.stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();

        AudiogramDemoRun run = new AudiogramDemoRun(
                runId.toString(),
                "AnnualAudiogramCompleted",
                "1.0.0",
                LocalDate.now().toString(),
                new RunSummary(compliant, dueSoon, overdue, missingData, excluded),
                outcomes
        );
        runPersistenceService.persistAudiogramRun(run);
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
        evaluatedResource.put("patientId", patient.patientId());
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
