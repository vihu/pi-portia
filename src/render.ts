import * as path from "node:path";
import { computeEffectivePheromoneStrength, computePheromoneBoost } from "./pheromones.ts";
import type {
  MemoryEvent,
  MemoryPheromone,
  MemoryPheromoneSummary,
  MemoryRecord,
  MemoryTraceEvent,
  PortiaInspectResult,
  PortiaListResult,
  PortiaRecordResult,
  PortiaRepairResult,
  PortiaSearchHit,
  PortiaSearchOutput,
  PortiaSettings,
  PortiaStats,
  PortiaTrailsResult,
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
  const target = signal.scopePath ?? signal.query ?? (signal.type === "pheromone" ? "reinforced" : "query");
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
  if (memory.pheromoneBoost && memory.pheromoneBoost > 0) headerParts.push(`pheromone=+${memory.pheromoneBoost.toFixed(1)}`);

  const reasonText = memory.reasons
    .map((reason) => {
      if (reason.type === "chord") return "chord";
      if (reason.type === "pheromone") return `pheromone:+${(memory.pheromoneBoost ?? reason.strength ?? 0).toFixed(1)}`;
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

function renderCompactMemory(memory: MemoryRecord): string {
  const title = memory.title ? truncate(memory.title, 120) : truncate(memory.body.replace(/\s+/g, " ").trim(), 120);
  return `- [${memory.id}] ${memory.status} ${memory.kind} ${memory.scopePath} — ${title}`;
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

function renderTraceEvent(event: MemoryTraceEvent): string {
  const parts = [`- ${event.eventType}`, event.createdAt, `[${event.memoryId}]`, `weight=${event.weight}`];
  if (event.scopePath) parts.push(`scope=${event.scopePath}`);
  if (event.toolName) parts.push(`tool=${event.toolName}`);
  if (event.toolCallId) parts.push(`call=${event.toolCallId}`);
  return parts.join(" ");
}

function renderPheromoneSummary(summary: MemoryPheromoneSummary): string {
  const memory = summary.memory;
  const title = memory?.title ? truncate(memory.title, 90) : memory ? truncate(memory.body.replace(/\s+/g, " ").trim(), 90) : "missing memory";
  const scope = memory ? `${memory.status} ${memory.kind} ${memory.scopePath}` : "missing";
  const effective = summary.effectiveStrength !== undefined ? ` effective=${summary.effectiveStrength.toFixed(2)}` : "";
  const boost = summary.boost !== undefined ? ` boost=+${summary.boost.toFixed(1)}` : "";
  return `- [${summary.memoryId}] strength=${summary.strength.toFixed(2)}${effective}${boost} exposed=${summary.exposedCount} followed=${summary.followedCount} success=${summary.successCount} failure=${summary.failureCount} ${scope} — ${title}`;
}

function renderPheromoneBlock(pheromone: MemoryPheromone | undefined, effectiveStrength?: number, pheromoneBoost?: number): string[] {
  if (!pheromone) return ["No pheromone summary recorded yet."];
  const effective = effectiveStrength ?? computeEffectivePheromoneStrength(pheromone, 30);
  const boost = pheromoneBoost ?? computePheromoneBoost(effective, 25);
  const lines: string[] = [];
  lines.push(`Strength: ${pheromone.strength.toFixed(2)} effective=${effective.toFixed(2)} boost=+${boost.toFixed(1)}`);
  lines.push(`Exposed: ${pheromone.exposedCount}`);
  lines.push(`Followed: ${pheromone.followedCount}`);
  lines.push(`Ignored: ${pheromone.ignoredCount}`);
  lines.push(`Validation passed: ${pheromone.successCount}`);
  lines.push(`Validation failed: ${pheromone.failureCount}`);
  if (pheromone.lastExposedAt) lines.push(`Last exposed: ${pheromone.lastExposedAt}`);
  if (pheromone.lastFollowedAt) lines.push(`Last followed: ${pheromone.lastFollowedAt}`);
  if (pheromone.lastSuccessAt) lines.push(`Last success: ${pheromone.lastSuccessAt}`);
  if (pheromone.lastFailureAt) lines.push(`Last failure: ${pheromone.lastFailureAt}`);
  return lines;
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
  if (result.filters.cursor) lines.push("Cursor: provided");

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

  lines.push("");
  lines.push("## Page");
  lines.push(`- limit: ${result.page.limit}`);
  lines.push(`- hasMore: ${result.page.hasMore}`);
  if (result.page.nextCursor) {
    lines.push(`- nextCursor: ${result.page.nextCursor}`);
    lines.push("- cursor usage: repeat the same filters with this cursor");
  }

  return lines.join("\n");
}

function renderSearchHit(hit: PortiaSearchHit): string {
  const memory = hit.memory;
  const headerParts = [
    `- [${memory.id}]`,
    memory.status,
    memory.kind,
    memory.scopePath,
    `match=${hit.matchType}`,
    `importance=${memory.importance}`,
  ];
  if (hit.score !== undefined) headerParts.push(`score=${hit.score.toFixed(3)}`);
  headerParts.push(`updated=${memory.updatedAt}`);

  const title = memory.title ? truncate(memory.title, 140) : truncate(memory.body.replace(/\s+/g, " ").trim(), 140);
  const snippet = hit.snippet?.replace(/\s+/g, " ").trim();
  const snippetLine = snippet ? `\n  snippet: ${truncate(snippet, 240)}` : "";
  const source = renderMemorySource(memory);
  const sourceLine = source ? `\n  source: ${truncate(source, 180)}` : "";

  return `${headerParts.join(" ")}\n  ${title}${snippetLine}${sourceLine}`;
}

export function renderSearch(result: PortiaSearchOutput): string {
  const lines: string[] = [];
  lines.push("# Portia Search");
  lines.push("");
  lines.push(`Project: ${result.projectRoot}`);
  lines.push(`DB: ${result.dbPath}`);
  lines.push(`Query: ${result.filters.query}`);
  lines.push(`Status: ${result.filters.status}`);
  if (result.filters.scopePath) lines.push(`Scope: ${result.filters.scopePath} (${result.filters.scopeMode})`);
  if (result.filters.kind) lines.push(`Kind: ${result.filters.kind}`);
  lines.push(`Order: ${result.filters.orderBy}`);
  lines.push(`Match mode: ${result.filters.matchMode}`);
  lines.push(`Substring fallback: ${result.filters.includeSubstringFallback}`);
  lines.push(`Limit: ${result.page.limit}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push(`## Hits (${result.hits.length})`);
  if (result.hits.length === 0) {
    lines.push("No Portia memories matched this search.");
  } else {
    for (const hit of result.hits) {
      lines.push("");
      lines.push(renderSearchHit(hit));
    }
  }

  lines.push("");
  lines.push(`## Page`);
  lines.push(`- limit: ${result.page.limit}`);
  lines.push(`- hasMore: ${result.page.hasMore}`);
  if (result.page.nextCursor) {
    lines.push(`- nextCursor: ${result.page.nextCursor}`);
    lines.push("- cursor usage: repeat the same query and filters with this cursor");
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
  if (result.supersededBy.length > 0) lines.push(`Superseded by: ${result.supersededBy.map((item) => item.id).join(", ")}`);
  const source = renderMemorySource(memory);
  if (source) lines.push(`Source: ${source}`);
  lines.push("");
  lines.push("Body:");
  lines.push(memory.body);

  lines.push("");
  lines.push("## Pheromone");
  for (const line of renderPheromoneBlock(result.pheromone, result.pheromoneEffectiveStrength, result.pheromoneBoost)) lines.push(line);

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

export function renderTrails(result: PortiaTrailsResult): string {
  const lines: string[] = [];
  lines.push("# Portia Trails");
  lines.push("");
  lines.push(`Project: ${result.projectRoot}`);
  lines.push(`DB: ${result.dbPath}`);
  lines.push(`Mode: ${result.mode}`);
  if (result.memoryId) lines.push(`Memory: ${result.memoryId}`);

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  if (result.pheromones.length > 0) {
    lines.push("");
    lines.push(`## Pheromones (${result.pheromones.length})`);
    for (const pheromone of result.pheromones) lines.push(renderPheromoneSummary(pheromone));
  }

  if (result.events.length > 0) {
    lines.push("");
    lines.push(`## Trace Events (${result.events.length})`);
    for (const event of result.events) lines.push(renderTraceEvent(event));
  }

  if (result.pheromones.length === 0 && result.events.length === 0) {
    lines.push("");
    lines.push("No Portia pheromone trails matched these filters yet.");
  }

  return lines.join("\n");
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
  const status = result.written ? "written" : result.skipReason === "duplicate" ? "duplicate-blocked" : "proposal-only";
  lines.push(`Status: ${status}`);
  if (result.skipReason === "readonly") lines.push("Reason: readonly policy; no durable Portia write was made.");
  if (result.skipReason === "confirm") lines.push("Reason: confirm policy currently returns a proposal; no durable Portia write was made.");
  if (result.skipReason === "duplicate") lines.push("Reason: exact duplicate protection prevented a durable Portia write.");
  if (result.memory) lines.push(`Memory: ${result.memory.id}`);
  if (result.event) lines.push(`Event: ${result.event.id}`);
  if (result.supersededMemory) lines.push(`Superseded memory: ${result.supersededMemory.id}`);
  if (result.supersedeEvent) lines.push(`Supersede event: ${result.supersedeEvent.id}`);

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
  lines.push(`- duplicate policy: ${proposal.duplicatePolicy}`);
  if (proposal.supersedesId) lines.push(`- supersedes: ${proposal.supersedesId}`);
  if (proposal.sourceType || proposal.sourceRef) {
    lines.push(`- source: ${[proposal.sourceType, proposal.sourceRef].filter(Boolean).join(":")}`);
  }
  if (proposal.title) {
    lines.push("");
    lines.push(truncate(proposal.title, 160));
  }
  lines.push("");
  lines.push(truncate(proposal.body, 900));
  if (result.duplicateBlockedBy) {
    lines.push("");
    lines.push("## Exact Duplicate");
    lines.push(renderCompactMemory(result.duplicateBlockedBy));
  }

  if (result.relatedMemories.length > 0) {
    lines.push("");
    lines.push("## Related Active Memories");
    for (const memory of result.relatedMemories) lines.push(renderCompactMemory(memory));
  }

  if (proposal.evidence) {
    lines.push("");
    lines.push("## Evidence");
    lines.push(truncate(proposal.evidence, 900));
  }

  if (!result.written && result.skipReason !== "duplicate") {
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
  lines.push(`Pheromones: ${settings.enablePheromones ? "enabled" : "disabled"}, ranking ${settings.pheromoneRanking ? "on" : "off"}`);
  lines.push(`Pheromone worker policy: ${settings.pheromoneWorkerPolicy}`);
  lines.push(`Pheromone half-life: ${settings.pheromoneHalfLifeDays} days`);
  lines.push(`Pheromone max boost: ${settings.pheromoneMaxBoost}`);
  lines.push(`Trace events: ${stats.pheromoneTraceEvents}`);
  lines.push(`Reinforced memories: ${stats.reinforcedMemories}`);
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
