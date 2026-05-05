import * as path from "node:path";
import type { PortiaSettings, PortiaStats, RetrievedMemory, RetrievalSignal, SenseResult } from "./types.ts";

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function formatMaybeRelative(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

function renderSignal(signal: RetrievalSignal): string {
  const label = signal.type.toUpperCase();
  const target = signal.scopePath ?? signal.query ?? "query";
  const parts = [`- ${label} ${target}`];
  if (signal.strength !== undefined) parts.push(`strength=${signal.strength}`);
  if (signal.score !== undefined) parts.push(`score=${signal.score.toFixed(3)}`);
  if (signal.count !== undefined) parts.push(`matches=${signal.count}`);
  return parts.join(" ");
}

function renderMemory(memory: RetrievedMemory): string {
  const headerParts = [
    `[${memory.id}]`,
    memory.kind,
    memory.scopePath,
    `rank=${Math.round(memory.rank)}`,
  ];

  if (memory.importance) headerParts.push(`importance=${memory.importance}`);
  if (memory.confidence !== 100) headerParts.push(`confidence=${memory.confidence}`);

  const reasonText = memory.reasons
    .map((reason) => {
      if (reason.type === "chord") return "chord";
      return `${reason.type}:${reason.scopePath ?? "?"}`;
    })
    .join(", ");

  const title = memory.title ? `\n${truncate(memory.title, 160)}` : "";
  const provenance = [memory.sourceType, memory.sourceRef].filter(Boolean).join(":");
  const provenanceLine = provenance ? `\nsource: ${truncate(provenance, 180)}` : "";

  return `${headerParts.join(" ")}\nreasons: ${reasonText}${provenanceLine}${title}\n${truncate(memory.body, 900)}`;
}

export function renderSense(result: SenseResult): string {
  const lines: string[] = [];
  lines.push("# Portia Sense");
  lines.push("");
  lines.push(`Target: ${formatMaybeRelative(result.projectRoot, result.targetPath)}`);
  lines.push(`Scope: ${result.targetScope}`);
  lines.push(`Project: ${result.projectRoot}`);
  if (result.query) lines.push(`Query: ${result.query}`);
  lines.push(`DB: ${result.dbPath}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push("## Active Signals");
  if (result.signals.length === 0) {
    lines.push("- none");
  } else {
    for (const signal of result.signals) lines.push(renderSignal(signal));
  }

  lines.push("");
  lines.push("## Memories");
  if (result.memories.length === 0) {
    lines.push("No active Portia memories matched. This is normal for a new or unseeded project DB.");
  } else {
    for (const memory of result.memories) {
      lines.push("");
      lines.push(renderMemory(memory));
    }
  }

  lines.push("");
  lines.push("Reminder: Portia memories are pointers and gotchas, not source-of-truth replacements. Follow referenced files and commands.");
  return lines.join("\n");
}

export function renderStatus(settings: PortiaSettings, stats: PortiaStats): string {
  const lines: string[] = [];
  lines.push("# Portia Status");
  lines.push("");
  lines.push(`Enabled: ${settings.enabled}`);
  lines.push(`Project: ${settings.projectRoot}`);
  lines.push(`DB: ${stats.dbPath}`);
  lines.push(`Schema: ${stats.schemaVersion}`);
  lines.push(`Write policy: ${settings.effectiveWritePolicy}`);
  lines.push(`Worker write policy: ${settings.workerWritePolicy}`);
  if (settings.modeOverride) lines.push(`PORTIA_MODE: ${settings.modeOverride}`);
  lines.push(`FTS: ${stats.ftsAvailable ? "available" : "unavailable"}`);
  lines.push(`Dependency scan: ${settings.enableDependencyScan}`);
  lines.push(`Vectors: ${settings.enableVectors ? "enabled" : "disabled"}`);
  lines.push("");
  lines.push("## Memory Counts");
  lines.push(`- total: ${stats.totalMemories}`);
  lines.push(`- active: ${stats.activeMemories}`);
  lines.push(`- stale: ${stats.staleMemories}`);
  lines.push(`- superseded: ${stats.supersededMemories}`);
  lines.push(`- deleted: ${stats.deletedMemories}`);

  lines.push("");
  lines.push("## Active by Kind");
  if (stats.byKind.length === 0) lines.push("- none");
  else for (const row of stats.byKind) lines.push(`- ${row.kind}: ${row.count}`);

  lines.push("");
  lines.push("## Top Scopes");
  if (stats.topScopes.length === 0) lines.push("- none");
  else for (const row of stats.topScopes) lines.push(`- ${row.scopePath}: ${row.count}`);

  return lines.join("\n");
}
