package com.workwell.engine.port;

import com.workwell.compile.SyntheticFhirBundleBuilder.ExamConfig;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.time.LocalDate;
import org.hl7.fhir.r4.model.Bundle;

/**
 * Port: supplies the FHIR R4 {@link Bundle} for a subject on a given evaluation date. The synthetic
 * adapter fabricates the bundle from an {@link ExamConfig}; a future adapter maps real EHR/FHIR data
 * onto the same return type without touching the engine.
 */
public interface PatientDataProvider {

    Bundle bundleFor(EmployeeProfile employee, ExamConfig config, LocalDate evaluationDate);
}
