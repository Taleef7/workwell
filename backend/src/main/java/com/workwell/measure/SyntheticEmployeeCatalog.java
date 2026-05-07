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
                new EmployeeProfile("emp-050", "Parisa Ali", "Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-051", "Qasim Tariq", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-052", "Rimsha Fayyaz", "Welder", "Plant A"),
                new EmployeeProfile("emp-053", "Sohail Akram", "Industrial Hygienist", "Plant A"),
                new EmployeeProfile("emp-054", "Tania Waqar", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-055", "Umair Ashraf", "Maintenance Tech / Hazwoper Responder", "Plant A"),
                new EmployeeProfile("emp-056", "Verya Noman", "Welder", "Plant A"),
                new EmployeeProfile("emp-057", "Wajeeha Niaz", "Industrial Hygienist", "Plant A"),
                new EmployeeProfile("emp-058", "Xahir Rehman", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-059", "Yasmeen Omer", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-060", "Zubair Khan", "Welder / Hazwoper Responder", "Plant A"),
                new EmployeeProfile("emp-061", "Abeer Junaid", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-062", "Basil Farid", "Welder", "Plant B"),
                new EmployeeProfile("emp-063", "Cynosha Iqbal", "Industrial Hygienist", "Plant B"),
                new EmployeeProfile("emp-064", "Daniyal Safdar", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-065", "Emaan Rizvi", "Maintenance Tech / Hazwoper Responder", "Plant B"),
                new EmployeeProfile("emp-066", "Farhan Nadeem", "Welder", "Plant B"),
                new EmployeeProfile("emp-067", "Ghaniya Waheed", "Industrial Hygienist", "Plant B"),
                new EmployeeProfile("emp-068", "Hammad Bilal", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-069", "Iqbal Yousaf", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-070", "Javeria Mir", "Welder / Hazwoper Responder", "Plant B"),
                new EmployeeProfile("emp-071", "Kashif Alam", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-072", "Lubna Tahir", "Welder", "Plant A"),
                new EmployeeProfile("emp-073", "Mubeen Shah", "Industrial Hygienist / Clinic Liaison", "Plant A"),
                new EmployeeProfile("emp-074", "Nawal Haroon", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-075", "Owais Ijaz", "Maintenance Tech / Hazwoper Responder", "Plant A"),
                new EmployeeProfile("emp-076", "Pareesa Moin", "Welder", "Plant A"),
                new EmployeeProfile("emp-077", "Qurat Ali", "Industrial Hygienist", "Plant A"),
                new EmployeeProfile("emp-078", "Raheel Zaki", "Office Staff", "Plant A"),
                new EmployeeProfile("emp-079", "Saba Khawar", "Maintenance Tech", "Plant A"),
                new EmployeeProfile("emp-080", "Tariq Fawad", "Welder / Hazwoper Responder", "Plant A"),
                new EmployeeProfile("emp-081", "Urooj Ahmed", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-082", "Vaqas Hasan", "Welder", "Plant B"),
                new EmployeeProfile("emp-083", "Warda Iram", "Industrial Hygienist", "Plant B"),
                new EmployeeProfile("emp-084", "Xain Noor", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-085", "Yumna Tariq", "Maintenance Tech / Hazwoper Responder", "Plant B"),
                new EmployeeProfile("emp-086", "Zain Aslam", "Welder", "Plant B"),
                new EmployeeProfile("emp-087", "Aqsa Kaleem", "Industrial Hygienist / Safety Lead", "Plant B"),
                new EmployeeProfile("emp-088", "Bilawal Hadi", "Office Staff", "Plant B"),
                new EmployeeProfile("emp-089", "Celia Haris", "Maintenance Tech", "Plant B"),
                new EmployeeProfile("emp-090", "Danisha Noor", "Welder / Hazwoper Responder", "Plant B"),
                new EmployeeProfile("emp-091", "Eshal Qadir", "Nurse / Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-092", "Faizan Rauf", "Nurse", "Clinic"),
                new EmployeeProfile("emp-093", "Gulzar Ali", "Nurse", "Clinic"),
                new EmployeeProfile("emp-094", "Hina Batool", "Nurse / TB Program", "Clinic"),
                new EmployeeProfile("emp-095", "Irfan Bashir", "Nurse", "Clinic"),
                new EmployeeProfile("emp-096", "Jannat Younas", "Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-097", "Kamil Reza", "Clinic Staff / Immunization Desk", "Clinic"),
                new EmployeeProfile("emp-098", "Laraib Nadeem", "Clinic Staff", "Clinic"),
                new EmployeeProfile("emp-099", "Mehwish Hanif", "Clinic Staff / Occupational Health", "Clinic"),
                new EmployeeProfile("emp-100", "Nihal Sadiq", "Clinic Staff", "Clinic")
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
