/**
 * The first 48 corpus records, verbatim.
 *
 * These rows were the whole Maui panel before the 20,000-patient corpus, and every existing fixture,
 * screenshot and saved filter refers to them by `pat-001..pat-048`. The generator therefore emits them
 * UNCHANGED as its own first 48 records rather than deriving them, so scaling the corpus never renames
 * a patient someone already has open (spec, "Determinism").
 *
 * Do not edit a field here. Changing one changes an identity the rest of the repo already pins.
 */
import type { EmployeeBase } from "../employee-catalog.ts";

export const CORPUS_FIXTURE_PREFIX: readonly EmployeeBase[] = [
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
