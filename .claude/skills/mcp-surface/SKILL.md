---
name: mcp-surface
description: Work on WorkWell's own MCP server — the read-only tools the worker serves to Claude Desktop and other clients. Use when adding, changing, or reviewing a WorkWell MCP tool, or its security boundary and role gating.
---

# WorkWell's MCP surface

Read **`docs/MCP.md`** — security boundary, tool posture, tool inventory (v2.0.0), role matrix, and
schema examples. `docs/MCP_LOCAL.md` covers local wiring.

## Non-negotiable

- **Read-only.** The MCP tools served from the worker are read-only. A tool that mutates state does
  not belong on this surface.
- **AI never decides compliance** (`docs/AI_GUARDRAILS.md`, a `CLAUDE.md` hard rule). An MCP tool may
  report what the CQL engine computed; it may never compute or infer a compliance verdict itself.
- Respect the role matrix. `/api/identity/**` and anything exposing national IDs, MRNs, or DOB is
  CASE_MANAGER/ADMIN-gated — the MCP surface must not become a way around that.
- Every state change writes an `audit_event`. If a tool somehow needs to write, it audits.
