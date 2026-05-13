import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePortiaSettings } from "../config.ts";
import { openPortiaDatabase } from "../db.ts";
import { listPortiaMemories } from "../list.ts";
import { renderMemoryList } from "../render.ts";
import type { PortiaListInput } from "../list.ts";

export const PortiaListParams = Type.Object({
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
  query: Type.Optional(Type.String({
    description: "Optional case-insensitive query over title, body, scope, kind, and provenance.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum memories to list. Defaults to 20; capped at 100.",
  })),
});

export function registerPortiaListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "portia_list",
    label: "Portia List",
    description: "List project-local Portia memories with status, scope, kind, and query filters. Read-only.",
    promptSnippet: "List project-local Portia memories for inspection, audit, and duplicate checks",
    promptGuidelines: [
      "Use portia_list when you need to understand what durable Portia memories exist before recording or repairing memory.",
      "Use portia_inspect for full provenance and event history of a specific memory id.",
      "Treat listed memories as pointers; verify source files and commands before relying on them.",
    ],
    parameters: PortiaListParams,

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
        const result = listPortiaMemories(db, settings, params as PortiaListInput, ctx.cwd);
        return {
          content: [{ type: "text" as const, text: renderMemoryList(result) }],
          details: result,
        };
      } finally {
        db.close();
      }
    },
  });
}
