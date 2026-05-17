package com.workwell.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.AbstractIntegrationTest;
import com.workwell.caseflow.EvidenceService;
import com.workwell.run.AllProgramsRunService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest(properties = {
        "workwell.auth.enabled=true",
        "workwell.auth.jwt-secret=test-secret-for-evidence-security"
})
@AutoConfigureMockMvc
class EvidenceAccessIntegrationTest extends AbstractIntegrationTest {

    private static final Path evidenceRoot = createEvidenceRoot();

    @DynamicPropertySource
    static void evidenceProperties(DynamicPropertyRegistry registry) {
        registry.add("workwell.storage.evidence-root", () -> evidenceRoot.toString());
    }

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private EvidenceService evidenceService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @BeforeEach
    void resetState() throws Exception {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, evidence_attachments, outreach_records, scheduled_appointments, waivers CASCADE");
        deleteEvidenceFiles();
        Files.createDirectories(evidenceRoot);
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void caseManagerCanUploadDownloadAndAuditEvidence() throws Exception {
        UUID caseId = anyCaseId();
        MvcResult uploadResult = mockMvc.perform(multipart("/api/cases/{caseId}/evidence", caseId)
                        .file(new MockMultipartFile(
                                "file",
                                "../../safety/../hearing review.pdf",
                                "application/pdf",
                                pdfBytes("case-manager-upload")
                        ))
                        .param("description", "Annual audiogram follow-up"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.fileName").value("hearing_review.pdf"))
                .andReturn();

        JsonNode uploadJson = objectMapper.readTree(uploadResult.getResponse().getContentAsString());
        UUID evidenceId = UUID.fromString(uploadJson.path("id").asText());

        MvcResult result = mockMvc.perform(get("/api/evidence/{id}/download", evidenceId))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", "attachment; filename=\"hearing_review.pdf\""))
                .andReturn();

        assertThat(result.getResponse().getContentAsByteArray()).containsExactly(pdfBytes("case-manager-upload"));

        Map<String, Object> audit = jdbcTemplate.queryForMap(
                """
                        SELECT actor, ref_case_id, entity_id, payload_json
                        FROM audit_events
                        WHERE event_type = 'EVIDENCE_DOWNLOADED'
                          AND entity_id = ?
                        ORDER BY occurred_at DESC
                        LIMIT 1
                        """,
                evidenceId
        );

        assertThat(audit.get("actor")).isEqualTo("cm@workwell.dev");
        assertThat(audit.get("ref_case_id")).isEqualTo(caseId);
        assertThat(audit.get("entity_id")).isEqualTo(evidenceId);

        JsonNode payload = objectMapper.readTree(String.valueOf(audit.get("payload_json")));
        assertThat(payload.path("fileName").asText()).isEqualTo("hearing_review.pdf");
        assertThat(payload.path("contentType").asText()).isEqualTo("application/pdf");
        assertThat(payload.path("fileSizeBytes").asLong()).isEqualTo(pdfBytes("case-manager-upload").length);
        assertThat(payload.path("timestamp").asText()).isNotBlank();
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void adminCanDownloadEvidence() throws Exception {
        EvidenceService.EvidenceAttachment attachment = seedEvidence("admin-download.pdf");

        mockMvc.perform(get("/api/evidence/{id}/download", attachment.id()))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", "attachment; filename=\"admin-download.pdf\""));
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void authorsCannotDownloadEvidence() throws Exception {
        EvidenceService.EvidenceAttachment attachment = seedEvidence("author-download.pdf");

        mockMvc.perform(get("/api/evidence/{id}/download", attachment.id()))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "viewer@workwell.dev", roles = "VIEWER")
    void viewersCannotDownloadEvidence() throws Exception {
        EvidenceService.EvidenceAttachment attachment = seedEvidence("viewer-download.pdf");

        mockMvc.perform(get("/api/evidence/{id}/download", attachment.id()))
                .andExpect(status().isForbidden());
    }

    @Test
    void unauthenticatedDownloadsAreRejected() throws Exception {
        EvidenceService.EvidenceAttachment attachment = seedEvidence("anonymous-download.pdf");

        mockMvc.perform(get("/api/evidence/{id}/download", attachment.id()))
                .andExpect(result -> assertThat(result.getResponse().getStatus()).isIn(401, 403));
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void unknownEvidenceIdReturns404() throws Exception {
        mockMvc.perform(get("/api/evidence/{id}/download", UUID.fromString("11111111-1111-1111-1111-111111111111")))
                .andExpect(status().isNotFound());
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void caseManagerCanListEvidenceMetadata() throws Exception {
        UUID caseId = anyCaseId();
        seedEvidence("cm-list.pdf");
        mockMvc.perform(get("/api/cases/{caseId}/evidence", caseId))
                .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void adminCanListEvidenceMetadata() throws Exception {
        UUID caseId = anyCaseId();
        mockMvc.perform(get("/api/cases/{caseId}/evidence", caseId))
                .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void authorCannotListEvidenceMetadata() throws Exception {
        UUID caseId = anyCaseId();
        mockMvc.perform(get("/api/cases/{caseId}/evidence", caseId))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "approver@workwell.dev", roles = "APPROVER")
    void approverCannotListEvidenceMetadata() throws Exception {
        UUID caseId = anyCaseId();
        mockMvc.perform(get("/api/cases/{caseId}/evidence", caseId))
                .andExpect(status().isForbidden());
    }

    @Test
    void unauthenticatedEvidenceListIsRejected() throws Exception {
        UUID caseId = anyCaseId();
        mockMvc.perform(get("/api/cases/{caseId}/evidence", caseId))
                .andExpect(result -> assertThat(result.getResponse().getStatus()).isIn(401, 403));
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void uploadEndpointRejectsUnauthorizedRole() throws Exception {
        UUID caseId = anyCaseId();
        mockMvc.perform(multipart("/api/cases/{caseId}/evidence", caseId)
                        .file(new MockMultipartFile(
                                "file",
                                "evidence.pdf",
                                "application/pdf",
                                pdfBytes("unauthorized-upload")
                        )))
                .andExpect(status().isForbidden());
    }

    private EvidenceService.EvidenceAttachment seedEvidence(String originalFilename) {
        UUID caseId = anyCaseId();
        return evidenceService.upload(
                caseId,
                new MockMultipartFile(
                        "file",
                        originalFilename,
                        "application/pdf",
                        pdfBytes(originalFilename)
                ),
                "Evidence payload",
                "admin@workwell.dev"
        );
    }

    private UUID anyCaseId() {
        return jdbcTemplate.queryForObject("SELECT id FROM cases ORDER BY created_at ASC LIMIT 1", UUID.class);
    }

    private byte[] pdfBytes(String label) {
        return ("%PDF-1.4\n" + label + "\n%%EOF").getBytes(StandardCharsets.UTF_8);
    }

    private static Path createEvidenceRoot() {
        try {
            return Files.createTempDirectory("workwell-evidence-test");
        } catch (IOException ex) {
            throw new ExceptionInInitializerError(ex);
        }
    }

    private void deleteEvidenceFiles() throws IOException {
        if (!Files.exists(evidenceRoot)) {
            return;
        }
        try (var paths = Files.walk(evidenceRoot)) {
            paths.sorted(Comparator.comparingInt(Path::getNameCount).reversed().thenComparing(Path::toString))
                    .forEach(path -> {
                        if (!path.equals(evidenceRoot)) {
                            try {
                                Files.deleteIfExists(path);
                            } catch (IOException ex) {
                                throw new IllegalStateException("Unable to clean evidence root", ex);
                            }
                        }
                    });
        }
    }
}
