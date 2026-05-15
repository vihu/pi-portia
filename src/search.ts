import type { PortiaSearchMatchMode } from "./types.ts";

export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_SEARCH_TERMS_LENGTH = 2_000;

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
