# From the clinic EHR to a quality result

**Audience:** nurses, quality leaders, clinical informaticists, and implementation teams.

This diagram shows how clinical records move from the clinic's EHR to a quality result. WorkWell calls the preparation handoff **normalization**.

```mermaid
sequenceDiagram
    actor NP as Quality nurse practitioner
    participant WW as WorkWell run pipeline
    participant EHR as Clinic EHR / WebChart
    participant N as WorkWell normalization
    participant ME as Clinical measure engine
    participant QR as Quality results

    NP->>WW: Start a quality-measure run
    WW->>EHR: Request patient and clinical records
    EHR-->>WW: Return FHIR records<br/>(Patient, Observation, Procedure, etc.)
    WW->>N: Prepare the records for evaluation
    N-->>ME: Send a consistent FHIR patient record

    ME->>ME: Apply the clinical measure logic
    ME-->>WW: Return the result and supporting evidence
    WW->>QR: Save the result and audit history

    NP->>QR: Review patient or population results
    QR-->>NP: Show the status and the evidence behind it
```

The EHR provides the clinical records, normalization prepares them for evaluation, and the clinical measure engine determines the quality result.
