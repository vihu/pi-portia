import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildAutopilotContext, extractPromptPathCandidates, renderAutopilotGuidance, selectAutopilotTarget } from "../src/autopilot.ts";
import { resolvePortiaSettings } from "../src/config.ts";
import { openPortiaDatabase } from "../src/db.ts";
import { recordPortiaMemory } from "../src/record.ts";
import { senseMemories } from "../src/retrieval.ts";

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-portia-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  return dir;
}

function insertMemory(dbPath, overrides = {}) {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const row = {
    id: overrides.id ?? `mem-${Math.random().toString(16).slice(2)}`,
    scope_path: overrides.scope_path ?? ".",
    kind: overrides.kind ?? "gotcha",
    title: overrides.title ?? null,
    body: overrides.body ?? "fixture body",
    status: overrides.status ?? "active",
    importance: overrides.importance ?? 0,
    confidence: overrides.confidence ?? 100,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    created_by: overrides.created_by ?? "test",
    supersedes_id: overrides.supersedes_id ?? null,
    source_type: overrides.source_type ?? "test",
    source_ref: overrides.source_ref ?? "fixture",
  };

  db.prepare(`
    insert into memories (
      id, scope_path, kind, title, body, status, importance, confidence,
      created_at, updated_at, created_by, supersedes_id, source_type, source_ref
    ) values (
      @id, @scope_path, @kind, @title, @body, @status, @importance, @confidence,
      @created_at, @updated_at, @created_by, @supersedes_id, @source_type, @source_ref
    )
  `).run(row);
  db.close();
  return row;
}

function settings(projectRoot, dbPath, overrides = {}) {
  const writePolicy = overrides.writePolicy ?? "confirm";
  return {
    enabled: true,
    dbPath,
    writePolicy,
    workerWritePolicy: "readonly",
    effectiveWritePolicy: overrides.effectiveWritePolicy ?? writePolicy,
    maxSenseResults: 12,
    enableDependencyScan: true,
    enableFts: true,
    enableVectors: false,
    autoPromptGuidance: true,
    autoRecordGuidance: true,
    autoSense: true,
    autoSenseMaxResults: 5,
    autoSenseMaxChars: 2500,
    projectRoot,
    globalSettingsPath: path.join(projectRoot, "global-settings.json"),
    projectSettingsPath: path.join(projectRoot, ".pi", "settings.json"),
    ...overrides,
  };
}

test("openPortiaDatabase creates schema and FTS search works", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");

  const db = openPortiaDatabase(dbPath);
  try {
    const stats = db.getStats();
    assert.equal(stats.schemaVersion, 1);
    assert.equal(stats.ftsAvailable, true);
    assert.equal(stats.totalMemories, 0);
  } finally {
    db.close();
  }

  insertMemory(dbPath, {
    id: "auth-gotcha",
    scope_path: "src/auth",
    kind: "gotcha",
    body: "Login tests require seeded auth fixtures before changing token expiry.",
    importance: 5,
  });

  const reopened = openPortiaDatabase(dbPath);
  try {
    assert.equal(reopened.getStats().activeMemories, 1);
    assert.equal(reopened.getActiveMemoriesByScopes(["src/auth"]).at(0)?.id, "auth-gotcha");
    assert.equal(reopened.searchActiveMemories('"fixtures"', 10).at(0)?.id, "auth-gotcha");
  } finally {
    reopened.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("senseMemories ranks proximity, dependency, and FTS memories", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.join(project, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(project, "src", "db"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "auth", "session.ts"), "import { db } from '../db/client';\nexport const token = db;\n");
  fs.writeFileSync(path.join(project, "src", "db", "client.ts"), "export const db = {};\n");

  const db = openPortiaDatabase(dbPath);
  db.close();

  insertMemory(dbPath, {
    id: "auth-invariant",
    scope_path: "src/auth",
    kind: "invariant",
    body: "Read tests/auth/session.test.ts before changing token expiry behavior.",
    importance: 4,
  });
  insertMemory(dbPath, {
    id: "db-gotcha",
    scope_path: "src/db",
    kind: "gotcha",
    body: "Auth integration tests require seeded database fixtures.",
    importance: 3,
  });

  const reopened = openPortiaDatabase(dbPath);
  try {
    const result = senseMemories(reopened, settings(project, dbPath), {
      path: "src/auth/session.ts",
      query: "database fixtures",
    }, project);

    assert.deepEqual(new Set(result.memories.map((memory) => memory.id)), new Set(["auth-invariant", "db-gotcha"]));
    assert.equal(result.signals.some((signal) => signal.type === "proximity" && signal.scopePath === "src/auth"), true);
    assert.equal(result.signals.some((signal) => signal.type === "dependency" && signal.scopePath === "src/db"), true);
    assert.equal(result.signals.some((signal) => signal.type === "chord"), true);
  } finally {
    reopened.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("recordPortiaMemory writes memory, event, and searchable FTS when policy is write", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  try {
    const result = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      scopePath: "src/auth",
      kind: "decision",
      title: "Token compaction decision",
      body: "Use Portia records to preserve durable project decisions after compaction resumes a session.",
      importance: 7,
      confidence: 95,
      sourceType: "observation",
      sourceRef: "abc123def456",
      evidence: "Synthetic observation id used by this test to verify provenance payloads.",
    }, project);

    assert.equal(result.written, true);
    assert.equal(result.memory?.scopePath, "src/auth");
    assert.equal(result.memory?.kind, "decision");
    assert.equal(result.memory?.sourceType, "observation");
    assert.equal(result.memory?.sourceRef, "abc123def456");
    assert.equal(result.event?.eventType, "created");
    assert.equal(db.getStats().activeMemories, 1);
    assert.equal(db.searchActiveMemories('"compaction"', 10).at(0)?.id, result.memory?.id);

    const events = db.getMemoryEvents(result.memory.id);
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].payloadJson);
    assert.equal(payload.action, "record");
    assert.equal(payload.proposal.sourceType, "observation");
    assert.equal(payload.evidence, "Synthetic observation id used by this test to verify provenance payloads.");
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("recordPortiaMemory returns proposals without writing in readonly and confirm policies", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);
  const input = {
    scopePath: ".",
    kind: "gotcha",
    title: "Readonly proposal",
    body: "Readonly and confirm policies should return structured proposals without durable memory writes.",
    sourceType: "command",
    sourceRef: "node --test",
  };

  try {
    const readonly = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "readonly",
      modeOverride: "readonly",
    }), input, project);
    assert.equal(readonly.written, false);
    assert.equal(readonly.skipReason, "readonly");
    assert.equal(readonly.proposal.scopePath, ".");
    assert.equal(db.getStats().activeMemories, 0);

    const confirm = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "confirm",
      effectiveWritePolicy: "confirm",
    }), input, project);
    assert.equal(confirm.written, false);
    assert.equal(confirm.skipReason, "confirm");
    assert.equal(db.getStats().activeMemories, 0);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("autopilot target selection finds project paths and falls back to root", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.join(project, "src", "db"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "db", "client.ts"), "export const db = {};\n");

  try {
    assert.deepEqual(extractPromptPathCandidates("Please inspect @src/db/client.ts, then ignore A1/A2"), ["src/db/client.ts", "A1/A2"]);

    const target = selectAutopilotTarget(settings(project, dbPath), "Please inspect @src/db/client.ts, then ignore A1/A2", project);
    assert.equal(target.path, "src/db/client.ts");
    assert.equal(target.includeDependencies, true);
    assert.equal(target.matchedPromptPath, "src/db/client.ts");

    const fallback = selectAutopilotTarget(settings(project, dbPath), "What should I know next?", project);
    assert.equal(fallback.path, ".");
    assert.equal(fallback.includeDependencies, false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("autopilot guidance reflects write policy and can omit record guidance", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");

  try {
    const writeGuidance = renderAutopilotGuidance(settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }));
    assert.match(writeGuidance, /Portia project memory autopilot/);
    assert.match(writeGuidance, /record durable memories without asking/);

    const noRecordGuidance = renderAutopilotGuidance(settings(project, dbPath, {
      autoRecordGuidance: false,
    }));
    assert.doesNotMatch(noRecordGuidance, /portia_record/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("autopilot context renders a bounded Portia Project Context pack", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "db.ts"), "export const schema = 'memory_fts';\n");

  const db = openPortiaDatabase(dbPath);
  db.close();
  insertMemory(dbPath, {
    id: "fts-trigger-gotcha",
    scope_path: "src/db.ts",
    kind: "gotcha",
    title: "FTS trigger maintenance",
    body: "memory_fts is maintained by SQLite triggers; inspect src/db.ts before changing schema writes.",
    importance: 8,
  });

  const reopened = openPortiaDatabase(dbPath);
  try {
    const context = buildAutopilotContext(reopened, settings(project, dbPath, {
      autoSenseMaxResults: 2,
      autoSenseMaxChars: 500,
    }), "Before editing src/db.ts, what about memory_fts triggers?", project);

    assert.match(context, /## Portia Project Context/);
    assert.match(context, /fts-trigger-gotcha/);
    assert.match(context, /Verify source before relying/);
    assert.equal(context.length <= 500, true);
  } finally {
    reopened.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("resolvePortiaSettings parses autopilot settings and caps auto sense limits", () => {
  const project = tempProject();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-portia-agent-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      portia: {
        autoPromptGuidance: false,
        autoRecordGuidance: false,
        autoSense: false,
        autoSenseMaxResults: 99,
        autoSenseMaxChars: 99_999,
      },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const resolved = resolvePortiaSettings(project);
    assert.equal(resolved.autoPromptGuidance, false);
    assert.equal(resolved.autoRecordGuidance, false);
    assert.equal(resolved.autoSense, false);
    assert.equal(resolved.autoSenseMaxResults, 12);
    assert.equal(resolved.autoSenseMaxChars, 12_000);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("PORTIA_MODE=readonly overrides configured write policy", () => {
  const project = tempProject();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-portia-agent-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldPortiaMode = process.env.PORTIA_MODE;

  try {
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      portia: {
        writePolicy: "write",
      },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PORTIA_MODE = "readonly";

    const resolved = resolvePortiaSettings(project);
    assert.equal(resolved.writePolicy, "write");
    assert.equal(resolved.effectiveWritePolicy, "readonly");
    assert.equal(resolved.modeOverride, "readonly");
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldPortiaMode === undefined) delete process.env.PORTIA_MODE;
    else process.env.PORTIA_MODE = oldPortiaMode;
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
