import test from "node:test";
import assert from "node:assert/strict";
import { PortiaDoctorParams, registerPortiaDoctorTool } from "../src/tools/doctor.ts";
import { PortiaInspectParams, registerPortiaInspectTool } from "../src/tools/inspect.ts";
import { PortiaListParams, registerPortiaListTool } from "../src/tools/list.ts";
import { PortiaRecordParams, registerPortiaRecordTool } from "../src/tools/record.ts";
import { PortiaRepairParams, registerPortiaRepairTool } from "../src/tools/repair.ts";
import { PortiaSearchParams, registerPortiaSearchTool } from "../src/tools/search.ts";
import { PortiaSenseParams, registerPortiaSenseTool } from "../src/tools/sense.ts";

function captureRegisteredTools(registerTools) {
  const tools = [];
  const pi = {
    registerTool(tool) {
      tools.push(tool);
    },
  };
  for (const registerTool of registerTools) registerTool(pi);
  return tools;
}

function enumValues(schema) {
  return schema.anyOf?.map((option) => option.const).filter(Boolean) ?? [];
}

test("Portia tool registrations expose expected names, handlers, and schemas", () => {
  const tools = captureRegisteredTools([
    registerPortiaSenseTool,
    registerPortiaRecordTool,
    registerPortiaListTool,
    registerPortiaDoctorTool,
    registerPortiaSearchTool,
    registerPortiaInspectTool,
    registerPortiaRepairTool,
  ]);

  assert.deepEqual(tools.map((tool) => tool.name), [
    "portia_sense",
    "portia_record",
    "portia_list",
    "portia_doctor",
    "portia_search",
    "portia_inspect",
    "portia_repair",
  ]);

  const expectedParameters = {
    portia_sense: PortiaSenseParams,
    portia_record: PortiaRecordParams,
    portia_list: PortiaListParams,
    portia_doctor: PortiaDoctorParams,
    portia_search: PortiaSearchParams,
    portia_inspect: PortiaInspectParams,
    portia_repair: PortiaRepairParams,
  };

  for (const tool of tools) {
    assert.equal(typeof tool.execute, "function", tool.name);
    assert.equal(tool.parameters, expectedParameters[tool.name], tool.name);
    assert.equal(Array.isArray(tool.promptGuidelines), true, tool.name);
    assert.equal(tool.promptGuidelines.length > 0, true, tool.name);
  }
});

test("Portia browse/search schemas include pagination and safe filter options", () => {
  assert.deepEqual(PortiaSearchParams.required, ["query"]);
  assert.equal(PortiaSearchParams.properties.query.type, "string");
  assert.equal(PortiaSearchParams.properties.cursor.type, "string");
  assert.equal(PortiaSearchParams.properties.limit.type, "number");
  assert.deepEqual(enumValues(PortiaSearchParams.properties.matchMode), ["all", "any", "phrase"]);
  assert.deepEqual(enumValues(PortiaSearchParams.properties.orderBy), ["relevance", "updated", "importance"]);

  assert.equal(PortiaListParams.properties.cursor.type, "string");
  assert.equal(PortiaListParams.properties.limit.type, "number");
  assert.deepEqual(enumValues(PortiaListParams.properties.status), ["active", "stale", "superseded", "deleted", "any"]);
  assert.deepEqual(enumValues(PortiaListParams.properties.kind), ["purpose", "pointer", "invariant", "gotcha", "decision", "pattern", "plan"]);
});

test("maintenance tool guidance stays aligned with v1 command scope", () => {
  const [doctor] = captureRegisteredTools([registerPortiaDoctorTool]);
  const guidance = doctor.promptGuidelines.join("\n");

  assert.match(guidance, /read-only/);
  assert.match(guidance, /portia-reindex/);
  assert.doesNotMatch(guidance, /export|import|backup/i);
  assert.deepEqual(PortiaDoctorParams.required ?? [], []);
});
