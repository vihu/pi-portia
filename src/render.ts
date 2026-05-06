import * as path from "node:path";
import type {
  MemoryEvent,
  MemoryRecord,
  PortiaInspectResult,
  PortiaListResult,
  PortiaRecordResult,
  PortiaRepairResult,
  PortiaSettings,
  PortiaStats,
  RetrievedMemory,
  RetrievalSignal,
  SenseResult,
} from "./types.ts";

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

function renderMemorySource(memory: MemoryRecord): string | undefined {
  const provenance = [memory.sourceType, memory.sourceRef].filter(Boolean).join(":");
  return provenance || undefined;
}

function renderListMemory(memory: MemoryRecord): string {
  const headerParts = [
    `- [${memory.id}]`,
    memory.status,
    memory.kind,
    memory.scopePath,
    `importance=${memory.importance}`,
    `confidence=${memory.confidence}`,
  ];
  const title = memory.title ? truncate(memory.title, 140) : truncate(memory.body.replace(/\s+/g, " ").trim(), 140);
  const source = renderMemorySource(memory);
  const sourceLine = source ? `\n  source: ${truncate(source, 180)}` : "";
  const updatedLine = `\n  updated: ${memory.updatedAt}`;
  return `${headerParts.join(" ")}\n  ${title}${sourceLine}${updatedLine}`;
}

function renderEventPayload(event: MemoryEvent): string {
  try {
    return truncate(JSON.stringify(JSON.parse(event.payloadJson), null, 2), 1_200);
  } catch {
    return truncate(event.payloadJson, 1_200);
  }
}

function renderEvent(event: MemoryEvent): string {
  const by = event.createdBy ? ` by ${event.createdBy}` : "";
  return `- ${event.eventType} ${event.createdAt}${by}\n${renderEventPayload(event)}`;
}

export function renderMemoryList(result: PortiaListResult): string {
  const lines: string[] = [];
  lines.push("# Portia List");
  lines.push("");
  lines.push(`Project: ${result.projectRoot}`);
  lines.push(`DB: ${result.dbPath}`);
  lines.push(`Status: ${result.filters.status}`);
  if (result.filters.scopePath) lines.push(`Scope: ${result.filters.scopePath}`);
  if (result.filters.kind) lines.push(`Kind: ${result.filters.kind}`);
  if (result.filters.query) lines.push(`Query: ${result.filters.query}`);
  lines.push(`Limit: ${result.filters.limit}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push(`## Memories (${result.memories.length})`);
  if (result.memories.length === 0) {
    lines.push("No Portia memories matched these filters.");
  } else {
    for (const memory of result.memories) {
      lines.push("");
      lines.push(renderListMemory(memory));
    }
  }

  return lines.join("\n");
}

export function renderMemoryInspect(result: PortiaInspectResult): string {
  const lines: string[] = [];
  lines.push("# Portia Inspect");
  lines.push("");
  lines.push(`Project: ${result.projectRoot}`);
  lines.push(`DB: ${result.dbPath}`);
  lines.push(`ID: ${result.id}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  const memory = result.memory;
  if (!memory) return lines.join("\n");

  lines.push("");
  lines.push(`## Memory`);
  lines.push(`[${memory.id}] ${memory.status} ${memory.kind} ${memory.scopePath}`);
  if (memory.title) lines.push(`Title: ${memory.title}`);
  lines.push(`Importance: ${memory.importance}`);
  lines.push(`Confidence: ${memory.confidence}`);
  lines.push(`Created: ${memory.createdAt}${memory.createdBy ? ` by ${memory.createdBy}` : ""}`);
  lines.push(`Updated: ${memory.updatedAt}`);
  if (memory.supersedesId) lines.push(`Supersedes: ${memory.supersedesId}`);
  const source = renderMemorySource(memory);
  if (source) lines.push(`Source: ${source}`);
  lines.push("");
  lines.push("Body:");
  lines.push(memory.body);

  lines.push("");
  lines.push(`## Events (${result.events.length})`);
  if (result.events.length === 0) {
    lines.push("No memory events recorded for this memory.");
  } else {
    for (const event of result.events) {
      lines.push("");
      lines.push(renderEvent(event));
    }
  }

  return lines.join("\n");
}

export function renderRepair(result: PortiaRepairResult): string {
  const lines: string[] = [];
  const proposal = result.proposal;

  lines.push("# Portia Repair");
  lines.push("");
  lines.push(`Project: ${result.projectRoot}`);
  lines.push(`DB: ${result.dbPath}`);
  lines.push(`Write policy: ${result.writePolicy}`);
  if (result.modeOverride) lines.push(`PORTIA_MODE: ${result.modeOverride}`);
  lines.push(`Status: ${result.written ? "written" : "proposal-only"}`);
  if (result.skipReason === "readonly") lines.push("Reason: readonly policy; no durable Portia write was made.");
  if (result.skipReason === "confirm") lines.push("Reason: confirm policy currently returns a proposal; no durable Portia write was made.");
  if (result.skipReason === "noop") lines.push("Reason: memory already has the requested status; no event was written.");
  if (result.memory) lines.push(`Memory: ${result.memory.id}`);
  if (result.event) lines.push(`Event: ${result.event.id}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push("## Repair");
  lines.push(`- id: ${proposal.id}`);
  lines.push(`- action: ${proposal.action}`);
  lines.push(`- current status: ${proposal.currentStatus ?? "unknown"}`);
  lines.push(`- target status: ${proposal.targetStatus}`);
  if (proposal.sourceType || proposal.sourceRef) {
    lines.push(`- source: ${[proposal.sourceType, proposal.sourceRef].filter(Boolean).join(":")}`);
  }
  lines.push("");
  lines.push(proposal.reason);
  if (proposal.evidence) {
    lines.push("");
    lines.push("## Evidence");
    lines.push(truncate(proposal.evidence, 900));
  }

  if (!result.written && result.skipReason !== "noop") {
    lines.push("");
    lines.push("This is a structured repair proposal only. A main session with writePolicy=write can apply it with portia_repair.");
  }

  return lines.join("\n");
}

export function renderAutopilotContext(result: SenseResult, maxChars: number): string | undefined {
  if (result.memories.length === 0) return undefined;

  const lines: string[] = [];
  lines.push("## Portia Project Context");
  lines.push("");
  lines.push("Relevant project-memory pointers for this turn. Verify source before relying on them.");
  lines.push("");

  for (const memory of result.memories) {
    const title = memory.title ? `${truncate(memory.title, 120)} — ` : "";
    const body = truncate(memory.body.replace(/\s+/g, " ").trim(), 240);
    const line = `- [${memory.id}] ${memory.kind} ${memory.scopePath} — ${title}${body}`;
    const candidate = [...lines, line].join("\n");
    if (candidate.length > maxChars) break;
    lines.push(line);
  }

  if (lines.length <= 4) return undefined;
  return truncate(lines.join("\n"), maxChars);
}

export function renderRecord(result: PortiaRecordResult): string {
  const lines: string[] = [];
  const proposal = result.proposal;

  lines.push("# Portia Record");
  lines.push("");
  lines.push(`Project: ${result.projectRoot}`);
  lines.push(`DB: ${result.dbPath}`);
  lines.push(`Write policy: ${result.writePolicy}`);
  if (result.modeOverride) lines.push(`PORTIA_MODE: ${result.modeOverride}`);
  lines.push(`Status: ${result.written ? "written" : "proposal-only"}`);
  if (result.skipReason === "readonly") lines.push("Reason: readonly policy; no durable Portia write was made.");
  if (result.skipReason === "confirm") lines.push("Reason: confirm policy currently returns a proposal; no durable Portia write was made.");
  if (result.memory) lines.push(`Memory: ${result.memory.id}`);
  if (result.event) lines.push(`Event: ${result.event.id}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push("## Memory");
  lines.push(`- scope: ${proposal.scopePath}`);
  lines.push(`- kind: ${proposal.kind}`);
  lines.push(`- importance: ${proposal.importance}`);
  lines.push(`- confidence: ${proposal.confidence}`);
  if (proposal.sourceType || proposal.sourceRef) {
    lines.push(`- source: ${[proposal.sourceType, proposal.sourceRef].filter(Boolean).join(":")}`);
  }
  if (proposal.title) {
    lines.push("");
    lines.push(truncate(proposal.title, 160));
  }
  lines.push("");
  lines.push(truncate(proposal.body, 900));
  if (proposal.evidence) {
    lines.push("");
    lines.push("## Evidence");
    lines.push(truncate(proposal.evidence, 900));
  }

  if (!result.written) {
    lines.push("");
    lines.push("This is a structured proposal only. A main session with writePolicy=write can persist it with portia_record.");
  }

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
  lines.push(`Autopilot guidance: ${settings.autoPromptGuidance}`);
  lines.push(`Autopilot record guidance: ${settings.autoRecordGuidance}`);
  lines.push(`Autopilot sense: ${settings.autoSense ? `enabled (${settings.autoSenseMaxResults} memories, ${settings.autoSenseMaxChars} chars)` : "disabled"}`);
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
