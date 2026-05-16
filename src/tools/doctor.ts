import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePortiaSettings } from "../config.ts";
import { doctorPortia } from "../doctor.ts";
import { openPortiaDatabaseReadOnly } from "../db.ts";
import { renderDoctor } from "../render.ts";

export const PortiaDoctorParams = Type.Object({});

export function registerPortiaDoctorTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "portia_doctor",
    label: "Portia Doctor",
    description: "Run read-only health diagnostics for the project-local Portia database, schema, FTS index, triggers, and orphaned rows.",
    promptSnippet: "Check Portia database health and maintenance readiness",
    promptGuidelines: [
      "Use portia_doctor when diagnosing Portia DB, schema, FTS, trigger, search_terms, or orphaned-row issues.",
      "portia_doctor is read-only; use maintenance commands such as /portia-reindex only when explicitly appropriate.",
      "Treat warnings and errors as diagnostics; inspect source or run maintenance before assuming memories are lost.",
    ],
    parameters: PortiaDoctorParams,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const settings = resolvePortiaSettings(ctx.cwd);
      if (!settings.enabled) {
        return {
          content: [{ type: "text" as const, text: "Portia is disabled for this project/session." }],
          details: { enabled: false, projectRoot: settings.projectRoot, modeOverride: settings.modeOverride },
        };
      }

      const db = openPortiaDatabaseReadOnly(settings.dbPath);
      try {
        const result = doctorPortia(db, settings);
        return {
          content: [{ type: "text" as const, text: renderDoctor(result) }],
          details: result,
        };
      } finally {
        db.close();
      }
    },
  });
}
