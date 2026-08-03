# The C2 loop runs end to end — and Cypress cannot read the document it produces

Date: 2026-08-03. Follow-on to `CVU_CALCULATION_CHECK_SPIKE_2026-08-02.md` (#385/#386/#387/#388).

**Headline, in the order that matters.** WorkWell can now take a Cypress patient archive, resolve it to
people, calculate, finalize and export a QRDA Category III **entirely through its own API** — the loop
locked decision #2 names. The document carries **exactly Cypress's expected population counts**. And
Cypress's `ExpectedResultsValidator`, run against it for the first time, **extracted nothing from it**,
so the comparison C2 exists to perform did not happen. The cause is measure-identity LINEAGE, not
arithmetic.

## 1. The loop, through the product

`scripts/cvu/c2-submit.ts` drives the real routes in-process against a temporary SQLite database — the
same code a deployed worker runs, with no fixture and no shortcut around identity resolution or the
reportability guard:

```text
CMS125  153 documents → 150 subjects (3 merged, 0 unreadable, 2 demographic conflicts) → COMPLETED
        populations in the submitted document: {"IPP":150,"DENOM":150,"DENEX":47,"NUMER":2}
CMS122   68 documents →  64 subjects (3 merged, 1 unreadable, 3 demographic conflicts) → COMPLETED
        populations in the submitted document: {"IPP":64,"DENOM":64,"DENEX":32,"NUMER":31}
```

Both are Cypress's expected results exactly (`IPP 150/150, DENOM 150, NUMER 2, DENEX 47` and
`64/64/31/32`). The one unreadable CMS122 document is the half of a clinically split patient carrying
only a payer entry, which ADR-051 refuses; its person is recovered from the other half, which is why 68
documents still resolve to 64 people.

Two new routes made this possible, and neither existed before (#386 §11.1 named the gap):
`POST /api/runs/:id/import` (a batch, resolved to people first) and `POST /api/runs/:id/finalize`
(refuses any run whose outcomes did not all come from imported documents). ADR-056.

## 2. What Cypress said

Submitted to the C2 task through `C2Task#execute` — the same path the upload form drives —
and the job run inline so the verdict is immediate. **`state=failed` for both measures.**

| errors | CMS125 | CMS122 |
|---|---|---|
| `CqmValidators::Cat3Measure` | 3 | 3 |
| `Validators::ExpectedSupplementalResults` | 45 | 53 |
| **population mismatches** | **0** | **0** |

**Zero population mismatches is NOT a pass, and reading it as one is the trap.**
`ExpectedResultsValidator#check_population` compares only `if !reported_result.empty?` — so a document it
cannot read at all produces no population errors, which looks identical to agreement if you count errors.
Measured directly by running the validator and printing what it extracted:

```text
reported_results: {"PopulationSet_1" => {}, "PopulationSet_1_Stratification_1" => {}, "PopulationSet_1_Stratification_2" => {}}
```

**Empty for every population set.** Cypress read no number of ours, so it compared nothing.

A related trap in the message wording, which cost a wrong first reading here: `Reported IPP value 150
does not match sum 0 of supplemental key RACE values` looks like Cypress quoting our 150. It is not —
`check_supplemental_data_matches_pop_sums` computes `pop_sum` from the **expected** supplemental values
and calls it "Reported". The `0` is ours. That message is evidence about supplemental data only.

## 3. The cause: two lineages of the same measure

```text
Invalid HQMF ID Found: AE8BC6FE-718D-4C4F-AF2F-22AAF9C7844D
Invalid HQMF Set ID Found: F766AFA2-F780-45D2-B224-C1BDB733FA6F
Population 9F3B1C07-2E5A-4D18-B6A4-70C9E8D5A231 for Measure ae8bc6fe-… reported more than once
```

Cypress's bundle carries **CMS125v14, the QDM lineage**. We run and report **CMS125FHIR v1.0.000, the
QI-Core lineage** — a different eMeasure UUID, a different set id, and population criteria named
`InitialPopulation_1` rather than identified by per-population UUIDs. `extract_results_by_ids` looks for
its own measure's population ids and finds none of ours, hence the empty extraction. The third error is
the same mismatch in a third place: our Cat III uses one shared `@root` with the criterion name in
`@extension`, so Cypress sees the same population id four times.

**This is not a defect we should fix by relabelling.** ADR-046 decision 3 forbids claiming a published
eMeasure identity the run did not use, and emitting the QDM UUID while executing the FHIR artifact is
exactly that. The document is internally honest: it says which artifact produced these numbers.

## 4. The second gap: supplemental data

45 and 53 errors, all of one shape. QRDA III requires RACE, ETHNICITY, SEX and PAYER breakdowns per
population, and **we emit none** — `sum 0` in every message. C2 grades them; our Cat III has never
carried them. Separately from the lineage problem, this alone would fail a submission.

Note the input is there: Patient Characteristic Payer appears in every Cypress document (153 and 68
entries) and our importer drops it, and race/ethnicity ride in `<recordTarget>` where the importer reads
neither. So this is an end-to-end gap — import, evidence and export — not just an export one.

## 5. What this changes, and what it does not

**Established.** The import → evaluate → finalize → export loop exists in the product and runs over a
third party's archive. The numbers it produces are right, which #388 measured directly against Cypress's
own per-patient expected results (64/64 and 150/150 subjects agreeing on every population). Cypress's C2
validator has now run against a document we produced, which had never happened.

**Not established, and the honest statement of the bar.** Locked decision #2 asks for the loop to come
back **green**. It is red, for two reasons that are now precisely known and neither of which is our
calculation: a measure-identity lineage our export deliberately will not fake, and supplemental data we
do not carry. A green C2 needs either a QDM-lineage reporting path (a real decision, not a patch — it
would mean reporting an identity for logic we did not execute, or vendoring the QDM artifacts and
executing those) or Cypress bundles in the FHIR lineage, which CMS does not yet publish for C2.

## 6. Reproducing

```powershell
# 1. Oracle + archive: scripts/cvu/README.md §"The Calculation Check (C2) comparison"
# 2. The loop, through the product API:
corepack pnpm --dir backend-ts exec tsx ../scripts/cvu/c2-submit.ts `
  --docs ../cvu-workdir/c2/passB/CMS125v14 --measure cms125 --eval 2024-12-31 `
  --out ../cvu-workdir/c2/submission `
  --assert-measure DBD9ECCD-C3EA-42DB-9344-72AD44F84F51 `
  --assert-measure 19783C1B-4FD1-46C1-8A96-A2F192B97EE0
# 3. Submit to the C2 task and print the verdict: scripts/cvu/c2/submit.rb (inside the container)
```

`--assert-measure` is required and is the lineage problem showing up on the way IN as well: the route
refuses a submission whose documents reference a measure identity it does not recognise, and a QDM-lineage
QRDA of a measure we hold as FHIR is exactly that. The assertion is recorded in every outcome's evidence,
so a later reader sees that a human claimed the mapping rather than the system deriving it.
