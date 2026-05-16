import type { PortiaDatabase } from "./db.ts";
import type { PortiaDoctorResult, PortiaDoctorSummary, PortiaSettings } from "./types.ts";

function summarize(checks: PortiaDoctorResult["checks"]): PortiaDoctorSummary {
  const summary: PortiaDoctorSummary = { ok: 0, warnings: 0, errors: 0 };
  for (const check of checks) {
    if (check.status === "ok") summary.ok += 1;
    else if (check.status === "warning") summary.warnings += 1;
    else summary.errors += 1;
  }
  return summary;
}

export function doctorPortia(db: PortiaDatabase, settings: PortiaSettings): PortiaDoctorResult {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const health = db.doctor();
  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    enabled: settings.enabled,
    schemaVersion: health.schemaVersion,
    settings: {
      writePolicy: settings.writePolicy,
      effectiveWritePolicy: settings.effectiveWritePolicy,
      enableFts: settings.enableFts,
      enablePheromones: settings.enablePheromones,
    },
    summary: summarize(health.checks),
    checks: health.checks,
  };
}
