import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePortiaSettings } from "../config.ts";
import { openPortiaDatabase } from "../db.ts";
import { inspectPortiaMemory } from "../inspect.ts";
import { renderMemoryInspect } from "../render.ts";
import type { PortiaInspectInput } from "../types.ts";

export const PortiaInspectParams = Type.Object({
  id: Type.String({
    description: "Portia memory id to inspect.",
  }),
  includeEvents: Type.Optional(Type.Boolean({
    description: "Whether to include memory event history. Defaults to true.",
  })),
});

export function registerPortiaInspectTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "portia_inspect",
    label: "Portia Inspect",
    description: "Inspect one Portia memory by id, including provenance and event history. Read-only.",
    promptSnippet: "Inspect a Portia memory by id with provenance and event history",
    promptGuidelines: [
      "Use portia_inspect when a Portia memory's provenance, status, or event history matters before acting.",
      "Use portia_list to discover candidate memory ids.",
      "Use portia_repair only after inspecting or otherwise verifying why a memory should be changed.",
    ],
    parameters: PortiaInspectParams,

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
        const result = inspectPortiaMemory(db, settings, params as PortiaInspectInput);
        return {
          content: [{ type: "text" as const, text: renderMemoryInspect(result) }],
          details: result,
        };
      } finally {
        db.close();
      }
    },
  });
}
