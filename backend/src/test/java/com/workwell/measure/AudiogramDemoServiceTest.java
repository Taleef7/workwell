package com.workwell.measure;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.verify;

import com.workwell.run.RunPersistenceService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
@ExtendWith(MockitoExtension.class)
class AudiogramDemoServiceTest {

    @Mock
    private RunPersistenceService runPersistenceService;

    @Test
    void buildsSeededAudiogramRunWithoutNullEvidenceErrors() {
        AudiogramDemoService service = new AudiogramDemoService(runPersistenceService);
        AudiogramDemoService.AudiogramDemoRun run = service.run();

        assertNotNull(run);
        assertEquals("AnnualAudiogramCompleted", run.measureName());
        assertEquals(5, run.outcomes().size());
        assertEquals(1, run.summary().compliant());
        assertEquals(1, run.summary().dueSoon());
        assertEquals(1, run.summary().overdue());
        assertEquals(1, run.summary().missingData());
        assertEquals(1, run.summary().excluded());
        verify(runPersistenceService).persistAudiogramRun(run);
    }
}
