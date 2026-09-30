# Vendored EvoOntology core (MIT)

Source: https://github.com/ruc-datalab/EvoOntology (commit 6201f3d, 2026-09-23), package `evoontology/` only
(stdlib-only, Python >= 3.10). lca starts its semantic MCP server with

    python3 framework/vendor/evoontology/evoontology/runtime/mcp_server.py --store <workspace>

and exposes only `browse_semantics` / `resolve_semantics` to the `data-analyst` agent (the lifecycle/evolution
tools are hidden via agent permissions). Upstream LICENSE is kept next to this file. Update by re-copying the
package directory; no local modifications.
