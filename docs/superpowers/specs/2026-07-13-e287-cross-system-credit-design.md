# Cross-system credit at the calculation level — design (#287)

**Status:** **Draft — pending owner review.** No code, no schema. Buildable against the synthetic
directory today (E15 shipped); gains real data via E12 PR-2c + #187 PR-3.
**Date:** 2026-07-13.
**The ask (Doug, 2026-06-24, verbatim):** *"You can do calculations and attribute patient even if they
came from two different EHR systems… If they are compliant anywhere, are they compliant everywhere?
When doing quality calculations, give everybody credit regardless of who did it."* (The
cardiologist-gives-the-flu-shot example.)

**Today this is display-only.** E15/ADR-022 resolves a person across systems and shows a merged,
system-tagged timeline — but by design it never re-aggregates. A person vaccinated in system A still
counts as non-compliant in system B's quality numbers, and still generates an outreach case there.

---

## 1. Two different things are being asked for. Separate them.

The phrase "compliant anywhere ⇒ compliant everywhere" can mean either of these, and they produce
**different numbers**:

| Lens | Denominator | Numerator | What it answers |
|---|---|---|---|
| **A. Record-scoped, credit-shared** *(this is Doug's ask)* | unchanged — every source record still counts in its own tenant | a record is COMPLIANT if **any linked record** of that person is COMPLIANT | *"What is system B's quality rate, giving credit for care delivered in system A?"* |
| **B. Person-scoped, deduplicated** | each **person** counted **once**, not once per system | best outcome across their records | *"What fraction of actual humans are compliant?"* |

Doug's sentence — *"give everybody credit regardless of who did it"* — is **Lens A**: it is about not
penalizing a system for care delivered elsewhere. Lens B is a different (also useful) question about
true population coverage, and it is the one that changes the denominator.

**Recommendation: build Lens A first**, because (a) it is literally what was asked, (b) it is the one
with an operational payoff (§5), and (c) **it preserves `All = Σ tenants`** — each record still belongs
to exactly one tenant, so the rollup arithmetic (ADR-019) is untouched; only the numerator moves. Lens B
breaks that invariant by construction (a person spanning two tenants can no longer be summed twice) and
therefore needs its own root, not a re-count of the existing one. Ship B later, explicitly labeled, if
wanted.

---

## 2. The credit rule — precedence, stated exactly

Given a person's linked records and one measure, the credited outcome for **every** record of that
person is the highest-precedence outcome any of them holds:

```
COMPLIANT  >  EXCLUDED  >  DUE_SOON  >  OVERDUE  >  MISSING_DATA
```

- **COMPLIANT wins outright** — that is the whole ask.
- **EXCLUDED propagates** (above the non-compliant buckets, below COMPLIANT). A contraindication or
  waiver is a property of the *person*, not of the system that recorded it: if system A has a
  documented contraindication, system B must not keep chasing them. But an actual completed
  vaccination (COMPLIANT) still outranks an exclusion — a person who *got* the shot is compliant, not
  excused from it.
- **DUE_SOON > OVERDUE > MISSING_DATA** — the least-alarming true state wins, since a more recent
  event in another system is genuinely better information than an older one here.

**This selects among CQL-decided outcomes. It never re-derives one.** No new status is invented, no
CQL is re-run, no stored `outcomes.status` is mutated. ADR-008 holds by construction.

### The trap: only combine outcomes that answer the same question

Two records' outcomes are comparable **only if** they share the **measure id** *and* the **evaluation
period** (`bucketPeriodForMeasure`), and were evaluated as-of the same date. Otherwise "credit" would
silently import a stale answer:

> An audiogram in system A dated 400 days ago evaluated in *last year's* period was COMPLIANT then.
> Crediting that bucket into *this* period's numbers would mark an overdue employee compliant. The
> bucket is a function of the evaluation date; it is not a durable fact.

So the join key is **(person, measure_id, evaluation_period)** — the same key case idempotency already
uses — and only outcomes from the **latest population run per measure** (the existing `latestRunRows`
reduction) participate. This is a hard correctness rule, not a nicety.

### RECURRING vs PERMANENT (open question 1 in the issue — answered)

**Both.** Doug's own example (a flu shot given by a cardiologist) is a RECURRING measure, so restricting
credit to PERMANENT series-completion measures would fail the very case he raised. The period-matching
rule above is exactly what makes RECURRING credit safe: an outcome only carries credit *within the
period it was computed for*.

---

## 3. Where it plugs in (read-time; no schema)

The credit rule is a **pure function over already-computed outcomes**, applied at read time in one
place, then consumed by every surface:

```
creditAcrossPersons(outcomes, people) → outcomes'      // pure; same rows, possibly upgraded status
```

- Input: the same `OutcomeWithRun[]` the roster / rollup / programs overview already load
  (`rollup-shared.ts` `latestRunRows`), plus `resolvePeople(directory)` from E15 (already
  override-aware: human CONFIRMED/BROKEN `person_links` reshape the grouping — ADR-022).
- Output: the same rows, with `status` upgraded per §2 where a linked record earned it, and an additive
  marker on the evidence (`creditedFrom: {tenantId, externalId, runId}`) so **every credited cell is
  traceable to the record that earned it**. A credited compliance that cannot be traced is an audit
  failure waiting to happen.
- **Opt-in, never the default:** `?resolution=person` on the roster / quality / programs endpoints. The
  per-tenant view stays the default so today's numbers do not silently change under anyone.

Surfaces, in build order (open question 2 — answered): **roster first** (it is where a case manager sees
"chase this person", and the credit visibly removes wasted work), then **programs/quality**, then the
`/people/[personId]` panel (which already shows the merged timeline and just needs the credited status
alongside it).

### Quality snapshots (open question 3 — answered: read-time only, for now)

Do **not** materialize a person-resolved scope into `quality_snapshots` yet. The table's key is
`(measure_id, period, scope_level, scope_id)`; adding a resolution dimension means either overloading
`scope_level` (hacky, and it would pollute the reconciliation invariant that `buildSnapshotRows` asserts)
or a DDL change. Read-time is fast enough for the live tenants (~2,100 rows) and costs nothing to revert.
Revisit only if a person-resolved *history* chart is actually wanted.

---

## 4. What this does NOT do

- It does **not** mutate `outcomes.status`. The stored CQL verdict per record is untouched; credit is a
  read-time lens. (Reversibility: delete the query param.)
- It does **not** re-aggregate tenants. `All = Σ tenants` (ADR-019) still holds — each record still
  belongs to one tenant; only its numerator membership can change.
- It does **not** auto-merge identities. Credit flows only across records E15 already groups — a shared
  national/MRN match key, or a **human-confirmed** `person_links` row — and never across a BROKEN link.
  Match-don't-auto-merge (ADR-022) is preserved. **This is the safety property that matters most:** a
  false identity match would now silently mark a *different human* compliant. Today it only mis-groups a
  timeline (embarrassing); with credit it mis-states compliance (dangerous). The doc for this feature
  must say plainly: **credit is only as trustworthy as the identity match beneath it**, which is exactly
  why the reconcile write path (#187 PR-2) is a human-in-the-loop action.

---

## 5. The operational payoff — and the one write-path decision

The real value is not a nicer percentage. It is **not chasing people who already got the shot.**

Today, a person vaccinated in system A gets an open case, an outreach email, and a spot on a case
manager's worklist in system B. With credit, that case should not exist.

That means a **write-path** question, and it is the only part of this design that changes state:

> **Should a credited-COMPLIANT outcome close the open case in the other system?**

**Recommendation: yes, but as an explicit, audited, opt-in Phase 2** — never a silent side effect of a
read lens. Concretely: the run pipeline's case upsert (`planCaseUpsert`) already has a
`closed_reason` vocabulary and a system-closure path; add `CROSS_SYSTEM_CREDIT` as a reason, gated on
the same opt-in flag, writing a `CASE_RESOLVED` audit event whose payload names the crediting record.
That satisfies the hard rule (every state change is audited) and keeps it fully reversible/inspectable.

**Phase 1 (this design) is read-only.** The case-closure write path is Phase 2, and needs its own owner
sign-off because it closes real work items.

---

## 6. Verification plan

1. **Golden:** the two seeded cross-system pairs in the synthetic directory (`emp-006` twh→ihn mobility;
   `emp-007`/`ihn-emp-002` duplicate) — assert a COMPLIANT in one system upgrades the linked record and
   **nothing else moves**.
2. **Invariant:** with `?resolution=person`, the rollup still reconciles `All = Σ tenants` (the existing
   guard test, re-run under the lens).
3. **ADR-008 guard:** stored `outcomes.status` is byte-identical before and after any credited read.
4. **Period safety:** an outcome from a *prior* period must never carry credit into the current one (the
   §2 trap) — a regression test with a deliberately stale outcome.
5. **BROKEN link:** a human-BROKEN `person_links` row must block credit between those two records.
6. **Precedence:** each pair in the §2 ordering, including COMPLIANT-beats-EXCLUDED.

---

## 7. Open questions for the owner

1. **Lens A only, or Lens B too?** (§1 — recommend A now, B later and separately labeled.)
2. **Is the Phase-2 case-closure write path wanted?** (§5 — it is where the actual operational saving
   is, and it closes real work items, so it needs an explicit yes.)
3. **Default-on or opt-in?** Recommend **opt-in** (`?resolution=person`) — flipping the default would
   silently change every quality number the demo has ever shown, mid-conversation with MIE.
