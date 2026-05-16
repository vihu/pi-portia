import * as path from "node:path";
import type { PortiaDatabase } from "./db.ts";
import { MEMORY_KINDS, MEMORY_STATUSES } from "./types.ts";
import { isPathInside, normalizeScopePath, toProjectRelative } from "./root.ts";
import type { MemoryKind, MemoryListStatus, PortiaListResult, PortiaSettings } from "./types.ts";

const DEFAULT_LIST_LIMIT = 30;
const DEFAULT_LIST_MAX_RESULTS = 250;
const MAX_QUERY_LENGTH = 500;
const MAX_CURSOR_LENGTH = 4_000;

export interface PortiaListInput {
  status?: MemoryListStatus;
  scopePath?: string;
  kind?: MemoryKind | string;
  query?: string;
  limit?: number;
  cursor?: string;
}

function stripAtPrefix(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

function trimOptional(value: string | undefined, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error(`${label} is too long; maximum is ${maxLength} characters.`);
  return trimmed;
}

function parseStatus(value: string | undefined): MemoryListStatus {
  if (!value) return "active";
  const normalized = value.trim().toLowerCase();
  if (normalized === "all" || normalized === "any") return "any";
  if ((MEMORY_STATUSES as readonly string[]).includes(normalized)) return normalized as MemoryListStatus;
  throw new Error(`Invalid Portia memory status: ${value}`);
}

function parseKind(value: string | undefined): MemoryKind | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if ((MEMORY_KINDS as readonly string[]).includes(normalized)) return normalized as MemoryKind;
  throw new Error(`Invalid Portia memory kind: ${value}`);
}

function parseLimit(settings: PortiaSettings, value: number | undefined, warnings: string[]): number {
  const defaultLimit = settings.listDefaultLimit ?? DEFAULT_LIST_LIMIT;
  const maxResults = settings.listMaxResults ?? DEFAULT_LIST_MAX_RESULTS;
  if (value === undefined) return defaultLimit;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Portia list limit must be a positive integer.");
  if (value > maxResults) {
    warnings.push(`Requested limit ${value} exceeds portia.listMaxResults ${maxResults}; using ${maxResults}.`);
    return maxResults;
  }
  return value;
}

function resolveScopePath(settings: PortiaSettings, cwd: string, inputScopePath: string): string {
  const raw = stripAtPrefix(inputScopePath.trim() || ".");
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(cwd, raw);

  if (!isPathInside(settings.projectRoot, absolutePath)) {
    throw new Error(`Scope path is outside the Portia project root: ${inputScopePath}`);
  }

  return normalizeScopePath(toProjectRelative(settings.projectRoot, absolutePath));
}

export function listPortiaMemories(db: PortiaDatabase, settings: PortiaSettings, input: PortiaListInput, cwd: string): PortiaListResult {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const status = parseStatus(input.status);
  const kind = parseKind(input.kind);
  const scopePath = input.scopePath ? resolveScopePath(settings, cwd, input.scopePath) : undefined;
  const query = trimOptional(input.query, MAX_QUERY_LENGTH, "Portia list query");
  const warnings: string[] = [];
  const limit = parseLimit(settings, input.limit, warnings);
  const cursor = trimOptional(input.cursor, MAX_CURSOR_LENGTH, "Portia list cursor");

  const result = db.listMemoryPage({
    status,
    scopePath,
    kind,
    query,
    limit,
    cursor,
  });

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    filters: {
      status,
      scopePath,
      kind,
      query,
      limit: result.page.limit,
      cursor,
    },
    memories: result.memories,
    page: result.page,
    warnings,
  };
}
