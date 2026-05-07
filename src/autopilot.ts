import * as fs from "node:fs";
import * as path from "node:path";
import type { PortiaDatabase } from "./db.ts";
import { renderAutopilotContext } from "./render.ts";
import { senseMemories } from "./retrieval.ts";
import { isPathInside, toProjectRelative } from "./root.ts";
import type { PortiaSettings, SenseResult } from "./types.ts";

const MAX_QUERY_CHARS = 500;
const PATH_TOKEN_RE = /@?[A-Za-z0-9._~/-]+/g;
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,12}$/;

export interface AutopilotTarget {
  path: string;
  includeDependencies: boolean;
  matchedPromptPath?: string;
}

export interface AutopilotContextResult {
  result: SenseResult;
  rendered: string;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function normalizePromptWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cleanPromptPathToken(token: string): string | undefined {
  let cleaned = token
    .trim()
    .replace(/^[`'"([{<]+/, "")
    .replace(/[`'"\])}>.,;:!?]+$/, "");

  if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
  if (!cleaned || cleaned.includes("://") || cleaned.includes("*")) return undefined;
  if (cleaned === "." || cleaned === ".." || cleaned === "~") return undefined;
  return cleaned;
}

function looksLikePath(candidate: string): boolean {
  return candidate.includes("/") || candidate.startsWith(".") || FILE_EXTENSION_RE.test(candidate);
}

function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existingPathCandidate(projectRoot: string, cwd: string, candidate: string): string | undefined {
  const candidates = path.isAbsolute(candidate)
    ? [path.resolve(candidate)]
    : [path.resolve(cwd, candidate), path.resolve(projectRoot, candidate)];

  for (const absolutePath of candidates) {
    if (isPathInside(projectRoot, absolutePath) && pathExists(absolutePath)) return absolutePath;
  }

  const fallback = candidates.find((absolutePath) => isPathInside(projectRoot, absolutePath));
  if (!fallback) return undefined;

  const parent = path.dirname(fallback);
  if (FILE_EXTENSION_RE.test(candidate) && isPathInside(projectRoot, parent) && pathExists(parent)) return fallback;
  return undefined;
}

export function extractPromptPathCandidates(prompt: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const match of prompt.matchAll(PATH_TOKEN_RE)) {
    const cleaned = cleanPromptPathToken(match[0]);
    if (!cleaned || !looksLikePath(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    candidates.push(cleaned);
  }

  return candidates;
}

export function selectAutopilotTarget(settings: PortiaSettings, prompt: string, cwd: string): AutopilotTarget {
  for (const candidate of extractPromptPathCandidates(prompt)) {
    const absolutePath = existingPathCandidate(settings.projectRoot, cwd, candidate);
    if (!absolutePath) continue;

    return {
      path: toProjectRelative(settings.projectRoot, absolutePath),
      includeDependencies: isExistingFile(absolutePath),
      matchedPromptPath: candidate,
    };
  }

  return {
    path: ".",
    includeDependencies: false,
  };
}

export function buildAutopilotSenseQuery(prompt: string): string | undefined {
  const normalized = normalizePromptWhitespace(prompt);
  return normalized ? truncate(normalized, MAX_QUERY_CHARS) : undefined;
}

export function renderAutopilotGuidance(settings: PortiaSettings): string | undefined {
  if (!settings.autoPromptGuidance) return undefined;

  const lines: string[] = [];
  lines.push("## Portia project memory autopilot");
  lines.push("");
  lines.push("Portia is persistent project memory. Treat Portia memories as pointers, not ground truth.");
  lines.push("- Before non-trivial work in unfamiliar project areas, use `portia_sense` with the relevant path/query.");

  if (settings.autoRecordGuidance) {
    lines.push("- After verified durable project-specific findings, use `portia_record` for decisions, gotchas, invariants, pointers, patterns, purpose, or plans.");
    lines.push("- Do not record generic advice, raw conversation summaries, every file read, or unverified speculation.");
    if (settings.effectiveWritePolicy === "write") {
      lines.push("- Current Portia write policy is `write`: record durable memories without asking the user for confirmation.");
    } else {
      lines.push(`- Current Portia write policy is \`${settings.effectiveWritePolicy}\`: use/return structured proposals instead of assuming a durable write happened.`);
    }
  }

  return lines.join("\n");
}

export function buildAutopilotContextResult(db: PortiaDatabase, settings: PortiaSettings, prompt: string, cwd: string): AutopilotContextResult | undefined {
  if (!settings.autoSense) return undefined;

  const target = selectAutopilotTarget(settings, prompt, cwd);
  const result = senseMemories(db, settings, {
    path: target.path,
    query: buildAutopilotSenseQuery(prompt),
    includeDependencies: target.includeDependencies,
    limit: settings.autoSenseMaxResults,
  }, cwd);
  const rendered = renderAutopilotContext(result, settings.autoSenseMaxChars);
  if (!rendered) return undefined;
  return { result, rendered };
}

export function buildAutopilotContext(db: PortiaDatabase, settings: PortiaSettings, prompt: string, cwd: string): string | undefined {
  return buildAutopilotContextResult(db, settings, prompt, cwd)?.rendered;
}
