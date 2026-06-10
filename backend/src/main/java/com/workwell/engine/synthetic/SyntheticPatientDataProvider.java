package com.workwell.engine.synthetic;

import com.workwell.compile.SyntheticFhirBundleBuilder;
import com.workwell.compile.SyntheticFhirBundleBuilder.ExamConfig;
import com.workwell.engine.port.PatientDataProvider;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.time.LocalDate;
import org.hl7.fhir.r4.model.Bundle;
import org.springframework.stereotype.Component;

/**
 * Default {@link PatientDataProvider} for the synthetic demo. Fabricates a subject's FHIR R4 bundle
 * via {@link SyntheticFhirBundleBuilder}. This is the injectable seam that a future real-data adapter
 * replaces without touching the engine.
 */
@Component
public class SyntheticPatientDataProvider implements PatientDataProvider {

    private final SyntheticFhirBundleBuilder builder = new SyntheticFhirBundleBuilder();

    @Override
    public Bundle bundleFor(EmployeeProfile employee, ExamConfig config, LocalDate evaluationDate) {
        return builder.buildBundle(employee, config, evaluationDate);
    }
}
