package com.workwell.engine.port;

import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.util.List;

/**
 * Port: the directory of subjects the engine evaluates. The synthetic adapter returns the demo
 * workforce; a future adapter can return real employees/patients from an external directory.
 */
public interface EmployeeDirectory {

    List<EmployeeProfile> allEmployees();

    EmployeeProfile byId(String externalId);
}
