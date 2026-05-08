package com.workwell.caseflow;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;

class EvidenceServiceTest {

    @Test
    void rejectsSpoofedContentTypeWithoutMatchingSignature() {
        EvidenceService service = new EvidenceService(mock(JdbcTemplate.class), new ObjectMapper(), "build/test-evidence");
        MockMultipartFile file = new MockMultipartFile(
                "file",
                "spoofed.pdf",
                "application/pdf",
                "not-a-real-pdf".getBytes(StandardCharsets.UTF_8)
        );

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () ->
                service.upload(UUID.fromString("11111111-1111-1111-1111-111111111111"), file, null, "case-manager")
        );

        assertEquals("Only PDF, PNG, and JPG files are allowed", ex.getMessage());
    }
}
