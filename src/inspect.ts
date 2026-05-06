import type { PortiaDatabase } from "./db.ts";
import type { PortiaInspectInput, PortiaInspectResult, PortiaSettings } from "./types.ts";

const MAX_ID_LENGTH = 240;

function parseId(value: string): string {
  const id = value.trim();
  if (!id) throw new Error("Portia inspect id must not be empty.");
  if (id.length > MAX_ID_LENGTH) throw new Error(`Portia inspect id is too long; maximum is ${MAX_ID_LENGTH} characters.`);
  return id;
}

export function inspectPortiaMemory(db: PortiaDatabase, settings: PortiaSettings, input: PortiaInspectInput): PortiaInspectResult {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const id = parseId(input.id);
  const memory = db.getMemory(id);
  const includeEvents = input.includeEvents ?? true;
  const events = memory && includeEvents ? db.getMemoryEvents(id) : [];
  const warnings: string[] = [];

  if (!memory) warnings.push("No Portia memory found for this id. Try /portia-list query <term> to search.");

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    id,
    memory,
    events,
    warnings,
  };
}
