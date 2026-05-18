package com.workwell.web;

import com.workwell.caseflow.UnsupportedEvidenceTypeException;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Maps evidence upload validation failures to HTTP 415 with a stable JSON body.
 * Scoped to {@link UnsupportedEvidenceTypeException} only so existing
 * {@code ResponseStatusException} handling elsewhere is unaffected.
 */
@RestControllerAdvice
public class EvidenceExceptionHandler {

    @ExceptionHandler(UnsupportedEvidenceTypeException.class)
    public ResponseEntity<Map<String, Object>> handleUnsupportedEvidenceType(
            UnsupportedEvidenceTypeException ex
    ) {
        Set<String> accepted = ex.accepted() != null ? ex.accepted() : Set.of();
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).body(Map.of(
                "error", "unsupported_media_type",
                "message", ex.getMessage(),
                "accepted", accepted
        ));
    }
}
