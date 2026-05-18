package com.workwell.caseflow;

import java.util.Set;

/**
 * Thrown when an uploaded evidence file is rejected because its detected content
 * type is not in the allow-list or it exceeds the size limit. Mapped to HTTP 415
 * by {@code EvidenceExceptionHandler}.
 */
public class UnsupportedEvidenceTypeException extends RuntimeException {

    private final Set<String> accepted;

    public UnsupportedEvidenceTypeException(String message, Set<String> accepted) {
        super(message);
        this.accepted = accepted;
    }

    public Set<String> accepted() {
        return accepted;
    }
}
