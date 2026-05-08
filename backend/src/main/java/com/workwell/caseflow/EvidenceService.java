package com.workwell.caseflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.security.SecurityActor;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

@Service
public class EvidenceService {
    private static final long MAX_BYTES = 10L * 1024L * 1024L;

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final Path evidenceRoot;

    public EvidenceService(
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper,
            @Value("${workwell.storage.evidence-root:uploads/evidence}") String evidenceRoot
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        this.evidenceRoot = Path.of(evidenceRoot).toAbsolutePath().normalize();
    }

    public EvidenceAttachment upload(UUID caseId, MultipartFile file, String description, String actor) {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("File is required");
        }
        if (file.getSize() > MAX_BYTES) {
            throw new IllegalArgumentException("Files larger than 10 MB are not allowed");
        }

        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to read evidence file", ex);
        }

        String mimeType = detectMimeType(bytes);
        if (mimeType == null) {
            throw new IllegalArgumentException("Only PDF, PNG, and JPG files are allowed");
        }

        ensureCaseExists(caseId);

        String safeFileName = sanitize(file.getOriginalFilename());
        UUID evidenceId = UUID.randomUUID();
        String storageKey = caseId + "/" + evidenceId + "-" + safeFileName;
        Path targetPath = evidenceRoot.resolve(storageKey).normalize();
        if (!targetPath.startsWith(evidenceRoot)) {
            throw new IllegalStateException("Invalid storage path");
        }

        try {
            Files.createDirectories(targetPath.getParent());
            Files.write(targetPath, bytes);
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to store evidence file", ex);
        }

        String resolvedActor = SecurityActor.currentActorOr(actor);
        jdbcTemplate.update(
                """
                        INSERT INTO evidence_attachments (
                            id, case_id, uploaded_by, file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                        """,
                evidenceId,
                caseId,
                resolvedActor,
                safeFileName,
                file.getSize(),
                mimeType,
                storageKey,
                description == null || description.isBlank() ? null : description.trim()
        );

        insertAudit(caseId, resolvedActor, Map.of(
                "evidenceId", evidenceId.toString(),
                "fileName", safeFileName,
                "mimeType", mimeType,
                "fileSizeBytes", file.getSize(),
                "description", description == null ? "" : description.trim()
        ));

        return new EvidenceAttachment(
                evidenceId,
                caseId,
                resolvedActor,
                safeFileName,
                bytes.length,
                mimeType,
                storageKey,
                description == null || description.isBlank() ? null : description.trim(),
                Instant.now()
        );
    }

    public List<EvidenceAttachment> list(UUID caseId) {
        return jdbcTemplate.query(
                """
                        SELECT id, case_id, uploaded_by, file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at
                        FROM evidence_attachments
                        WHERE case_id = ?
                        ORDER BY uploaded_at DESC
                        """,
                (rs, rowNum) -> new EvidenceAttachment(
                        (UUID) rs.getObject("id"),
                        (UUID) rs.getObject("case_id"),
                        rs.getString("uploaded_by"),
                        rs.getString("file_name"),
                        rs.getLong("file_size_bytes"),
                        rs.getString("mime_type"),
                        rs.getString("storage_key"),
                        rs.getString("description"),
                        rs.getTimestamp("uploaded_at").toInstant()
                ),
                caseId
        );
    }

    public DownloadedEvidence loadForDownload(UUID evidenceId) {
        EvidenceAttachment attachment = jdbcTemplate.query(
                """
                        SELECT id, case_id, uploaded_by, file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at
                        FROM evidence_attachments
                        WHERE id = ?
                        """,
                rs -> {
                    if (!rs.next()) return null;
                    return new EvidenceAttachment(
                            (UUID) rs.getObject("id"),
                            (UUID) rs.getObject("case_id"),
                            rs.getString("uploaded_by"),
                            rs.getString("file_name"),
                            rs.getLong("file_size_bytes"),
                            rs.getString("mime_type"),
                            rs.getString("storage_key"),
                            rs.getString("description"),
                            rs.getTimestamp("uploaded_at").toInstant()
                    );
                },
                evidenceId
        );
        if (attachment == null) {
            throw new IllegalArgumentException("Evidence not found");
        }

        Path path = evidenceRoot.resolve(attachment.storageKey()).normalize();
        if (!path.startsWith(evidenceRoot) || !Files.exists(path)) {
            throw new IllegalStateException("Evidence file is missing");
        }

        try {
            byte[] bytes = Files.readAllBytes(path);
            MediaType mediaType = MediaType.parseMediaType(attachment.mimeType());
            boolean inline = attachment.mimeType().startsWith("image/");
            return new DownloadedEvidence(attachment, bytes, mediaType, inline);
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to read evidence file", ex);
        }
    }

    private void ensureCaseExists(UUID caseId) {
        try {
            jdbcTemplate.queryForObject("SELECT id FROM cases WHERE id = ?", UUID.class, caseId);
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Case not found");
        }
    }

    private void insertAudit(UUID caseId, String actor, Map<String, Object> payload) {
        try {
            jdbcTemplate.update(
                    """
                            INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_case_id, payload_json)
                            VALUES (?, ?, ?, ?, ?, ?::jsonb)
                            """,
                    "EVIDENCE_UPLOADED",
                    "evidence_attachment",
                    UUID.randomUUID(),
                    actor,
                    caseId,
                    objectMapper.writeValueAsString(payload)
            );
        } catch (Exception ex) {
            throw new IllegalStateException("Unable to write evidence audit event", ex);
        }
    }

    private String sanitize(String fileName) {
        String candidate = fileName == null || fileName.isBlank() ? "evidence" : fileName;
        return candidate.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private String detectMimeType(byte[] bytes) {
        if (bytes.length >= 8
                && (bytes[0] & 0xFF) == 0x89
                && bytes[1] == 'P'
                && bytes[2] == 'N'
                && bytes[3] == 'G'
                && bytes[4] == 0x0D
                && bytes[5] == 0x0A
                && bytes[6] == 0x1A
                && bytes[7] == 0x0A) {
            return "image/png";
        }
        if (bytes.length >= 3
                && (bytes[0] & 0xFF) == 0xFF
                && (bytes[1] & 0xFF) == 0xD8
                && (bytes[2] & 0xFF) == 0xFF) {
            return "image/jpeg";
        }
        if (bytes.length >= 5
                && bytes[0] == '%'
                && bytes[1] == 'P'
                && bytes[2] == 'D'
                && bytes[3] == 'F'
                && bytes[4] == '-') {
            return "application/pdf";
        }
        return null;
    }

    public record EvidenceAttachment(
            UUID id,
            UUID caseId,
            String uploadedBy,
            String fileName,
            long fileSizeBytes,
            String mimeType,
            String storageKey,
            String description,
            Instant uploadedAt
    ) {
    }

    public record DownloadedEvidence(
            EvidenceAttachment attachment,
            byte[] bytes,
            MediaType mediaType,
            boolean inline
    ) {
    }
}
