package com.workwell.engine.synthetic;

import com.workwell.engine.model.MeasureDefinition;
import com.workwell.engine.port.MeasureDefinitionProvider;
import org.springframework.stereotype.Component;

/**
 * Default {@link MeasureDefinitionProvider} for the synthetic demo. Holds the per-measure bindings
 * (value sets, codes, compliance window, shape flags) for the 10 runnable measures. Moved verbatim
 * from the former private {@code CqlEvaluationService.measureSeedSpecFor()} switch so it is now the
 * single source of truth.
 */
@Component
public class SyntheticMeasureDefinitionProvider implements MeasureDefinitionProvider {

    @Override
    public MeasureDefinition forMeasure(String measureName) {
        return switch (measureName) {
            case "Audiogram" -> new MeasureDefinition(
                    "audiogram",
                    "hearing-enrollment",
                    "urn:workwell:vs:hearing-enrollment",
                    "audiogram-waiver",
                    "urn:workwell:vs:audiogram-waiver",
                    "audiogram-procedure",
                    "urn:workwell:vs:audiogram-procedures",
                    false);
            case "TB Surveillance" -> new MeasureDefinition(
                    "tb_surveillance",
                    "tb-program",
                    "urn:workwell:vs:tb-eligible-roles",
                    "tb-exemption",
                    "urn:workwell:vs:tb-exemption",
                    "tb-screen",
                    "urn:workwell:vs:tb-screening",
                    false);
            case "HAZWOPER Surveillance" -> new MeasureDefinition(
                    "hazwoper",
                    "hazwoper-program",
                    "urn:workwell:vs:hazwoper-enrollment",
                    "hazwoper-exemption",
                    "urn:workwell:vs:hazwoper-exemption",
                    "hazwoper-exam",
                    "urn:workwell:vs:hazwoper-exams",
                    false);
            case "Flu Vaccine" -> new MeasureDefinition(
                    "flu_vaccine",
                    "clinical-role",
                    "urn:workwell:vs:clinical-roles",
                    "flu-exemption",
                    "urn:workwell:vs:flu-exemption",
                    "flu-vaccine",
                    "urn:workwell:vs:flu-vaccines",
                    true);
            case "Hypertension BP Screening" -> new MeasureDefinition(
                    "hypertension",
                    "wellness-enrolled",
                    "urn:workwell:vs:wellness-enrollment",
                    "wellness-exempt",
                    "urn:workwell:vs:wellness-exemption",
                    "bp-screen",
                    "urn:workwell:vs:bp-screening",
                    false);
            case "Diabetes HbA1c Monitoring" -> new MeasureDefinition(
                    "diabetes_hba1c",
                    "diabetes-enrolled",
                    "urn:workwell:vs:diabetes-program",
                    "diabetes-exempt",
                    "urn:workwell:vs:diabetes-exemption",
                    "hba1c-lab",
                    "urn:workwell:vs:hba1c-labs",
                    false,
                    180);
            case "BMI Screening & Counseling" -> new MeasureDefinition(
                    "obesity_bmi",
                    "wellness-enrolled",
                    "urn:workwell:vs:wellness-enrollment",
                    "wellness-exempt",
                    "urn:workwell:vs:wellness-exemption",
                    "bmi-screen",
                    "urn:workwell:vs:bmi-screening",
                    false);
            case "Cholesterol LDL Screening" -> new MeasureDefinition(
                    "cholesterol_ldl",
                    "cholesterol-enrolled",
                    "urn:workwell:vs:cholesterol-program",
                    "cholesterol-exempt",
                    "urn:workwell:vs:cholesterol-exemption",
                    "ldl-lab",
                    "urn:workwell:vs:ldl-labs",
                    false);
            case "Breast Cancer Screening" -> new MeasureDefinition(
                    "cms125",
                    "cms125-eligible",
                    "urn:workwell:vs:cms125-eligible",
                    "cms125-excluded",
                    "urn:workwell:vs:cms125-excluded",
                    "mammogram",
                    "urn:workwell:vs:cms125-mammogram",
                    false,
                    820);
            case "Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)" -> new MeasureDefinition(
                    "cms122",
                    "cms122-diabetes",
                    "urn:workwell:vs:cms122-diabetes",
                    "cms122-excluded",
                    "urn:workwell:vs:cms122-excluded",
                    "hba1c-obs",
                    "urn:workwell:vs:cms122-hba1c",
                    false,
                    365,
                    true);
            default -> null;
        };
    }
}
