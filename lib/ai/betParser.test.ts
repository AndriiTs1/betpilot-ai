import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractBetTool,
  rejectBetTool,
  extractSingleBetFromImageTool,
  extractParlayBetFromImageTool,
  extractExpressBetTool,
} from "./betParser";

// Regression test for a real production incident (Stage 12, Phase 3
// hotfix): Anthropic's strict-mode tool schema only supports `minItems`
// values of 0 or 1 on an array property. A value >1 (used here for "at
// least 2 selections") doesn't just get ignored — it makes the *entire*
// client.beta.messages.create() call fail with a 400 before any tool is
// even selected, breaking every tool in the same `tools` array, including
// unrelated ones like extract_bet. Confirmed against real production logs:
//   tools.1.custom: For 'array' type, 'minItems' values other than 0 or 1
//   are not supported (got: [2, 5])
//
// This walks every exported BetaTool's input_schema recursively and fails
// if any array-typed node still has a numeric minItems above 1 — so this
// exact mistake can't silently come back in a future tool.

const ALL_TOOLS = [
  extractBetTool,
  rejectBetTool,
  extractSingleBetFromImageTool,
  extractParlayBetFromImageTool,
  extractExpressBetTool,
];

function findUnsupportedMinItems(node: unknown, path: string, violations: string[]): void {
  if (typeof node !== "object" || node === null) return;

  if (Array.isArray(node)) {
    node.forEach((item, index) => findUnsupportedMinItems(item, `${path}[${index}]`, violations));
    return;
  }

  const record = node as Record<string, unknown>;

  if (typeof record.minItems === "number" && record.minItems > 1) {
    violations.push(`${path}.minItems = ${record.minItems}`);
  }

  for (const [key, value] of Object.entries(record)) {
    findUnsupportedMinItems(value, `${path}.${key}`, violations);
  }
}

test("betParser: no exported Anthropic tool schema uses an unsupported minItems > 1", () => {
  for (const tool of ALL_TOOLS) {
    const violations: string[] = [];
    findUnsupportedMinItems(tool.input_schema, tool.name, violations);
    assert.deepEqual(violations, [], `${tool.name} has unsupported minItems: ${violations.join(", ")}`);
  }
});

test("betParser: every tool schema is still well-formed (has a name and input_schema)", () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.input_schema, "object");
  }
});
