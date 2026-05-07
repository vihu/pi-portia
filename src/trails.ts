import type { PortiaDatabase } from "./db.ts";
import { computeEffectivePheromoneStrength, computePheromoneBoost } from "./pheromones.ts";
import type { MemoryPheromoneSummary, MemoryTraceEvent, PortiaSettings, PortiaTrailsInput, PortiaTrailsResult } from "./types.ts";

const DEFAULT_TRAILS_LIMIT = 12;
const MAX_TRAILS_LIMIT = 100;
const MAX_ID_LENGTH = 240;

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRAILS_LIMIT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Portia trails limit must be a positive integer.");
  return Math.min(value, MAX_TRAILS_LIMIT);
}

function parseMemoryId(value: string | undefined): string {
  const id = value?.trim();
  if (!id) throw new Error("Usage: /portia-trails memory <memory-id>");
  if (id.length > MAX_ID_LENGTH) throw new Error(`Portia trails memory id is too long; maximum is ${MAX_ID_LENGTH} characters.`);
  return id;
}

function withEffective(settings: PortiaSettings, summary: MemoryPheromoneSummary): MemoryPheromoneSummary {
  const effectiveStrength = computeEffectivePheromoneStrength(summary, settings.pheromoneHalfLifeDays);
  return {
    ...summary,
    effectiveStrength,
    boost: computePheromoneBoost(effectiveStrength, settings.pheromoneMaxBoost),
  };
}

export function listPortiaTrails(db: PortiaDatabase, settings: PortiaSettings, input: PortiaTrailsInput = {}): PortiaTrailsResult {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const mode = input.mode ?? "top";
  const limit = parseLimit(input.limit);
  const warnings: string[] = [];
  let memoryId: string | undefined;
  let pheromones: MemoryPheromoneSummary[] = [];
  let events: MemoryTraceEvent[] = [];

  if (mode === "memory") {
    memoryId = parseMemoryId(input.memoryId);
    const pheromone = db.getMemoryPheromone(memoryId);
    const memory = db.getMemory(memoryId);
    if (!memory) warnings.push("No Portia memory found for this id.");
    if (pheromone) pheromones = [withEffective(settings, { ...pheromone, memory })];
    else if (memory) warnings.push("No pheromone summary has been recorded for this memory yet.");
    events = db.getTraceEventsForMemory(memoryId, limit);
  } else if (mode === "recent") {
    events = db.getRecentTraceEvents(limit);
  } else {
    pheromones = db.listPheromones({ mode, limit }).map((summary) => withEffective(settings, summary));
    if (pheromones.length === limit) warnings.push("Result limit reached; narrow the query or increase the limit if needed.");
  }

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    mode,
    memoryId,
    pheromones,
    events,
    warnings,
  };
}
