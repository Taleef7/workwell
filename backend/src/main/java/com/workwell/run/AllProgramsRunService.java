package com.workwell.run;

import com.workwell.measure.AudiogramDemoService;
import com.workwell.measure.FluVaccineDemoService;
import com.workwell.measure.HazwoperSurveillanceDemoService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.TBSurveillanceDemoService;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.web.EvalController.ManualRunResponse;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class AllProgramsRunService {
    private final AudiogramDemoService audiogramDemoService;
    private final TBSurveillanceDemoService tbSurveillanceDemoService;
    private final HazwoperSurveillanceDemoService hazwoperSurveillanceDemoService;
    private final FluVaccineDemoService fluVaccineDemoService;
    private final RunPersistenceService runPersistenceService;
    private final MeasureService measureService;

    public AllProgramsRunService(
            AudiogramDemoService audiogramDemoService,
            TBSurveillanceDemoService tbSurveillanceDemoService,
            HazwoperSurveillanceDemoService hazwoperSurveillanceDemoService,
            FluVaccineDemoService fluVaccineDemoService,
            RunPersistenceService runPersistenceService,
            MeasureService measureService
    ) {
        this.audiogramDemoService = audiogramDemoService;
        this.tbSurveillanceDemoService = tbSurveillanceDemoService;
        this.hazwoperSurveillanceDemoService = hazwoperSurveillanceDemoService;
        this.fluVaccineDemoService = fluVaccineDemoService;
        this.runPersistenceService = runPersistenceService;
        this.measureService = measureService;
    }

    public ManualRunResponse runAllPrograms(String scopeLabel, String triggerActor) {
        measureService.listMeasures();
        UUID runId = UUID.randomUUID();
        LocalDate evaluationDate = LocalDate.now();
        List<DemoRunPayload> payloads = runPersistenceService.loadActiveMeasureScopes().stream()
                .map(scopeRow -> switch (scopeRow.measureName()) {
                    case "Audiogram" -> audiogramDemoService.buildPayload(runId.toString(), evaluationDate);
                    case "TB Surveillance" -> tbSurveillanceDemoService.buildPayload(runId.toString(), evaluationDate);
                    case "HAZWOPER Surveillance" -> hazwoperSurveillanceDemoService.buildPayload(runId.toString(), evaluationDate);
                    case "Flu Vaccine" -> fluVaccineDemoService.buildPayload(runId.toString(), evaluationDate);
                    default -> null;
                })
                .filter(payload -> payload != null)
                .toList();
        UUID persistedRunId = runPersistenceService.persistAllProgramsRun(runId.toString(), scopeLabel, payloads);
        return new ManualRunResponse(
                persistedRunId.toString(),
                scopeLabel,
                payloads.size(),
                payloads.stream().map(DemoRunPayload::measureName).toList()
        );
    }
}
