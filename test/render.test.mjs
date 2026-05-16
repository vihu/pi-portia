import test from "node:test";
import assert from "node:assert/strict";
import { renderMemoryList, renderRecord, renderRepair, renderSearch, renderStatus } from "../src/render.ts";

const memory = {
  rowid: 1,
  id: "mem-render-1",
  scopePath: "src/render.ts",
  kind: "decision",
  title: "Renderer fixture",
  body: "Renderer output should remain compact and include page metadata.",
  status: "active",
  importance: 7,
  confidence: 95,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  createdBy: "test",
  sourceType: "file",
  sourceRef: "src/render.ts",
};

const settings = {
  enabled: true,
  dbPath: ".pi/portia/portia.sqlite",
  writePolicy: "confirm",
  workerWritePolicy: "readonly",
  effectiveWritePolicy: "confirm",
  maxSenseResults: 12,
  searchDefaultLimit: 30,
  searchMaxResults: 250,
  listDefaultLimit: 30,
  listMaxResults: 250,
  enableDependencyScan: true,
  enableFts: true,
  enableVectors: false,
  autoPromptGuidance: true,
  autoRecordGuidance: true,
  autoSense: true,
  autoSenseMaxResults: 5,
  autoSenseMaxChars: 2500,
  enablePheromones: true,
  pheromoneRanking: true,
  pheromoneHalfLifeDays: 30,
  pheromoneMaxBoost: 25,
  pheromoneFollowWeight: 1,
  pheromoneSuccessWeight: 2,
  pheromoneFailureWeight: -0.4,
  pheromoneIgnoredWeight: 0,
  pheromoneWorkerPolicy: "off",
  traceRetentionDays: 180,
  projectRoot: "/tmp/project",
  globalSettingsPath: "/tmp/global-settings.json",
  projectSettingsPath: "/tmp/project/.pi/settings.json",
};

test("renderMemoryList and renderSearch include pagination hints without object noise", () => {
  const listOutput = renderMemoryList({
    projectRoot: "/tmp/project",
    dbPath: "/tmp/project/.pi/portia/portia.sqlite",
    filters: {
      status: "active",
      scopePath: "src",
      kind: "decision",
      query: "renderer",
      limit: 1,
      cursor: "previous-cursor",
    },
    memories: [memory],
    page: { limit: 1, hasMore: true, nextCursor: "next-list-cursor" },
    warnings: ["Requested limit was capped."],
  });

  assert.match(listOutput, /^# Portia List/);
  assert.match(listOutput, /\[mem-render-1\] active decision src\/render\.ts/);
  assert.match(listOutput, /- nextCursor: next-list-cursor/);
  assert.match(listOutput, /cursor usage: repeat the same filters/);
  assert.doesNotMatch(listOutput, /\[object Object\]/);

  const searchOutput = renderSearch({
    projectRoot: "/tmp/project",
    dbPath: "/tmp/project/.pi/portia/portia.sqlite",
    filters: {
      query: "renderer",
      status: "active",
      scopePath: "src",
      scopeMode: "subtree",
      kind: "decision",
      orderBy: "relevance",
      matchMode: "all",
      includeSubstringFallback: true,
      limit: 1,
      cursor: "previous-cursor",
    },
    hits: [{ memory, matchType: "fts", score: -1.2345, snippet: "Renderer <b>fixture</b> match" }],
    page: { limit: 1, hasMore: true, nextCursor: "next-search-cursor" },
    warnings: [],
  });

  assert.match(searchOutput, /^# Portia Search/);
  assert.match(searchOutput, /Query: renderer/);
  assert.match(searchOutput, /match=fts/);
  assert.match(searchOutput, /score=-1\.234/);
  assert.match(searchOutput, /snippet: Renderer <b>fixture<\/b> match/);
  assert.match(searchOutput, /cursor usage: repeat the same query and filters/);
  assert.doesNotMatch(searchOutput, /\[object Object\]/);
});

test("renderRecord and renderRepair keep proposal-only guidance visible", () => {
  const recordOutput = renderRecord({
    projectRoot: "/tmp/project",
    dbPath: "/tmp/project/.pi/portia/portia.sqlite",
    writePolicy: "confirm",
    written: false,
    skipReason: "confirm",
    proposal: {
      scopePath: "src/render.ts",
      kind: "decision",
      title: "Renderer proposal",
      body: "Renderers should make proposal-only status obvious.",
      importance: 6,
      confidence: 90,
      sourceType: "file",
      sourceRef: "test/render.test.mjs",
      evidence: "unit test",
      duplicatePolicy: "blockExact",
    },
    warnings: [],
    relatedMemories: [memory],
  });

  assert.match(recordOutput, /# Portia Record/);
  assert.match(recordOutput, /Status: proposal-only/);
  assert.match(recordOutput, /confirm policy currently returns a proposal/);
  assert.match(recordOutput, /This is a structured proposal only/);
  assert.match(recordOutput, /Related Active Memories/);
  assert.doesNotMatch(recordOutput, /\[object Object\]/);

  const repairOutput = renderRepair({
    projectRoot: "/tmp/project",
    dbPath: "/tmp/project/.pi/portia/portia.sqlite",
    writePolicy: "readonly",
    written: false,
    skipReason: "readonly",
    proposal: {
      id: "mem-render-1",
      action: "stale",
      targetStatus: "stale",
      currentStatus: "active",
      reason: "Renderer proposal should include audit reason.",
      sourceType: "manual",
      sourceRef: "test",
      evidence: "verified stale fixture",
    },
    warnings: [],
  });

  assert.match(repairOutput, /# Portia Repair/);
  assert.match(repairOutput, /Status: proposal-only/);
  assert.match(repairOutput, /Reason: readonly policy/);
  assert.match(repairOutput, /verified stale fixture/);
  assert.match(repairOutput, /This is a structured repair proposal only/);
  assert.doesNotMatch(repairOutput, /\[object Object\]/);
});

test("renderStatus exposes maintenance-relevant settings", () => {
  const statusOutput = renderStatus(settings, {
    dbPath: "/tmp/project/.pi/portia/portia.sqlite",
    schemaVersion: 3,
    totalMemories: 3,
    activeMemories: 2,
    staleMemories: 1,
    supersededMemories: 0,
    deletedMemories: 0,
    ftsAvailable: true,
    pheromoneTraceEvents: 4,
    pheromoneMemoryCount: 2,
    reinforcedMemories: 1,
    byKind: [{ kind: "decision", count: 2 }],
    topScopes: [{ scopePath: "src", count: 3 }],
  });

  assert.match(statusOutput, /^# Portia Status/);
  assert.match(statusOutput, /Schema: 3/);
  assert.match(statusOutput, /FTS: available/);
  assert.match(statusOutput, /Pheromone worker policy: off/);
  assert.match(statusOutput, /- active: 2/);
  assert.doesNotMatch(statusOutput, /\[object Object\]/);
});
