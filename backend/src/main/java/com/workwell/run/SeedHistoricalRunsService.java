package com.workwell.run;

import com.workwell.compile.CqlEvaluationService;
import com.workwell.run.DemoRunModels.ActiveMeasureScope;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import jakarta.annotation.PostConstruct;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class SeedHistoricalRunsService {
    private static final Logger log = LoggerFactory.getLogger(SeedHistoricalRunsService.class);
    private static final double[] PASS_RATE_DELTAS = new double[]{-0.05, -0.02, 0.00, 0.03, 0.05};

    private final RunPersistenceService runPersistenceService;
    private final CqlEvaluationService cqlEvaluationService;
    private final JdbcTemplate jdbcTemplate;

    public SeedHistoricalRunsService(
            RunPersistenceService runPersistenceService,
            CqlEvaluationService cqlEvaluationService,
            JdbcTemplate jdbcTemplate
    ) {
        this.runPersistenceService = runPersistenceService;
        this.cqlEvaluationService = cqlEvaluationService;
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostConstruct
    public void seedHistoricalRunsIfEmpty() {
        Integer runCount = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runs", Integer.class);
        if (runCount != null && runCount > 0) {
            return;
        }

        List<ActiveMeasureScope> scopes = runPersistenceService.loadActiveMeasureScopes();
        if (scopes.isEmpty()) {
            return;
        }

        LocalDate today = LocalDate.now();
        for (int i = 0; i < PASS_RATE_DELTAS.length; i++) {
            LocalDate evaluationDate = today.minusDays((long) (PASS_RATE_DELTAS.length - i) * 30L);
            UUID runId = UUID.randomUUID();
            double delta = PASS_RATE_DELTAS[i];

            List<DemoRunPayload> payloads = scopes.stream()
                    .map(scope -> buildAdjustedPayload(runId, scope, evaluationDate, delta))
                    .toList();

            runPersistenceService.persistAllProgramsRun(runId.toString(), "All Programs", payloads);
            log.info("Seeded historical run {} at {} with pass-rate delta {}", runId, evaluationDate, delta);
        }
    }

    private DemoRunPayload buildAdjustedPayload(
            UUID runId,
            ActiveMeasureScope scope,
            LocalDate evaluationDate,
            double passRateDelta
    ) {
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT cql_text, version FROM measure_versions WHERE id = ?",
                scope.measureVersionId()
        );
        String cqlText = (String) row.get("cql_text");
        String measureVersion = (String) row.get("version");

        DemoRunPayload basePayload = cqlEvaluationService.evaluate(
                runId.toString(),
                scope.measureName(),
                measureVersion,
                cqlText,
                evaluationDate
        );
        List<DemoOutcome> adjustedOutcomes = applyPassRateDelta(basePayload.outcomes(), passRateDelta);
        return new DemoRunPayload(
                basePayload.runId(),
                basePayload.measureName(),
                basePayload.measureVersion(),
                basePayload.evaluationDate(),
                adjustedOutcomes
        );
    }

    private List<DemoOutcome> applyPassRateDelta(List<DemoOutcome> outcomes, double passRateDelta) {
        List<DemoOutcome> adjusted = new ArrayList<>(outcomes);
        int total = adjusted.size();
        if (total == 0) {
            return adjusted;
        }

        int compliantCount = (int) adjusted.stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        int targetCompliant = Math.max(0, Math.min(total, (int) Math.round(compliantCount + (total * passRateDelta))));

        if (targetCompliant < compliantCount) {
            int toDemote = compliantCount - targetCompliant;
            for (int i = 0; i < adjusted.size() && toDemote > 0; i++) {
                DemoOutcome current = adjusted.get(i);
                if ("COMPLIANT".equals(current.outcome())) {
                    adjusted.set(i, replaceOutcome(current, "DUE_SOON", "Historical seed adjustment: pass-rate variance."));
                    toDemote--;
                }
            }
        } else if (targetCompliant > compliantCount) {
            int toPromote = targetCompliant - compliantCount;
            for (int i = 0; i < adjusted.size() && toPromote > 0; i++) {
                DemoOutcome current = adjusted.get(i);
                if (!"COMPLIANT".equals(current.outcome()) && !"EXCLUDED".equals(current.outcome())) {
                    adjusted.set(i, replaceOutcome(current, "COMPLIANT", "Historical seed adjustment: pass-rate variance."));
                    toPromote--;
                }
            }
        }

        return adjusted;
    }

    private DemoOutcome replaceOutcome(DemoOutcome current, String nextOutcome, String summary) {
        Map<String, Object> evidence = new LinkedHashMap<>();
        if (current.evidenceJson() != null) {
            evidence.putAll(current.evidenceJson());
        }
        evidence.put("historicalSeedAdjusted", true);
        evidence.put("historicalSeedOutcome", nextOutcome);
        return new DemoOutcome(
                current.subjectId(),
                current.subjectName(),
                current.role(),
                current.site(),
                nextOutcome,
                summary,
                evidence
        );
    }
}
