import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openPortiaDatabase } from "../src/db.ts";
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

function settings(projectRoot, dbPath) {
  return {
    enabled: true,
    dbPath,
    writePolicy: "confirm",
    workerWritePolicy: "readonly",
    effectiveWritePolicy: "confirm",
    maxSenseResults: 12,
    enableDependencyScan: true,
    enableFts: true,
    enableVectors: false,
    autoPromptGuidance: true,
    projectRoot,
    globalSettingsPath: path.join(projectRoot, "global-settings.json"),
    projectSettingsPath: path.join(projectRoot, ".pi", "settings.json"),
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
