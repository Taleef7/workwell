/**
 * Synthetic employee directory (#107 runs module) — TS port of the Java
 * com.workwell.measure.SyntheticEmployeeCatalog (the engine.synthetic EmployeeDirectory).
 * A static demo workforce keyed by external id; a future DB-backed directory replaces
 * this behind the same lookup. Used by the run read models to resolve outcome rows to
 * employee name/role/site. Generated from the Java catalog — keep in sync on re-seed.
 */
export interface EmployeeProfile {
  externalId: string;
  name: string;
  role: string;
  site: string;        // = location level
  providerId: string;  // attributed provider (an entry in PROVIDERS), at the same `site`
}

export interface Provider {
  id: string;
  name: string;
  location: string; // one of the employee `site` values
}

/** Single-tenant enterprise root for the multi-level dashboard hierarchy (#74 E4). */
export const ENTERPRISE = { id: "twh", name: "Total Worker Health" } as const;

/** Synthetic occupational-health clinicians — 2 per location (provider level, #74 E4). */
export const PROVIDERS: readonly Provider[] = [
  { id: "prov-001", name: "Dr. Sara Mahmood", location: "Plant A" },
  { id: "prov-002", name: "NP Kamran Sheikh", location: "Plant A" },
  { id: "prov-003", name: "Dr. Lubna Aziz", location: "Plant B" },
  { id: "prov-004", name: "NP Faisal Dar", location: "Plant B" },
  { id: "prov-005", name: "Dr. Hina Qureshi", location: "HQ" },
  { id: "prov-006", name: "NP Bilal Mansoor", location: "HQ" },
  { id: "prov-007", name: "Dr. Ayesha Raza", location: "Clinic" },
  { id: "prov-008", name: "NP Tariq Saleem", location: "Clinic" },
];

type EmployeeBase = Omit<EmployeeProfile, "providerId">;

const EMPLOYEE_BASE: readonly EmployeeBase[] = [
  { externalId: "emp-001", name: "Demo Author", role: "Author", site: "HQ" },
  { externalId: "emp-002", name: "Demo Approver", role: "Approver", site: "HQ" },
  { externalId: "emp-003", name: "Demo Case Manager", role: "Case Manager", site: "HQ" },
  { externalId: "emp-004", name: "Demo Admin", role: "Admin", site: "HQ" },
  { externalId: "emp-005", name: "Nadia Anwar", role: "Maintenance Tech", site: "Plant A" },
  { externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A" },
  { externalId: "emp-007", name: "Sana Imtiaz", role: "Office Staff", site: "Plant A" },
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

const PROVIDERS_BY_LOCATION = new Map<string, Provider[]>();
for (const p of PROVIDERS) {
  (PROVIDERS_BY_LOCATION.get(p.location) ?? PROVIDERS_BY_LOCATION.set(p.location, []).get(p.location)!).push(p);
}
for (const list of PROVIDERS_BY_LOCATION.values()) list.sort((a, b) => a.id.localeCompare(b.id));

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

const BY_ID = new Map<string, EmployeeProfile>(EMPLOYEES.map((e) => [e.externalId, e]));
const PROVIDER_BY_ID = new Map<string, Provider>(PROVIDERS.map((p) => [p.id, p]));

/** Lookup by external id; null when unknown (callers degrade gracefully — no throw). */
export function employeeById(externalId: string): EmployeeProfile | null {
  return BY_ID.get(externalId) ?? null;
}

/** Lookup a provider by id; null when unknown. */
export function providerById(id: string): Provider | null {
  return PROVIDER_BY_ID.get(id) ?? null;
}
