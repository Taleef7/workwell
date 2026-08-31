/**
 * Synthetic employee directory (#107 runs module) — TS port of the Java
 * com.workwell.measure.SyntheticEmployeeCatalog (the engine.synthetic EmployeeDirectory).
 * A static demo workforce keyed by external id; a future DB-backed directory replaces
 * this behind the same lookup. Used by the run read models to resolve outcome rows to
 * employee name/role/site. Generated from the Java catalog — keep in sync on re-seed.
 */
import {
  isWebChartConfigured,
  webChartConfigFromEnv,
  type DataSourceEnv,
} from "../ingress/data-source.ts";

export interface EmployeeProfile {
  externalId: string;
  name: string;
  role: string;
  site: string;        // = location level
  providerId: string;  // attributed provider (an entry in PROVIDERS), at the same `site`
  tenantId: string;    // = WebChart system / employer (an entry in TENANTS), above enterprise (#185 E13)
  // Cross-system identity fields (E15 PR-1) — present only on the small set of synthetic people who
  // exist in >1 WebChart system, so the identity layer can resolve "the same person" by a shared
  // deterministic key (a national/MRN identifier). Absent ⇒ the record is its own singleton person.
  // Additive + optional — no existing row's identity changes, so E13 tenant counts are untouched.
  dateOfBirth?: string; // YYYY-MM-DD (synthetic)
  nationalId?: string;  // shared cross-system identifier (synthetic)
}

export interface Provider {
  id: string;
  name: string;
  location: string; // one of the employee `site` values
  tenantId: string; // the tenant this provider belongs to (#185 E13)
}

/** A WebChart system / employer — the top of the rollup hierarchy (#185 E13 PR-1). */
export interface Tenant { id: string; name: string; }
/** An employer org under a tenant (1 per tenant in PR-1; the level is retained for future multi-org tenants). */
export interface Enterprise { id: string; name: string; tenantId: string; }

export interface SyntheticDirectoryView {
  readonly EMPLOYEES: readonly EmployeeProfile[];
  readonly PROVIDERS: readonly Provider[];
  readonly TENANTS: readonly Tenant[];
  readonly employeeById: (externalId: string) => EmployeeProfile | null;
  readonly providerById: (id: string, env?: DataSourceEnv) => Provider | null;
  readonly tenantById: (id: string, env?: DataSourceEnv) => Tenant | null;
  readonly enterpriseForTenant: (tenantId: string, env?: DataSourceEnv) => Enterprise | null;
  readonly employeesForTenant: (tenantId: string) => EmployeeProfile[];
  readonly providersForLocation: (location: string) => Provider[];
}

/** The tenants/systems whose compliance rolls up into one dashboard (#185 E13 PR-1; `mhn` scale
 *  tenant added in PR-2 — its 120k subjects live only as outcome rows, not in this directory). */
export const TENANTS: readonly Tenant[] = [
  { id: "twh", name: "Total Worker Health" },
  { id: "ihn", name: "Indus Hospital Network" },
  { id: "mhn", name: "MetroHealth Network" },
  { id: "maui", name: "Maui Pilot Clinic" },
];

/** One enterprise per tenant (PR-1; `mhn` is the population-scale tenant, PR-2). */
const ENTERPRISES: readonly Enterprise[] = [
  { id: "twh", name: "Total Worker Health", tenantId: "twh" },
  { id: "ihn", name: "Indus Hospital Network", tenantId: "ihn" },
  { id: "mhn", name: "MetroHealth Network", tenantId: "mhn" },
  { id: "maui", name: "Maui Pilot Clinic", tenantId: "maui" },
];

/** Tenant 1's enterprise root (back-compat; = ENTERPRISES[0]). Pre-E13 single-tenant callers. */
export const ENTERPRISE = { id: "twh", name: "Total Worker Health" } as const;

/** Synthetic occupational-health clinicians — 2 per location (provider level, #74 E4 / #185 E13). */
export const PROVIDERS: readonly Provider[] = [
  // Tenant 1 — Total Worker Health (twh)
  { id: "prov-001", name: "Dr. Sara Mahmood", location: "Plant A", tenantId: "twh" },
  { id: "prov-002", name: "NP Kamran Sheikh", location: "Plant A", tenantId: "twh" },
  { id: "prov-003", name: "Dr. Lubna Aziz", location: "Plant B", tenantId: "twh" },
  { id: "prov-004", name: "NP Faisal Dar", location: "Plant B", tenantId: "twh" },
  { id: "prov-005", name: "Dr. Hina Qureshi", location: "HQ", tenantId: "twh" },
  { id: "prov-006", name: "NP Bilal Mansoor", location: "HQ", tenantId: "twh" },
  { id: "prov-007", name: "Dr. Ayesha Raza", location: "Clinic", tenantId: "twh" },
  { id: "prov-008", name: "NP Tariq Saleem", location: "Clinic", tenantId: "twh" },
  // Tenant 2 — Indus Hospital Network (ihn): 2 clinicians per campus
  { id: "prov-101", name: "Dr. Saima Anwar", location: "North Campus", tenantId: "ihn" },
  { id: "prov-102", name: "NP Rizwan Tariq", location: "North Campus", tenantId: "ihn" },
  { id: "prov-103", name: "Dr. Maria Yusuf", location: "South Campus", tenantId: "ihn" },
  { id: "prov-104", name: "NP Hamid Raza", location: "South Campus", tenantId: "ihn" },
  { id: "prov-105", name: "Dr. Nida Kamal", location: "Outpatient Clinic", tenantId: "ihn" },
  { id: "prov-106", name: "NP Asad Mahmood", location: "Outpatient Clinic", tenantId: "ihn" },
  // Tenant 4 — Maui Pilot Clinic: 2 primary-care providers per clinic
  { id: "maui-prov-001", name: "Dr. Aven Stone", location: "Wailuku Clinic", tenantId: "maui" },
  { id: "maui-prov-002", name: "NP Kira Venn", location: "Wailuku Clinic", tenantId: "maui" },
  { id: "maui-prov-003", name: "Dr. Oren Tide", location: "Kihei Clinic", tenantId: "maui" },
  { id: "maui-prov-004", name: "PA Nima Cove", location: "Kihei Clinic", tenantId: "maui" },
];

type EmployeeBase = Omit<EmployeeProfile, "providerId">;
/** A tenant-less base row (the original twh seed); `tenantId: "twh"` is injected below. */
type TenantlessBase = Omit<EmployeeProfile, "providerId" | "tenantId">;

const TWH_BASE_RAW: readonly TenantlessBase[] = [
  { externalId: "emp-001", name: "Demo Author", role: "Author", site: "HQ" },
  { externalId: "emp-002", name: "Demo Approver", role: "Approver", site: "HQ" },
  { externalId: "emp-003", name: "Demo Case Manager", role: "Case Manager", site: "HQ" },
  { externalId: "emp-004", name: "Demo Admin", role: "Admin", site: "HQ" },
  { externalId: "emp-005", name: "Nadia Anwar", role: "Maintenance Tech", site: "Plant A" },
  // emp-006 / emp-007 are the twh side of two cross-system people (E15 PR-1): emp-006 "Omar Siddiq"
  // is the MOBILITY subject (moved twh→ihn; his twh link is PRIOR — see identity mobility seed), and
  // emp-007 "Sana Imtiaz" is a plain cross-system DUPLICATE (active in both systems). Both share a
  // synthetic nationalId with their ihn record.
  { externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A", dateOfBirth: "1985-03-12", nationalId: "NID-100-OMAR" },
  { externalId: "emp-007", name: "Sana Imtiaz", role: "Office Staff", site: "Plant A", dateOfBirth: "1990-07-22", nationalId: "NID-200-SANA" },
  { externalId: "emp-008", name: "Tariq Ilyas", role: "Industrial Hygienist", site: "Plant A" },
  { externalId: "emp-009", name: "Uzma Farooq", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-010", name: "Waleed Noor", role: "Welder", site: "Plant A" },
  { externalId: "emp-011", name: "Yasir Khan", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-012", name: "Zara Tariq", role: "Welder", site: "Plant B" },
  { externalId: "emp-013", name: "Adeel Hamid", role: "Industrial Hygienist", site: "Plant B" },
  { externalId: "emp-014", name: "Bushra Habib", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-015", name: "Danish Ali", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-016", name: "Eman Saleem", role: "Welder", site: "Plant B" },
  { externalId: "emp-017", name: "Faisal Javed", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-018", name: "Ghazala Fatima", role: "Industrial Hygienist", site: "Plant B" },
  { externalId: "emp-019", name: "Haris Latif", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-020", name: "Iqra Masood", role: "Welder", site: "Plant B" },
  { externalId: "emp-021", name: "Junaid Arif", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-022", name: "Kiran Saeed", role: "Welder", site: "Plant A" },
  { externalId: "emp-023", name: "Liaqat Hussain", role: "Industrial Hygienist", site: "Plant A" },
  { externalId: "emp-024", name: "Maham Yousaf", role: "Office Staff", site: "Plant A" },
  { externalId: "emp-025", name: "Noman Asif", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-026", name: "Rabia Akhtar", role: "Welder", site: "Plant A" },
  { externalId: "emp-027", name: "Saad Ahmed", role: "Office Staff", site: "Plant A" },
  { externalId: "emp-028", name: "Tehmina Waheed", role: "Industrial Hygienist", site: "Plant A" },
  { externalId: "emp-029", name: "Usman Rauf", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-030", name: "Vania Riaz", role: "Welder", site: "Plant A" },
  { externalId: "emp-031", name: "Waqas Amin", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-032", name: "Xenia Jamil", role: "Welder", site: "Plant B" },
  { externalId: "emp-033", name: "Yumna Baig", role: "Industrial Hygienist", site: "Plant B" },
  { externalId: "emp-034", name: "Zeeshan Mir", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-035", name: "Areeba Khalid", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-036", name: "Babar Waqar", role: "Welder", site: "Plant B" },
  { externalId: "emp-037", name: "Celia Nadeem", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-038", name: "Dawood Fiaz", role: "Industrial Hygienist", site: "Plant B" },
  { externalId: "emp-039", name: "Esha Zubair", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-040", name: "Fahad Munir", role: "Welder", site: "Plant B" },
  { externalId: "emp-041", name: "Gul Mehak", role: "Nurse", site: "Clinic" },
  { externalId: "emp-042", name: "Hamza Nisar", role: "Nurse", site: "Clinic" },
  { externalId: "emp-043", name: "Iram Bashir", role: "Nurse", site: "Clinic" },
  { externalId: "emp-044", name: "Jibran Rauf", role: "Nurse", site: "Clinic" },
  { externalId: "emp-045", name: "Khadija Aslam", role: "Nurse", site: "Clinic" },
  { externalId: "emp-046", name: "Laiba Sher", role: "Clinic Staff", site: "Clinic" },
  { externalId: "emp-047", name: "Murtaza Qadir", role: "Clinic Staff", site: "Clinic" },
  { externalId: "emp-048", name: "Noor Adeel", role: "Clinic Staff", site: "Clinic" },
  { externalId: "emp-049", name: "Omair Hassan", role: "Clinic Staff", site: "Clinic" },
  { externalId: "emp-050", name: "Parisa Ali", role: "Clinic Staff", site: "Clinic" },
  { externalId: "emp-051", name: "Qasim Tariq", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-052", name: "Rimsha Fayyaz", role: "Welder", site: "Plant A" },
  { externalId: "emp-053", name: "Sohail Akram", role: "Industrial Hygienist", site: "Plant A" },
  { externalId: "emp-054", name: "Tania Waqar", role: "Office Staff", site: "Plant A" },
  { externalId: "emp-055", name: "Umair Ashraf", role: "Maintenance Tech / Hazwoper Responder", site: "Plant A" },
  { externalId: "emp-056", name: "Verya Noman", role: "Welder", site: "Plant A" },
  { externalId: "emp-057", name: "Wajeeha Niaz", role: "Industrial Hygienist", site: "Plant A" },
  { externalId: "emp-058", name: "Xahir Rehman", role: "Office Staff", site: "Plant A" },
  { externalId: "emp-059", name: "Yasmeen Omer", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-060", name: "Zubair Khan", role: "Welder / Hazwoper Responder", site: "Plant A" },
  { externalId: "emp-061", name: "Abeer Junaid", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-062", name: "Basil Farid", role: "Welder", site: "Plant B" },
  { externalId: "emp-063", name: "Cynosha Iqbal", role: "Industrial Hygienist", site: "Plant B" },
  { externalId: "emp-064", name: "Daniyal Safdar", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-065", name: "Emaan Rizvi", role: "Maintenance Tech / Hazwoper Responder", site: "Plant B" },
  { externalId: "emp-066", name: "Farhan Nadeem", role: "Welder", site: "Plant B" },
  { externalId: "emp-067", name: "Ghaniya Waheed", role: "Industrial Hygienist", site: "Plant B" },
  { externalId: "emp-068", name: "Hammad Bilal", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-069", name: "Iqbal Yousaf", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-070", name: "Javeria Mir", role: "Welder / Hazwoper Responder", site: "Plant B" },
  { externalId: "emp-071", name: "Kashif Alam", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-072", name: "Lubna Tahir", role: "Welder", site: "Plant A" },
  { externalId: "emp-073", name: "Mubeen Shah", role: "Industrial Hygienist / Clinic Liaison", site: "Plant A" },
  { externalId: "emp-074", name: "Nawal Haroon", role: "Office Staff", site: "Plant A" },
  { externalId: "emp-075", name: "Owais Ijaz", role: "Maintenance Tech / Hazwoper Responder", site: "Plant A" },
  { externalId: "emp-076", name: "Pareesa Moin", role: "Welder", site: "Plant A" },
  { externalId: "emp-077", name: "Qurat Ali", role: "Industrial Hygienist", site: "Plant A" },
  { externalId: "emp-078", name: "Raheel Zaki", role: "Office Staff", site: "Plant A" },
  { externalId: "emp-079", name: "Saba Khawar", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-080", name: "Tariq Fawad", role: "Welder / Hazwoper Responder", site: "Plant A" },
  { externalId: "emp-081", name: "Urooj Ahmed", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-082", name: "Vaqas Hasan", role: "Welder", site: "Plant B" },
  { externalId: "emp-083", name: "Warda Iram", role: "Industrial Hygienist", site: "Plant B" },
  { externalId: "emp-084", name: "Xain Noor", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-085", name: "Yumna Tariq", role: "Maintenance Tech / Hazwoper Responder", site: "Plant B" },
  { externalId: "emp-086", name: "Zain Aslam", role: "Welder", site: "Plant B" },
  { externalId: "emp-087", name: "Aqsa Kaleem", role: "Industrial Hygienist / Safety Lead", site: "Plant B" },
  { externalId: "emp-088", name: "Bilawal Hadi", role: "Office Staff", site: "Plant B" },
  { externalId: "emp-089", name: "Celia Haris", role: "Maintenance Tech", site: "Plant B" },
  { externalId: "emp-090", name: "Danisha Noor", role: "Welder / Hazwoper Responder", site: "Plant B" },
  { externalId: "emp-091", name: "Eshal Qadir", role: "Nurse / Clinic Staff", site: "Clinic" },
  { externalId: "emp-092", name: "Faizan Rauf", role: "Nurse", site: "Clinic" },
  { externalId: "emp-093", name: "Gulzar Ali", role: "Nurse", site: "Clinic" },
  { externalId: "emp-094", name: "Hina Batool", role: "Nurse / TB Program", site: "Clinic" },
  { externalId: "emp-095", name: "Irfan Bashir", role: "Nurse", site: "Clinic" },
  { externalId: "emp-096", name: "Jannat Younas", role: "Clinic Staff", site: "Clinic" },
  { externalId: "emp-097", name: "Kamil Reza", role: "Clinic Staff / Immunization Desk", site: "Clinic" },
  { externalId: "emp-098", name: "Laraib Nadeem", role: "Clinic Staff", site: "Clinic" },
  { externalId: "emp-099", name: "Mehwish Hanif", role: "Clinic Staff / Occupational Health", site: "Clinic" },
  { externalId: "emp-100", name: "Nihal Sadiq", role: "Clinic Staff", site: "Clinic" },
];

/** Tenant 1 (twh) — the original 100, stamped with their tenant. Identities unchanged. */
const TWH_BASE: readonly EmployeeBase[] = TWH_BASE_RAW.map((e) => ({ ...e, tenantId: "twh" }));

/** Tenant 2 (ihn) — Indus Hospital Network: 50 employees across 3 campuses, healthcare roles. */
const IHN_BASE: readonly EmployeeBase[] = [
  // North Campus (17)
  // ihn-emp-001 / ihn-emp-002 are the ihn side of the two cross-system people (E15 PR-1): same
  // synthetic person as twh emp-006 / emp-007 (shared nationalId + DOB + aligned name), system-local
  // ids differ. ihn-emp-001 is "Omar Siddiq"'s current (ACTIVE) system after the move.
  { externalId: "ihn-emp-001", name: "Omar Siddiq", role: "Nurse", site: "North Campus", tenantId: "ihn", dateOfBirth: "1985-03-12", nationalId: "NID-100-OMAR" },
  { externalId: "ihn-emp-002", name: "Sana Imtiaz", role: "Physician", site: "North Campus", tenantId: "ihn", dateOfBirth: "1990-07-22", nationalId: "NID-200-SANA" },
  { externalId: "ihn-emp-003", name: "Caira Sattar", role: "Lab Tech", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-004", name: "Daniyal Khan", role: "Front Desk", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-005", name: "Erum Pervaiz", role: "Pharmacist", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-006", name: "Faraz Iqbal", role: "Radiology Tech", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-007", name: "Gohar Nawaz", role: "Nurse", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-008", name: "Hafsa Malik", role: "Nurse", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-009", name: "Imran Sethi", role: "Physician", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-010", name: "Jaweria Aslam", role: "Lab Tech", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-011", name: "Kamran Butt", role: "Front Desk", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-012", name: "Lubna Shafiq", role: "Pharmacist", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-013", name: "Moeen Akhtar", role: "Radiology Tech", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-014", name: "Nashit Raza", role: "Nurse", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-015", name: "Owais Latif", role: "Physician", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-016", name: "Pakeeza Amin", role: "Nurse", site: "North Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-017", name: "Qaiser Shah", role: "Lab Tech", site: "North Campus", tenantId: "ihn" },
  // South Campus (17)
  { externalId: "ihn-emp-018", name: "Rida Farooqi", role: "Nurse", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-019", name: "Saqib Mehmood", role: "Physician", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-020", name: "Tooba Yaseen", role: "Lab Tech", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-021", name: "Usman Ghani", role: "Front Desk", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-022", name: "Vania Rashid", role: "Pharmacist", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-023", name: "Wahaj Ansari", role: "Radiology Tech", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-024", name: "Xara Kamran", role: "Nurse", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-025", name: "Yousuf Adil", role: "Physician", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-026", name: "Zoya Hameed", role: "Nurse", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-027", name: "Adnan Saqib", role: "Lab Tech", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-028", name: "Bushra Naveed", role: "Front Desk", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-029", name: "Chand Riaz", role: "Pharmacist", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-030", name: "Dua Sami", role: "Radiology Tech", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-031", name: "Ehsan Tariq", role: "Nurse", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-032", name: "Fariha Zaman", role: "Physician", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-033", name: "Ghulam Abbas", role: "Nurse", site: "South Campus", tenantId: "ihn" },
  { externalId: "ihn-emp-034", name: "Huda Saleem", role: "Lab Tech", site: "South Campus", tenantId: "ihn" },
  // Outpatient Clinic (16)
  { externalId: "ihn-emp-035", name: "Ibrahim Dar", role: "Nurse", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-036", name: "Jamila Karim", role: "Physician", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-037", name: "Kashan Vohra", role: "Lab Tech", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-038", name: "Laila Nawaz", role: "Front Desk", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-039", name: "Mahad Sohail", role: "Pharmacist", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-040", name: "Noreen Akram", role: "Radiology Tech", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-041", name: "Obaid Rauf", role: "Nurse", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-042", name: "Pari Gul", role: "Physician", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-043", name: "Qudsia Bano", role: "Nurse", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-044", name: "Rehan Aziz", role: "Lab Tech", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-045", name: "Sadia Munir", role: "Front Desk", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-046", name: "Talha Qamar", role: "Pharmacist", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-047", name: "Uzair Hanif", role: "Radiology Tech", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-048", name: "Wajiha Sajid", role: "Nurse", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-049", name: "Yahya Mir", role: "Physician", site: "Outpatient Clinic", tenantId: "ihn" },
  { externalId: "ihn-emp-050", name: "Zainab Asif", role: "Nurse", site: "Outpatient Clinic", tenantId: "ihn" },
];

/** Tenant 4 (maui) — a deterministic primary-care patient panel across two clinics. */
const MAUI_BASE: readonly EmployeeBase[] = [
  { externalId: "pat-001", name: "Ari Wren", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1952-02-14" },
  { externalId: "pat-002", name: "Nia Calder", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1953-05-27" },
  { externalId: "pat-003", name: "Milo Quade", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1954-08-09" },
  { externalId: "pat-004", name: "Sela Rowan", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1955-11-18" },
  { externalId: "pat-005", name: "Kian Voss", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1956-03-06" },
  { externalId: "pat-006", name: "Tessa Maren", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1957-07-21" },
  { externalId: "pat-007", name: "Orin Vale", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1958-10-02" },
  { externalId: "pat-008", name: "Luma Keene", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1959-12-29" },
  { externalId: "pat-009", name: "Jori Flint", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1960-01-15" },
  { externalId: "pat-010", name: "Veda Sloan", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1961-04-30" },
  { externalId: "pat-011", name: "Cato Wynn", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1962-09-12" },
  { externalId: "pat-012", name: "Mira Hallow", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1963-02-23" },
  { externalId: "pat-013", name: "Rian Cove", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1964-06-17" },
  { externalId: "pat-014", name: "Elia Fern", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1965-11-05" },
  { externalId: "pat-015", name: "Noa Mercer", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1966-03-28" },
  { externalId: "pat-016", name: "Zuri Bell", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1967-08-14" },
  { externalId: "pat-017", name: "Ivo Rook", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1968-12-01" },
  { externalId: "pat-018", name: "Kira Dune", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1969-05-19" },
  { externalId: "pat-019", name: "Ansel Pryce", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1970-10-26" },
  { externalId: "pat-020", name: "Mina Lark", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1971-01-08" },
  { externalId: "pat-021", name: "Oren Farrow", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1972-04-16" },
  { externalId: "pat-022", name: "Suri Moss", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1973-07-03" },
  { externalId: "pat-023", name: "Tavi North", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1974-09-24" },
  { externalId: "pat-024", name: "Ena Briar", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1975-12-11" },
  { externalId: "pat-025", name: "Bram Ellery", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1976-02-07" },
  { externalId: "pat-026", name: "Yara Finch", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1977-06-25" },
  { externalId: "pat-027", name: "Cal Vesper", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1978-11-13" },
  { externalId: "pat-028", name: "Nomi Hart", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1979-03-31" },
  { externalId: "pat-029", name: "Jalen Quill", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1980-08-20" },
  { externalId: "pat-030", name: "Eira Bloom", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1981-10-06" },
  { externalId: "pat-031", name: "Remy Ash", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1982-01-22" },
  { externalId: "pat-032", name: "Lior Tern", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1983-04-09" },
  { externalId: "pat-033", name: "Sana Drift", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1984-07-27" },
  { externalId: "pat-034", name: "Daro Wells", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1985-11-16" },
  { externalId: "pat-035", name: "Maren Pike", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1986-02-04" },
  { externalId: "pat-036", name: "Olia Snow", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1987-05-22" },
  { externalId: "pat-037", name: "Koa Linden", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1988-09-10" },
  { externalId: "pat-038", name: "Rhea Morrow", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1989-12-19" },
  { externalId: "pat-039", name: "Tobin Crest", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1990-03-15" },
  { externalId: "pat-040", name: "Vina Gale", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1991-06-08" },
  { externalId: "pat-041", name: "Elior Banks", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1992-08-26" },
  { externalId: "pat-042", name: "Nara Field", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1993-10-17" },
  { externalId: "pat-043", name: "Soren Lake", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1994-01-29" },
  { externalId: "pat-044", name: "Iria West", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1995-04-12" },
  { externalId: "pat-045", name: "Mako Reed", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1996-07-01" },
  { externalId: "pat-046", name: "Yuna Vale", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1951-09-21" },
  { externalId: "pat-047", name: "Aven Shore", role: "Patient", site: "Wailuku Clinic", tenantId: "maui", dateOfBirth: "1952-12-07" },
  { externalId: "pat-048", name: "Nilo Gray", role: "Patient", site: "Kihei Clinic", tenantId: "maui", dateOfBirth: "1996-11-03" },
];

/** All directory rows, including the Maui primary-care panel. */
const EMPLOYEE_BASE: readonly EmployeeBase[] = [...TWH_BASE, ...IHN_BASE, ...MAUI_BASE];

function providerIndexByLocation(providers: readonly Provider[]): Map<string, Provider[]> {
  const index = new Map<string, Provider[]>();
  for (const p of providers) {
    (index.get(p.location) ?? index.set(p.location, []).get(p.location)!).push(p);
  }
  for (const list of index.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return index;
}

// Full-provider index: assignProviders must see every provider before any profile visibility filter.
const PROVIDERS_BY_LOCATION = providerIndexByLocation(PROVIDERS);

/** Providers serving a location (sorted by id); [] for an unknown location. */
export function providersForLocation(location: string): Provider[] {
  return PROVIDERS_BY_LOCATION.get(location) ?? [];
}

/**
 * Deterministic round-robin: within each site, employees sorted by externalId are spread
 * across that site's providers in id order. Pure function of the inputs — no randomness —
 * so attribution is stable across runs/imports (required by the reconciliation tests).
 */
function assignProviders(base: readonly EmployeeBase[]): EmployeeProfile[] {
  const bySite = new Map<string, EmployeeBase[]>();
  for (const e of base) (bySite.get(e.site) ?? bySite.set(e.site, []).get(e.site)!).push(e);
  const out = new Map<string, string>(); // externalId -> providerId
  for (const [site, emps] of bySite) {
    const providers = providersForLocation(site);
    const sorted = [...emps].sort((a, b) => a.externalId.localeCompare(b.externalId));
    sorted.forEach((e, i) => {
      const pid = providers.length ? providers[i % providers.length]!.id : `prov-${site}`;
      out.set(e.externalId, pid);
    });
  }
  return base.map((e) => ({ ...e, providerId: out.get(e.externalId)! }));
}

export const EMPLOYEES: readonly EmployeeProfile[] = assignProviders(EMPLOYEE_BASE);

/**
 * Tenants whose people are DIRECTORY-ONLY for now: visible in /api/tenants, people search and
 * rosters, but excluded from every seeded-distribution/evaluation surface. The maui pilot cohort
 * waits for MM-1's measure-set wiring — evaluating it today would (a) change the global seeded
 * distribution's input and silently reshuffle existing tenants' outcomes (case churn on the live
 * demo), and (b) enroll patients in occupational-health measures. Remove a tenant from this set
 * only together with per-tenant distribution/applicability (ROADMAP_2026-08-30 MM-1).
 */
export const EVALUATION_EXCLUDED_TENANTS: ReadonlySet<string> = new Set(["maui"]);

/** The population every evaluation surface uses: the directory minus evaluation-excluded tenants. */
export const EVALUABLE_EMPLOYEES: readonly EmployeeProfile[] = EMPLOYEES.filter(
  (e) => !EVALUATION_EXCLUDED_TENANTS.has(e.tenantId),
);

/**
 * The four hardcoded demo-login personas (`emp-001..004`, the system roles Author/Approver/Case
 * Manager/Admin). They carry no occupational measures, so the compliance roster floats them to the
 * BOTTOM (UX-1) — by this explicit marker rather than a has-data heuristic: an `All Employees` segment
 * can hand a persona a single Compliant cell, which would un-sink a has-data check and lead the flagship
 * roster with four fake users.
 */
export const DEMO_PERSONA_EXTERNAL_IDS: ReadonlySet<string> = new Set(["emp-001", "emp-002", "emp-003", "emp-004"]);
export const isDemoPersona = (externalId: string): boolean => DEMO_PERSONA_EXTERNAL_IDS.has(externalId);

const BY_ID = new Map<string, EmployeeProfile>(EMPLOYEES.map((e) => [e.externalId, e]));
const PROVIDER_BY_ID = new Map<string, Provider>(PROVIDERS.map((p) => [p.id, p]));

const WEBCHART_PROVIDER: Provider = {
  id: "wc-provider-1",
  name: "WebChart Clinician",
  location: "WebChart",
  tenantId: "wc",
};
const WEBCHART_ENTERPRISE: Enterprise = { id: "wc", name: "WebChart", tenantId: "wc" };

/** Lookup by external id; null when unknown (callers degrade gracefully — no throw). */
export function employeeById(externalId: string): EmployeeProfile | null {
  return BY_ID.get(externalId) ?? null;
}

/** Lookup a provider by id; null when unknown. */
export function providerById(id: string, env?: DataSourceEnv): Provider | null {
  if (id === WEBCHART_PROVIDER.id && env && isWebChartConfigured(env)) return WEBCHART_PROVIDER;
  return PROVIDER_BY_ID.get(id) ?? null;
}

const TENANT_BY_ID = new Map<string, Tenant>(TENANTS.map((t) => [t.id, t]));
const ENTERPRISE_BY_TENANT = new Map<string, Enterprise>(ENTERPRISES.map((e) => [e.tenantId, e]));

/** Lookup a tenant by id; null when unknown (#185 E13). */
export function tenantById(id: string, env?: DataSourceEnv): Tenant | null {
  if (id === "wc" && env) return webChartTenant(env);
  return TENANT_BY_ID.get(id) ?? null;
}

/** The enterprise for a tenant; null when unknown. */
export function enterpriseForTenant(tenantId: string, env?: DataSourceEnv): Enterprise | null {
  if (tenantId === "wc" && env && isWebChartConfigured(env)) return WEBCHART_ENTERPRISE;
  return ENTERPRISE_BY_TENANT.get(tenantId) ?? null;
}

/** The configured live WebChart tenant; absent unless the existing ingress seam is selected. */
export function webChartTenant(env: DataSourceEnv): Tenant | null {
  if (!isWebChartConfigured(env)) return null;
  const cfg = webChartConfigFromEnv(env)!;
  return { id: "wc", name: `WebChart (${new URL(cfg.baseUrl).host})` };
}

/** Employees belonging to a tenant, in directory order. */
export function employeesForTenant(tenantId: string): EmployeeProfile[] {
  return EMPLOYEES.filter((e) => e.tenantId === tenantId);
}

/** Pure scoped views over the fully assigned synthetic directory. */
export function scopedSyntheticDirectory(visibleTenantIds: ReadonlySet<string>): SyntheticDirectoryView {
  const employees = EMPLOYEES.filter((e) => visibleTenantIds.has(e.tenantId));
  const providers = PROVIDERS.filter((p) => visibleTenantIds.has(p.tenantId));
  const tenants = TENANTS.filter((t) => visibleTenantIds.has(t.id));
  const byEmployeeId = new Map(employees.map((e) => [e.externalId, e]));
  const byProviderId = new Map(providers.map((p) => [p.id, p]));
  const byTenantId = new Map(tenants.map((t) => [t.id, t]));
  const byEnterpriseTenantId = new Map(
    ENTERPRISES.filter((e) => visibleTenantIds.has(e.tenantId)).map((e) => [e.tenantId, e]),
  );
  const providersByLocation = providerIndexByLocation(providers);

  return {
    EMPLOYEES: employees,
    PROVIDERS: providers,
    TENANTS: tenants,
    employeeById: (externalId) => byEmployeeId.get(externalId) ?? null,
    providerById: (id, env) => {
      if (id === WEBCHART_PROVIDER.id && visibleTenantIds.has("wc") && env && isWebChartConfigured(env)) return WEBCHART_PROVIDER;
      return byProviderId.get(id) ?? null;
    },
    tenantById: (id, env) => {
      if (id === "wc" && visibleTenantIds.has("wc") && env) return webChartTenant(env);
      return byTenantId.get(id) ?? null;
    },
    enterpriseForTenant: (tenantId, env) => {
      if (tenantId === "wc" && visibleTenantIds.has("wc") && env && isWebChartConfigured(env)) return WEBCHART_ENTERPRISE;
      return byEnterpriseTenantId.get(tenantId) ?? null;
    },
    employeesForTenant: (tenantId) => employees.filter((e) => e.tenantId === tenantId),
    providersForLocation: (location) => providersByLocation.get(location) ?? [],
  };
}
