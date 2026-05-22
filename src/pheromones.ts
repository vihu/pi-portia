import * as path from "node:path";
import type { PortiaDatabase } from "./db.ts";
import { isPathInside, normalizeScopePath, toProjectRelative } from "./root.ts";
import type {
  MemoryRecord,
  PheromoneTraceEventType,
  PortiaSearchOutput,
  PortiaSettings,
  SenseResult,
} from "./types.ts";

const MAX_PROMPT_PAYLOAD_CHARS = 500;
const LOW_WORKER_MULTIPLIER = 0.25;

export type TraceExposureSource = "autopilot" | "portia_sense" | "command" | "portia_search" | "auto_search";
export type SearchTraceExposureSource = "portia_search" | "auto_search";

interface TraceExposure {
  memoryId: string;
  source: TraceExposureSource;
  targetScope: string;
  query?: string;
  status?: string;
  searchScopePath?: string;
  scopeMode?: string;
  matchMode?: string;
  rank?: number;
  index: number;
}

interface TraceTouch {
  scopePath: string;
  toolName: string;
  mode: "read" | "write" | "command";
  toolCallId?: string;
  index: number;
}

interface TraceValidation {
  command: string;
  passed: boolean;
  toolCallId?: string;
  index: number;
}

export interface PheromoneTraceState {
  turnId: string;
  sessionFile?: string;
  prompt: string;
  startedAt: string;
  projectRoot: string;
  exposures: TraceExposure[];
  touchedScopes: TraceTouch[];
  validations: TraceValidation[];
  toolCallIndexes: Map<string, number>;
  nextIndex: number;
}

export interface ToolCallObservation {
  toolName: string;
  toolCallId?: string;
}

export interface ToolResultObservation {
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
  isError: boolean;
  cwd: string;
}

export interface PheromoneFlushResult {
  exposed: number;
  followed: number;
  ignored: number;
  validations: number;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function stripAtPrefix(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

function resolveToolPath(settings: PortiaSettings, cwd: string, rawPath: string): string | undefined {
  const raw = stripAtPrefix(rawPath.trim());
  if (!raw) return undefined;

  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(cwd, raw);

  if (!isPathInside(settings.projectRoot, absolutePath)) return undefined;
  return normalizeScopePath(toProjectRelative(settings.projectRoot, absolutePath));
}

function scopeContains(memoryScope: string, touchedScope: string): boolean {
  const memory = normalizeScopePath(memoryScope);
  const touched = normalizeScopePath(touchedScope);
  if (memory === ".") return true;
  return touched === memory || touched.startsWith(`${memory}/`);
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function sourceRefScope(settings: PortiaSettings, sourceRef: string | undefined): string | undefined {
  if (!sourceRef) return undefined;
  const trimmed = sourceRef.trim();
  if (!trimmed || trimmed.includes(" ") || trimmed.includes("://") || !looksLikePath(trimmed)) return undefined;

  const raw = stripAtPrefix(trimmed.replace(/^file:/, ""));
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(settings.projectRoot, raw);

  if (!isPathInside(settings.projectRoot, absolutePath)) return undefined;
  return normalizeScopePath(toProjectRelative(settings.projectRoot, absolutePath));
}

function followedByTouch(settings: PortiaSettings, memory: MemoryRecord, exposure: TraceExposure, touches: TraceTouch[]): { touch: TraceTouch; eventType: PheromoneTraceEventType } | undefined {
  const sourceScope = sourceRefScope(settings, memory.sourceRef);

  for (const touch of touches) {
    if (touch.index <= exposure.index) continue;
    if (scopeContains(memory.scopePath, touch.scopePath)) return { touch, eventType: "followed_scope" };
    if (sourceScope && scopeContains(sourceScope, touch.scopePath)) return { touch, eventType: "followed_source_ref" };
  }

  return undefined;
}

function validationAfterFollow(follow: TraceTouch, validations: TraceValidation[]): TraceValidation | undefined {
  const later = validations.filter((validation) => validation.index > follow.index);
  return later.find((validation) => validation.passed) ?? later.find((validation) => !validation.passed);
}

function isValidationCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;

  return [
    /(^|&&|;|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|lint)\b/,
    /(^|&&|;|\s)(vitest|pytest|tsc)\b/,
    /(^|&&|;|\s)cargo\s+test\b/,
    /(^|&&|;|\s)go\s+test\b/,
    /(^|&&|;|\s)pi\b.*\/portia-status/,
  ].some((pattern) => pattern.test(normalized));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nextIndex(state: PheromoneTraceState): number {
  const index = state.nextIndex;
  state.nextIndex += 1;
  return index;
}

function workerMultiplier(settings: PortiaSettings): number {
  if (settings.effectiveWritePolicy === "readonly" && settings.pheromoneWorkerPolicy === "low") return LOW_WORKER_MULTIPLIER;
  return 1;
}

function isOrderedTool(toolName: string): boolean {
  return toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "bash";
}

function toolResultIndex(state: PheromoneTraceState, toolCallId: string | undefined): number {
  if (toolCallId) {
    const orderedIndex = state.toolCallIndexes.get(toolCallId);
    if (orderedIndex !== undefined) return orderedIndex;
  }
  return nextIndex(state);
}

function recordAndApply(db: PortiaDatabase, settings: PortiaSettings, state: PheromoneTraceState, input: {
  memoryId: string;
  eventType: PheromoneTraceEventType;
  delta: number;
  scopePath?: string;
  toolName?: string;
  toolCallId?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}): void {
  const weight = input.delta * workerMultiplier(settings);
  db.recordTraceEvent({
    memoryId: input.memoryId,
    eventType: input.eventType,
    scopePath: input.scopePath,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    sessionFile: state.sessionFile,
    turnId: state.turnId,
    weight,
    payload: input.payload,
    createdAt: input.createdAt,
  });
  db.applyPheromoneDelta({
    memoryId: input.memoryId,
    eventType: input.eventType,
    delta: weight,
    halfLifeDays: settings.pheromoneHalfLifeDays,
    createdAt: input.createdAt,
  });
}

export function shouldWritePheromones(settings: PortiaSettings): boolean {
  if (!settings.enabled || !settings.enablePheromones) return false;
  if (settings.modeOverride === "off") return false;
  if (settings.effectiveWritePolicy === "readonly" && settings.pheromoneWorkerPolicy === "off") return false;
  return true;
}

export function createPheromoneTraceState(settings: PortiaSettings, prompt: string, sessionFile?: string): PheromoneTraceState {
  return {
    turnId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionFile,
    prompt,
    startedAt: new Date().toISOString(),
    projectRoot: settings.projectRoot,
    exposures: [],
    touchedScopes: [],
    validations: [],
    toolCallIndexes: new Map(),
    nextIndex: 0,
  };
}

export function addSenseExposures(state: PheromoneTraceState, result: SenseResult, source: Extract<TraceExposureSource, "autopilot" | "portia_sense" | "command">): void {
  for (const memory of result.memories) {
    state.exposures.push({
      memoryId: memory.id,
      source,
      targetScope: result.targetScope,
      query: result.query,
      index: nextIndex(state),
    });
  }
}

export function addSearchExposures(state: PheromoneTraceState, result: PortiaSearchOutput, source: SearchTraceExposureSource): void {
  result.hits.forEach((hit, rank) => {
    state.exposures.push({
      memoryId: hit.memory.id,
      source,
      targetScope: hit.memory.scopePath || result.filters.scopePath || ".",
      query: result.filters.query,
      status: result.filters.status,
      searchScopePath: result.filters.scopePath,
      scopeMode: result.filters.scopeMode,
      matchMode: result.filters.matchMode,
      rank,
      index: nextIndex(state),
    });
  });
}

export function observeToolCall(state: PheromoneTraceState, observation: ToolCallObservation): void {
  if (!observation.toolCallId || !isOrderedTool(observation.toolName)) return;
  if (state.toolCallIndexes.has(observation.toolCallId)) return;
  state.toolCallIndexes.set(observation.toolCallId, nextIndex(state));
}

export function observeToolResult(state: PheromoneTraceState, settings: PortiaSettings, observation: ToolResultObservation): void {
  const toolName = observation.toolName;
  if ((toolName === "read" || toolName === "edit" || toolName === "write") && !observation.isError) {
    const inputPath = asString(observation.input.path);
    const scopePath = inputPath ? resolveToolPath(settings, observation.cwd, inputPath) : undefined;
    if (!scopePath) return;

    state.touchedScopes.push({
      scopePath,
      toolName,
      mode: toolName === "read" ? "read" : "write",
      toolCallId: observation.toolCallId,
      index: toolResultIndex(state, observation.toolCallId),
    });
    return;
  }

  if (toolName === "bash") {
    const command = asString(observation.input.command);
    if (!command || !isValidationCommand(command)) return;

    state.validations.push({
      command,
      passed: !observation.isError,
      toolCallId: observation.toolCallId,
      index: toolResultIndex(state, observation.toolCallId),
    });
  }
}

export function flushPheromoneTraceState(db: PortiaDatabase, settings: PortiaSettings, state: PheromoneTraceState): PheromoneFlushResult {
  const result: PheromoneFlushResult = { exposed: 0, followed: 0, ignored: 0, validations: 0 };
  if (!shouldWritePheromones(settings)) return result;

  const flushAt = new Date().toISOString();
  const exposuresByMemory = new Map<string, TraceExposure[]>();
  for (const exposure of state.exposures) {
    const list = exposuresByMemory.get(exposure.memoryId) ?? [];
    list.push(exposure);
    exposuresByMemory.set(exposure.memoryId, list);
  }

  for (const exposures of exposuresByMemory.values()) {
    exposures.sort((a, b) => a.index - b.index);
  }

  for (const exposure of state.exposures) {
    const memory = db.getMemory(exposure.memoryId);
    if (!memory || memory.status !== "active") continue;

    recordAndApply(db, settings, state, {
      memoryId: memory.id,
      eventType: "exposed",
      delta: 0,
      scopePath: exposure.targetScope,
      payload: {
        source: exposure.source,
        targetScope: exposure.targetScope,
        query: exposure.query,
        status: exposure.status,
        searchScopePath: exposure.searchScopePath,
        scopeMode: exposure.scopeMode,
        matchMode: exposure.matchMode,
        rank: exposure.rank,
        prompt: truncate(state.prompt.replace(/\s+/g, " ").trim(), MAX_PROMPT_PAYLOAD_CHARS),
      },
      createdAt: flushAt,
    });
    result.exposed += 1;
  }

  for (const [memoryId, exposures] of exposuresByMemory) {
    const memory = db.getMemory(memoryId);
    if (!memory || memory.status !== "active") continue;

    const earliestExposure = exposures[0];
    const follow = followedByTouch(settings, memory, earliestExposure, state.touchedScopes);
    if (!follow) {
      recordAndApply(db, settings, state, {
        memoryId,
        eventType: "ignored",
        delta: settings.pheromoneIgnoredWeight,
        scopePath: earliestExposure.targetScope,
        payload: {
          source: earliestExposure.source,
          targetScope: earliestExposure.targetScope,
          query: earliestExposure.query,
          status: earliestExposure.status,
          searchScopePath: earliestExposure.searchScopePath,
          scopeMode: earliestExposure.scopeMode,
          matchMode: earliestExposure.matchMode,
          rank: earliestExposure.rank,
        },
        createdAt: flushAt,
      });
      result.ignored += 1;
      continue;
    }

    recordAndApply(db, settings, state, {
      memoryId,
      eventType: follow.eventType,
      delta: settings.pheromoneFollowWeight,
      scopePath: follow.touch.scopePath,
      toolName: follow.touch.toolName,
      toolCallId: follow.touch.toolCallId,
      payload: {
        source: earliestExposure.source,
        targetScope: earliestExposure.targetScope,
        query: earliestExposure.query,
        status: earliestExposure.status,
        searchScopePath: earliestExposure.searchScopePath,
        scopeMode: earliestExposure.scopeMode,
        matchMode: earliestExposure.matchMode,
        rank: earliestExposure.rank,
        followedScope: follow.touch.scopePath,
        followMode: follow.touch.mode,
      },
      createdAt: flushAt,
    });
    result.followed += 1;

    const validation = validationAfterFollow(follow.touch, state.validations);
    if (!validation) continue;

    recordAndApply(db, settings, state, {
      memoryId,
      eventType: validation.passed ? "validation_passed" : "validation_failed",
      delta: validation.passed ? settings.pheromoneSuccessWeight : settings.pheromoneFailureWeight,
      toolName: "bash",
      toolCallId: validation.toolCallId,
      payload: {
        command: validation.command,
        passed: validation.passed,
        followedScope: follow.touch.scopePath,
      },
      createdAt: flushAt,
    });
    result.validations += 1;
  }

  db.pruneTraceEvents(settings.traceRetentionDays);
  return result;
}

export function recordSenseExposureOnly(db: PortiaDatabase, settings: PortiaSettings, result: SenseResult, source: "command"): void {
  if (!shouldWritePheromones(settings)) return;
  const state = createPheromoneTraceState(settings, source);
  const exposedAt = new Date().toISOString();
  addSenseExposures(state, result, source);

  for (const exposure of state.exposures) {
    const memory = db.getMemory(exposure.memoryId);
    if (!memory || memory.status !== "active") continue;

    recordAndApply(db, settings, state, {
      memoryId: memory.id,
      eventType: "exposed",
      delta: 0,
      scopePath: exposure.targetScope,
      payload: {
        source,
        targetScope: exposure.targetScope,
        query: exposure.query,
      },
      createdAt: exposedAt,
    });
  }

  db.pruneTraceEvents(settings.traceRetentionDays);
}

export function computeEffectivePheromoneStrength(pheromone: { strength: number; lastDecayedAt: string }, halfLifeDays: number, now = Date.now()): number {
  const last = Date.parse(pheromone.lastDecayedAt);
  if (!Number.isFinite(last) || halfLifeDays <= 0 || now <= last) return pheromone.strength;
  const ageDays = (now - last) / 86_400_000;
  return pheromone.strength * Math.pow(0.5, ageDays / halfLifeDays);
}

export function computePheromoneBoost(effectiveStrength: number, maxBoost: number): number {
  return maxBoost * (1 - Math.exp(-Math.max(0, effectiveStrength) / 6));
}
