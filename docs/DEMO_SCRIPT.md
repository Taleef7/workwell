# WorkWell Measure Studio D16 Demo Script

## 1. Measure Studio Catalog
- Open the Measure Studio app.
- Navigate to **Measures**.
- Confirm the catalog includes:
  - **Audiogram** (Active, v1.0)
  - **TB Surveillance** (Active, v1.3)

## 2. Create a Draft Measure
- Click **Create Measure**.
- Enter a sample Name, Policy Ref, and Owner.
- Submit and confirm navigation to `/studio/[id]`.
- Highlight Draft badge and that authoring starts in Draft.

## 3. Audiogram Authoring Surface
- Open the **Audiogram** measure in Studio.
- Show **Spec** tab fields and save draft behavior.
- Switch to **CQL** tab and run **Compile**.
- Confirm compile status badge and lifecycle status in header.

## 4. Run Execution
- Navigate to **Runs**.
- Trigger **Run S1a Audiogram Vertical**.
- Show run summary and outcome distribution.

## 5. Worklist + Filters
- Navigate to **Cases**.
- Show default **Status = Open** view.
- Apply **Measure = Audiogram** filter and show filtered list.

## 6. Case Detail + Outreach
- Open an **Overdue** case.
- Show Why Flagged evidence and audit timeline.
- Click **Send outreach**.

## 7. Rerun-to-Verify Closure
- On the same case detail page, click **Rerun to verify**.
- Confirm case transitions to **CLOSED**.
- Highlight audit timeline entries for outreach + verification + closure.

## 8. Audit Export
- Return to **Cases**.
- Click **Export CSV**.
- Confirm `audit-events.csv` downloads and contains the full chain.

## 9. MCP Layer 1 (if available in live demo)
- In Claude Desktop, connect to the MCP endpoint.
- Run: **\"Show me all open Audiogram cases\"**
- Run: **\"Get the summary of the latest run\"**
- Show structured responses from read-only tools.
