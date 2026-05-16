import type { PortiaDatabase } from "./db.ts";
import type { PortiaReindexInput, PortiaReindexResult, PortiaSettings } from "./types.ts";

export function reindexPortia(db: PortiaDatabase, settings: PortiaSettings, input: PortiaReindexInput = {}): PortiaReindexResult {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const dryRun = input.dryRun ?? false;
  const canWrite = settings.effectiveWritePolicy === "write";
  const shouldWrite = !dryRun && canWrite;
  const warnings: string[] = [];

  if (!dryRun && !canWrite) {
    warnings.push(`Portia write policy is ${settings.effectiveWritePolicy}; reindex was not applied. Set writePolicy=write or run a dry-run first.`);
  }

  const result = db.reindex({ dryRun: !shouldWrite });
  warnings.push(...result.warnings);

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    dryRun,
    written: shouldWrite,
    writePolicy: settings.effectiveWritePolicy,
    before: result.before,
    after: result.after,
    recomputedSearchTerms: result.recomputedSearchTerms,
    rebuiltFts: result.rebuiltFts,
    warnings,
  };
}
