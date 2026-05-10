# WorkWell MCP

WorkWell exposes a read-only MCP surface for programmatic inspection of cases, runs, measures, measure versions, and structured outcome explanations.

## Security boundary

- `/sse` and `/mcp/**` are protected by Spring Security.
- MCP access is role-gated to `ROLE_ADMIN`, `ROLE_CASE_MANAGER`, or `ROLE_MCP_CLIENT`.
- There is no public MCP mode in production.
- MCP tool calls are audited as `MCP_TOOL_CALLED`.
- The audit actor comes from the authenticated security context, not a hardcoded transport identity.

## Tool posture

- MCP tools are read-only.
- Tool arguments are sanitized before audit persistence.
- Invalid tool arguments return safe errors and still generate audit records.
- MCP tools never decide compliance; CQL remains the source of truth.

## Operational notes

- `list_cases` and `get_case` are the primary case inspection tools.
- `get_run_summary`, `list_runs`, `list_measures`, `get_measure_version`, and `explain_outcome` expose the operational read surface.
- Any future MCP write surface must go through a separate security review and documentation update.
