import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolvePortiaSettings } from "../config.ts";
import { openPortiaDatabase } from "../db.ts";
import { renderSense } from "../render.ts";
import { senseMemories } from "../retrieval.ts";

export const PortiaSenseParams = Type.Object({
  path: Type.String({
    description: "Project path to sense around. A leading @ is accepted and stripped.",
  }),
  query: Type.Optional(Type.String({
    description: "Optional task/search query for FTS chord search.",
  })),
  includeDependencies: Type.Optional(Type.Boolean({
    description: "Whether to include memories near relative imports/dependencies for file targets. Defaults to settings.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum memories to return. Defaults to portia.maxSenseResults.",
  })),
});

export function registerPortiaSenseTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "portia_sense",
    label: "Portia Sense",
    description: "Retrieve compact project-local Portia memories for a path and optional task query. Read-only.",
    promptSnippet: "Retrieve compact project-local spatial memories and gotchas for a path/task query",
    promptGuidelines: [
      "Use portia_sense before non-trivial work in unfamiliar project areas.",
      "Treat portia_sense results as pointers; follow referenced files and commands before relying on them.",
    ],
    parameters: PortiaSenseParams,

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
        const result = senseMemories(db, settings, params, ctx.cwd);
        return {
          content: [{ type: "text" as const, text: renderSense(result) }],
          details: result,
        };
      } finally {
        db.close();
      }
    },
  });
}
