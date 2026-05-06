import type { PortiaDatabase } from "./db.ts";
import type {
  MemoryStatus,
  PortiaRepairAction,
  PortiaRepairInput,
  PortiaRepairProposal,
  PortiaRepairResult,
  PortiaSettings,
} from "./types.ts";

const MAX_ID_LENGTH = 240;
const MAX_REASON_LENGTH = 1_200;
const MAX_SOURCE_TYPE_LENGTH = 80;
const MAX_SOURCE_REF_LENGTH = 240;
const MAX_EVIDENCE_LENGTH = 1_200;

function trimRequired(value: string, maxLength: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  if (trimmed.length > maxLength) throw new Error(`${label} is too long; maximum is ${maxLength} characters.`);
  return trimmed;
}

function trimOptional(value: string | undefined, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error(`${label} is too long; maximum is ${maxLength} characters.`);
  return trimmed;
}

function parseAction(value: string): PortiaRepairAction {
  const normalized = value.trim().toLowerCase();
  if (normalized === "stale" || normalized === "delete" || normalized === "reactivate") return normalized;
  throw new Error(`Invalid Portia repair action: ${value}`);
}

function targetStatusForAction(action: PortiaRepairAction): MemoryStatus {
  if (action === "delete") return "deleted";
  if (action === "reactivate") return "active";
  return "stale";
}

function createRepairProposal(db: PortiaDatabase, input: PortiaRepairInput): { proposal: PortiaRepairProposal; warnings: string[] } {
  const id = trimRequired(input.id, MAX_ID_LENGTH, "Portia repair id");
  const action = parseAction(input.action);
  const targetStatus = targetStatusForAction(action);
  const reason = trimRequired(input.reason, MAX_REASON_LENGTH, "Portia repair reason");
  const memory = db.getMemory(id);
  if (!memory) throw new Error(`Portia memory not found: ${id}`);

  const warnings: string[] = [];
  if (memory.status === targetStatus) warnings.push(`Memory is already ${targetStatus}; no status change is needed.`);

  return {
    proposal: {
      id,
      action,
      targetStatus,
      reason,
      sourceType: trimOptional(input.sourceType, MAX_SOURCE_TYPE_LENGTH, "Portia repair sourceType"),
      sourceRef: trimOptional(input.sourceRef, MAX_SOURCE_REF_LENGTH, "Portia repair sourceRef"),
      evidence: trimOptional(input.evidence, MAX_EVIDENCE_LENGTH, "Portia repair evidence"),
      currentStatus: memory.status,
    },
    warnings,
  };
}

function createRepairBase(db: PortiaDatabase, settings: PortiaSettings, input: PortiaRepairInput) {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const { proposal, warnings } = createRepairProposal(db, input);
  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    writePolicy: settings.effectiveWritePolicy,
    modeOverride: settings.modeOverride,
    proposal,
    warnings,
  };
}

export function repairPortiaMemory(db: PortiaDatabase, settings: PortiaSettings, input: PortiaRepairInput): PortiaRepairResult {
  const base = createRepairBase(db, settings, input);

  if (settings.effectiveWritePolicy !== "write") {
    return {
      ...base,
      written: false,
      skipReason: settings.effectiveWritePolicy === "confirm" ? "confirm" : "readonly",
    };
  }

  if (base.proposal.currentStatus === base.proposal.targetStatus) {
    return {
      ...base,
      written: false,
      skipReason: "noop",
    };
  }

  const { memory, event } = db.updateMemoryStatus({
    id: base.proposal.id,
    status: base.proposal.targetStatus,
    reason: base.proposal.reason,
    createdBy: "portia_repair",
    sourceType: base.proposal.sourceType,
    sourceRef: base.proposal.sourceRef,
    evidence: base.proposal.evidence,
    eventPayload: {
      action: "repair",
      repairAction: base.proposal.action,
    },
  });

  return {
    ...base,
    written: true,
    memory,
    event,
  };
}
