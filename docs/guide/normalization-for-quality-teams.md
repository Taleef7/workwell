# From the clinic EHR to a quality result

**Audience:** nurses, quality leaders, clinical informaticists, and implementation teams.

This diagram shows how clinical records move from the clinic's EHR to a quality result. WorkWell calls the preparation handoff **normalization**.

```mermaid
sequenceDiagram
    actor NP as Quality coordinator
    participant WW as WorkWell run pipeline
    participant EHR as Clinic EHR / WebChart
    participant N as WorkWell normalization
    participant ME as Clinical measure engine
    participant QR as Quality results

    NP->>WW: Start a quality-measure run
    Note over WW,EHR: Live-EHR deployments only; the demo and the sandbox evaluate a synthetic roster instead
    WW->>EHR: Request patient and clinical records
    EHR-->>WW: Return FHIR records<br/>(Patient, Observation, Procedure, etc.)
    WW->>N: Prepare (normalize) the records
    N-->>WW: One consistent FHIR record per patient
    WW->>ME: Evaluate one patient record

    ME->>ME: Apply the clinical measure logic
    ME-->>WW: Return the result and supporting evidence
    WW->>QR: Save the result and audit history

    NP->>QR: Review patient or population results
    QR-->>NP: Show the status and the evidence behind it
```

The EHR provides the clinical records, normalization prepares them for evaluation, and the clinical measure engine determines the quality result.
