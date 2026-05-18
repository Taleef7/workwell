package com.workwell.caseflow;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
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
        // A ZIP-looking payload renamed to .pdf must be rejected by content detection.
        MockMultipartFile file = new MockMultipartFile(
                "file",
                "spoofed.pdf",
                "application/pdf",
                "PK not-a-real-pdf".getBytes(StandardCharsets.UTF_8)
        );

        UnsupportedEvidenceTypeException ex = assertThrows(UnsupportedEvidenceTypeException.class, () ->
                service.upload(UUID.fromString("11111111-1111-1111-1111-111111111111"), file, null, "case-manager")
        );

        assertTrue(ex.accepted().contains("application/pdf"));
        assertTrue(ex.accepted().contains("text/csv"));
    }

    @Test
    void rejectsFilesOverTenMegabytesWith415() {
        EvidenceService service = new EvidenceService(mock(JdbcTemplate.class), new ObjectMapper(), "build/test-evidence");
        byte[] oversized = new byte[10 * 1024 * 1024 + 1];
        MockMultipartFile file = new MockMultipartFile("file", "big.pdf", "application/pdf", oversized);

        UnsupportedEvidenceTypeException ex = assertThrows(UnsupportedEvidenceTypeException.class, () ->
                service.upload(UUID.fromString("11111111-1111-1111-1111-111111111111"), file, null, "case-manager")
        );

        assertTrue(ex.getMessage().contains("exceeds the 10MB limit"));
    }
}
