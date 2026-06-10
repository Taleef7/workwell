package com.workwell.engine.synthetic;

import com.workwell.engine.port.EmployeeDirectory;
import com.workwell.measure.SyntheticEmployeeCatalog;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Default {@link EmployeeDirectory} for the synthetic demo. Delegates to the static
 * {@link SyntheticEmployeeCatalog}; a future DB-backed directory implements this same port (any
 * schema change for that is owner-gated).
 */
@Component
public class SyntheticEmployeeDirectory implements EmployeeDirectory {

    @Override
    public List<EmployeeProfile> allEmployees() {
        return SyntheticEmployeeCatalog.allEmployees();
    }

    @Override
    public EmployeeProfile byId(String externalId) {
        return SyntheticEmployeeCatalog.byId(externalId);
    }
}
