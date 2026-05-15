import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findProjectRoot } from "./root.ts";
import type { PheromoneWorkerPolicy, PortiaMode, PortiaSettings, WritePolicy } from "./types.ts";

const SETTINGS_KEY = "portia";
const DEFAULT_DB_PATH = ".pi/portia/portia.sqlite";
const ABSOLUTE_BROWSE_LIMIT = 500;

interface PartialPortiaSettings {
  enabled?: boolean;
  dbPath?: string;
  writePolicy?: WritePolicy;
  workerWritePolicy?: WritePolicy;
  maxSenseResults?: number;
  searchDefaultLimit?: number;
  searchMaxResults?: number;
  listDefaultLimit?: number;
  listMaxResults?: number;
  enableDependencyScan?: boolean;
  enableFts?: boolean;
  enableVectors?: boolean;
  autoPromptGuidance?: boolean;
  autoRecordGuidance?: boolean;
  autoSense?: boolean;
  autoSenseMaxResults?: number;
  autoSenseMaxChars?: number;
  enablePheromones?: boolean;
  pheromoneRanking?: boolean;
  pheromoneHalfLifeDays?: number;
  pheromoneMaxBoost?: number;
  pheromoneFollowWeight?: number;
  pheromoneSuccessWeight?: number;
  pheromoneFailureWeight?: number;
  pheromoneIgnoredWeight?: number;
  pheromoneWorkerPolicy?: PheromoneWorkerPolicy;
  traceRetentionDays?: number;
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed;
}

function parseWritePolicy(value: unknown): WritePolicy | undefined {
  if (value === "readonly" || value === "confirm" || value === "write") return value;
  return undefined;
}

function parseMode(value: unknown): PortiaMode | undefined {
  if (value === "off") return value;
  return parseWritePolicy(value);
}

function parsePheromoneWorkerPolicy(value: unknown): PheromoneWorkerPolicy | undefined {
  if (value === "off" || value === "low" || value === "write") return value;
  return undefined;
}

function parseSettingsFile(filePath: string): PartialPortiaSettings {
  const raw = readJsonSafe(filePath)[SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const input = raw as Record<string, unknown>;
  const settings: PartialPortiaSettings = {};

  const enabled = parseBoolean(input.enabled);
  if (enabled !== undefined) settings.enabled = enabled;

  if (typeof input.dbPath === "string" && input.dbPath.trim()) {
    settings.dbPath = input.dbPath.trim();
  }

  const writePolicy = parseWritePolicy(input.writePolicy);
  if (writePolicy) settings.writePolicy = writePolicy;

  const workerWritePolicy = parseWritePolicy(input.workerWritePolicy);
  if (workerWritePolicy) settings.workerWritePolicy = workerWritePolicy;

  const maxSenseResults = parsePositiveInteger(input.maxSenseResults);
  if (maxSenseResults) settings.maxSenseResults = Math.min(maxSenseResults, 50);

  const searchDefaultLimit = parsePositiveInteger(input.searchDefaultLimit);
  if (searchDefaultLimit) settings.searchDefaultLimit = Math.min(searchDefaultLimit, ABSOLUTE_BROWSE_LIMIT);

  const searchMaxResults = parsePositiveInteger(input.searchMaxResults);
  if (searchMaxResults) settings.searchMaxResults = Math.min(searchMaxResults, ABSOLUTE_BROWSE_LIMIT);

  const listDefaultLimit = parsePositiveInteger(input.listDefaultLimit);
  if (listDefaultLimit) settings.listDefaultLimit = Math.min(listDefaultLimit, ABSOLUTE_BROWSE_LIMIT);

  const listMaxResults = parsePositiveInteger(input.listMaxResults);
  if (listMaxResults) settings.listMaxResults = Math.min(listMaxResults, ABSOLUTE_BROWSE_LIMIT);

  const enableDependencyScan = parseBoolean(input.enableDependencyScan);
  if (enableDependencyScan !== undefined) settings.enableDependencyScan = enableDependencyScan;

  const enableFts = parseBoolean(input.enableFts);
  if (enableFts !== undefined) settings.enableFts = enableFts;

  const enableVectors = parseBoolean(input.enableVectors);
  if (enableVectors !== undefined) settings.enableVectors = enableVectors;

  const autoPromptGuidance = parseBoolean(input.autoPromptGuidance);
  if (autoPromptGuidance !== undefined) settings.autoPromptGuidance = autoPromptGuidance;

  const autoRecordGuidance = parseBoolean(input.autoRecordGuidance);
  if (autoRecordGuidance !== undefined) settings.autoRecordGuidance = autoRecordGuidance;

  const autoSense = parseBoolean(input.autoSense);
  if (autoSense !== undefined) settings.autoSense = autoSense;

  const autoSenseMaxResults = parsePositiveInteger(input.autoSenseMaxResults);
  if (autoSenseMaxResults) settings.autoSenseMaxResults = Math.min(autoSenseMaxResults, 12);

  const autoSenseMaxChars = parsePositiveInteger(input.autoSenseMaxChars);
  if (autoSenseMaxChars) settings.autoSenseMaxChars = Math.min(autoSenseMaxChars, 12_000);

  const enablePheromones = parseBoolean(input.enablePheromones);
  if (enablePheromones !== undefined) settings.enablePheromones = enablePheromones;

  const pheromoneRanking = parseBoolean(input.pheromoneRanking);
  if (pheromoneRanking !== undefined) settings.pheromoneRanking = pheromoneRanking;

  const pheromoneHalfLifeDays = parsePositiveNumber(input.pheromoneHalfLifeDays);
  if (pheromoneHalfLifeDays !== undefined) settings.pheromoneHalfLifeDays = Math.min(pheromoneHalfLifeDays, 3650);

  const pheromoneMaxBoost = parsePositiveNumber(input.pheromoneMaxBoost);
  if (pheromoneMaxBoost !== undefined) settings.pheromoneMaxBoost = Math.min(pheromoneMaxBoost, 100);

  const pheromoneFollowWeight = parseFiniteNumber(input.pheromoneFollowWeight);
  if (pheromoneFollowWeight !== undefined) settings.pheromoneFollowWeight = Math.max(-10, Math.min(10, pheromoneFollowWeight));

  const pheromoneSuccessWeight = parseFiniteNumber(input.pheromoneSuccessWeight);
  if (pheromoneSuccessWeight !== undefined) settings.pheromoneSuccessWeight = Math.max(-10, Math.min(10, pheromoneSuccessWeight));

  const pheromoneFailureWeight = parseFiniteNumber(input.pheromoneFailureWeight);
  if (pheromoneFailureWeight !== undefined) settings.pheromoneFailureWeight = Math.max(-10, Math.min(10, pheromoneFailureWeight));

  const pheromoneIgnoredWeight = parseFiniteNumber(input.pheromoneIgnoredWeight);
  if (pheromoneIgnoredWeight !== undefined) settings.pheromoneIgnoredWeight = Math.max(-10, Math.min(10, pheromoneIgnoredWeight));

  const pheromoneWorkerPolicy = parsePheromoneWorkerPolicy(input.pheromoneWorkerPolicy);
  if (pheromoneWorkerPolicy) settings.pheromoneWorkerPolicy = pheromoneWorkerPolicy;

  const traceRetentionDays = parsePositiveInteger(input.traceRetentionDays);
  if (traceRetentionDays) settings.traceRetentionDays = Math.min(traceRetentionDays, 3650);

  return settings;
}

function resolveConfiguredPath(value: string, projectRoot: string): string {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;
  return path.resolve(projectRoot, value);
}

export function resolvePortiaSettings(cwd: string): PortiaSettings {
  const projectRoot = findProjectRoot(cwd);
  const globalDir = getAgentDir();
  const globalSettingsPath = path.join(globalDir, "settings.json");
  const projectSettingsPath = path.join(projectRoot, ".pi", "settings.json");

  const globalSettings = parseSettingsFile(globalSettingsPath);
  const projectSettings = parseSettingsFile(projectSettingsPath);
  const merged = {
    enabled: true,
    dbPath: DEFAULT_DB_PATH,
    writePolicy: "confirm" as WritePolicy,
    workerWritePolicy: "readonly" as WritePolicy,
    maxSenseResults: 12,
    searchDefaultLimit: 30,
    searchMaxResults: 250,
    listDefaultLimit: 30,
    listMaxResults: 250,
    enableDependencyScan: true,
    enableFts: true,
    enableVectors: false,
    autoPromptGuidance: true,
    autoRecordGuidance: true,
    autoSense: true,
    autoSenseMaxResults: 5,
    autoSenseMaxChars: 2_500,
    enablePheromones: true,
    pheromoneRanking: true,
    pheromoneHalfLifeDays: 30,
    pheromoneMaxBoost: 25,
    pheromoneFollowWeight: 1,
    pheromoneSuccessWeight: 2,
    pheromoneFailureWeight: -0.4,
    pheromoneIgnoredWeight: 0,
    pheromoneWorkerPolicy: "off" as PheromoneWorkerPolicy,
    traceRetentionDays: 180,
    ...globalSettings,
    ...projectSettings,
  };

  const envMode = parseMode(process.env.PORTIA_MODE?.trim().toLowerCase());
  const enabled = envMode === "off" ? false : merged.enabled;
  const effectiveWritePolicy = envMode && envMode !== "off" ? envMode : merged.writePolicy;
  const searchMaxResults = Math.min(merged.searchMaxResults, ABSOLUTE_BROWSE_LIMIT);
  const listMaxResults = Math.min(merged.listMaxResults, ABSOLUTE_BROWSE_LIMIT);
  const searchDefaultLimit = Math.min(merged.searchDefaultLimit, searchMaxResults);
  const listDefaultLimit = Math.min(merged.listDefaultLimit, listMaxResults);

  return {
    ...merged,
    enabled,
    effectiveWritePolicy,
    searchDefaultLimit,
    searchMaxResults,
    listDefaultLimit,
    listMaxResults,
    modeOverride: envMode,
    dbPath: resolveConfiguredPath(merged.dbPath, projectRoot),
    projectRoot,
    globalSettingsPath,
    projectSettingsPath,
  };
}
