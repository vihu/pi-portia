import type { PortiaSearchMatchMode } from "./types.ts";

export const MAX_SEARCH_QUERY_LENGTH = 500;

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

function pushTerm(terms: string[], term: string): void {
  const trimmed = term.trim();
  if (trimmed) terms.push(trimmed);
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
