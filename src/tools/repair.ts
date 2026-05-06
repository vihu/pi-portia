import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolvePortiaSettings } from "../config.ts";
import { openPortiaDatabase } from "../db.ts";
import { repairPortiaMemory } from "../repair.ts";
import { renderRepair } from "../render.ts";
import type { PortiaRepairInput } from "../types.ts";

export const PortiaRepairParams = Type.Object({
  id: Type.String({
    description: "Portia memory id to repair.",
  }),
  action: Type.Union([
    Type.Literal("stale"),
    Type.Literal("delete"),
    Type.Literal("reactivate"),
  ], {
    description: "Repair action. stale/deleted memories are hidden from active retrieval; delete is a soft delete.",
  }),
  reason: Type.String({
    description: "Required audit reason for the repair.",
  }),
  sourceType: Type.Optional(Type.String({
    description: "Optional provenance type for the repair, e.g. manual, session, file, command.",
  })),
  sourceRef: Type.Optional(Type.String({
    description: "Optional provenance reference for the repair.",
  })),
  evidence: Type.Optional(Type.String({
    description: "Optional supporting evidence stored in the repair event payload.",
  })),
});

export function registerPortiaRepairTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "portia_repair",
    label: "Portia Repair",
    description: "Soft-repair a Portia memory by marking it stale, deleted, or active when policy allows; returns a proposal in readonly/confirm mode.",
    promptSnippet: "Repair Portia memories by soft-marking stale, deleted, or active with auditable event history",
    promptGuidelines: [
      "Use portia_repair only for verified bad, stale, test, or revalidated Portia memories.",
      "Prefer portia_inspect before repairing so provenance and event history are understood.",
      "Repair actions are soft status changes; they should preserve audit history via memory events.",
    ],
    parameters: PortiaRepairParams,

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
        const result = repairPortiaMemory(db, settings, params as PortiaRepairInput);
        return {
          content: [{ type: "text" as const, text: renderRepair(result) }],
          details: result,
        };
      } finally {
        db.close();
      }
    },
  });
}
