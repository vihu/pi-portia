import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildAutopilotContext, extractPromptPathCandidates, renderAutopilotGuidance, selectAutopilotTarget } from "../src/autopilot.ts";
import { resolvePortiaSettings } from "../src/config.ts";
import { openPortiaDatabase } from "../src/db.ts";
import { inspectPortiaMemory } from "../src/inspect.ts";
import { listPortiaMemories } from "../src/list.ts";
import { addSenseExposures, createPheromoneTraceState, flushPheromoneTraceState, observeToolCall, observeToolResult, shouldWritePheromones } from "../src/pheromones.ts";
import { recordPortiaMemory } from "../src/record.ts";
import { repairPortiaMemory } from "../src/repair.ts";
import { senseMemories } from "../src/retrieval.ts";
import { buildSafeFtsQuery, buildSearchTerms, parsePlainSearchTerms } from "../src/search.ts";
import { listPortiaTrails } from "../src/trails.ts";

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
    assert.equal(stats.schemaVersion, 3);
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

test("schema v3 migrates FTS metadata and generated search terms", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const legacy = new Database(dbPath);
  legacy.exec(`
    create table portia_meta (key text primary key, value text not null);
    insert into portia_meta(key, value) values ('schema_version', '2');

    create table memories (
      id text primary key,
      scope_path text not null,
      kind text not null,
      title text,
      body text not null,
      status text not null default 'active',
      importance integer not null default 0,
      confidence integer not null default 100,
      created_at text not null,
      updated_at text not null,
      created_by text,
      supersedes_id text references memories(id),
      source_type text,
      source_ref text
    );

    create virtual table memory_fts using fts5(
      title,
      body,
      scope_path,
      kind,
      content='memories',
      content_rowid='rowid'
    );
  `);
  legacy.prepare(`
    insert into memories (
      id, scope_path, kind, title, body, status, importance, confidence,
      created_at, updated_at, created_by, supersedes_id, source_type, source_ref
    ) values (
      'legacy-search', 'src/config.ts', 'gotcha', 'Legacy search metadata',
      'Changing maxSenseResults must be searchable by component words.',
      'active', 5, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      'test', null, 'manual', 'docs/LegacyNote.md'
    )
  `).run();
  legacy.close();

  const migrated = openPortiaDatabase(dbPath);
  try {
    assert.equal(migrated.getStats().schemaVersion, 3);

    for (const rawQuery of ["max sense results", "manual", "legacy note"]) {
      const built = buildSafeFtsQuery(rawQuery);
      assert.equal(built.ok, true, rawQuery);
      if (!built.ok) continue;
      const results = migrated.searchActiveMemories(built.query.expression, 10);
      assert.equal(results.some((memory) => memory.id === "legacy-search"), true, rawQuery);
    }

    const created = migrated.createMemory({
      scopePath: "src/search.ts",
      kind: "gotcha",
      title: "Post-migration trigger fixture",
      body: "Changing newCamelIdentifier should be searchable after migration.",
      importance: 5,
      confidence: 100,
      sourceType: "test",
      sourceRef: "docs/NewMemoryNote.md",
    }).memory;

    for (const rawQuery of ["new camel identifier", "new memory note"]) {
      const built = buildSafeFtsQuery(rawQuery);
      assert.equal(built.ok, true, rawQuery);
      if (!built.ok) continue;
      const results = migrated.searchActiveMemories(built.query.expression, 10);
      assert.equal(results.some((memory) => memory.id === created.id), true, rawQuery);
    }
  } finally {
    migrated.close();
  }

  const inspected = new Database(dbPath);
  try {
    const memoryColumns = inspected.prepare("pragma table_info(memories)").all().map((row) => row.name);
    const ftsColumns = inspected.prepare("pragma table_info(memory_fts)").all().map((row) => row.name);
    assert.equal(memoryColumns.includes("search_terms"), true);
    assert.deepEqual(ftsColumns, ["title", "body", "scope_path", "kind", "source_type", "source_ref", "search_terms"]);
  } finally {
    inspected.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("safe FTS query builder quotes plain user input", () => {
  const searchTerms = buildSearchTerms({
    scopePath: "src/config.ts",
    kind: "gotcha",
    body: "Adjust maxSenseResults and SQL_ERROR handling.",
    sourceRef: "docs/LegacyNote.md",
  });
  assert.match(searchTerms, /\bmax\b/);
  assert.match(searchTerms, /\bsense\b/);
  assert.match(searchTerms, /\bresults\b/);
  assert.match(searchTerms, /\blegacy\b/);
  assert.match(searchTerms, /\bnote\b/);

  assert.deepEqual(parsePlainSearchTerms('alpha "beta gamma" delta'), ["alpha", "beta gamma", "delta"]);
  assert.deepEqual(parsePlainSearchTerms('/portia-list src/config.ts foo:bar'), ["/portia-list", "src/config.ts", "foo:bar"]);

  const all = buildSafeFtsQuery("alpha beta");
  assert.equal(all.ok, true);
  if (all.ok) assert.equal(all.query.expression, '"alpha" "beta"');

  const any = buildSafeFtsQuery("alpha beta", { matchMode: "any" });
  assert.equal(any.ok, true);
  if (any.ok) assert.equal(any.query.expression, '"alpha" OR "beta"');

  const phrase = buildSafeFtsQuery('alpha "beta"', { matchMode: "phrase" });
  assert.equal(phrase.ok, true);
  if (phrase.ok) assert.equal(phrase.query.expression, '"alpha ""beta"""');

  const empty = buildSafeFtsQuery("   ");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.reason, "empty");

  const tooLong = buildSafeFtsQuery("x".repeat(501));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error.reason, "too_long");
});

test("safe FTS query builder prevents malformed MATCH errors for code-like literals", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");

  const db = openPortiaDatabase(dbPath);
  db.close();

  insertMemory(dbPath, {
    id: "literal-search-fixture",
    scope_path: "src/config.ts",
    kind: "gotcha",
    title: "Literal /portia-list search fixture",
    body: 'Search for -6 /portia-list src/config.ts foo:bar v1.2 "quoted" AND OR NOT without raw FTS syntax errors.',
  });

  const reopened = openPortiaDatabase(dbPath);
  try {
    for (const rawQuery of ["-6", "/portia-list", "src/config.ts", "foo:bar", "v1.2", '"quoted"', "AND OR NOT"]) {
      const built = buildSafeFtsQuery(rawQuery);
      assert.equal(built.ok, true, rawQuery);
      if (!built.ok) continue;

      const results = reopened.searchActiveMemories(built.query.expression, 10);
      assert.equal(results.some((memory) => memory.id === "literal-search-fixture"), true, rawQuery);
    }
  } finally {
    reopened.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("searchMemoryHits applies weighted FTS filters and substring fallback", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  function runSearch(rawQuery, overrides = {}) {
    const built = buildSafeFtsQuery(rawQuery, { matchMode: overrides.matchMode });
    assert.equal(built.ok, true, rawQuery);
    if (!built.ok) return [];
    return db.searchMemoryHits({
      ftsQuery: built.query.expression,
      rawQuery: built.query.rawQuery,
      terms: built.query.terms,
      matchMode: built.query.matchMode,
      ...overrides,
    });
  }

  try {
    const titleHit = db.createMemory({
      scopePath: "src/auth",
      kind: "decision",
      title: "Token search policy",
      body: "Prefer the title result when ranking weighted full-text matches.",
      importance: 4,
      confidence: 100,
    }).memory;
    const bodyHit = db.createMemory({
      scopePath: "src/auth/session",
      kind: "gotcha",
      title: "Session cache",
      body: "Token search appears only in this body field for comparison.",
      importance: 4,
      confidence: 100,
    }).memory;
    const dbHit = db.createMemory({
      scopePath: "src/db",
      kind: "decision",
      title: "Database note",
      body: "Database-specific token search behavior.",
      importance: 4,
      confidence: 100,
    }).memory;
    const staleHit = db.createMemory({
      scopePath: "src/auth",
      kind: "decision",
      title: "Token search stale note",
      body: "Inactive token search result.",
      importance: 10,
      confidence: 100,
    }).memory;
    db.updateMemoryStatus({ id: staleHit.id, status: "stale", reason: "test fixture" });
    const fallbackHit = db.createMemory({
      scopePath: "src/config",
      kind: "gotcha",
      title: "Substring fallback fixture",
      body: "Update maxSenseResults carefully when changing retrieval limits.",
      importance: 1,
      confidence: 100,
    }).memory;

    const relevance = runSearch("token search", { limit: 10 });
    assert.equal(relevance.at(0)?.memory.id, titleHit.id);
    assert.equal(relevance.at(0)?.matchType, "fts");
    assert.match(relevance.at(0)?.snippet ?? "", /\[/);
    assert.equal(relevance.some((hit) => hit.memory.id === bodyHit.id), true);
    assert.equal(relevance.some((hit) => hit.memory.id === staleHit.id), false);

    const importantHit = db.createMemory({
      scopePath: "src/auth",
      kind: "gotcha",
      title: "Important body-only fixture",
      body: "Token search should sort first when explicit importance ordering is requested.",
      importance: 9,
      confidence: 100,
    }).memory;
    const byImportance = runSearch("token search", { orderBy: "importance", limit: 10 });
    assert.equal(byImportance.at(0)?.memory.id, importantHit.id);

    const anyStatus = runSearch("token search", { status: "any", limit: 10 });
    assert.equal(anyStatus.some((hit) => hit.memory.id === staleHit.id), true);

    const decisions = runSearch("token search", { kind: "decision", limit: 10 });
    assert.equal(decisions.some((hit) => hit.memory.id === titleHit.id), true);
    assert.equal(decisions.some((hit) => hit.memory.id === dbHit.id), true);
    assert.equal(decisions.some((hit) => hit.memory.id === bodyHit.id), false);

    const authSubtree = runSearch("token search", { scopePath: "src/auth", scopeMode: "subtree", limit: 10 });
    assert.equal(authSubtree.some((hit) => hit.memory.id === titleHit.id), true);
    assert.equal(authSubtree.some((hit) => hit.memory.id === bodyHit.id), true);
    assert.equal(authSubtree.some((hit) => hit.memory.id === dbHit.id), false);

    const authExact = runSearch("token search", { scopePath: "src/auth", scopeMode: "exact", limit: 10 });
    assert.equal(authExact.some((hit) => hit.memory.id === titleHit.id), true);
    assert.equal(authExact.some((hit) => hit.memory.id === bodyHit.id), false);

    const substring = runSearch("SenseRes", { limit: 10 });
    assert.equal(substring.some((hit) => hit.memory.id === fallbackHit.id && hit.matchType === "substring"), true);

    const withoutSubstring = runSearch("SenseRes", { includeSubstringFallback: false, limit: 10 });
    assert.equal(withoutSubstring.some((hit) => hit.memory.id === fallbackHit.id), false);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("searchMemoryPage paginates with opaque cursors", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  function buildFilters(overrides = {}) {
    const built = buildSafeFtsQuery("cursor pagination target");
    assert.equal(built.ok, true);
    if (!built.ok) throw new Error("failed to build fixture query");
    return {
      ftsQuery: built.query.expression,
      rawQuery: built.query.rawQuery,
      terms: built.query.terms,
      matchMode: built.query.matchMode,
      orderBy: "importance",
      limit: 2,
      ...overrides,
    };
  }

  try {
    for (let index = 1; index <= 5; index += 1) {
      db.createMemory({
        scopePath: "src/search",
        kind: "gotcha",
        title: `Cursor fixture ${index}`,
        body: "cursor pagination target",
        importance: index,
        confidence: 100,
      });
    }

    const filters = buildFilters();
    const firstPage = db.searchMemoryPage(filters);
    assert.deepEqual(firstPage.hits.map((hit) => hit.memory.importance), [5, 4]);
    assert.equal(firstPage.page.limit, 2);
    assert.equal(firstPage.page.hasMore, true);
    assert.equal(typeof firstPage.page.nextCursor, "string");

    const secondPage = db.searchMemoryPage({ ...filters, cursor: firstPage.page.nextCursor });
    assert.deepEqual(secondPage.hits.map((hit) => hit.memory.importance), [3, 2]);
    assert.equal(secondPage.page.hasMore, true);
    assert.equal(new Set(firstPage.hits.map((hit) => hit.memory.id)).size, firstPage.hits.length);
    assert.equal(firstPage.hits.some((hit) => secondPage.hits.some((nextHit) => nextHit.memory.id === hit.memory.id)), false);

    const thirdPage = db.searchMemoryPage({ ...filters, cursor: secondPage.page.nextCursor });
    assert.deepEqual(thirdPage.hits.map((hit) => hit.memory.importance), [1]);
    assert.equal(thirdPage.page.hasMore, false);
    assert.equal(thirdPage.page.nextCursor, undefined);

    for (const orderBy of ["relevance", "updated"]) {
      const orderedFilters = buildFilters({ orderBy });
      const orderedFirstPage = db.searchMemoryPage(orderedFilters);
      const orderedSecondPage = db.searchMemoryPage({ ...orderedFilters, cursor: orderedFirstPage.page.nextCursor });
      assert.equal(orderedFirstPage.hits.length, 2);
      assert.equal(orderedSecondPage.hits.length, 2);
      assert.equal(orderedFirstPage.hits.some((hit) => orderedSecondPage.hits.some((nextHit) => nextHit.memory.id === hit.memory.id)), false, orderBy);
    }

    assert.throws(() => db.searchMemoryPage({ ...filters, cursor: "not-a-valid-cursor" }), /Invalid Portia search cursor/);
    assert.throws(() => db.searchMemoryPage({ ...filters, kind: "decision", cursor: firstPage.page.nextCursor }), /does not match the current query and filters/);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("searchMemoryPage does not duplicate FTS hits as substring fallback", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  try {
    for (let index = 1; index <= 3; index += 1) {
      db.createMemory({
        scopePath: "src/search",
        kind: "gotcha",
        title: `FTS fixture ${index}`,
        body: "token alpha",
        importance: 5,
        confidence: 100,
      });
      db.createMemory({
        scopePath: "src/search",
        kind: "gotcha",
        title: `Fallback fixture ${index}`,
        body: "maxSenseResults beta",
        importance: 5,
        confidence: 100,
      });
    }

    const built = buildSafeFtsQuery("token SenseRes", { matchMode: "any" });
    assert.equal(built.ok, true);
    if (!built.ok) throw new Error("failed to build fixture query");

    const filters = {
      ftsQuery: built.query.expression,
      rawQuery: built.query.rawQuery,
      terms: built.query.terms,
      matchMode: built.query.matchMode,
      orderBy: "relevance",
      limit: 2,
    };
    const allHits = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = db.searchMemoryPage({ ...filters, cursor });
      allHits.push(...result.hits);
      cursor = result.page.nextCursor;
      if (!cursor) break;
    }

    assert.equal(allHits.length, 6);
    assert.equal(new Set(allHits.map((hit) => hit.memory.id)).size, 6);
    assert.deepEqual(allHits.map((hit) => hit.matchType), ["fts", "fts", "fts", "substring", "substring", "substring"]);
  } finally {
    db.close();
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
    const result = senseMemories(reopened, settings(project, dbPath, { pheromoneRanking: false }), {
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

test("pheromone trace events update summary counts without exposure self-reinforcement", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  try {
    const memory = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      scopePath: "src/db.ts",
      kind: "gotcha",
      title: "Schema trace target",
      body: "Read src/db.ts before changing Portia schema migrations.",
    }, project).memory;

    db.recordTraceEvent({ memoryId: memory.id, eventType: "exposed", scopePath: "src/db.ts", weight: 0 });
    db.applyPheromoneDelta({ memoryId: memory.id, eventType: "exposed", delta: 0 });
    db.recordTraceEvent({ memoryId: memory.id, eventType: "ignored", scopePath: "src/db.ts", weight: 0 });
    db.applyPheromoneDelta({ memoryId: memory.id, eventType: "ignored", delta: 0 });

    const pheromone = db.getMemoryPheromone(memory.id);
    assert.equal(pheromone.strength, 0);
    assert.equal(pheromone.exposedCount, 1);
    assert.equal(pheromone.ignoredCount, 1);
    assert.equal(db.getTraceEventsForMemory(memory.id).length, 2);
    assert.equal(db.getStats().pheromoneTraceEvents, 2);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("pheromone trace state uses tool_call order when validation result finishes before read result", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "db.ts"), "export const schema = true;\n");
  const db = openPortiaDatabase(dbPath);

  try {
    const writeSettings = settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    });
    const memory = recordPortiaMemory(db, writeSettings, {
      scopePath: "src/db.ts",
      kind: "gotcha",
      title: "Schema migration gotcha",
      body: "Inspect src/db.ts and run typecheck after changing Portia schema migrations.",
    }, project).memory;

    const sense = senseMemories(db, writeSettings, { path: "src/db.ts", query: "schema migrations" }, project);
    const trace = createPheromoneTraceState(writeSettings, "Change src/db.ts schema migrations", "test-session.jsonl");
    addSenseExposures(trace, sense, "autopilot");
    observeToolCall(trace, { toolName: "read", toolCallId: "read-1" });
    observeToolCall(trace, { toolName: "bash", toolCallId: "bash-1" });
    observeToolResult(trace, writeSettings, {
      toolName: "bash",
      toolCallId: "bash-1",
      input: { command: "npm run typecheck" },
      isError: false,
      cwd: project,
    });
    observeToolResult(trace, writeSettings, {
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "src/db.ts" },
      isError: false,
      cwd: project,
    });

    const flushed = flushPheromoneTraceState(db, writeSettings, trace);
    assert.equal(flushed.exposed, 1);
    assert.equal(flushed.followed, 1);
    assert.equal(flushed.validations, 1);

    const pheromone = db.getMemoryPheromone(memory.id);
    assert.equal(pheromone.exposedCount, 1);
    assert.equal(pheromone.followedCount, 1);
    assert.equal(pheromone.successCount, 1);
    assert.equal(pheromone.strength, 3);

    const trails = listPortiaTrails(db, writeSettings, { mode: "top" });
    assert.equal(trails.pheromones.at(0)?.memoryId, memory.id);
    assert.equal(trails.pheromones.at(0)?.boost > 0, true);

    const inspected = inspectPortiaMemory(db, writeSettings, { id: memory.id });
    assert.equal(inspected.pheromone?.strength, 3);
    assert.equal(inspected.pheromoneBoost > 0, true);
    const inspectedWithLowerMaxBoost = inspectPortiaMemory(db, settings(project, dbPath, { pheromoneMaxBoost: 5 }), { id: memory.id });
    assert.equal(inspectedWithLowerMaxBoost.pheromoneBoost < inspected.pheromoneBoost, true);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("pheromone failed validation applies weak negative delta after follow", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "db.ts"), "export const schema = true;\n");
  const db = openPortiaDatabase(dbPath);

  try {
    const writeSettings = settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    });
    const memory = recordPortiaMemory(db, writeSettings, {
      scopePath: "src/db.ts",
      kind: "gotcha",
      title: "Validation failure gotcha",
      body: "Inspect src/db.ts and run typecheck after schema changes.",
    }, project).memory;

    const sense = senseMemories(db, writeSettings, { path: "src/db.ts" }, project);
    const trace = createPheromoneTraceState(writeSettings, "Change src/db.ts schema migrations");
    addSenseExposures(trace, sense, "autopilot");
    observeToolResult(trace, writeSettings, {
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "src/db.ts" },
      isError: false,
      cwd: project,
    });
    observeToolResult(trace, writeSettings, {
      toolName: "bash",
      toolCallId: "bash-1",
      input: { command: "npm run typecheck" },
      isError: true,
      cwd: project,
    });

    const flushed = flushPheromoneTraceState(db, writeSettings, trace);
    assert.equal(flushed.validations, 1);

    const pheromone = db.getMemoryPheromone(memory.id);
    assert.equal(pheromone.failureCount, 1);
    assert.equal(Math.abs(pheromone.strength - 0.6) < 0.000001, true);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("readonly worker policy low applies reduced pheromone weights", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "db.ts"), "export const schema = true;\n");
  const db = openPortiaDatabase(dbPath);

  try {
    const writeSettings = settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    });
    const memory = recordPortiaMemory(db, writeSettings, {
      scopePath: "src/db.ts",
      kind: "gotcha",
      title: "Worker low weight gotcha",
      body: "Inspect src/db.ts before schema changes.",
    }, project).memory;
    const workerSettings = settings(project, dbPath, {
      effectiveWritePolicy: "readonly",
      modeOverride: "readonly",
      pheromoneWorkerPolicy: "low",
    });

    const sense = senseMemories(db, writeSettings, { path: "src/db.ts" }, project);
    const trace = createPheromoneTraceState(workerSettings, "Worker inspects src/db.ts");
    addSenseExposures(trace, sense, "autopilot");
    observeToolResult(trace, workerSettings, {
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "src/db.ts" },
      isError: false,
      cwd: project,
    });

    assert.equal(shouldWritePheromones(workerSettings), true);
    flushPheromoneTraceState(db, workerSettings, trace);

    const pheromone = db.getMemoryPheromone(memory.id);
    assert.equal(pheromone.followedCount, 1);
    assert.equal(pheromone.strength, 0.25);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("trace retention prunes old raw trace events", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  try {
    const memory = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      scopePath: "src/db.ts",
      kind: "gotcha",
      title: "Retention gotcha",
      body: "Old raw trace events should be pruned.",
    }, project).memory;

    db.recordTraceEvent({
      memoryId: memory.id,
      eventType: "exposed",
      weight: 0,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    db.recordTraceEvent({
      memoryId: memory.id,
      eventType: "followed_scope",
      weight: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const pruned = db.pruneTraceEvents(30, new Date("2026-01-15T00:00:00.000Z"));
    assert.equal(pruned, 1);
    assert.equal(db.getTraceEventsForMemory(memory.id, 10).length, 1);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("pheromone ranking boosts only already relevant candidates and can be disabled", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "db.ts"), "export const schema = true;\n");
  const db = openPortiaDatabase(dbPath);
  db.close();

  insertMemory(dbPath, {
    id: "important-base",
    scope_path: "src",
    kind: "gotcha",
    body: "High importance unreinforced memory for schema work.",
    importance: 5,
  });
  insertMemory(dbPath, {
    id: "reinforced-route",
    scope_path: "src",
    kind: "gotcha",
    body: "Lower importance memory repeatedly followed for schema work.",
    importance: 0,
  });
  insertMemory(dbPath, {
    id: "unrelated-reinforced",
    scope_path: "docs",
    kind: "gotcha",
    body: "Unrelated reinforced memory must not appear unless it is a candidate.",
    importance: 0,
  });

  const reopened = openPortiaDatabase(dbPath);
  try {
    reopened.applyPheromoneDelta({ memoryId: "reinforced-route", eventType: "validation_passed", delta: 20 });
    reopened.applyPheromoneDelta({ memoryId: "unrelated-reinforced", eventType: "validation_passed", delta: 20 });

    const disabled = senseMemories(reopened, settings(project, dbPath, { pheromoneRanking: false }), {
      path: "src/db.ts",
    }, project);
    assert.equal(disabled.memories.at(0)?.id, "important-base");
    assert.equal(disabled.memories.some((memory) => memory.id === "unrelated-reinforced"), false);

    const enabled = senseMemories(reopened, settings(project, dbPath, { pheromoneRanking: true }), {
      path: "src/db.ts",
    }, project);
    assert.equal(enabled.memories.at(0)?.id, "reinforced-route");
    assert.equal(enabled.memories.at(0)?.reasons.some((reason) => reason.type === "pheromone"), true);
    assert.equal(enabled.memories.some((memory) => memory.id === "unrelated-reinforced"), false);
  } finally {
    reopened.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("readonly worker policy off disables pheromone writes", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const readonlySettings = settings(project, dbPath, {
    effectiveWritePolicy: "readonly",
    modeOverride: "readonly",
    pheromoneWorkerPolicy: "off",
  });

  try {
    assert.equal(shouldWritePheromones(readonlySettings), false);
  } finally {
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

test("recordPortiaMemory blocks exact duplicate active memories by default", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);
  const writeSettings = settings(project, dbPath, {
    writePolicy: "write",
    effectiveWritePolicy: "write",
  });
  const input = {
    scopePath: ".",
    kind: "decision",
    title: "Duplicate guard",
    body: "Exact duplicate memories should not create parallel active records.",
    sourceType: "test",
    sourceRef: "duplicate",
  };

  try {
    const first = recordPortiaMemory(db, writeSettings, input, project);
    assert.equal(first.written, true);

    const blocked = recordPortiaMemory(db, writeSettings, {
      ...input,
      body: "Exact   duplicate memories should not create parallel active records.",
    }, project);
    assert.equal(blocked.written, false);
    assert.equal(blocked.skipReason, "duplicate");
    assert.equal(blocked.duplicateBlockedBy?.id, first.memory.id);
    assert.equal(blocked.memory?.id, first.memory.id);
    assert.equal(db.getStats().activeMemories, 1);

    const allowed = recordPortiaMemory(db, writeSettings, {
      ...input,
      duplicatePolicy: "warn",
    }, project);
    assert.equal(allowed.written, true);
    assert.equal(allowed.warnings.some((warning) => warning.includes("duplicatePolicy=warn")), true);
    assert.equal(db.getStats().activeMemories, 2);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("recordPortiaMemory reports related active memories without blocking fuzzy overlaps", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);
  const writeSettings = settings(project, dbPath, {
    writePolicy: "write",
    effectiveWritePolicy: "write",
  });

  try {
    const existing = recordPortiaMemory(db, writeSettings, {
      scopePath: "src/db.ts",
      kind: "gotcha",
      title: "FTS trigger maintenance",
      body: "memory_fts triggers keep Portia search rows synchronized after memory writes.",
      sourceType: "test",
      sourceRef: "related-existing",
    }, project);

    const related = recordPortiaMemory(db, writeSettings, {
      scopePath: "src/db.ts",
      kind: "gotcha",
      title: "FTS triggers require care",
      body: "Before changing memory_fts triggers, verify Portia search rows stay synchronized.",
      sourceType: "test",
      sourceRef: "related-new",
    }, project);

    assert.equal(related.written, true);
    assert.equal(related.relatedMemories.some((memory) => memory.id === existing.memory.id), true);
    assert.equal(related.warnings.some((warning) => warning.includes("related active")), true);
    assert.equal(db.getStats().activeMemories, 2);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("recordPortiaMemory can atomically supersede an active memory", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);
  const writeSettings = settings(project, dbPath, {
    writePolicy: "write",
    effectiveWritePolicy: "write",
  });

  try {
    const oldMemory = recordPortiaMemory(db, writeSettings, {
      scopePath: "pi-portia",
      kind: "plan",
      title: "Old memory quality plan",
      body: "Old quality plan says manual deletion is handled only through repair commands.",
      sourceType: "test",
      sourceRef: "supersede-old",
    }, project);

    const replacement = recordPortiaMemory(db, writeSettings, {
      scopePath: "pi-portia",
      kind: "plan",
      title: "New memory quality plan",
      body: "New quality plan adds portia-delete and record-time supersession controls.",
      supersedesId: oldMemory.memory.id,
      sourceType: "test",
      sourceRef: "supersede-new",
      evidence: "Synthetic test verifies supersession lineage.",
    }, project);

    assert.equal(replacement.written, true);
    assert.equal(replacement.memory?.supersedesId, oldMemory.memory.id);
    assert.equal(replacement.supersededMemory?.id, oldMemory.memory.id);
    assert.equal(replacement.supersededMemory?.status, "superseded");
    assert.equal(replacement.supersedeEvent?.eventType, "status_changed");
    assert.equal(db.getMemory(oldMemory.memory.id)?.status, "superseded");
    assert.equal(db.getStats().activeMemories, 1);
    assert.equal(db.getStats().supersededMemories, 1);

    const payload = JSON.parse(replacement.supersedeEvent.payloadJson);
    assert.equal(payload.action, "supersede");
    assert.equal(payload.newStatus, "superseded");
    assert.equal(payload.replacementId, replacement.memory.id);

    const activeSense = senseMemories(db, settings(project, dbPath), {
      path: "pi-portia",
      query: "manual deletion repair commands",
    }, project);
    assert.equal(activeSense.memories.some((memory) => memory.id === oldMemory.memory.id), false);

    const inspectedOld = inspectPortiaMemory(db, settings(project, dbPath), { id: oldMemory.memory.id });
    assert.equal(inspectedOld.supersededBy.some((memory) => memory.id === replacement.memory.id), true);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("listPortiaMemories filters by status, scope, kind, and query", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);
  db.close();

  insertMemory(dbPath, {
    id: "root-decision",
    scope_path: ".",
    kind: "decision",
    title: "Root operating model",
    body: "Main sessions write while worker sessions stay readonly.",
    importance: 7,
  });
  insertMemory(dbPath, {
    id: "auth-stale-gotcha",
    scope_path: "src/auth",
    kind: "gotcha",
    title: "Old fixtures",
    body: "Old seeded fixture note that should be stale.",
    status: "stale",
    importance: 3,
  });

  const reopened = openPortiaDatabase(dbPath);
  try {
    const active = listPortiaMemories(reopened, settings(project, dbPath), {}, project);
    assert.deepEqual(active.memories.map((memory) => memory.id), ["root-decision"]);

    const all = listPortiaMemories(reopened, settings(project, dbPath), { status: "any" }, project);
    assert.deepEqual(new Set(all.memories.map((memory) => memory.id)), new Set(["root-decision", "auth-stale-gotcha"]));

    const scoped = listPortiaMemories(reopened, settings(project, dbPath), {
      status: "any",
      scopePath: "src/auth",
      kind: "gotcha",
      query: "seeded fixture",
    }, project);
    assert.deepEqual(scoped.memories.map((memory) => memory.id), ["auth-stale-gotcha"]);
  } finally {
    reopened.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("inspectPortiaMemory returns memory details and event history", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  try {
    const recorded = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      scopePath: ".",
      kind: "decision",
      title: "Inspectable memory",
      body: "Recorded memories should be inspectable with event provenance.",
      sourceType: "test",
      sourceRef: "inspect",
    }, project);

    const inspected = inspectPortiaMemory(db, settings(project, dbPath), { id: recorded.memory.id });
    assert.equal(inspected.memory?.id, recorded.memory.id);
    assert.equal(inspected.memory?.title, "Inspectable memory");
    assert.equal(inspected.events.length, 1);
    assert.equal(inspected.events[0].eventType, "created");

    const missing = inspectPortiaMemory(db, settings(project, dbPath), { id: "missing-memory" });
    assert.equal(missing.memory, undefined);
    assert.equal(missing.warnings.some((warning) => warning.includes("No Portia memory")), true);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("repairPortiaMemory soft changes status, writes events, and active sense ignores inactive memories", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  try {
    const recorded = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      scopePath: ".",
      kind: "gotcha",
      title: "Repair target",
      body: "Temporary smoke memory should be hidden after repair deletes it.",
      sourceType: "test",
      sourceRef: "repair",
    }, project);

    const stale = repairPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      id: recorded.memory.id,
      action: "stale",
      reason: "Synthetic test mark stale.",
      sourceType: "test",
      sourceRef: "repair-stale",
    });
    assert.equal(stale.written, true);
    assert.equal(stale.memory?.status, "stale");

    const reactivated = repairPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      id: recorded.memory.id,
      action: "reactivate",
      reason: "Synthetic test reactivate.",
    });
    assert.equal(reactivated.written, true);
    assert.equal(reactivated.memory?.status, "active");

    const deleted = repairPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      id: recorded.memory.id,
      action: "delete",
      reason: "Synthetic test soft delete.",
      evidence: "Deleted memories remain inspectable but are not active retrieval candidates.",
    });
    assert.equal(deleted.written, true);
    assert.equal(deleted.memory?.status, "deleted");
    assert.equal(deleted.event?.eventType, "status_changed");

    const payload = JSON.parse(deleted.event.payloadJson);
    assert.equal(payload.oldStatus, "active");
    assert.equal(payload.newStatus, "deleted");
    assert.equal(payload.repairAction, "delete");
    assert.equal(db.getMemoryEvents(recorded.memory.id).length, 4);

    const activeSense = senseMemories(db, settings(project, dbPath), {
      path: ".",
      query: "Temporary smoke memory",
    }, project);
    assert.equal(activeSense.memories.some((memory) => memory.id === recorded.memory.id), false);

    const listedDeleted = listPortiaMemories(db, settings(project, dbPath), { status: "deleted" }, project);
    assert.equal(listedDeleted.memories.at(0)?.id, recorded.memory.id);
  } finally {
    db.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("repairPortiaMemory returns proposals without writing in readonly and confirm policies", () => {
  const project = tempProject();
  const dbPath = path.join(project, ".pi", "portia", "portia.sqlite");
  const db = openPortiaDatabase(dbPath);

  try {
    const recorded = recordPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "write",
    }), {
      scopePath: ".",
      kind: "gotcha",
      title: "Repair proposal target",
      body: "Readonly and confirm repair policies should not write status changes.",
    }, project);

    const readonly = repairPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "write",
      effectiveWritePolicy: "readonly",
      modeOverride: "readonly",
    }), {
      id: recorded.memory.id,
      action: "delete",
      reason: "Readonly proposal only.",
    });
    assert.equal(readonly.written, false);
    assert.equal(readonly.skipReason, "readonly");
    assert.equal(db.getMemory(recorded.memory.id)?.status, "active");

    const confirm = repairPortiaMemory(db, settings(project, dbPath, {
      writePolicy: "confirm",
      effectiveWritePolicy: "confirm",
    }), {
      id: recorded.memory.id,
      action: "stale",
      reason: "Confirm proposal only.",
    });
    assert.equal(confirm.written, false);
    assert.equal(confirm.skipReason, "confirm");
    assert.equal(db.getMemory(recorded.memory.id)?.status, "active");
    assert.equal(db.getMemoryEvents(recorded.memory.id).length, 1);
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
        searchDefaultLimit: 600,
        searchMaxResults: 999,
        listDefaultLimit: 90,
        listMaxResults: 70,
        enablePheromones: false,
        pheromoneRanking: false,
        pheromoneHalfLifeDays: 45,
        pheromoneMaxBoost: 30,
        pheromoneFailureWeight: -0.2,
        pheromoneIgnoredWeight: -0.1,
        pheromoneWorkerPolicy: "low",
        traceRetentionDays: 400,
      },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const resolved = resolvePortiaSettings(project);
    assert.equal(resolved.autoPromptGuidance, false);
    assert.equal(resolved.autoRecordGuidance, false);
    assert.equal(resolved.autoSense, false);
    assert.equal(resolved.autoSenseMaxResults, 12);
    assert.equal(resolved.autoSenseMaxChars, 12_000);
    assert.equal(resolved.searchDefaultLimit, 500);
    assert.equal(resolved.searchMaxResults, 500);
    assert.equal(resolved.listDefaultLimit, 70);
    assert.equal(resolved.listMaxResults, 70);
    assert.equal(resolved.enablePheromones, false);
    assert.equal(resolved.pheromoneRanking, false);
    assert.equal(resolved.pheromoneHalfLifeDays, 45);
    assert.equal(resolved.pheromoneMaxBoost, 30);
    assert.equal(resolved.pheromoneFailureWeight, -0.2);
    assert.equal(resolved.pheromoneIgnoredWeight, -0.1);
    assert.equal(resolved.pheromoneWorkerPolicy, "low");
    assert.equal(resolved.traceRetentionDays, 400);
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
