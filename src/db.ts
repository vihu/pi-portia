import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { buildSearchTerms } from "./search.ts";

type DatabaseConnection = InstanceType<typeof Database>;
import type {
  CreateMemoryInput,
  CreateMemoryResult,
  CreateMemorySupersedingInput,
  ApplyPheromoneDeltaInput,
  CreateMemorySupersedingResult,
  ListPheromonesFilters,
  MemoryEvent,
  MemoryListFilters,
  MemoryPheromone,
  MemoryPheromoneSummary,
  MemoryRecord,
  MemoryTraceEvent,
  PortiaStats,
  RecordTraceEventInput,
  UpdateMemoryStatusInput,
  UpdateMemoryStatusResult,
} from "./types.ts";

const SCHEMA_VERSION = 3;
const MIN_PHEROMONE_STRENGTH = -5;
const MAX_PHEROMONE_STRENGTH = 20;

interface MemoryRow {
  rowid: number;
  id: string;
  scope_path: string;
  kind: string;
  title: string | null;
  body: string;
  status: string;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  supersedes_id: string | null;
  source_type: string | null;
  source_ref: string | null;
}

interface EventRow {
  id: string;
  memory_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
  created_by: string | null;
}

interface PheromoneRow {
  memory_id: string;
  strength: number;
  exposed_count: number;
  followed_count: number;
  ignored_count: number;
  success_count: number;
  failure_count: number;
  last_exposed_at: string | null;
  last_followed_at: string | null;
  last_ignored_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_decayed_at: string;
  updated_at: string;
}

interface PheromoneSummaryRow extends PheromoneRow, MemoryRow {}

interface TraceEventRow {
  id: string;
  memory_id: string;
  event_type: string;
  scope_path: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  session_file: string | null;
  turn_id: string | null;
  weight: number;
  payload_json: string;
  created_at: string;
}

interface CountRow {
  count: number;
}

interface KindCountRow {
  kind: string;
  count: number;
}

interface ScopeCountRow {
  scope_path: string;
  count: number;
}

interface FtsRow extends MemoryRow {
  score: number;
}

interface TableInfoRow {
  name: string;
}

interface SearchTermsBackfillRow {
  rowid: number;
  scope_path: string;
  kind: string;
  title: string | null;
  body: string;
  source_type: string | null;
  source_ref: string | null;
}

interface TriggerSqlRow {
  name: string;
  sql: string | null;
}

function toMemory(row: MemoryRow): MemoryRecord {
  return {
    rowid: row.rowid,
    id: row.id,
    scopePath: row.scope_path,
    kind: row.kind,
    title: row.title ?? undefined,
    body: row.body,
    status: row.status,
    importance: row.importance,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by ?? undefined,
    supersedesId: row.supersedes_id ?? undefined,
    sourceType: row.source_type ?? undefined,
    sourceRef: row.source_ref ?? undefined,
  };
}

function toEvent(row: EventRow): MemoryEvent {
  return {
    id: row.id,
    memoryId: row.memory_id,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
  };
}

function toPheromone(row: PheromoneRow): MemoryPheromone {
  return {
    memoryId: row.memory_id,
    strength: row.strength,
    exposedCount: row.exposed_count,
    followedCount: row.followed_count,
    ignoredCount: row.ignored_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastExposedAt: row.last_exposed_at ?? undefined,
    lastFollowedAt: row.last_followed_at ?? undefined,
    lastIgnoredAt: row.last_ignored_at ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastFailureAt: row.last_failure_at ?? undefined,
    lastDecayedAt: row.last_decayed_at,
    updatedAt: row.updated_at,
  };
}

function toTraceEvent(row: TraceEventRow): MemoryTraceEvent {
  return {
    id: row.id,
    memoryId: row.memory_id,
    eventType: row.event_type,
    scopePath: row.scope_path ?? undefined,
    toolName: row.tool_name ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    sessionFile: row.session_file ?? undefined,
    turnId: row.turn_id ?? undefined,
    weight: row.weight,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function clampPheromoneStrength(value: number): number {
  return Math.max(MIN_PHEROMONE_STRENGTH, Math.min(MAX_PHEROMONE_STRENGTH, value));
}

function decayedStrength(strength: number, lastDecayedAt: string, now: string, halfLifeDays = 30): number {
  const last = Date.parse(lastDecayedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(current) || current <= last || halfLifeDays <= 0) return strength;
  const ageDays = (current - last) / 86_400_000;
  return strength * Math.pow(0.5, ageDays / halfLifeDays);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function memorySelectSql(): string {
  return `
    select rowid, id, scope_path, kind, title, body, status, importance, confidence,
           created_at, updated_at, created_by, supersedes_id, source_type, source_ref
    from memories
  `;
}

function memoryStatusOrderSql(): string {
  return `
    case status
      when 'active' then 0
      when 'stale' then 1
      when 'superseded' then 2
      when 'deleted' then 3
      else 9
    end
  `;
}

function normalizeDuplicateText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

const RELATED_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "into",
  "when",
  "then",
  "than",
  "should",
  "memory",
  "memories",
  "portia",
]);

function relatedTokens(value: string): Set<string> {
  const tokens = value.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? [];
  return new Set(tokens.filter((token) => !RELATED_STOP_WORDS.has(token)));
}

function relatedScore(queryTokens: Set<string>, memory: MemoryRecord): number {
  if (queryTokens.size === 0) return 0;
  const memoryTokens = relatedTokens(`${memory.title ?? ""} ${memory.body}`);
  if (memoryTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) overlap += 1;
  }

  return overlap / Math.sqrt(queryTokens.size * memoryTokens.size);
}

function tableColumns(db: DatabaseConnection, tableName: string): string[] {
  return (db.prepare(`pragma table_info(${tableName})`).all() as TableInfoRow[]).map((row) => row.name);
}

function ensureSearchTermsColumn(db: DatabaseConnection): void {
  if (!tableColumns(db, "memories").includes("search_terms")) {
    db.exec("alter table memories add column search_terms text");
  }
}

function memoryFtsNeedsRebuild(db: DatabaseConnection): boolean {
  const exists = (db.prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'memory_fts'").get() as CountRow | undefined)?.count ?? 0;
  if (exists === 0) return true;

  const expectedColumns = ["title", "body", "scope_path", "kind", "source_type", "source_ref", "search_terms"];
  const existingColumns = tableColumns(db, "memory_fts");
  return expectedColumns.join("|") !== existingColumns.join("|");
}

function memoryFtsTriggersNeedRebuild(db: DatabaseConnection): boolean {
  const expectedNames = new Set(["memories_ai", "memories_ad", "memories_au"]);
  const rows = db.prepare(`
    select name, sql
    from sqlite_master
    where type = 'trigger' and name in ('memories_ai', 'memories_ad', 'memories_au')
  `).all() as TriggerSqlRow[];

  if (rows.length !== expectedNames.size) return true;
  for (const row of rows) {
    expectedNames.delete(row.name);
    const sql = row.sql ?? "";
    if (!sql.includes("source_type") || !sql.includes("source_ref") || !sql.includes("search_terms")) return true;
  }

  return expectedNames.size > 0;
}

function dropMemoryFtsTriggers(db: DatabaseConnection): void {
  db.exec(`
    drop trigger if exists memories_ai;
    drop trigger if exists memories_ad;
    drop trigger if exists memories_au;
  `);
}

function createMemoryFts(db: DatabaseConnection): void {
  db.exec(`
    create virtual table if not exists memory_fts using fts5(
      title,
      body,
      scope_path,
      kind,
      source_type,
      source_ref,
      search_terms,
      content='memories',
      content_rowid='rowid'
    );
  `);
}

function createMemoryFtsTriggers(db: DatabaseConnection): void {
  dropMemoryFtsTriggers(db);
  db.exec(`
    create trigger memories_ai after insert on memories begin
      insert into memory_fts(rowid, title, body, scope_path, kind, source_type, source_ref, search_terms)
      values (new.rowid, new.title, new.body, new.scope_path, new.kind, new.source_type, new.source_ref, new.search_terms);
    end;

    create trigger memories_ad after delete on memories begin
      insert into memory_fts(memory_fts, rowid, title, body, scope_path, kind, source_type, source_ref, search_terms)
      values ('delete', old.rowid, old.title, old.body, old.scope_path, old.kind, old.source_type, old.source_ref, old.search_terms);
    end;

    create trigger memories_au after update on memories begin
      insert into memory_fts(memory_fts, rowid, title, body, scope_path, kind, source_type, source_ref, search_terms)
      values ('delete', old.rowid, old.title, old.body, old.scope_path, old.kind, old.source_type, old.source_ref, old.search_terms);
      insert into memory_fts(rowid, title, body, scope_path, kind, source_type, source_ref, search_terms)
      values (new.rowid, new.title, new.body, new.scope_path, new.kind, new.source_type, new.source_ref, new.search_terms);
    end;
  `);
}

function backfillSearchTerms(db: DatabaseConnection): number {
  const rows = db.prepare(`
    select rowid, scope_path, kind, title, body, source_type, source_ref
    from memories
    where search_terms is null
    order by rowid asc
  `).all() as SearchTermsBackfillRow[];

  if (rows.length === 0) return 0;

  const update = db.prepare("update memories set search_terms = @searchTerms where rowid = @rowid");
  let changed = 0;
  for (const row of rows) {
    const result = update.run({
      rowid: row.rowid,
      searchTerms: buildSearchTerms({
        scopePath: row.scope_path,
        kind: row.kind,
        title: row.title,
        body: row.body,
        sourceType: row.source_type,
        sourceRef: row.source_ref,
      }),
    }) as { changes?: number };
    changed += result.changes ?? 0;
  }

  return changed;
}

function rebuildMemoryFts(db: DatabaseConnection): void {
  db.prepare("insert into memory_fts(memory_fts) values ('rebuild')").run();
}

function ensureMemoryFts(db: DatabaseConnection): void {
  const ftsNeedsRebuild = memoryFtsNeedsRebuild(db);
  const triggersNeedRebuild = ftsNeedsRebuild || memoryFtsTriggersNeedRebuild(db);
  if (triggersNeedRebuild) dropMemoryFtsTriggers(db);

  const backfilledRows = backfillSearchTerms(db);

  if (ftsNeedsRebuild) {
    db.exec("drop table if exists memory_fts");
    createMemoryFts(db);
  }

  if (triggersNeedRebuild) createMemoryFtsTriggers(db);

  if (ftsNeedsRebuild || backfilledRows > 0) rebuildMemoryFts(db);
}

function runMigrations(db: DatabaseConnection): void {
  const migrate = db.transaction(() => {
    db.exec(`
      create table if not exists portia_meta (
        key text primary key,
        value text not null
      );

      create table if not exists memories (
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
        source_ref text,
        search_terms text
      );

      create index if not exists memories_status_scope_idx on memories(status, scope_path);
      create index if not exists memories_kind_idx on memories(kind);
      create index if not exists memories_updated_idx on memories(updated_at);

      create table if not exists memory_events (
        id text primary key,
        memory_id text not null,
        event_type text not null,
        payload_json text not null,
        created_at text not null,
        created_by text
      );

      create index if not exists memory_events_memory_idx on memory_events(memory_id, created_at);

      create table if not exists memory_pheromones (
        memory_id text primary key references memories(id),
        strength real not null default 0,
        exposed_count integer not null default 0,
        followed_count integer not null default 0,
        ignored_count integer not null default 0,
        success_count integer not null default 0,
        failure_count integer not null default 0,
        last_exposed_at text,
        last_followed_at text,
        last_ignored_at text,
        last_success_at text,
        last_failure_at text,
        last_decayed_at text not null,
        updated_at text not null
      );

      create index if not exists memory_pheromones_strength_idx on memory_pheromones(strength, updated_at);
      create index if not exists memory_pheromones_updated_idx on memory_pheromones(updated_at);

      create table if not exists memory_trace_events (
        id text primary key,
        memory_id text not null references memories(id),
        event_type text not null,
        scope_path text,
        tool_name text,
        tool_call_id text,
        session_file text,
        turn_id text,
        weight real not null default 0,
        payload_json text not null,
        created_at text not null
      );

      create index if not exists memory_trace_events_memory_idx on memory_trace_events(memory_id, created_at);
      create index if not exists memory_trace_events_turn_idx on memory_trace_events(turn_id, created_at);
      create index if not exists memory_trace_events_type_idx on memory_trace_events(event_type, created_at);

      create table if not exists memory_edges (
        from_id text not null,
        to_id text not null,
        relation text not null,
        primary key (from_id, to_id, relation)
      );
    `);

    ensureSearchTermsColumn(db);
    ensureMemoryFts(db);

    db.prepare(`
      insert into portia_meta(key, value)
      values ('schema_version', ?)
      on conflict(key) do update set value = excluded.value
    `).run(String(SCHEMA_VERSION));
  });

  migrate();
}

export class PortiaDatabase {
  readonly dbPath: string;
  private readonly db: DatabaseConnection;

  constructor(dbPath: string, db: DatabaseConnection) {
    this.dbPath = dbPath;
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`
      ${memorySelectSql()}
      where id = ?
    `).get(id) as MemoryRow | undefined;

    return row ? toMemory(row) : undefined;
  }

  private requireMemory(id: string): MemoryRecord {
    const memory = this.getMemory(id);
    if (!memory) throw new Error(`Portia memory was not found: ${id}`);
    return memory;
  }

  private getEventById(id: string): MemoryEvent {
    const row = this.db.prepare(`
      select id, memory_id, event_type, payload_json, created_at, created_by
      from memory_events
      where id = ?
    `).get(id) as EventRow | undefined;

    if (!row) throw new Error(`Portia memory event was not found after write: ${id}`);
    return toEvent(row);
  }

  createMemory(input: CreateMemoryInput): CreateMemoryResult {
    const id = randomUUID();
    const eventId = randomUUID();
    const now = new Date().toISOString();
    const createdBy = input.createdBy ?? "portia";
    const payloadJson = JSON.stringify(input.eventPayload ?? { action: "record" });
    const searchTerms = buildSearchTerms({
      scopePath: input.scopePath,
      kind: input.kind,
      title: input.title,
      body: input.body,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
    });

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        insert into memories (
          id, scope_path, kind, title, body, status, importance, confidence,
          created_at, updated_at, created_by, supersedes_id, source_type, source_ref, search_terms
        ) values (
          @id, @scopePath, @kind, @title, @body, 'active', @importance, @confidence,
          @createdAt, @updatedAt, @createdBy, @supersedesId, @sourceType, @sourceRef, @searchTerms
        )
      `).run({
        id,
        scopePath: input.scopePath,
        kind: input.kind,
        title: input.title ?? null,
        body: input.body,
        importance: input.importance,
        confidence: input.confidence,
        createdAt: now,
        updatedAt: now,
        createdBy,
        supersedesId: input.supersedesId ?? null,
        sourceType: input.sourceType ?? null,
        sourceRef: input.sourceRef ?? null,
        searchTerms,
      });

      this.db.prepare(`
        insert into memory_events (id, memory_id, event_type, payload_json, created_at, created_by)
        values (@id, @memoryId, 'created', @payloadJson, @createdAt, @createdBy)
      `).run({
        id: eventId,
        memoryId: id,
        payloadJson,
        createdAt: now,
        createdBy,
      });

      return {
        memory: this.requireMemory(id),
        event: this.getEventById(eventId),
      };
    });

    return insert();
  }

  createMemorySuperseding(input: CreateMemorySupersedingInput): CreateMemorySupersedingResult {
    const existing = this.requireMemory(input.supersedesId);
    if (existing.status !== "active") {
      throw new Error(`Portia supersedes target must be active; ${input.supersedesId} is ${existing.status}.`);
    }

    const id = randomUUID();
    const eventId = randomUUID();
    const supersedeEventId = randomUUID();
    const now = new Date().toISOString();
    const createdBy = input.createdBy ?? "portia";
    const payloadJson = JSON.stringify(input.eventPayload ?? { action: "record" });
    const searchTerms = buildSearchTerms({
      scopePath: input.scopePath,
      kind: input.kind,
      title: input.title,
      body: input.body,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
    });
    const eventPayload = input.eventPayload ?? {};
    const evidence = typeof eventPayload.evidence === "string" ? eventPayload.evidence : undefined;
    const supersedePayloadJson = JSON.stringify({
      action: "supersede",
      reason: input.supersedeReason,
      oldStatus: existing.status,
      newStatus: "superseded",
      replacementId: id,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      evidence,
    });

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        insert into memories (
          id, scope_path, kind, title, body, status, importance, confidence,
          created_at, updated_at, created_by, supersedes_id, source_type, source_ref, search_terms
        ) values (
          @id, @scopePath, @kind, @title, @body, 'active', @importance, @confidence,
          @createdAt, @updatedAt, @createdBy, @supersedesId, @sourceType, @sourceRef, @searchTerms
        )
      `).run({
        id,
        scopePath: input.scopePath,
        kind: input.kind,
        title: input.title ?? null,
        body: input.body,
        importance: input.importance,
        confidence: input.confidence,
        createdAt: now,
        updatedAt: now,
        createdBy,
        supersedesId: input.supersedesId,
        sourceType: input.sourceType ?? null,
        sourceRef: input.sourceRef ?? null,
        searchTerms,
      });

      this.db.prepare(`
        insert into memory_events (id, memory_id, event_type, payload_json, created_at, created_by)
        values (@id, @memoryId, 'created', @payloadJson, @createdAt, @createdBy)
      `).run({
        id: eventId,
        memoryId: id,
        payloadJson,
        createdAt: now,
        createdBy,
      });

      this.db.prepare(`
        update memories
        set status = 'superseded',
            updated_at = @updatedAt
        where id = @id
      `).run({
        id: input.supersedesId,
        updatedAt: now,
      });

      this.db.prepare(`
        insert into memory_events (id, memory_id, event_type, payload_json, created_at, created_by)
        values (@id, @memoryId, 'status_changed', @payloadJson, @createdAt, @createdBy)
      `).run({
        id: supersedeEventId,
        memoryId: input.supersedesId,
        payloadJson: supersedePayloadJson,
        createdAt: now,
        createdBy,
      });

      return {
        memory: this.requireMemory(id),
        event: this.getEventById(eventId),
        supersededMemory: this.requireMemory(input.supersedesId),
        supersedeEvent: this.getEventById(supersedeEventId),
      };
    });

    return insert();
  }

  findExactDuplicateMemory(input: { scopePath: string; kind: string; title?: string; body: string }): MemoryRecord | undefined {
    const title = normalizeDuplicateText(input.title);
    const body = normalizeDuplicateText(input.body);
    const rows = this.db.prepare(`
      ${memorySelectSql()}
      where status = 'active' and scope_path = @scopePath and kind = @kind
      order by importance desc, updated_at desc, id asc
    `).all({
      scopePath: input.scopePath,
      kind: input.kind,
    }) as MemoryRow[];

    for (const row of rows) {
      const memory = toMemory(row);
      if (normalizeDuplicateText(memory.title) === title && normalizeDuplicateText(memory.body) === body) return memory;
    }

    return undefined;
  }

  findRelatedMemories(input: { scopePath: string; kind?: string; query?: string; title?: string; body?: string; limit?: number; status?: "active" | "any" }): MemoryRecord[] {
    const limit = clampLimit(input.limit, 5);
    const status = input.status ?? "active";
    const clauses = ["scope_path = @scopePath"];
    const params: Record<string, unknown> = { scopePath: input.scopePath, limit: Math.max(limit * 8, 20) };

    if (status !== "any") clauses.push("status = 'active'");
    if (input.kind) {
      clauses.push("kind = @kind");
      params.kind = input.kind;
    }

    const rows = this.db.prepare(`
      ${memorySelectSql()}
      where ${clauses.join(" and ")}
      order by importance desc, updated_at desc, id asc
      limit @limit
    `).all(params) as MemoryRow[];

    const queryTokens = relatedTokens(input.query ?? `${input.title ?? ""} ${input.body ?? ""}`);
    return rows
      .map((row) => {
        const memory = toMemory(row);
        return { memory, score: relatedScore(queryTokens, memory) };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id))
      .slice(0, limit)
      .map((candidate) => candidate.memory);
  }

  listMemories(filters: MemoryListFilters = {}): MemoryRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {
      limit: clampLimit(filters.limit, 20),
    };

    if (filters.status && filters.status !== "any") {
      clauses.push("status = @status");
      params.status = filters.status;
    }

    if (filters.scopePath) {
      clauses.push("scope_path = @scopePath");
      params.scopePath = filters.scopePath;
    }

    if (filters.kind) {
      clauses.push("kind = @kind");
      params.kind = filters.kind;
    }

    if (filters.query?.trim()) {
      clauses.push(`
        lower(
          coalesce(title, '') || ' ' || body || ' ' || scope_path || ' ' || kind || ' ' ||
          coalesce(source_type, '') || ' ' || coalesce(source_ref, '')
        ) like @query escape '\\'
      `);
      params.query = `%${escapeLike(filters.query.trim().toLowerCase())}%`;
    }

    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db.prepare(`
      ${memorySelectSql()}
      ${where}
      order by ${memoryStatusOrderSql()} asc, importance desc, updated_at desc, id asc
      limit @limit
    `).all(params) as MemoryRow[];

    return rows.map(toMemory);
  }

  searchMemories(query: string, filters: MemoryListFilters = {}): MemoryRecord[] {
    return this.listMemories({ ...filters, query });
  }

  updateMemoryStatus(input: UpdateMemoryStatusInput): UpdateMemoryStatusResult {
    const existing = this.requireMemory(input.id);
    const eventId = randomUUID();
    const now = new Date().toISOString();
    const createdBy = input.createdBy ?? "portia";
    const payloadJson = JSON.stringify({
      ...(input.eventPayload ?? {}),
      reason: input.reason,
      oldStatus: existing.status,
      newStatus: input.status,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      evidence: input.evidence,
    });

    const update = this.db.transaction(() => {
      this.db.prepare(`
        update memories
        set status = @status,
            updated_at = @updatedAt
        where id = @id
      `).run({
        id: input.id,
        status: input.status,
        updatedAt: now,
      });

      this.db.prepare(`
        insert into memory_events (id, memory_id, event_type, payload_json, created_at, created_by)
        values (@id, @memoryId, 'status_changed', @payloadJson, @createdAt, @createdBy)
      `).run({
        id: eventId,
        memoryId: input.id,
        payloadJson,
        createdAt: now,
        createdBy,
      });

      return {
        memory: this.requireMemory(input.id),
        event: this.getEventById(eventId),
      };
    });

    return update();
  }

  getMemoryEvents(memoryId: string): MemoryEvent[] {
    const rows = this.db.prepare(`
      select id, memory_id, event_type, payload_json, created_at, created_by
      from memory_events
      where memory_id = ?
      order by created_at asc, id asc
    `).all(memoryId) as EventRow[];

    return rows.map(toEvent);
  }

  getMemoriesSuperseding(memoryId: string): MemoryRecord[] {
    const rows = this.db.prepare(`
      ${memorySelectSql()}
      where supersedes_id = ?
      order by ${memoryStatusOrderSql()} asc, importance desc, updated_at desc, id asc
    `).all(memoryId) as MemoryRow[];

    return rows.map(toMemory);
  }

  recordTraceEvent(input: RecordTraceEventInput): MemoryTraceEvent {
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const payloadJson = JSON.stringify(input.payload ?? {});

    this.db.prepare(`
      insert into memory_trace_events (
        id, memory_id, event_type, scope_path, tool_name, tool_call_id,
        session_file, turn_id, weight, payload_json, created_at
      ) values (
        @id, @memoryId, @eventType, @scopePath, @toolName, @toolCallId,
        @sessionFile, @turnId, @weight, @payloadJson, @createdAt
      )
    `).run({
      id,
      memoryId: input.memoryId,
      eventType: input.eventType,
      scopePath: input.scopePath ?? null,
      toolName: input.toolName ?? null,
      toolCallId: input.toolCallId ?? null,
      sessionFile: input.sessionFile ?? null,
      turnId: input.turnId ?? null,
      weight: input.weight ?? 0,
      payloadJson,
      createdAt,
    });

    const row = this.db.prepare(`
      select id, memory_id, event_type, scope_path, tool_name, tool_call_id,
             session_file, turn_id, weight, payload_json, created_at
      from memory_trace_events
      where id = ?
    `).get(id) as TraceEventRow | undefined;

    if (!row) throw new Error(`Portia trace event was not found after write: ${id}`);
    return toTraceEvent(row);
  }

  applyPheromoneDelta(input: ApplyPheromoneDeltaInput): MemoryPheromone {
    const now = input.createdAt ?? new Date().toISOString();
    const eventType = input.eventType;
    const existing = this.getMemoryPheromone(input.memoryId);
    const baseStrength = existing ? decayedStrength(existing.strength, existing.lastDecayedAt, now, input.halfLifeDays ?? 30) : 0;
    const strength = clampPheromoneStrength(baseStrength + input.delta);

    this.db.prepare(`
      insert into memory_pheromones (
        memory_id, strength, exposed_count, followed_count, ignored_count, success_count, failure_count,
        last_exposed_at, last_followed_at, last_ignored_at, last_success_at, last_failure_at,
        last_decayed_at, updated_at
      ) values (
        @memoryId, @strength,
        case when @eventType = 'exposed' then 1 else 0 end,
        case when @eventType in ('followed_scope', 'followed_source_ref') then 1 else 0 end,
        case when @eventType = 'ignored' then 1 else 0 end,
        case when @eventType = 'validation_passed' then 1 else 0 end,
        case when @eventType = 'validation_failed' then 1 else 0 end,
        case when @eventType = 'exposed' then @now else null end,
        case when @eventType in ('followed_scope', 'followed_source_ref') then @now else null end,
        case when @eventType = 'ignored' then @now else null end,
        case when @eventType = 'validation_passed' then @now else null end,
        case when @eventType = 'validation_failed' then @now else null end,
        @now, @now
      )
      on conflict(memory_id) do update set
        strength = @strength,
        exposed_count = exposed_count + case when @eventType = 'exposed' then 1 else 0 end,
        followed_count = followed_count + case when @eventType in ('followed_scope', 'followed_source_ref') then 1 else 0 end,
        ignored_count = ignored_count + case when @eventType = 'ignored' then 1 else 0 end,
        success_count = success_count + case when @eventType = 'validation_passed' then 1 else 0 end,
        failure_count = failure_count + case when @eventType = 'validation_failed' then 1 else 0 end,
        last_exposed_at = case when @eventType = 'exposed' then @now else last_exposed_at end,
        last_followed_at = case when @eventType in ('followed_scope', 'followed_source_ref') then @now else last_followed_at end,
        last_ignored_at = case when @eventType = 'ignored' then @now else last_ignored_at end,
        last_success_at = case when @eventType = 'validation_passed' then @now else last_success_at end,
        last_failure_at = case when @eventType = 'validation_failed' then @now else last_failure_at end,
        last_decayed_at = @now,
        updated_at = @now
    `).run({
      memoryId: input.memoryId,
      eventType,
      strength,
      now,
    });

    const pheromone = this.getMemoryPheromone(input.memoryId);
    if (!pheromone) throw new Error(`Portia pheromone summary was not found after write: ${input.memoryId}`);
    return pheromone;
  }

  getMemoryPheromone(memoryId: string): MemoryPheromone | undefined {
    const row = this.db.prepare(`
      select memory_id, strength, exposed_count, followed_count, ignored_count, success_count, failure_count,
             last_exposed_at, last_followed_at, last_ignored_at, last_success_at, last_failure_at,
             last_decayed_at, updated_at
      from memory_pheromones
      where memory_id = ?
    `).get(memoryId) as PheromoneRow | undefined;

    return row ? toPheromone(row) : undefined;
  }

  getMemoryPheromones(memoryIds: string[]): Map<string, MemoryPheromone> {
    const uniqueIds = [...new Set(memoryIds)];
    if (uniqueIds.length === 0) return new Map();

    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      select memory_id, strength, exposed_count, followed_count, ignored_count, success_count, failure_count,
             last_exposed_at, last_followed_at, last_ignored_at, last_success_at, last_failure_at,
             last_decayed_at, updated_at
      from memory_pheromones
      where memory_id in (${placeholders})
    `).all(...uniqueIds) as PheromoneRow[];

    return new Map(rows.map((row) => [row.memory_id, toPheromone(row)]));
  }

  listPheromones(filters: ListPheromonesFilters = {}): MemoryPheromoneSummary[] {
    const limit = clampLimit(filters.limit, 20);
    const mode = filters.mode ?? "top";
    const where = mode === "weak"
      ? "where p.exposed_count > 0 and p.followed_count = 0"
      : "where p.exposed_count > 0 or p.followed_count > 0 or p.success_count > 0 or p.failure_count > 0 or p.strength != 0";
    const order = mode === "weak"
      ? "p.ignored_count desc, p.exposed_count desc, p.strength asc, p.updated_at desc"
      : "p.strength desc, p.success_count desc, p.followed_count desc, p.updated_at desc";

    const rows = this.db.prepare(`
      select p.memory_id, p.strength, p.exposed_count, p.followed_count, p.ignored_count, p.success_count, p.failure_count,
             p.last_exposed_at, p.last_followed_at, p.last_ignored_at, p.last_success_at, p.last_failure_at,
             p.last_decayed_at, p.updated_at,
             m.rowid, m.id, m.scope_path, m.kind, m.title, m.body, m.status, m.importance, m.confidence,
             m.created_at, m.updated_at as memory_updated_at, m.created_by, m.supersedes_id, m.source_type, m.source_ref
      from memory_pheromones p
      left join memories m on m.id = p.memory_id
      ${where}
      order by ${order}
      limit @limit
    `).all({ limit }) as Array<PheromoneRow & {
      rowid: number | null;
      id: string | null;
      scope_path: string | null;
      kind: string | null;
      title: string | null;
      body: string | null;
      status: string | null;
      importance: number | null;
      confidence: number | null;
      created_at: string | null;
      memory_updated_at: string | null;
      created_by: string | null;
      supersedes_id: string | null;
      source_type: string | null;
      source_ref: string | null;
    }>;

    return rows.map((row) => {
      const summary: MemoryPheromoneSummary = toPheromone(row);
      if (row.id) {
        summary.memory = toMemory({
          rowid: row.rowid ?? 0,
          id: row.id,
          scope_path: row.scope_path ?? ".",
          kind: row.kind ?? "pointer",
          title: row.title,
          body: row.body ?? "",
          status: row.status ?? "deleted",
          importance: row.importance ?? 0,
          confidence: row.confidence ?? 100,
          created_at: row.created_at ?? row.updated_at,
          updated_at: row.memory_updated_at ?? row.updated_at,
          created_by: row.created_by,
          supersedes_id: row.supersedes_id,
          source_type: row.source_type,
          source_ref: row.source_ref,
        });
      }
      return summary;
    });
  }

  getTraceEventsForMemory(memoryId: string, limit = 20): MemoryTraceEvent[] {
    const rows = this.db.prepare(`
      select id, memory_id, event_type, scope_path, tool_name, tool_call_id,
             session_file, turn_id, weight, payload_json, created_at
      from memory_trace_events
      where memory_id = @memoryId
      order by created_at desc, id desc
      limit @limit
    `).all({ memoryId, limit: clampLimit(limit, 20) }) as TraceEventRow[];

    return rows.map(toTraceEvent);
  }

  getRecentTraceEvents(limit = 20): MemoryTraceEvent[] {
    const rows = this.db.prepare(`
      select id, memory_id, event_type, scope_path, tool_name, tool_call_id,
             session_file, turn_id, weight, payload_json, created_at
      from memory_trace_events
      order by created_at desc, id desc
      limit @limit
    `).all({ limit: clampLimit(limit, 20) }) as TraceEventRow[];

    return rows.map(toTraceEvent);
  }

  pruneTraceEvents(retentionDays: number, now = new Date()): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const result = this.db.prepare("delete from memory_trace_events where created_at < ?").run(cutoff) as { changes?: number };
    return result.changes ?? 0;
  }

  getStats(): PortiaStats {
    const count = (sql: string): number => (this.db.prepare(sql).get() as CountRow | undefined)?.count ?? 0;
    const schemaVersion = Number(
      (this.db.prepare("select value from portia_meta where key = 'schema_version'").get() as { value?: string } | undefined)
        ?.value ?? 0,
    );
    const ftsAvailable =
      ((this.db.prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'memory_fts'").get() as CountRow | undefined)
        ?.count ?? 0) > 0;

    const byKind = (this.db.prepare(`
      select kind, count(*) as count
      from memories
      where status = 'active'
      group by kind
      order by count desc, kind asc
    `).all() as KindCountRow[]).map((row) => ({ kind: row.kind, count: row.count }));

    const topScopes = (this.db.prepare(`
      select scope_path, count(*) as count
      from memories
      where status = 'active'
      group by scope_path
      order by count desc, scope_path asc
      limit 12
    `).all() as ScopeCountRow[]).map((row) => ({ scopePath: row.scope_path, count: row.count }));

    return {
      dbPath: this.dbPath,
      schemaVersion,
      totalMemories: count("select count(*) as count from memories"),
      activeMemories: count("select count(*) as count from memories where status = 'active'"),
      staleMemories: count("select count(*) as count from memories where status = 'stale'"),
      supersededMemories: count("select count(*) as count from memories where status = 'superseded'"),
      deletedMemories: count("select count(*) as count from memories where status = 'deleted'"),
      ftsAvailable,
      pheromoneTraceEvents: count("select count(*) as count from memory_trace_events"),
      pheromoneMemoryCount: count("select count(*) as count from memory_pheromones"),
      reinforcedMemories: count("select count(*) as count from memory_pheromones where strength > 0"),
      byKind,
      topScopes,
    };
  }

  getActiveMemoriesByScopes(scopePaths: string[]): MemoryRecord[] {
    const uniqueScopes = [...new Set(scopePaths)];
    if (uniqueScopes.length === 0) return [];

    const placeholders = uniqueScopes.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      select rowid, id, scope_path, kind, title, body, status, importance, confidence,
             created_at, updated_at, created_by, supersedes_id, source_type, source_ref
      from memories
      where status = 'active' and scope_path in (${placeholders})
      order by importance desc, updated_at desc, id asc
    `).all(...uniqueScopes) as MemoryRow[];

    return rows.map(toMemory);
  }

  searchActiveMemories(ftsQuery: string, limit: number): Array<MemoryRecord & { ftsScore: number }> {
    const rows = this.db.prepare(`
      select m.rowid, m.id, m.scope_path, m.kind, m.title, m.body, m.status, m.importance, m.confidence,
             m.created_at, m.updated_at, m.created_by, m.supersedes_id, m.source_type, m.source_ref,
             bm25(memory_fts) as score
      from memory_fts
      join memories m on memory_fts.rowid = m.rowid
      where memory_fts match ? and m.status = 'active'
      order by score asc
      limit ?
    `).all(ftsQuery, limit) as FtsRow[];

    return rows.map((row) => ({ ...toMemory(row), ftsScore: row.score }));
  }
}

export function openPortiaDatabase(dbPath: string): PortiaDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  return new PortiaDatabase(dbPath, db);
}
