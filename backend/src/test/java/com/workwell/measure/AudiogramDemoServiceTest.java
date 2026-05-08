package com.workwell.measure;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.verify;

import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.run.RunPersistenceService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
@ExtendWith(MockitoExtension.class)
class AudiogramDemoServiceTest {
    // Tests the legacy /api/runs/audiogram endpoint path. The primary evaluation pipeline is tested in CqlEvaluationServiceTest.

    @Mock
    private RunPersistenceService runPersistenceService;

    @Test
    void buildsSeededAudiogramRunWithoutNullEvidenceErrors() {
        AudiogramDemoService service = new AudiogramDemoService(runPersistenceService);
        AudiogramDemoService.AudiogramDemoRun run = service.run();

        assertNotNull(run);
        assertEquals("Audiogram", run.measureName());
        assertEquals(15, run.outcomes().size());
        assertEquals(3, run.summary().compliant());
        assertEquals(3, run.summary().dueSoon());
        assertEquals(4, run.summary().overdue());
        assertEquals(3, run.summary().missingData());
        assertEquals(2, run.summary().excluded());
        verify(runPersistenceService).persistDemoRun(org.mockito.ArgumentMatchers.any(DemoRunPayload.class));
    }
}
