import * as fs from "node:fs";
import * as path from "node:path";
import { dependencyScopesForFile } from "./dependencies.ts";
import type { PortiaDatabase } from "./db.ts";
import { isPathInside, normalizeScopePath, toProjectRelative } from "./root.ts";
import type { MemoryRecord, PortiaSettings, RetrievedMemory, RetrievalSignal, SenseInput, SenseResult } from "./types.ts";

const KIND_WEIGHTS: Record<string, number> = {
  invariant: 28,
  gotcha: 26,
  decision: 24,
  pointer: 20,
  purpose: 16,
  plan: 12,
  pattern: 10,
};

interface Candidate {
  memory: MemoryRecord;
  reasons: RetrievalSignal[];
  ftsScore?: number;
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

function stripAtPrefix(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

function resolveTargetPath(projectRoot: string, cwd: string, inputPath: string): string {
  const raw = stripAtPrefix(inputPath.trim() || ".");
  if (path.isAbsolute(raw)) return path.resolve(raw);

  const cwdCandidate = path.resolve(cwd, raw);
  const rootCandidate = path.resolve(projectRoot, raw);

  if (!pathExists(cwdCandidate) && pathExists(rootCandidate)) return rootCandidate;
  return cwdCandidate;
}

function scopeChainForTarget(targetAbs: string, targetScope: string): Array<{ scopePath: string; strength: number }> {
  const scopes: string[] = [];
  const looksLikeFile = isExistingFile(targetAbs) || Boolean(path.extname(targetScope));

  if (targetScope !== ".") scopes.push(targetScope);

  let current = looksLikeFile ? normalizeScopePath(path.dirname(targetScope)) : targetScope;
  while (true) {
    const normalized = normalizeScopePath(current);
    if (!scopes.includes(normalized)) scopes.push(normalized);
    if (normalized === ".") break;
    current = path.dirname(normalized);
  }

  return scopes.map((scopePath, index) => ({
    scopePath,
    strength: Math.max(20, 100 - index * 12),
  }));
}

function buildFtsQuery(query: string): string | undefined {
  const tokens = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_./:-]+/gu)
    ?.map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 12);

  if (!tokens || tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

function recencyWeight(updatedAt: string): number {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 0;

  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (ageDays <= 7) return 8;
  if (ageDays <= 30) return 5;
  if (ageDays <= 180) return 2;
  return 0;
}

function addCandidate(candidates: Map<string, Candidate>, memory: MemoryRecord, reason: RetrievalSignal, ftsScore?: number): void {
  const existing = candidates.get(memory.id);
  if (existing) {
    existing.reasons.push(reason);
    if (ftsScore !== undefined) existing.ftsScore = ftsScore;
    return;
  }

  candidates.set(memory.id, {
    memory,
    reasons: [reason],
    ftsScore,
  });
}

function rankCandidate(candidate: Candidate): number {
  const bestStrength = Math.max(0, ...candidate.reasons.map((reason) => reason.strength ?? 0));
  const hasFts = candidate.ftsScore !== undefined;
  const ftsWeight = hasFts ? 35 : 0;
  const kindWeight = KIND_WEIGHTS[candidate.memory.kind] ?? 8;
  const importanceWeight = candidate.memory.importance * 4;
  return bestStrength + ftsWeight + kindWeight + importanceWeight + recencyWeight(candidate.memory.updatedAt);
}

function summarizeSignals(items: Array<{ reasons: RetrievalSignal[] }>): RetrievalSignal[] {
  const aggregate = new Map<string, RetrievalSignal>();

  for (const item of items) {
    for (const reason of item.reasons) {
      const key = `${reason.type}:${reason.scopePath ?? reason.query ?? ""}`;
      const existing = aggregate.get(key);
      if (existing) {
        existing.count = (existing.count ?? 0) + 1;
        existing.strength = Math.max(existing.strength ?? 0, reason.strength ?? 0) || undefined;
        continue;
      }
      aggregate.set(key, { ...reason, count: 1 });
    }
  }

  return [...aggregate.values()].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
}

function clampLimit(input: number | undefined, fallback: number): number {
  if (!input || !Number.isFinite(input)) return fallback;
  return Math.max(1, Math.min(50, Math.floor(input)));
}

export function senseMemories(db: PortiaDatabase, settings: PortiaSettings, input: SenseInput, cwd: string): SenseResult {
  const warnings: string[] = [];
  const limit = clampLimit(input.limit, settings.maxSenseResults);
  const includeDependencies = input.includeDependencies ?? settings.enableDependencyScan;
  const targetAbs = resolveTargetPath(settings.projectRoot, cwd, input.path);

  if (!isPathInside(settings.projectRoot, targetAbs)) {
    throw new Error(`Path is outside the Portia project root: ${input.path}`);
  }

  const targetScope = toProjectRelative(settings.projectRoot, targetAbs);
  const proximityScopes = scopeChainForTarget(targetAbs, targetScope);
  const candidates = new Map<string, Candidate>();

  for (const memory of db.getActiveMemoriesByScopes(proximityScopes.map((scope) => scope.scopePath))) {
    const scope = proximityScopes.find((candidateScope) => candidateScope.scopePath === memory.scopePath);
    addCandidate(candidates, memory, {
      type: "proximity",
      scopePath: memory.scopePath,
      strength: scope?.strength ?? 50,
    });
  }

  if (includeDependencies && isExistingFile(targetAbs)) {
    const dependencyScopes = dependencyScopesForFile(targetAbs, settings.projectRoot);
    for (const memory of db.getActiveMemoriesByScopes(dependencyScopes)) {
      addCandidate(candidates, memory, {
        type: "dependency",
        scopePath: memory.scopePath,
        strength: 70,
      });
    }
  }

  const query = input.query?.trim();
  if (query && settings.enableFts) {
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery) {
      try {
        for (const memory of db.searchActiveMemories(ftsQuery, Math.max(limit * 3, 24))) {
          addCandidate(candidates, memory, {
            type: "chord",
            query,
            score: memory.ftsScore,
            strength: 45,
          }, memory.ftsScore);
        }
      } catch (error) {
        warnings.push(`FTS search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const ranked: RetrievedMemory[] = [...candidates.values()]
    .map((candidate) => ({
      ...candidate.memory,
      reasons: candidate.reasons,
      ftsScore: candidate.ftsScore,
      rank: rankCandidate(candidate),
    }))
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, limit);

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    targetPath: targetAbs,
    targetScope,
    query: query || undefined,
    includeDependencies,
    limit,
    signals: summarizeSignals(ranked),
    memories: ranked,
    warnings,
  };
}
