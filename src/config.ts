import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { findProjectRoot } from "./root.ts";
import type { PortiaMode, PortiaSettings, WritePolicy } from "./types.ts";

const SETTINGS_KEY = "portia";
const DEFAULT_DB_PATH = ".pi/portia/portia.sqlite";

interface PartialPortiaSettings {
  enabled?: boolean;
  dbPath?: string;
  writePolicy?: WritePolicy;
  workerWritePolicy?: WritePolicy;
  maxSenseResults?: number;
  enableDependencyScan?: boolean;
  enableFts?: boolean;
  enableVectors?: boolean;
  autoPromptGuidance?: boolean;
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

function parseWritePolicy(value: unknown): WritePolicy | undefined {
  if (value === "readonly" || value === "confirm" || value === "write") return value;
  return undefined;
}

function parseMode(value: unknown): PortiaMode | undefined {
  if (value === "off") return value;
  return parseWritePolicy(value);
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

  const enableDependencyScan = parseBoolean(input.enableDependencyScan);
  if (enableDependencyScan !== undefined) settings.enableDependencyScan = enableDependencyScan;

  const enableFts = parseBoolean(input.enableFts);
  if (enableFts !== undefined) settings.enableFts = enableFts;

  const enableVectors = parseBoolean(input.enableVectors);
  if (enableVectors !== undefined) settings.enableVectors = enableVectors;

  const autoPromptGuidance = parseBoolean(input.autoPromptGuidance);
  if (autoPromptGuidance !== undefined) settings.autoPromptGuidance = autoPromptGuidance;

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
    enableDependencyScan: true,
    enableFts: true,
    enableVectors: false,
    autoPromptGuidance: true,
    ...globalSettings,
    ...projectSettings,
  };

  const envMode = parseMode(process.env.PORTIA_MODE?.trim().toLowerCase());
  const enabled = envMode === "off" ? false : merged.enabled;
  const effectiveWritePolicy = envMode && envMode !== "off" ? envMode : merged.writePolicy;

  return {
    ...merged,
    enabled,
    effectiveWritePolicy,
    modeOverride: envMode,
    dbPath: resolveConfiguredPath(merged.dbPath, projectRoot),
    projectRoot,
    globalSettingsPath,
    projectSettingsPath,
  };
}
