import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

type DatabaseConnection = InstanceType<typeof Database>;
import type { CreateMemoryInput, CreateMemoryResult, MemoryEvent, MemoryRecord, PortiaStats } from "./types.ts";

const SCHEMA_VERSION = 1;

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
        source_ref text
      );

      create index if not exists memories_status_scope_idx on memories(status, scope_path);
      create index if not exists memories_kind_idx on memories(kind);
      create index if not exists memories_updated_idx on memories(updated_at);

      create virtual table if not exists memory_fts using fts5(
        title,
        body,
        scope_path,
        kind,
        content='memories',
        content_rowid='rowid'
      );

      create trigger if not exists memories_ai after insert on memories begin
        insert into memory_fts(rowid, title, body, scope_path, kind)
        values (new.rowid, new.title, new.body, new.scope_path, new.kind);
      end;

      create trigger if not exists memories_ad after delete on memories begin
        insert into memory_fts(memory_fts, rowid, title, body, scope_path, kind)
        values ('delete', old.rowid, old.title, old.body, old.scope_path, old.kind);
      end;

      create trigger if not exists memories_au after update on memories begin
        insert into memory_fts(memory_fts, rowid, title, body, scope_path, kind)
        values ('delete', old.rowid, old.title, old.body, old.scope_path, old.kind);
        insert into memory_fts(rowid, title, body, scope_path, kind)
        values (new.rowid, new.title, new.body, new.scope_path, new.kind);
      end;

      create table if not exists memory_events (
        id text primary key,
        memory_id text not null,
        event_type text not null,
        payload_json text not null,
        created_at text not null,
        created_by text
      );

      create index if not exists memory_events_memory_idx on memory_events(memory_id, created_at);

      create table if not exists memory_edges (
        from_id text not null,
        to_id text not null,
        relation text not null,
        primary key (from_id, to_id, relation)
      );
    `);

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

  private getMemoryById(id: string): MemoryRecord {
    const row = this.db.prepare(`
      select rowid, id, scope_path, kind, title, body, status, importance, confidence,
             created_at, updated_at, created_by, supersedes_id, source_type, source_ref
      from memories
      where id = ?
    `).get(id) as MemoryRow | undefined;

    if (!row) throw new Error(`Portia memory was not found after write: ${id}`);
    return toMemory(row);
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

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        insert into memories (
          id, scope_path, kind, title, body, status, importance, confidence,
          created_at, updated_at, created_by, supersedes_id, source_type, source_ref
        ) values (
          @id, @scopePath, @kind, @title, @body, 'active', @importance, @confidence,
          @createdAt, @updatedAt, @createdBy, @supersedesId, @sourceType, @sourceRef
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
        memory: this.getMemoryById(id),
        event: this.getEventById(eventId),
      };
    });

    return insert();
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
