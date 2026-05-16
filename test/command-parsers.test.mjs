import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDeleteArgs,
  parseInspectArgs,
  parseListArgs,
  parseReindexArgs,
  parseRepairArgs,
  parseSenseArgs,
  parseTrailsArgs,
} from "../src/index.ts";

function assertUsageError(fn, pattern = /Usage:/) {
  assert.throws(fn, pattern);
}

test("slash command parsers cover common command syntax", () => {
  assert.deepEqual(parseSenseArgs(""), { path: "." });
  assert.deepEqual(parseSenseArgs("src/auth token expiry"), {
    path: "src/auth",
    query: "token expiry",
  });

  assert.deepEqual(parseListArgs("all scope src/auth kind gotcha limit 50 cursor abc query token expiry"), {
    status: "any",
    scopePath: "src/auth",
    kind: "gotcha",
    limit: 50,
    cursor: "abc",
    query: "token expiry",
  });
  assert.deepEqual(parseListArgs("deleted query stale fact"), {
    status: "deleted",
    query: "stale fact",
  });

  assert.deepEqual(parseInspectArgs(" mem-1 "), { id: "mem-1", includeEvents: true });
  assert.deepEqual(parseRepairArgs("mem-1 stale superseded by new plan"), {
    id: "mem-1",
    action: "stale",
    reason: "superseded by new plan",
  });
  assert.deepEqual(parseDeleteArgs("mem-1 temporary fixture memory"), {
    id: "mem-1",
    action: "delete",
    reason: "temporary fixture memory",
    sourceType: "command",
    sourceRef: "/portia-delete",
  });

  assert.deepEqual(parseReindexArgs(""), {});
  assert.deepEqual(parseReindexArgs("preview"), { dryRun: true });
  assert.deepEqual(parseReindexArgs("--dry-run"), { dryRun: true });

  assert.deepEqual(parseTrailsArgs(""), {});
  assert.deepEqual(parseTrailsArgs("recent 12"), { mode: "recent", limit: 12 });
  assert.deepEqual(parseTrailsArgs("memory mem-1 8"), { mode: "memory", memoryId: "mem-1", limit: 8 });
  assert.deepEqual(parseTrailsArgs("25"), { limit: 25 });
});

test("slash command parsers produce usage errors for malformed commands", () => {
  assertUsageError(() => parseListArgs("scope"), /\/portia-list scope/);
  assertUsageError(() => parseListArgs("query"), /\/portia-list query/);
  assertUsageError(() => parseListArgs("limit nope"), /\/portia-list limit/);
  assertUsageError(() => parseInspectArgs("  "), /\/portia-inspect/);
  assertUsageError(() => parseRepairArgs("mem-1 stale"), /\/portia-repair/);
  assertUsageError(() => parseDeleteArgs("mem-1"), /\/portia-delete/);
  assertUsageError(() => parseReindexArgs("apply now"), /\/portia-reindex/);
  assertUsageError(() => parseTrailsArgs("memory"), /\/portia-trails memory/);
  assertUsageError(() => parseTrailsArgs("unknown"), /\/portia-trails/);
});
