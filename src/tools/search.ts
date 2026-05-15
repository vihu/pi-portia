import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePortiaSettings } from "../config.ts";
import { openPortiaDatabase } from "../db.ts";
import { renderSearch } from "../render.ts";
import { searchPortiaMemories } from "../search.ts";
import type { PortiaSearchInput } from "../types.ts";

export const PortiaSearchParams = Type.Object({
  query: Type.String({
    description: "Plain-text search query. Terms are safely quoted for FTS5; raw FTS syntax is not exposed by default.",
  }),
  status: Type.Optional(Type.Union([
    Type.Literal("active"),
    Type.Literal("stale"),
    Type.Literal("superseded"),
    Type.Literal("deleted"),
    Type.Literal("any"),
  ], {
    description: "Memory status filter. Defaults to active; use any to include all statuses.",
  })),
  scopePath: Type.Optional(Type.String({
    description: "Optional project path/scope filter. A leading @ is accepted and stripped.",
  })),
  scopeMode: Type.Optional(Type.Union([
    Type.Literal("subtree"),
    Type.Literal("exact"),
  ], {
    description: "How scopePath is matched. Defaults to subtree.",
  })),
  kind: Type.Optional(Type.Union([
    Type.Literal("purpose"),
    Type.Literal("pointer"),
    Type.Literal("invariant"),
    Type.Literal("gotcha"),
    Type.Literal("decision"),
    Type.Literal("pattern"),
    Type.Literal("plan"),
  ], {
    description: "Optional Portia memory kind filter.",
  })),
  orderBy: Type.Optional(Type.Union([
    Type.Literal("relevance"),
    Type.Literal("updated"),
    Type.Literal("importance"),
  ], {
    description: "Search result ordering. Defaults to relevance.",
  })),
  matchMode: Type.Optional(Type.Union([
    Type.Literal("all"),
    Type.Literal("any"),
    Type.Literal("phrase"),
  ], {
    description: "Term matching mode. Defaults to all; use any for broader recall or phrase for an exact phrase.",
  })),
  includeSubstringFallback: Type.Optional(Type.Boolean({
    description: "Whether to include substring fallback matches after FTS matches. Defaults to true.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum hits to return. Defaults to portia.searchDefaultLimit and is capped by portia.searchMaxResults.",
  })),
  cursor: Type.Optional(Type.String({
    description: "Opaque nextCursor from a previous portia_search page. Repeat the same query and filters when using it.",
  })),
});

export function registerPortiaSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "portia_search",
    label: "Portia Search",
    description: "Search project-local Portia memories with safe FTS5 queries, filters, ranking, and cursor pagination. Read-only.",
    promptSnippet: "Search project-local Portia memories with safe FTS, filters, and cursor pagination",
    promptGuidelines: [
      "Use portia_search for explicit keyword search across Portia memories, especially in long sessions where portia_sense is too bounded.",
      "Use portia_sense for compact path/task context before unfamiliar work; use portia_search to find candidate memories by text.",
      "Use portia_inspect after search when provenance, event history, or full body details matter.",
      "Treat search hits as pointers; verify referenced files and commands before relying on them.",
      "Use nextCursor with the same query and filters to continue browsing additional pages.",
    ],
    parameters: PortiaSearchParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const settings = resolvePortiaSettings(ctx.cwd);
      if (!settings.enabled) {
        return {
          content: [{ type: "text" as const, text: "Portia is disabled for this project/session." }],
          details: { enabled: false, projectRoot: settings.projectRoot, modeOverride: settings.modeOverride },
        };
      }

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const result = searchPortiaMemories(db, settings, params as PortiaSearchInput, ctx.cwd);
        return {
          content: [{ type: "text" as const, text: renderSearch(result) }],
          details: result,
        };
      } finally {
        db.close();
      }
    },
  });
}
