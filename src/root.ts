import * as fs from "node:fs";
import * as path from "node:path";

const ROOT_MARKERS = [
  [".pi", "settings.json"],
  [".git"],
  ["package.json"],
  ["AGENTS.md"],
] as const;

function hasMarker(dir: string, marker: readonly string[]): boolean {
  return fs.existsSync(path.join(dir, ...marker));
}

export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);

  try {
    const stat = fs.statSync(dir);
    if (stat.isFile()) dir = path.dirname(dir);
  } catch {
    // Keep the resolved input; it may be a not-yet-created cwd in tests.
  }

  while (true) {
    if (ROOT_MARKERS.some((marker) => hasMarker(dir, marker))) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

export function toProjectRelative(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative) return ".";
  return normalizeScopePath(relative);
}

export function normalizeScopePath(scopePath: string): string {
  const normalized = scopePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (!normalized || normalized === ".") return ".";
  return normalized.replace(/\/$/, "") || ".";
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
