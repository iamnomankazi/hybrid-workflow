import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolationWarnings } from '../../src/cli/commands/result.mjs';

test('isolationWarnings flags MCP calls, codex_apps exposure and a skills catalog', () => {
  const clean = {
    events: { mcp_tool_calls: 0 },
    provenance: { observed_isolation: { skills_catalog_present: false, apps_present: false, global_instructions_present: true } },
  };
  assert.deepEqual(isolationWarnings(clean), [], 'pinned global instructions are a known limitation, not a warning');
  assert.deepEqual(isolationWarnings({
    events: { mcp_tool_calls: 1 },
    provenance: { observed_isolation: { skills_catalog_present: true, apps_present: true } },
  }), ['1 MCP tool call(s)', 'codex_apps MCP exposed', 'skills catalog present']);
  assert.deepEqual(isolationWarnings({ events: null, provenance: null }), [], 'results of attempts that never ran');
  assert.deepEqual(isolationWarnings({
    events: { mcp_tool_calls: 0 },
    provenance: { observed_isolation: { skills_catalog_present: false, global_instructions_present: null } },
  }), [], 'results written before apps_present existed');
});
