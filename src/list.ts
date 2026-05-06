import * as path from "node:path";
import type { PortiaDatabase } from "./db.ts";
import { MEMORY_KINDS, MEMORY_STATUSES } from "./types.ts";
import { isPathInside, normalizeScopePath, toProjectRelative } from "./root.ts";
import type { MemoryKind, MemoryListStatus, PortiaListResult, PortiaSettings } from "./types.ts";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_QUERY_LENGTH = 500;

export interface PortiaListInput {
  status?: MemoryListStatus;
  scopePath?: string;
  kind?: MemoryKind | string;
  query?: string;
  limit?: number;
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

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Portia list limit must be a positive integer.");
  return Math.min(value, MAX_LIST_LIMIT);
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
  const limit = parseLimit(input.limit);
  const warnings: string[] = [];

  const memories = db.listMemories({
    status,
    scopePath,
    kind,
    query,
    limit,
  });

  if (memories.length === limit) warnings.push("Result limit reached; narrow the query or increase the tool limit if needed.");

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    filters: {
      status,
      scopePath,
      kind,
      query,
      limit,
    },
    memories,
    warnings,
  };
}
