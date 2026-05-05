import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { buildAutopilotContext, renderAutopilotGuidance } from "./autopilot.ts";
import { resolvePortiaSettings } from "./config.ts";
import { openPortiaDatabase } from "./db.ts";
import { renderSense, renderStatus } from "./render.ts";
import { senseMemories } from "./retrieval.ts";
import { registerPortiaRecordTool } from "./tools/record.ts";
import { registerPortiaSenseTool } from "./tools/sense.ts";

function parseSenseArgs(args: string): { path: string; query?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { path: "." };

  const [first, ...rest] = trimmed.split(/\s+/);
  return {
    path: first || ".",
    query: rest.join(" ").trim() || undefined,
  };
}

function appendPromptSection(systemPrompt: string, section: string): string {
  return `${systemPrompt}\n\n${section}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("portia", (message, _options, theme) => {
    const title = theme.fg("accent", theme.bold("Portia"));
    return new Text(`${title}\n${message.content}`, 0, 0);
  });

  registerPortiaSenseTool(pi);
  registerPortiaRecordTool(pi);

  pi.on("before_agent_start", async (event, ctx) => {
    const settings = resolvePortiaSettings(ctx.cwd);
    if (!settings.enabled) return;

    const sections: string[] = [];
    const guidance = renderAutopilotGuidance(settings);
    if (guidance) sections.push(guidance);

    if (settings.autoSense) {
      try {
        const db = openPortiaDatabase(settings.dbPath);
        try {
          const context = buildAutopilotContext(db, settings, event.prompt, ctx.cwd);
          if (context) sections.push(context);
        } finally {
          db.close();
        }
      } catch {
        // Autopilot context must never break the user turn. Manual /portia-status
        // and /portia-sense still surface DB/retrieval failures explicitly.
      }
    }

    if (sections.length === 0) return;
    return { systemPrompt: appendPromptSection(event.systemPrompt, sections.join("\n\n")) };
  });

  pi.registerCommand("portia-status", {
    description: "Show Portia project memory status and database counts.",
    handler: async (_args, ctx) => {
      const settings = resolvePortiaSettings(ctx.cwd);
      if (!settings.enabled) {
        pi.sendMessage({
          customType: "portia",
          content: "Portia is disabled for this project/session.",
          display: true,
          details: { enabled: false, projectRoot: settings.projectRoot, modeOverride: settings.modeOverride },
        });
        return;
      }

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const stats = db.getStats();
        const content = renderStatus(settings, stats);
        pi.sendMessage({
          customType: "portia",
          content,
          display: true,
          details: { settings, stats },
        });
      } finally {
        db.close();
      }
    },
  });

  pi.registerCommand("portia-sense", {
    description: "Show Portia memories for a path: /portia-sense <path> [query]",
    handler: async (args, ctx) => {
      const settings = resolvePortiaSettings(ctx.cwd);
      if (!settings.enabled) {
        pi.sendMessage({
          customType: "portia",
          content: "Portia is disabled for this project/session.",
          display: true,
          details: { enabled: false, projectRoot: settings.projectRoot, modeOverride: settings.modeOverride },
        });
        return;
      }

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const input = parseSenseArgs(args);
        const result = senseMemories(db, settings, input, ctx.cwd);
        pi.sendMessage({
          customType: "portia",
          content: renderSense(result),
          display: true,
          details: result,
        });
      } finally {
        db.close();
      }
    },
  });
}
