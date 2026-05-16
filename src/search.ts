import { createHash } from "node:crypto";
import * as path from "node:path";
import type { PortiaDatabase } from "./db.ts";
import { isPathInside, normalizeScopePath, toProjectRelative } from "./root.ts";
import { MEMORY_KINDS, MEMORY_STATUSES } from "./types.ts";
import type {
  MemoryKind,
  MemoryListStatus,
  MemorySearchFilters,
  PortiaSearchInput,
  PortiaSearchMatchMode,
  PortiaSearchMatchType,
  PortiaSearchOrderBy,
  PortiaSearchOutput,
  PortiaSearchScopeMode,
  PortiaSettings,
} from "./types.ts";

export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_SEARCH_TERMS_LENGTH = 2_000;
export const SEARCH_CURSOR_TYPE = "portia_search";

const DEFAULT_SEARCH_LIMIT = 30;
const DEFAULT_SEARCH_MAX_RESULTS = 250;
const MAX_CURSOR_LENGTH = 4_000;
const SEARCH_STATUSES = new Set<string>([...MEMORY_STATUSES, "all", "any"]);
const SEARCH_SCOPE_MODES = new Set<string>(["subtree", "exact"]);
const SEARCH_ORDER_BYS = new Set<string>(["relevance", "updated", "importance"]);
const SEARCH_MATCH_MODES = new Set<string>(["all", "any", "phrase"]);

export type SafeFtsQueryIssue = "empty" | "too_long";

export interface SafeFtsQuery {
  rawQuery: string;
  expression: string;
  terms: string[];
  matchMode: PortiaSearchMatchMode;
}

export interface SafeFtsQueryError {
  reason: SafeFtsQueryIssue;
  message: string;
}

export type SafeFtsQueryResult =
  | { ok: true; query: SafeFtsQuery; warnings: string[] }
  | { ok: false; error: SafeFtsQueryError; warnings: string[] };

export interface BuildSafeFtsQueryOptions {
  matchMode?: PortiaSearchMatchMode;
  maxLength?: number;
}

export interface SearchTermsInput {
  scopePath: string;
  kind: string;
  title?: string | null;
  body?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
}

export interface SearchCursorAfter {
  matchType: PortiaSearchMatchType;
  id: string;
  score?: number;
  updatedAt?: string;
  importance?: number;
}

export interface SearchCursorPayload {
  v: 1;
  type: typeof SEARCH_CURSOR_TYPE;
  fingerprint: string;
  orderBy: PortiaSearchOrderBy;
  after: SearchCursorAfter;
}

interface SearchCursorFingerprintInput {
  ftsQuery: string;
  rawQuery?: string;
  terms?: string[];
  status?: MemoryListStatus;
  scopePath?: string;
  scopeMode?: PortiaSearchScopeMode;
  kind?: string;
  orderBy?: PortiaSearchOrderBy;
  matchMode?: PortiaSearchMatchMode;
  includeSubstringFallback?: boolean;
}

function stripAtPrefix(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

function parseSearchStatus(value: string | undefined): MemoryListStatus {
  if (!value) return "active";
  const normalized = value.trim().toLowerCase();
  if (normalized === "all" || normalized === "any") return "any";
  if ((MEMORY_STATUSES as readonly string[]).includes(normalized)) return normalized as MemoryListStatus;
  throw new Error(`Invalid Portia search status: ${value}`);
}

function parseSearchKind(value: string | undefined): MemoryKind | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if ((MEMORY_KINDS as readonly string[]).includes(normalized)) return normalized as MemoryKind;
  throw new Error(`Invalid Portia memory kind: ${value}`);
}

function parseSearchScopeMode(value: string | undefined): PortiaSearchScopeMode {
  if (!value) return "subtree";
  const normalized = value.trim().toLowerCase();
  if (SEARCH_SCOPE_MODES.has(normalized)) return normalized as PortiaSearchScopeMode;
  throw new Error(`Invalid Portia search scopeMode: ${value}`);
}

function parseSearchOrderBy(value: string | undefined): PortiaSearchOrderBy {
  if (!value) return "relevance";
  const normalized = value.trim().toLowerCase();
  if (SEARCH_ORDER_BYS.has(normalized)) return normalized as PortiaSearchOrderBy;
  throw new Error(`Invalid Portia search orderBy: ${value}`);
}

function parseSearchMatchMode(value: string | undefined): PortiaSearchMatchMode {
  if (!value) return "all";
  const normalized = value.trim().toLowerCase();
  if (SEARCH_MATCH_MODES.has(normalized)) return normalized as PortiaSearchMatchMode;
  throw new Error(`Invalid Portia search matchMode: ${value}`);
}

function parseSearchLimit(settings: PortiaSettings, value: number | undefined, warnings: string[]): number {
  const defaultLimit = settings.searchDefaultLimit ?? DEFAULT_SEARCH_LIMIT;
  const maxResults = settings.searchMaxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
  if (value === undefined) return defaultLimit;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Portia search limit must be a positive integer.");
  if (value > maxResults) {
    warnings.push(`Requested limit ${value} exceeds portia.searchMaxResults ${maxResults}; using ${maxResults}.`);
    return maxResults;
  }
  return value;
}

function trimOptional(value: string | undefined, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error(`${label} is too long; maximum is ${maxLength} characters.`);
  return trimmed;
}

function resolveSearchScopePath(settings: PortiaSettings, cwd: string, inputScopePath: string): string {
  const raw = stripAtPrefix(inputScopePath.trim() || ".");
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(cwd, raw);

  if (!isPathInside(settings.projectRoot, absolutePath)) {
    throw new Error(`Scope path is outside the Portia project root: ${inputScopePath}`);
  }

  return normalizeScopePath(toProjectRelative(settings.projectRoot, absolutePath));
}

function parseCommandBoolean(value: string | undefined, label: string): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  throw new Error(`Usage: /portia-search ${label} <true|false>`);
}

function requireNextToken(tokens: string[], index: number, usage: string): string {
  const value = tokens[index + 1];
  if (!value) throw new Error(usage);
  return value;
}

function pushTerm(terms: string[], term: string): void {
  const trimmed = term.trim();
  if (trimmed) terms.push(trimmed);
}

function splitCamelCaseToken(token: string): string[] {
  return token
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function addSearchTerm(terms: Set<string>, value: string): void {
  const normalized = value.toLowerCase().trim();
  if (normalized.length >= 2) terms.add(normalized);
}

function normalizeFingerprintInput(input: SearchCursorFingerprintInput): SearchCursorFingerprintInput {
  return {
    ftsQuery: input.ftsQuery.trim(),
    rawQuery: input.rawQuery?.trim() || undefined,
    terms: input.terms?.map((term) => term.trim()).filter(Boolean) ?? [],
    status: input.status ?? "active",
    scopePath: input.scopePath ?? undefined,
    scopeMode: input.scopeMode ?? "subtree",
    kind: input.kind ?? undefined,
    orderBy: input.orderBy ?? "relevance",
    matchMode: input.matchMode ?? "all",
    includeSubstringFallback: input.includeSubstringFallback ?? true,
  };
}

export function searchCursorFingerprint(input: MemorySearchFilters): string {
  const normalized = normalizeFingerprintInput({
    ftsQuery: input.ftsQuery,
    rawQuery: input.rawQuery,
    terms: input.terms,
    status: input.status,
    scopePath: input.scopePath,
    scopeMode: input.scopeMode,
    kind: input.kind,
    orderBy: input.orderBy,
    matchMode: input.matchMode,
    includeSubstringFallback: input.includeSubstringFallback,
  });

  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("base64url")
    .slice(0, 24);
}

function isSearchCursorAfter(value: unknown): value is SearchCursorAfter {
  if (!value || typeof value !== "object") return false;
  const candidate = value as SearchCursorAfter;
  return (candidate.matchType === "fts" || candidate.matchType === "substring") && typeof candidate.id === "string" && candidate.id.length > 0;
}

export function encodeSearchCursor(payload: SearchCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

export function decodeSearchCursor(cursor: string, expectedFingerprint: string, expectedOrderBy: PortiaSearchOrderBy): SearchCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw new Error("Invalid Portia search cursor: cursor is not valid encoded JSON.");
  }

  if (!parsed || typeof parsed !== "object") throw new Error("Invalid Portia search cursor: cursor payload is not an object.");
  const payload = parsed as SearchCursorPayload;
  if (payload.v !== 1 || payload.type !== SEARCH_CURSOR_TYPE || !isSearchCursorAfter(payload.after)) {
    throw new Error("Invalid Portia search cursor: unsupported cursor payload.");
  }
  if (payload.fingerprint !== expectedFingerprint) {
    throw new Error("Invalid Portia search cursor: cursor does not match the current query and filters.");
  }
  if (payload.orderBy !== expectedOrderBy) {
    throw new Error("Invalid Portia search cursor: cursor order does not match the current search order.");
  }

  return payload;
}

export function buildSearchTerms(input: SearchTermsInput): string {
  const terms = new Set<string>();
  const text = [
    input.title,
    input.body,
    input.scopePath,
    input.kind,
    input.sourceType,
    input.sourceRef,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");

  const codeLikeTokens = text.match(/[\p{L}\p{N}_./:@-]+/gu) ?? [];
  for (const token of codeLikeTokens) {
    const parts = token.split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
    const tokenIsCodeLike = parts.length > 1 || /[\p{Ll}\p{N}][\p{Lu}]/u.test(token);
    if (!tokenIsCodeLike) continue;

    addSearchTerm(terms, token.replace(/[^\p{L}\p{N}]+/gu, ""));
    for (const part of parts) {
      addSearchTerm(terms, part);
      const camelParts = splitCamelCaseToken(part);
      if (camelParts.length > 1) {
        for (const camelPart of camelParts) addSearchTerm(terms, camelPart);
      }
    }
  }

  let output = "";
  for (const term of terms) {
    if (output.length + term.length + 1 > MAX_SEARCH_TERMS_LENGTH) break;
    output += output ? ` ${term}` : term;
  }

  return output;
}

export function parsePlainSearchTerms(input: string): string[] {
  const terms: string[] = [];
  let current = "";
  let inQuote = false;

  for (const char of input) {
    if (char === '"') {
      if (inQuote) {
        pushTerm(terms, current);
        current = "";
        inQuote = false;
      } else {
        pushTerm(terms, current);
        current = "";
        inQuote = true;
      }
      continue;
    }

    if (!inQuote && /\s/u.test(char)) {
      pushTerm(terms, current);
      current = "";
      continue;
    }

    current += char;
  }

  pushTerm(terms, current);
  return terms;
}

export function quoteFts5Literal(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildSafeFtsQuery(input: string, options: BuildSafeFtsQueryOptions = {}): SafeFtsQueryResult {
  const rawQuery = input.trim();
  const maxLength = options.maxLength ?? MAX_SEARCH_QUERY_LENGTH;
  const matchMode = options.matchMode ?? "all";

  if (!rawQuery) {
    return {
      ok: false,
      error: {
        reason: "empty",
        message: "Search query is empty.",
      },
      warnings: [],
    };
  }

  if (rawQuery.length > maxLength) {
    return {
      ok: false,
      error: {
        reason: "too_long",
        message: `Search query is too long; maximum is ${maxLength} characters.`,
      },
      warnings: [],
    };
  }

  const terms = matchMode === "phrase" ? [rawQuery] : parsePlainSearchTerms(rawQuery);
  if (terms.length === 0) {
    return {
      ok: false,
      error: {
        reason: "empty",
        message: "Search query did not contain any searchable terms.",
      },
      warnings: [],
    };
  }

  const quotedTerms = terms.map(quoteFts5Literal);
  const expression = matchMode === "any"
    ? quotedTerms.join(" OR ")
    : quotedTerms.join(" ");

  return {
    ok: true,
    query: {
      rawQuery,
      expression,
      terms,
      matchMode,
    },
    warnings: [],
  };
}

export function parsePortiaSearchCommandArgs(args: string): PortiaSearchInput {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const input: Partial<PortiaSearchInput> = {};
  let index = 0;

  if (tokens[index] && SEARCH_STATUSES.has(tokens[index].toLowerCase())) {
    input.status = parseSearchStatus(tokens[index].toLowerCase());
    index += 1;
  }

  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();

    if (token === "query") {
      input.query = tokens.slice(index + 1).join(" ").trim();
      break;
    }

    if (token === "status") {
      input.status = parseSearchStatus(requireNextToken(tokens, index, "Usage: /portia-search status <active|stale|superseded|deleted|any>"));
      index += 2;
      continue;
    }

    if (SEARCH_STATUSES.has(token)) {
      input.status = parseSearchStatus(token);
      index += 1;
      continue;
    }

    if (token === "scope") {
      input.scopePath = requireNextToken(tokens, index, "Usage: /portia-search scope <path>");
      index += 2;
      continue;
    }

    if (token === "scope-mode" || token === "scopemode") {
      input.scopeMode = parseSearchScopeMode(requireNextToken(tokens, index, "Usage: /portia-search scope-mode <subtree|exact>"));
      index += 2;
      continue;
    }

    if (token === "kind") {
      input.kind = requireNextToken(tokens, index, "Usage: /portia-search kind <kind>");
      index += 2;
      continue;
    }

    if (token === "order" || token === "orderby" || token === "sort") {
      input.orderBy = parseSearchOrderBy(requireNextToken(tokens, index, "Usage: /portia-search order <relevance|updated|importance>"));
      index += 2;
      continue;
    }

    if (token === "match" || token === "matchmode" || token === "mode") {
      input.matchMode = parseSearchMatchMode(requireNextToken(tokens, index, "Usage: /portia-search match <all|any|phrase>"));
      index += 2;
      continue;
    }

    if (token === "limit") {
      const value = Number(requireNextToken(tokens, index, "Usage: /portia-search limit <positive integer>"));
      if (!Number.isInteger(value)) throw new Error("Usage: /portia-search limit <positive integer>");
      input.limit = value;
      index += 2;
      continue;
    }

    if (token === "cursor") {
      input.cursor = requireNextToken(tokens, index, "Usage: /portia-search cursor <cursor> query <text>");
      index += 2;
      continue;
    }

    if (token === "fallback" || token === "substring-fallback") {
      const next = tokens[index + 1];
      const hasExplicitValue = next !== undefined && /^(true|false|yes|no|on|off|1|0)$/i.test(next);
      input.includeSubstringFallback = parseCommandBoolean(hasExplicitValue ? next : undefined, token);
      index += hasExplicitValue ? 2 : 1;
      continue;
    }

    if (token === "no-fallback" || token === "no-substring-fallback") {
      input.includeSubstringFallback = false;
      index += 1;
      continue;
    }

    input.query = tokens.slice(index).join(" ").trim();
    break;
  }

  if (!input.query?.trim()) {
    if (input.cursor) throw new Error("Usage: /portia-search cursor <cursor> query <text> (repeat the same query and filters used for the previous page)");
    throw new Error("Usage: /portia-search [status] [scope <path>] [kind <kind>] [limit <n>] [query] <text>");
  }

  return input as PortiaSearchInput;
}

export function searchPortiaMemories(db: PortiaDatabase, settings: PortiaSettings, input: PortiaSearchInput, cwd: string): PortiaSearchOutput {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const warnings: string[] = [];
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const status = parseSearchStatus(input.status);
  const kind = parseSearchKind(input.kind);
  const scopePath = input.scopePath ? resolveSearchScopePath(settings, cwd, input.scopePath) : undefined;
  const scopeMode = parseSearchScopeMode(input.scopeMode);
  const orderBy = parseSearchOrderBy(input.orderBy);
  const matchMode = parseSearchMatchMode(input.matchMode);
  const includeSubstringFallback = input.includeSubstringFallback ?? true;
  const limit = parseSearchLimit(settings, input.limit, warnings);
  const cursor = trimOptional(input.cursor, MAX_CURSOR_LENGTH, "Portia search cursor");
  const built = buildSafeFtsQuery(query, { matchMode });

  if (!built.ok) throw new Error(built.error.message);
  warnings.push(...built.warnings);

  const result = db.searchMemoryPage({
    ftsQuery: built.query.expression,
    rawQuery: built.query.rawQuery,
    terms: built.query.terms,
    status,
    scopePath,
    scopeMode,
    kind,
    orderBy,
    matchMode,
    includeSubstringFallback,
    limit,
    cursor,
  });

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    filters: {
      query: built.query.rawQuery,
      status,
      scopePath,
      scopeMode,
      kind,
      orderBy,
      matchMode,
      includeSubstringFallback,
      limit: result.page.limit,
      cursor,
    },
    hits: result.hits,
    page: result.page,
    warnings,
  };
}
