import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeScopePath, toProjectRelative, isPathInside } from "./root.ts";

const IMPORT_PATTERNS = [
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
  /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /require\s*\(\s*["']([^"']+)["']\s*\)/g,
] as const;

const EXTENSION_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const INDEX_CANDIDATES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs", "index.json"];

function isReadableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function resolveRelativeImport(fromDir: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const base = path.resolve(fromDir, specifier);
  for (const extension of EXTENSION_CANDIDATES) {
    const candidate = `${base}${extension}`;
    if (isReadableFile(candidate)) return candidate;
  }

  if (isDirectory(base)) {
    for (const index of INDEX_CANDIDATES) {
      const candidate = path.join(base, index);
      if (isReadableFile(candidate)) return candidate;
    }
  }

  return undefined;
}

export function dependencyScopesForFile(filePath: string, projectRoot: string, maxDependencies = 24): string[] {
  if (!isReadableFile(filePath)) return [];

  const stat = fs.statSync(filePath);
  if (stat.size > 1_000_000) return [];

  const text = fs.readFileSync(filePath, "utf-8");
  const fromDir = path.dirname(filePath);
  const scopes: string[] = [];

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && scopes.length < maxDependencies) {
      const specifier = match[1];
      if (!specifier) continue;

      const resolved = resolveRelativeImport(fromDir, specifier);
      if (!resolved || !isPathInside(projectRoot, resolved)) continue;

      const relative = toProjectRelative(projectRoot, resolved);
      scopes.push(relative);

      const directoryScope = normalizeScopePath(path.dirname(relative));
      if (directoryScope !== relative) scopes.push(directoryScope);
    }
  }

  return [...new Set(scopes)].slice(0, maxDependencies);
}
