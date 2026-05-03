package com.workwell.measure;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import org.junit.jupiter.api.Test;

class AudiogramDemoServiceTest {

    private final AudiogramDemoService service = new AudiogramDemoService();

    @Test
    void buildsSeededAudiogramRunWithoutNullEvidenceErrors() {
        AudiogramDemoService.AudiogramDemoRun run = service.run();

        assertNotNull(run);
        assertEquals("AnnualAudiogramCompleted", run.measureName());
        assertEquals(5, run.outcomes().size());
        assertEquals(1, run.summary().compliant());
        assertEquals(1, run.summary().dueSoon());
        assertEquals(1, run.summary().overdue());
        assertEquals(1, run.summary().missingData());
        assertEquals(1, run.summary().excluded());
    }
}
