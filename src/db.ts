import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { buildSearchTerms, decodeSearchCursor, encodeSearchCursor, searchCursorFingerprint } from "./search.ts";
import type { SearchCursorAfter, SearchCursorPayload } from "./search.ts";

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
  MemoryListResult,
  MemoryPheromone,
  MemoryPheromoneSummary,
  MemoryRecord,
  MemorySearchFilters,
  MemorySearchResult,
  MemoryTraceEvent,
  PortiaDoctorCheck,
  PortiaReindexStats,
  PortiaSearchHit,
  PortiaSearchOrderBy,
  PortiaStats,
  RecordTraceEventInput,
  UpdateMemoryStatusInput,
  UpdateMemoryStatusResult,
} from "./types.ts";

const SCHEMA_VERSION = 3;
const MAX_BROWSE_LIMIT = 500;
const MAX_SEARCH_LIMIT = MAX_BROWSE_LIMIT;
const LIST_CURSOR_TYPE = "portia_list";
const SNIPPET_START_MARKER = "\u0001";
const SNIPPET_END_MARKER = "\u0002";
const MIN_PHEROMONE_STRENGTH = -5;
const MAX_PHEROMONE_STRENGTH = 20;
const EXPECTED_MEMORY_FTS_COLUMNS = ["title", "body", "scope_path", "kind", "source_type", "source_ref", "search_terms"] as const;
const EXPECTED_TABLE_COLUMNS: Record<string, readonly string[]> = {
  portia_meta: ["key", "value"],
  memories: [
    "id",
    "scope_path",
    "kind",
    "title",
    "body",
    "status",
    "importance",
    "confidence",
    "created_at",
    "updated_at",
    "created_by",
    "supersedes_id",
    "source_type",
    "source_ref",
    "search_terms",
  ],
  memory_events: ["id", "memory_id", "event_type", "payload_json", "created_at", "created_by"],
  memory_pheromones: [
    "memory_id",
    "strength",
    "exposed_count",
    "followed_count",
    "ignored_count",
    "success_count",
    "failure_count",
    "last_exposed_at",
    "last_followed_at",
    "last_ignored_at",
    "last_success_at",
    "last_failure_at",
    "last_decayed_at",
    "updated_at",
  ],
  memory_trace_events: [
    "id",
    "memory_id",
    "event_type",
    "scope_path",
    "tool_name",
    "tool_call_id",
    "session_file",
    "turn_id",
    "weight",
    "payload_json",
    "created_at",
  ],
  memory_edges: ["from_id", "to_id", "relation"],
  memory_fts: EXPECTED_MEMORY_FTS_COLUMNS,
};
const EXPECTED_MEMORY_FTS_TRIGGERS = ["memories_ai", "memories_ad", "memories_au"] as const;

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

interface SearchFtsRow extends FtsRow {
  title_snippet: string | null;
  body_snippet: string | null;
  scope_snippet: string | null;
  kind_snippet: string | null;
  source_type_snippet: string | null;
  source_ref_snippet: string | null;
}

interface ListCursorAfter {
  id: string;
  status: string;
  importance: number;
  updatedAt: string;
}

interface ListCursorPayload {
  v: 1;
  type: typeof LIST_CURSOR_TYPE;
  fingerprint: string;
  after: ListCursorAfter;
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

function clampSearchLimit(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(value)));
}

function clampBrowseLimit(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_BROWSE_LIMIT, Math.floor(value)));
}

function memoryColumn(alias: string, column: string): string {
  return alias ? `${alias}.${column}` : column;
}

function appendMemorySearchFilters(clauses: string[], params: Record<string, unknown>, filters: MemorySearchFilters, alias = "m"): void {
  const status = filters.status ?? "active";
  if (status !== "any") {
    clauses.push(`${memoryColumn(alias, "status")} = @status`);
    params.status = status;
  }

  if (filters.scopePath) {
    const scopeMode = filters.scopeMode ?? "subtree";
    if (scopeMode === "exact") {
      clauses.push(`${memoryColumn(alias, "scope_path")} = @scopePath`);
      params.scopePath = filters.scopePath;
    } else if (filters.scopePath !== ".") {
      clauses.push(`(${memoryColumn(alias, "scope_path")} = @scopePath or ${memoryColumn(alias, "scope_path")} like @scopePathPrefix escape '\\')`);
      params.scopePath = filters.scopePath;
      params.scopePathPrefix = `${escapeLike(filters.scopePath)}/%`;
    }
  }

  if (filters.kind) {
    clauses.push(`${memoryColumn(alias, "kind")} = @kind`);
    params.kind = filters.kind;
  }
}

function searchableTextSql(alias = "m"): string {
  const prefix = alias ? `${alias}.` : "";
  return `lower(
    coalesce(${prefix}title, '') || ' ' || ${prefix}body || ' ' || ${prefix}scope_path || ' ' || ${prefix}kind || ' ' ||
    coalesce(${prefix}source_type, '') || ' ' || coalesce(${prefix}source_ref, '') || ' ' || coalesce(${prefix}search_terms, '')
  )`;
}

function appendSubstringSearchFilter(clauses: string[], params: Record<string, unknown>, filters: MemorySearchFilters, alias = "m"): boolean {
  const matchMode = filters.matchMode ?? "all";
  const rawTerms = matchMode === "phrase"
    ? [filters.rawQuery ?? filters.terms?.join(" ") ?? ""]
    : (filters.terms && filters.terms.length > 0 ? filters.terms : [filters.rawQuery ?? ""]);
  const terms = rawTerms.map((term) => term.trim().toLowerCase()).filter(Boolean).slice(0, 20);
  if (terms.length === 0) return false;

  const searchableText = searchableTextSql(alias);
  const termClauses = terms.map((term, index) => {
    const key = `substring${index}`;
    params[key] = `%${escapeLike(term)}%`;
    return `${searchableText} like @${key} escape '\\'`;
  });

  clauses.push(matchMode === "any" ? `(${termClauses.join(" or ")})` : `(${termClauses.join(" and ")})`);
  return true;
}

function memorySearchOrderSql(orderBy: PortiaSearchOrderBy, alias = "m", relevanceColumn = "score"): string {
  const id = memoryColumn(alias, "id");
  const importance = memoryColumn(alias, "importance");
  const updatedAt = memoryColumn(alias, "updated_at");

  if (orderBy === "updated") return `${updatedAt} desc, ${id} asc`;
  if (orderBy === "importance") return `${importance} desc, ${updatedAt} desc, ${id} asc`;
  return `${relevanceColumn} asc, ${id} asc`;
}

function compareSearchHits(orderBy: PortiaSearchOrderBy, a: PortiaSearchHit, b: PortiaSearchHit): number {
  if (orderBy === "updated") return b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id);
  if (orderBy === "importance") {
    return b.memory.importance - a.memory.importance
      || b.memory.updatedAt.localeCompare(a.memory.updatedAt)
      || a.memory.id.localeCompare(b.memory.id);
  }

  return (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY)
    || a.memory.id.localeCompare(b.memory.id);
}

function formatVisibleSearchSnippet(snippet: string | null | undefined): string | undefined {
  if (!snippet?.includes(SNIPPET_START_MARKER)) return undefined;
  return snippet
    .replaceAll(SNIPPET_START_MARKER, "[")
    .replaceAll(SNIPPET_END_MARKER, "]");
}

function chooseVisibleSearchSnippet(row: SearchFtsRow): string | undefined {
  for (const snippet of [
    row.title_snippet,
    row.body_snippet,
    row.scope_snippet,
    row.kind_snippet,
    row.source_type_snippet,
    row.source_ref_snippet,
  ]) {
    const formatted = formatVisibleSearchSnippet(snippet);
    if (formatted) return formatted;
  }
  return undefined;
}

function requireCursorNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid Portia search cursor: missing ${label}.`);
  return value;
}

function requireCursorString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid Portia search cursor: missing ${label}.`);
  return value;
}

function appendSearchCursorClause(
  clauses: string[],
  params: Record<string, unknown>,
  after: SearchCursorAfter,
  orderBy: PortiaSearchOrderBy | "fallbackRelevance",
  alias = "",
): void {
  const id = memoryColumn(alias, "id");
  const updatedAt = memoryColumn(alias, "updated_at");
  const importance = memoryColumn(alias, "importance");
  params.cursorId = after.id;

  if (orderBy === "relevance") {
    const score = memoryColumn(alias, "score");
    params.cursorScore = requireCursorNumber(after.score, "relevance score");
    clauses.push(`(${score} > @cursorScore or (${score} = @cursorScore and ${id} > @cursorId))`);
    return;
  }

  if (orderBy === "updated") {
    params.cursorUpdatedAt = requireCursorString(after.updatedAt, "updated timestamp");
    clauses.push(`(${updatedAt} < @cursorUpdatedAt or (${updatedAt} = @cursorUpdatedAt and ${id} > @cursorId))`);
    return;
  }

  params.cursorImportance = requireCursorNumber(after.importance, "importance");
  params.cursorUpdatedAt = requireCursorString(after.updatedAt, "updated timestamp");
  clauses.push(`(${importance} < @cursorImportance or (${importance} = @cursorImportance and (${updatedAt} < @cursorUpdatedAt or (${updatedAt} = @cursorUpdatedAt and ${id} > @cursorId))))`);
}

function cursorAfterHit(hit: PortiaSearchHit): SearchCursorAfter {
  return {
    matchType: hit.matchType,
    id: hit.memory.id,
    score: hit.score,
    updatedAt: hit.memory.updatedAt,
    importance: hit.memory.importance,
  };
}

function encodeNextSearchCursor(fingerprint: string, orderBy: PortiaSearchOrderBy, hit: PortiaSearchHit): string {
  const payload: SearchCursorPayload = {
    v: 1,
    type: "portia_search",
    fingerprint,
    orderBy,
    after: cursorAfterHit(hit),
  };
  return encodeSearchCursor(payload);
}

function memorySelectSql(): string {
  return `
    select rowid, id, scope_path, kind, title, body, status, importance, confidence,
           created_at, updated_at, created_by, supersedes_id, source_type, source_ref
    from memories
  `;
}

function memoryStatusRank(status: string): number {
  if (status === "active") return 0;
  if (status === "stale") return 1;
  if (status === "superseded") return 2;
  if (status === "deleted") return 3;
  return 9;
}

function memoryStatusOrderSql(alias = ""): string {
  const status = memoryColumn(alias, "status");
  return `
    case ${status}
      when 'active' then 0
      when 'stale' then 1
      when 'superseded' then 2
      when 'deleted' then 3
      else 9
    end
  `;
}

function listCursorFingerprint(filters: MemoryListFilters): string {
  const normalized = {
    status: filters.status ?? undefined,
    scopePath: filters.scopePath ?? undefined,
    kind: filters.kind ?? undefined,
    query: filters.query?.trim().toLowerCase() || undefined,
    orderBy: "inventory",
  };

  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("base64url")
    .slice(0, 24);
}

function isListCursorAfter(value: unknown): value is ListCursorAfter {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ListCursorAfter;
  return typeof candidate.id === "string" && candidate.id.length > 0
    && typeof candidate.status === "string" && candidate.status.length > 0
    && typeof candidate.importance === "number" && Number.isFinite(candidate.importance)
    && typeof candidate.updatedAt === "string" && candidate.updatedAt.length > 0;
}

function encodeListCursor(payload: ListCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function decodeListCursor(cursor: string, expectedFingerprint: string): ListCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new Error("Invalid Portia list cursor: cursor is not valid encoded JSON.");
  }

  if (!parsed || typeof parsed !== "object") throw new Error("Invalid Portia list cursor: cursor payload is not an object.");
  const payload = parsed as ListCursorPayload;
  if (payload.v !== 1 || payload.type !== LIST_CURSOR_TYPE || !isListCursorAfter(payload.after)) {
    throw new Error("Invalid Portia list cursor: unsupported cursor payload.");
  }
  if (payload.fingerprint !== expectedFingerprint) {
    throw new Error("Invalid Portia list cursor: cursor does not match the current filters.");
  }

  return payload;
}

function listCursorAfterMemory(memory: MemoryRecord): ListCursorAfter {
  return {
    id: memory.id,
    status: memory.status,
    importance: memory.importance,
    updatedAt: memory.updatedAt,
  };
}

function encodeNextListCursor(fingerprint: string, memory: MemoryRecord): string {
  return encodeListCursor({
    v: 1,
    type: LIST_CURSOR_TYPE,
    fingerprint,
    after: listCursorAfterMemory(memory),
  });
}

function appendListCursorClause(clauses: string[], params: Record<string, unknown>, after: ListCursorAfter, alias = ""): void {
  const id = memoryColumn(alias, "id");
  const importance = memoryColumn(alias, "importance");
  const updatedAt = memoryColumn(alias, "updated_at");
  const statusRank = memoryStatusOrderSql(alias);
  params.cursorStatusRank = memoryStatusRank(after.status);
  params.cursorImportance = after.importance;
  params.cursorUpdatedAt = after.updatedAt;
  params.cursorId = after.id;
  clauses.push(`(
    ${statusRank} > @cursorStatusRank
    or (${statusRank} = @cursorStatusRank and (
      ${importance} < @cursorImportance
      or (${importance} = @cursorImportance and (
        ${updatedAt} < @cursorUpdatedAt
        or (${updatedAt} = @cursorUpdatedAt and ${id} > @cursorId)
      ))
    ))
  )`);
}

function appendMemoryListFilters(clauses: string[], params: Record<string, unknown>, filters: MemoryListFilters, alias = ""): void {
  if (filters.status && filters.status !== "any") {
    clauses.push(`${memoryColumn(alias, "status")} = @status`);
    params.status = filters.status;
  }

  if (filters.scopePath) {
    clauses.push(`${memoryColumn(alias, "scope_path")} = @scopePath`);
    params.scopePath = filters.scopePath;
  }

  if (filters.kind) {
    clauses.push(`${memoryColumn(alias, "kind")} = @kind`);
    params.kind = filters.kind;
  }

  if (filters.query?.trim()) {
    clauses.push(`
      lower(
        coalesce(${memoryColumn(alias, "title")}, '') || ' ' || ${memoryColumn(alias, "body")} || ' ' || ${memoryColumn(alias, "scope_path")} || ' ' || ${memoryColumn(alias, "kind")} || ' ' ||
        coalesce(${memoryColumn(alias, "source_type")}, '') || ' ' || coalesce(${memoryColumn(alias, "source_ref")}, '')
      ) like @query escape '\\'
    `);
    params.query = `%${escapeLike(filters.query.trim().toLowerCase())}%`;
  }
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

  const existingColumns = tableColumns(db, "memory_fts");
  return EXPECTED_MEMORY_FTS_COLUMNS.join("|") !== existingColumns.join("|");
}

function memoryFtsTriggersNeedRebuild(db: DatabaseConnection): boolean {
  const expectedNames = new Set<string>(EXPECTED_MEMORY_FTS_TRIGGERS);
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

function doctorCheck(name: string, status: PortiaDoctorCheck["status"], message: string, details?: Record<string, unknown>): PortiaDoctorCheck {
  return details ? { name, status, message, details } : { name, status, message };
}

function countSql(db: DatabaseConnection, sql: string): number {
  return (db.prepare(sql).get() as CountRow | undefined)?.count ?? 0;
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

  return updateSearchTerms(db, rows);
}

function updateSearchTerms(db: DatabaseConnection, rows: SearchTermsBackfillRow[]): number {
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

function recomputeAllSearchTerms(db: DatabaseConnection): number {
  const rows = db.prepare(`
    select rowid, scope_path, kind, title, body, source_type, source_ref
    from memories
    order by rowid asc
  `).all() as SearchTermsBackfillRow[];

  return updateSearchTerms(db, rows);
}

function ftsDocsizeCount(db: DatabaseConnection): number | undefined {
  const exists = countSql(db, "select count(*) as count from sqlite_master where type = 'table' and name = 'memory_fts_docsize'") > 0;
  if (!exists) return undefined;
  return countSql(db, "select count(*) as count from memory_fts_docsize");
}

function reindexStats(db: DatabaseConnection): PortiaReindexStats {
  return {
    memoryCount: countSql(db, "select count(*) as count from memories"),
    nullSearchTerms: countSql(db, "select count(*) as count from memories where search_terms is null"),
    ftsRows: ftsDocsizeCount(db),
  };
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

  listMemoryPage(filters: MemoryListFilters = {}): MemoryListResult {
    const limit = clampBrowseLimit(filters.limit, 30);
    const fingerprint = listCursorFingerprint(filters);
    const after = filters.cursor ? decodeListCursor(filters.cursor, fingerprint).after : undefined;
    const clauses: string[] = [];
    const params: Record<string, unknown> = {
      limit: limit + 1,
    };

    appendMemoryListFilters(clauses, params, filters);
    if (after) appendListCursorClause(clauses, params, after);

    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db.prepare(`
      ${memorySelectSql()}
      ${where}
      order by ${memoryStatusOrderSql()} asc, importance desc, updated_at desc, id asc
      limit @limit
    `).all(params) as MemoryRow[];

    const memories = rows.map(toMemory);
    const hasMore = memories.length > limit;
    const pageMemories = hasMore ? memories.slice(0, limit) : memories;
    const lastMemory = pageMemories.at(-1);

    return {
      memories: pageMemories,
      page: {
        limit,
        hasMore,
        nextCursor: hasMore && lastMemory ? encodeNextListCursor(fingerprint, lastMemory) : undefined,
      },
    };
  }

  listMemories(filters: MemoryListFilters = {}): MemoryRecord[] {
    return this.listMemoryPage(filters).memories;
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

  reindex(input: { dryRun?: boolean } = {}): { before: PortiaReindexStats; after?: PortiaReindexStats; recomputedSearchTerms: number; rebuiltFts: boolean; warnings: string[] } {
    const before = reindexStats(this.db);
    const warnings: string[] = [];

    if (input.dryRun) {
      if (before.ftsRows !== undefined && before.ftsRows !== before.memoryCount) {
        warnings.push(`FTS row count ${before.ftsRows} does not match memory count ${before.memoryCount}.`);
      }
      if (before.nullSearchTerms > 0) warnings.push(`${before.nullSearchTerms} memories have null search_terms.`);
      return { before, recomputedSearchTerms: 0, rebuiltFts: false, warnings };
    }

    const run = this.db.transaction(() => {
      ensureSearchTermsColumn(this.db);
      ensureMemoryFts(this.db);
      const recomputedSearchTerms = recomputeAllSearchTerms(this.db);
      rebuildMemoryFts(this.db);
      const after = reindexStats(this.db);
      return { recomputedSearchTerms, after };
    });

    const { recomputedSearchTerms, after } = run();
    if (after.ftsRows !== undefined && after.ftsRows !== after.memoryCount) {
      warnings.push(`FTS row count ${after.ftsRows} does not match memory count ${after.memoryCount} after rebuild.`);
    }
    if (after.nullSearchTerms > 0) warnings.push(`${after.nullSearchTerms} memories still have null search_terms after recompute.`);

    return { before, after, recomputedSearchTerms, rebuiltFts: true, warnings };
  }

  doctor(): { schemaVersion: number; checks: PortiaDoctorCheck[] } {
    const checks: PortiaDoctorCheck[] = [];
    const hasPortiaMeta = countSql(this.db, "select count(*) as count from sqlite_master where type = 'table' and name = 'portia_meta'") > 0;
    const schemaVersion = hasPortiaMeta
      ? Number(
        (this.db.prepare("select value from portia_meta where key = 'schema_version'").get() as { value?: string } | undefined)
          ?.value ?? 0,
      )
      : 0;

    checks.push(schemaVersion === SCHEMA_VERSION
      ? doctorCheck("schema_version", "ok", `Schema version ${schemaVersion} is current.`)
      : doctorCheck("schema_version", "error", `Schema version ${schemaVersion || "unknown"} does not match expected ${SCHEMA_VERSION}.`, {
        expected: SCHEMA_VERSION,
        actual: schemaVersion || undefined,
      }));

    const tableNames = new Set(
      (this.db.prepare("select name from sqlite_master where type = 'table'").all() as TableInfoRow[]).map((row) => row.name),
    );
    const expectedTables = Object.keys(EXPECTED_TABLE_COLUMNS);
    const missingTables = expectedTables.filter((table) => !tableNames.has(table));
    checks.push(missingTables.length === 0
      ? doctorCheck("tables", "ok", `All ${expectedTables.length} expected tables exist.`)
      : doctorCheck("tables", "error", `Missing expected tables: ${missingTables.join(", ")}.`, { missingTables }));

    for (const [tableName, expectedColumns] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
      if (!tableNames.has(tableName)) continue;
      const actualColumns = tableColumns(this.db, tableName);
      const missingColumns = expectedColumns.filter((column) => !actualColumns.includes(column));
      checks.push(missingColumns.length === 0
        ? doctorCheck(`columns:${tableName}`, "ok", `${tableName} columns are current.`)
        : doctorCheck(`columns:${tableName}`, "error", `${tableName} is missing columns: ${missingColumns.join(", ")}.`, {
          expectedColumns: [...expectedColumns],
          actualColumns,
          missingColumns,
        }));
    }

    const ftsAvailable = tableNames.has("memory_fts");
    checks.push(ftsAvailable
      ? doctorCheck("fts_available", "ok", "memory_fts table is available.")
      : doctorCheck("fts_available", "error", "memory_fts table is missing."));

    if (ftsAvailable && tableNames.has("memories") && tableNames.has("memory_fts_docsize")) {
      const memoryCount = countSql(this.db, "select count(*) as count from memories");
      const ftsDocCount = countSql(this.db, "select count(*) as count from memory_fts_docsize");
      const missingFtsRows = countSql(this.db, "select count(*) as count from memories m where m.rowid not in (select id from memory_fts_docsize)");
      const orphanFtsRows = countSql(this.db, "select count(*) as count from memory_fts_docsize d where d.id not in (select rowid from memories)");
      const consistent = memoryCount === ftsDocCount && missingFtsRows === 0 && orphanFtsRows === 0;
      checks.push(consistent
        ? doctorCheck("fts_row_consistency", "ok", `FTS docsize rows match ${memoryCount} memories.`)
        : doctorCheck("fts_row_consistency", "error", "FTS index row counts do not match memories; run reindex when available.", {
          memoryCount,
          ftsDocCount,
          missingFtsRows,
          orphanFtsRows,
        }));
    } else if (ftsAvailable && tableNames.has("memories")) {
      checks.push(doctorCheck("fts_row_consistency", "warning", "memory_fts_docsize shadow table is unavailable; row consistency could not be checked."));
    }

    const triggerRows = this.db.prepare(`
      select name, sql
      from sqlite_master
      where type = 'trigger' and name in ('memories_ai', 'memories_ad', 'memories_au')
    `).all() as TriggerSqlRow[];
    const triggerNames = new Set(triggerRows.map((row) => row.name));
    const missingTriggers = EXPECTED_MEMORY_FTS_TRIGGERS.filter((name) => !triggerNames.has(name));
    const outdatedTriggers = triggerRows
      .filter((row) => {
        const sql = row.sql ?? "";
        return !sql.includes("source_type") || !sql.includes("source_ref") || !sql.includes("search_terms");
      })
      .map((row) => row.name);
    checks.push(missingTriggers.length === 0 && outdatedTriggers.length === 0
      ? doctorCheck("fts_triggers", "ok", "FTS maintenance triggers are present and current.")
      : doctorCheck("fts_triggers", "error", "FTS maintenance triggers are missing or outdated.", {
        missingTriggers,
        outdatedTriggers,
      }));

    if (tableNames.has("memories") && tableColumns(this.db, "memories").includes("search_terms")) {
      const nullSearchTerms = countSql(this.db, "select count(*) as count from memories where search_terms is null");
      checks.push(nullSearchTerms === 0
        ? doctorCheck("search_terms", "ok", "All memories have generated search_terms values.")
        : doctorCheck("search_terms", "warning", `${nullSearchTerms} memories have null search_terms; run reindex when available.`, { nullSearchTerms }));
    }

    if (tableNames.has("memory_events") && tableNames.has("memories")) {
      const orphanedEvents = countSql(this.db, "select count(*) as count from memory_events e left join memories m on m.id = e.memory_id where m.id is null");
      checks.push(orphanedEvents === 0
        ? doctorCheck("orphaned_events", "ok", "No orphaned memory events found.")
        : doctorCheck("orphaned_events", "warning", `${orphanedEvents} memory events refer to missing memories.`, { orphanedEvents }));
    }

    if (tableNames.has("memory_pheromones") && tableNames.has("memories")) {
      const orphanedPheromones = countSql(this.db, "select count(*) as count from memory_pheromones p left join memories m on m.id = p.memory_id where m.id is null");
      checks.push(orphanedPheromones === 0
        ? doctorCheck("orphaned_pheromones", "ok", "No orphaned pheromone summaries found.")
        : doctorCheck("orphaned_pheromones", "warning", `${orphanedPheromones} pheromone summaries refer to missing memories.`, { orphanedPheromones }));
    }

    if (tableNames.has("memory_trace_events") && tableNames.has("memories")) {
      const orphanedTraceEvents = countSql(this.db, "select count(*) as count from memory_trace_events t left join memories m on m.id = t.memory_id where m.id is null");
      checks.push(orphanedTraceEvents === 0
        ? doctorCheck("orphaned_trace_events", "ok", "No orphaned pheromone trace events found.")
        : doctorCheck("orphaned_trace_events", "warning", `${orphanedTraceEvents} pheromone trace events refer to missing memories.`, { orphanedTraceEvents }));
    }

    if (tableNames.has("memory_edges") && tableNames.has("memories")) {
      const orphanedEdges = countSql(this.db, "select count(*) as count from memory_edges e left join memories fm on fm.id = e.from_id left join memories tm on tm.id = e.to_id where fm.id is null or tm.id is null");
      checks.push(orphanedEdges === 0
        ? doctorCheck("orphaned_edges", "ok", "No orphaned memory edges found.")
        : doctorCheck("orphaned_edges", "warning", `${orphanedEdges} memory edges refer to missing memories.`, { orphanedEdges }));
    }

    const foreignKeyViolations = (this.db.prepare("pragma foreign_key_check").all() as unknown[]).length;
    checks.push(foreignKeyViolations === 0
      ? doctorCheck("foreign_keys", "ok", "SQLite foreign key check passed.")
      : doctorCheck("foreign_keys", "error", `${foreignKeyViolations} SQLite foreign key violations found.`, { foreignKeyViolations }));

    const dbPathExists = fs.existsSync(this.dbPath);
    checks.push(dbPathExists
      ? doctorCheck("db_path", "ok", "Database path exists.", { dbPath: this.dbPath })
      : doctorCheck("db_path", "warning", "Database path does not exist on disk yet.", { dbPath: this.dbPath }));

    return { schemaVersion, checks };
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

  searchMemoryPage(filters: MemorySearchFilters): MemorySearchResult {
    const ftsQuery = filters.ftsQuery.trim();
    const limit = clampSearchLimit(filters.limit, 30);
    if (!ftsQuery) return { hits: [], page: { limit, hasMore: false } };

    const orderBy = filters.orderBy ?? "relevance";
    const includeSubstringFallback = filters.includeSubstringFallback ?? true;
    const fetchLimit = limit + 1;
    const fingerprint = searchCursorFingerprint(filters);
    const cursor = filters.cursor ? decodeSearchCursor(filters.cursor, fingerprint, orderBy) : undefined;
    const ftsHits: PortiaSearchHit[] = [];

    if (!(orderBy === "relevance" && cursor?.after.matchType === "substring")) {
      const ftsClauses = ["memory_fts match @ftsQuery"];
      const ftsOuterClauses: string[] = [];
      const ftsParams: Record<string, unknown> = { ftsQuery, limit: fetchLimit };
      appendMemorySearchFilters(ftsClauses, ftsParams, filters, "m");

      if (cursor) {
        if (orderBy === "relevance") appendSearchCursorClause(ftsOuterClauses, ftsParams, cursor.after, "relevance");
        else appendSearchCursorClause(ftsOuterClauses, ftsParams, cursor.after, orderBy);
      }

      const ftsOuterWhere = ftsOuterClauses.length > 0 ? `where ${ftsOuterClauses.join(" and ")}` : "";
      const ftsRows = this.db.prepare(`
        with ranked as (
          select m.rowid, m.id, m.scope_path, m.kind, m.title, m.body, m.status, m.importance, m.confidence,
                 m.created_at, m.updated_at, m.created_by, m.supersedes_id, m.source_type, m.source_ref,
                 bm25(memory_fts, 8.0, 1.0, 4.0, 2.0, 1.5, 3.0, 6.0) as score,
                 snippet(memory_fts, 0, char(1), char(2), '…', 24) as title_snippet,
                 snippet(memory_fts, 1, char(1), char(2), '…', 24) as body_snippet,
                 snippet(memory_fts, 2, char(1), char(2), '…', 24) as scope_snippet,
                 snippet(memory_fts, 3, char(1), char(2), '…', 24) as kind_snippet,
                 snippet(memory_fts, 4, char(1), char(2), '…', 24) as source_type_snippet,
                 snippet(memory_fts, 5, char(1), char(2), '…', 24) as source_ref_snippet
          from memory_fts
          join memories m on memory_fts.rowid = m.rowid
          where ${ftsClauses.join(" and ")}
        )
        select rowid, id, scope_path, kind, title, body, status, importance, confidence,
               created_at, updated_at, created_by, supersedes_id, source_type, source_ref,
               score, title_snippet, body_snippet, scope_snippet, kind_snippet, source_type_snippet, source_ref_snippet
        from ranked
        ${ftsOuterWhere}
        order by ${memorySearchOrderSql(orderBy, "")}
        limit @limit
      `).all(ftsParams) as SearchFtsRow[];

      ftsHits.push(...ftsRows.map((row) => ({
        memory: toMemory(row),
        matchType: "fts" as const,
        score: row.score,
        snippet: chooseVisibleSearchSnippet(row),
      })));
    }

    const hitsById = new Map<string, PortiaSearchHit>(ftsHits.map((hit) => [hit.memory.id, hit]));
    const fallbackHits: PortiaSearchHit[] = [];
    const fallbackFetchLimit = orderBy === "relevance" ? Math.max(0, fetchLimit - ftsHits.length) : fetchLimit;

    if (includeSubstringFallback && fallbackFetchLimit > 0) {
      const fallbackClauses: string[] = [];
      const fallbackParams: Record<string, unknown> = { ftsQuery, limit: fallbackFetchLimit };
      appendMemorySearchFilters(fallbackClauses, fallbackParams, filters, "m");
      const hasSubstringQuery = appendSubstringSearchFilter(fallbackClauses, fallbackParams, filters, "m");

      if (hasSubstringQuery) {
        fallbackClauses.push("m.rowid not in (select rowid from memory_fts where memory_fts match @ftsQuery)");

        if (cursor) {
          if (orderBy === "relevance") {
            if (cursor.after.matchType === "substring") appendSearchCursorClause(fallbackClauses, fallbackParams, cursor.after, "fallbackRelevance", "m");
          } else {
            appendSearchCursorClause(fallbackClauses, fallbackParams, cursor.after, orderBy, "m");
          }
        }

        const excludedIds = [...hitsById.keys()];
        if (excludedIds.length > 0) {
          const excludedPlaceholders = excludedIds.map((id, index) => {
            const key = `excluded${index}`;
            fallbackParams[key] = id;
            return `@${key}`;
          });
          fallbackClauses.push(`m.id not in (${excludedPlaceholders.join(", ")})`);
        }

        const where = fallbackClauses.length > 0 ? `where ${fallbackClauses.join(" and ")}` : "";
        const fallbackOrder = orderBy === "relevance"
          ? "m.importance desc, m.updated_at desc, m.id asc"
          : memorySearchOrderSql(orderBy, "m");
        const fallbackRows = this.db.prepare(`
          select m.rowid, m.id, m.scope_path, m.kind, m.title, m.body, m.status, m.importance, m.confidence,
                 m.created_at, m.updated_at, m.created_by, m.supersedes_id, m.source_type, m.source_ref
          from memories m
          ${where}
          order by ${fallbackOrder}
          limit @limit
        `).all(fallbackParams) as MemoryRow[];

        for (const row of fallbackRows) {
          const hit: PortiaSearchHit = { memory: toMemory(row), matchType: "substring" };
          if (!hitsById.has(hit.memory.id)) {
            hitsById.set(hit.memory.id, hit);
            fallbackHits.push(hit);
          }
        }
      }
    }

    const combined = orderBy === "relevance"
      ? [...ftsHits, ...fallbackHits]
      : [...hitsById.values()].sort((a, b) => compareSearchHits(orderBy, a, b));
    const hits = combined.slice(0, limit);
    const hasMore = combined.length > limit;
    const lastHit = hits.at(-1);
    const nextCursor = hasMore && lastHit ? encodeNextSearchCursor(fingerprint, orderBy, lastHit) : undefined;

    return {
      hits,
      page: {
        limit,
        hasMore,
        nextCursor,
      },
    };
  }

  searchMemoryHits(filters: MemorySearchFilters): PortiaSearchHit[] {
    return this.searchMemoryPage(filters).hits;
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

export function openPortiaDatabaseReadOnly(dbPath: string): PortiaDatabase {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("foreign_keys = ON");
  return new PortiaDatabase(dbPath, db);
}
