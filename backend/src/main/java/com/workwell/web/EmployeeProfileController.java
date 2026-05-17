package com.workwell.web;

import com.workwell.run.EmployeeProfileService;
import com.workwell.web.dto.EmployeeProfileResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/employees")
public class EmployeeProfileController {

    private final EmployeeProfileService service;

    public EmployeeProfileController(EmployeeProfileService service) {
        this.service = service;
    }

    @GetMapping("/{externalId}/profile")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<EmployeeProfileResponse> getProfile(@PathVariable String externalId) {
        return ResponseEntity.ok(service.getProfile(externalId));
    }

    @GetMapping("/search")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<EmployeeProfileService.EmployeeSearchResult>> search(
            @RequestParam String q,
            @RequestParam(defaultValue = "10") int limit) {
        int safeLimit = Math.max(1, Math.min(limit, 50));
        return ResponseEntity.ok(service.search(q, safeLimit));
    }
}
