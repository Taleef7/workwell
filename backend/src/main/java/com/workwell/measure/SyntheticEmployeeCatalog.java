package com.workwell.measure;

import java.util.List;

public final class SyntheticEmployeeCatalog {
    private SyntheticEmployeeCatalog() {
    }

    public static List<EmployeeProfile> allEmployees() {
        return List.of(
                new EmployeeProfile("emp-001", "Amina Shah", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-002", "Bilal Raza", "Welder", "Plant A"),
                new EmployeeProfile("emp-003", "Hina Qureshi", "Industrial Hygienist", "Plant A"),
                new EmployeeProfile("emp-004", "Kamran Malik", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-005", "Nadia Anwar", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-006", "Omar Siddiq", "Welder", "Plant A"),
                new EmployeeProfile("emp-007", "Sana Imtiaz", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-008", "Tariq Ilyas", "Industrial Hygienist", "Plant A"),
                new EmployeeProfile("emp-009", "Uzma Farooq", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-010", "Waleed Noor", "Welder", "Plant A"),
                new EmployeeProfile("emp-011", "Yasir Khan", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-012", "Zara Tariq", "Welder", "Plant B"),
                new EmployeeProfile("emp-013", "Adeel Hamid", "Industrial Hygienist", "Plant B"),
                new EmployeeProfile("emp-014", "Bushra Habib", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-015", "Danish Ali", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-016", "Eman Saleem", "Welder", "Plant B"),
                new EmployeeProfile("emp-017", "Faisal Javed", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-018", "Ghazala Fatima", "Industrial Hygienist", "Plant B"),
                new EmployeeProfile("emp-019", "Haris Latif", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-020", "Iqra Masood", "Welder", "Plant B"),
                new EmployeeProfile("emp-021", "Junaid Arif", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-022", "Kiran Saeed", "Welder", "Plant A"),
                new EmployeeProfile("emp-023", "Liaqat Hussain", "Industrial Hygienist", "Plant A"),
                new EmployeeProfile("emp-024", "Maham Yousaf", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-025", "Noman Asif", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-026", "Rabia Akhtar", "Welder", "Plant A"),
                new EmployeeProfile("emp-027", "Saad Ahmed", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-028", "Tehmina Waheed", "Industrial Hygienist", "Plant A"),
                new EmployeeProfile("emp-029", "Usman Rauf", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-030", "Vania Riaz", "Welder", "Plant A"),
                new EmployeeProfile("emp-031", "Waqas Amin", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-032", "Xenia Jamil", "Welder", "Plant B"),
                new EmployeeProfile("emp-033", "Yumna Baig", "Industrial Hygienist", "Plant B"),
                new EmployeeProfile("emp-034", "Zeeshan Mir", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-035", "Areeba Khalid", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-036", "Babar Waqar", "Welder", "Plant B"),
                new EmployeeProfile("emp-037", "Celia Nadeem", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-038", "Dawood Fiaz", "Industrial Hygienist", "Plant B"),
                new EmployeeProfile("emp-039", "Esha Zubair", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-040", "Fahad Munir", "Welder", "Plant B"),
                new EmployeeProfile("emp-041", "Gul Mehak", "Nurse", "Clinic"),
                new EmployeeProfile("emp-042", "Hamza Nisar", "Nurse", "Clinic"),
                new EmployeeProfile("emp-043", "Iram Bashir", "Nurse", "Clinic"),
                new EmployeeProfile("emp-044", "Jibran Rauf", "Nurse", "Clinic"),
                new EmployeeProfile("emp-045", "Khadija Aslam", "Nurse", "Clinic"),
                new EmployeeProfile("emp-046", "Laiba Sher", "Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-047", "Murtaza Qadir", "Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-048", "Noor Adeel", "Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-049", "Omair Hassan", "Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-050", "Parisa Ali", "Clinic Staff", "Clinic")
        );
    }

    public static EmployeeProfile byId(String subjectId) {
        return allEmployees().stream()
                .filter(employee -> employee.externalId().equals(subjectId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown employee id: " + subjectId));
    }

    public record EmployeeProfile(
            String externalId,
            String name,
            String role,
            String site
    ) {
    }
}
