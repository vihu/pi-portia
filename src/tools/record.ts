import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolvePortiaSettings } from "../config.ts";
import { openPortiaDatabase } from "../db.ts";
import { recordPortiaMemory } from "../record.ts";
import { renderRecord } from "../render.ts";
import type { PortiaRecordInput } from "../types.ts";

export const PortiaRecordParams = Type.Object({
  scopePath: Type.String({
    description: "Project path/scope this memory applies to. A leading @ is accepted and stripped.",
  }),
  kind: Type.Union([
    Type.Literal("purpose"),
    Type.Literal("pointer"),
    Type.Literal("invariant"),
    Type.Literal("gotcha"),
    Type.Literal("decision"),
    Type.Literal("pattern"),
    Type.Literal("plan"),
  ], {
    description: "Kind of durable project memory to record.",
  }),
  body: Type.String({
    description: "Durable, project-specific memory body. Keep it concise and verified.",
  }),
  title: Type.Optional(Type.String({
    description: "Short scannable title for the memory.",
  })),
  importance: Type.Optional(Type.Number({
    description: "Importance from 0 to 10. Defaults to 5.",
  })),
  confidence: Type.Optional(Type.Number({
    description: "Confidence from 0 to 100. Defaults to 90.",
  })),
  sourceType: Type.Optional(Type.String({
    description: "Provenance type, e.g. manual, session, observation, reflection, file, command.",
  })),
  sourceRef: Type.Optional(Type.String({
    description: "Provenance reference, e.g. observation/reflection id, file path, command, or session reference.",
  })),
  evidence: Type.Optional(Type.String({
    description: "Short supporting evidence stored in the memory event payload.",
  })),
  supersedesId: Type.Optional(Type.String({
    description: "Optional active memory id this new memory replaces; the old memory is marked superseded when writing is allowed.",
  })),
  duplicatePolicy: Type.Optional(Type.Union([
    Type.Literal("warn"),
    Type.Literal("blockExact"),
  ], {
    description: "Exact duplicate handling. Defaults to blockExact; warn allows the write with warnings.",
  })),
});

export function registerPortiaRecordTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "portia_record",
    label: "Portia Record",
    description: "Record a durable project-local Portia memory when policy allows, or return a structured proposal in readonly/confirm mode.",
    promptSnippet: "Record durable project-local decisions, gotchas, invariants, pointers, patterns, purpose, or plans",
    promptGuidelines: [
      "Use portia_record only for durable, verified, project-specific facts that will help future agents re-perceive the codebase.",
      "Good records include decisions, gotchas, invariants, source/navigation pointers, package commands, and spatial relationships.",
      "Do not record generic advice, raw conversation summaries, every file read, or unverified speculation.",
      "Use supersedesId when a new memory intentionally replaces an older active Portia memory.",
      "When promoting observational-memory facts, preserve the observation/reflection id in sourceRef and set sourceType accordingly.",
    ],
    parameters: PortiaRecordParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const settings = resolvePortiaSettings(ctx.cwd);
      if (!settings.enabled) {
        return {
          content: [{ type: "text" as const, text: "Portia is disabled for this project/session." }],
          details: { enabled: false, projectRoot: settings.projectRoot, modeOverride: settings.modeOverride },
        };
      }

      const input = params as PortiaRecordInput;

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const result = recordPortiaMemory(db, settings, input, ctx.cwd);
        return {
          content: [{ type: "text" as const, text: renderRecord(result) }],
          details: result,
        };
      } finally {
        db.close();
      }
    },
  });
}
