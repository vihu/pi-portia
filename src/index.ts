import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { buildAutopilotContext, renderAutopilotGuidance } from "./autopilot.ts";
import { resolvePortiaSettings } from "./config.ts";
import { openPortiaDatabase } from "./db.ts";
import { inspectPortiaMemory } from "./inspect.ts";
import { listPortiaMemories } from "./list.ts";
import { repairPortiaMemory } from "./repair.ts";
import { renderMemoryInspect, renderMemoryList, renderRepair, renderSense, renderStatus } from "./render.ts";
import { senseMemories } from "./retrieval.ts";
import { registerPortiaInspectTool } from "./tools/inspect.ts";
import { registerPortiaListTool } from "./tools/list.ts";
import { registerPortiaRecordTool } from "./tools/record.ts";
import { registerPortiaRepairTool } from "./tools/repair.ts";
import { registerPortiaSenseTool } from "./tools/sense.ts";
import type { MemoryListStatus, PortiaRepairAction } from "./types.ts";
import type { PortiaListInput } from "./list.ts";

function parseSenseArgs(args: string): { path: string; query?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { path: "." };

  const [first, ...rest] = trimmed.split(/\s+/);
  return {
    path: first || ".",
    query: rest.join(" ").trim() || undefined,
  };
}

const LIST_STATUSES = new Set(["active", "stale", "superseded", "deleted", "all", "any"]);

function parseListStatus(value: string): MemoryListStatus {
  return value === "all" ? "any" : value as MemoryListStatus;
}

function parseListArgs(args: string): PortiaListInput {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const input: PortiaListInput = {};
  let index = 0;

  if (tokens[index] && LIST_STATUSES.has(tokens[index].toLowerCase())) {
    input.status = parseListStatus(tokens[index].toLowerCase());
    index += 1;
  }

  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (LIST_STATUSES.has(token)) {
      input.status = parseListStatus(token);
      index += 1;
      continue;
    }

    if (token === "scope") {
      const value = tokens[index + 1];
      if (!value) throw new Error("Usage: /portia-list scope <path>");
      input.scopePath = value;
      index += 2;
      continue;
    }

    if (token === "kind") {
      const value = tokens[index + 1];
      if (!value) throw new Error("Usage: /portia-list kind <kind>");
      input.kind = value;
      index += 2;
      continue;
    }

    if (token === "query") {
      const query = tokens.slice(index + 1).join(" ").trim();
      if (!query) throw new Error("Usage: /portia-list query <text>");
      input.query = query;
      break;
    }

    if (token === "limit") {
      const value = Number(tokens[index + 1]);
      if (!Number.isInteger(value)) throw new Error("Usage: /portia-list limit <positive integer>");
      input.limit = value;
      index += 2;
      continue;
    }

    input.query = tokens.slice(index).join(" ");
    break;
  }

  return input;
}

function parseInspectArgs(args: string): { id: string; includeEvents: boolean } {
  const id = args.trim();
  if (!id) throw new Error("Usage: /portia-inspect <memory-id>");
  return { id, includeEvents: true };
}

function parseRepairArgs(args: string): { id: string; action: PortiaRepairAction; reason: string } {
  const [id, action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const reason = rest.join(" ").trim();
  if (!id || !action || !reason) {
    throw new Error("Usage: /portia-repair <memory-id> <stale|delete|reactivate> <reason>");
  }
  return { id, action: action as PortiaRepairAction, reason };
}

function parseDeleteArgs(args: string): { id: string; action: "delete"; reason: string; sourceType: string; sourceRef: string } {
  const [id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const reason = rest.join(" ").trim();
  if (!id || !reason) throw new Error("Usage: /portia-delete <memory-id> <reason>");
  return { id, action: "delete", reason, sourceType: "command", sourceRef: "/portia-delete" };
}

function appendPromptSection(systemPrompt: string, section: string): string {
  return `${systemPrompt}\n\n${section}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendPortiaCommandError(pi: ExtensionAPI, error: unknown): void {
  pi.sendMessage({
    customType: "portia",
    content: errorMessage(error),
    display: true,
    details: { error: errorMessage(error) },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("portia", (message, _options, theme) => {
    const title = theme.fg("accent", theme.bold("Portia"));
    return new Text(`${title}\n${message.content}`, 0, 0);
  });

  registerPortiaSenseTool(pi);
  registerPortiaRecordTool(pi);
  registerPortiaListTool(pi);
  registerPortiaInspectTool(pi);
  registerPortiaRepairTool(pi);

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

  pi.registerCommand("portia-list", {
    description: "List Portia memories: /portia-list [active|all|stale|deleted] [scope <path>|kind <kind>|query <text>]",
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

      let input: PortiaListInput;
      try {
        input = parseListArgs(args);
      } catch (error) {
        sendPortiaCommandError(pi, error);
        return;
      }

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const result = listPortiaMemories(db, settings, input, ctx.cwd);
        pi.sendMessage({
          customType: "portia",
          content: renderMemoryList(result),
          display: true,
          details: result,
        });
      } finally {
        db.close();
      }
    },
  });

  pi.registerCommand("portia-inspect", {
    description: "Inspect one Portia memory by id: /portia-inspect <memory-id>",
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

      let input: { id: string; includeEvents: boolean };
      try {
        input = parseInspectArgs(args);
      } catch (error) {
        sendPortiaCommandError(pi, error);
        return;
      }

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const result = inspectPortiaMemory(db, settings, input);
        pi.sendMessage({
          customType: "portia",
          content: renderMemoryInspect(result),
          display: true,
          details: result,
        });
      } finally {
        db.close();
      }
    },
  });

  pi.registerCommand("portia-repair", {
    description: "Soft-repair a Portia memory: /portia-repair <memory-id> <stale|delete|reactivate> <reason>",
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

      let input: { id: string; action: PortiaRepairAction; reason: string };
      try {
        input = parseRepairArgs(args);
      } catch (error) {
        sendPortiaCommandError(pi, error);
        return;
      }

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const result = repairPortiaMemory(db, settings, input);
        pi.sendMessage({
          customType: "portia",
          content: renderRepair(result),
          display: true,
          details: result,
        });
      } finally {
        db.close();
      }
    },
  });

  pi.registerCommand("portia-delete", {
    description: "Soft-delete a Portia memory: /portia-delete <memory-id> <reason>",
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

      let input: { id: string; action: "delete"; reason: string; sourceType: string; sourceRef: string };
      try {
        input = parseDeleteArgs(args);
      } catch (error) {
        sendPortiaCommandError(pi, error);
        return;
      }

      const db = openPortiaDatabase(settings.dbPath);
      try {
        const result = repairPortiaMemory(db, settings, input);
        pi.sendMessage({
          customType: "portia",
          content: renderRepair(result),
          display: true,
          details: result,
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
