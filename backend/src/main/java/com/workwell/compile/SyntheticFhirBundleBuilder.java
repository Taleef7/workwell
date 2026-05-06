package com.workwell.compile;

import com.workwell.measure.SyntheticEmployeeCatalog;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Condition;
import org.hl7.fhir.r4.model.Enumerations;
import org.hl7.fhir.r4.model.HumanName;
import org.hl7.fhir.r4.model.Immunization;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.Procedure;
import org.hl7.fhir.r4.model.Reference;

public class SyntheticFhirBundleBuilder {

    public Bundle buildBundle(SyntheticEmployeeCatalog.EmployeeProfile employee, ExamConfig config) {
        Bundle bundle = new Bundle();
        bundle.setType(Bundle.BundleType.COLLECTION);

        Patient patient = new Patient();
        patient.setId(employee.externalId());
        patient.addName(new HumanName().setText(employee.name()));
        patient.setBirthDate(java.util.Date.from(
                LocalDateTime.of(1980 + Math.floorMod(employee.externalId().hashCode(), 20), 1, 1, 0, 0)
                        .toInstant(ZoneOffset.UTC)
        ));
        bundle.addEntry().setResource(patient);

        if (config.programEnrolled()) {
            bundle.addEntry().setResource(buildCondition(
                    employee.externalId(),
                    config.programEnrollmentCode(),
                    config.programEnrollmentValueSet()
            ));
        }

        if (config.hasWaiver()) {
            bundle.addEntry().setResource(buildCondition(
                    employee.externalId(),
                    config.waiverCode(),
                    config.waiverValueSet()
            ));
        }

        if (config.daysSinceLastExam() != null) {
            String performedDateTime = LocalDate.now()
                    .minusDays(config.daysSinceLastExam())
                    .atStartOfDay()
                    .format(DateTimeFormatter.ISO_LOCAL_DATE_TIME);

            if (config.useImmunization()) {
                Immunization immunization = new Immunization();
                immunization.setId(employee.externalId() + "-immunization");
                immunization.setStatus(Immunization.ImmunizationStatus.COMPLETED);
                immunization.setPatient(new Reference("Patient/" + employee.externalId()));
                immunization.getVaccineCode().addCoding()
                        .setSystem(config.examValueSet())
                        .setCode(config.examCode())
                        .setDisplay(config.examCode());
                immunization.setOccurrence(new org.hl7.fhir.r4.model.DateTimeType(performedDateTime));
                bundle.addEntry().setResource(immunization);
            } else {
                Procedure procedure = new Procedure();
                procedure.setId(employee.externalId() + "-procedure");
                procedure.setStatus(Procedure.ProcedureStatus.COMPLETED);
                procedure.setSubject(new Reference("Patient/" + employee.externalId()));
                procedure.getCode().addCoding()
                        .setSystem(config.examValueSet())
                        .setCode(config.examCode())
                        .setDisplay(config.examCode());
                procedure.setPerformed(new org.hl7.fhir.r4.model.DateTimeType(performedDateTime));
                bundle.addEntry().setResource(procedure);
            }
        }

        return bundle;
    }

    private Condition buildCondition(String employeeExternalId, String code, String valueSet) {
        Condition condition = new Condition();
        condition.setId(employeeExternalId + "-" + code);
        condition.setSubject(new Reference("Patient/" + employeeExternalId));
        condition.getClinicalStatus().addCoding().setCode("active");
        condition.getCode().addCoding().setSystem(valueSet).setCode(code).setDisplay(code);
        condition.setVerificationStatus(new org.hl7.fhir.r4.model.CodeableConcept()
                .addCoding(new org.hl7.fhir.r4.model.Coding()
                        .setCode("confirmed")
                        .setSystem("http://terminology.hl7.org/CodeSystem/condition-ver-status")));
        return condition;
    }

    public record ExamConfig(
            Integer daysSinceLastExam,
            boolean hasWaiver,
            boolean programEnrolled,
            String programEnrollmentCode,
            String programEnrollmentValueSet,
            String waiverCode,
            String waiverValueSet,
            String examCode,
            String examValueSet,
            boolean useImmunization
    ) {
    }
}
