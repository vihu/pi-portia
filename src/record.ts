import * as path from "node:path";
import type { PortiaDatabase } from "./db.ts";
import { MEMORY_KINDS } from "./types.ts";
import { isPathInside, normalizeScopePath, toProjectRelative } from "./root.ts";
import type {
  MemoryKind,
  MemoryRecord,
  PortiaDuplicatePolicy,
  PortiaRecordInput,
  PortiaRecordProposal,
  PortiaRecordResult,
  PortiaSettings,
} from "./types.ts";

const DEFAULT_IMPORTANCE = 5;
const DEFAULT_CONFIDENCE = 90;
const DEFAULT_DUPLICATE_POLICY: PortiaDuplicatePolicy = "blockExact";
const MAX_TITLE_LENGTH = 180;
const MAX_BODY_LENGTH = 4_000;
const MAX_SOURCE_TYPE_LENGTH = 80;
const MAX_SOURCE_REF_LENGTH = 240;
const MAX_EVIDENCE_LENGTH = 1_200;
const MAX_SUPERSEDES_ID_LENGTH = 240;

function stripAtPrefix(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

function trimOptional(value: string | undefined, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error(`${label} is too long; maximum is ${maxLength} characters.`);
  return trimmed;
}

function parseBoundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function parseKind(value: string): MemoryKind {
  if ((MEMORY_KINDS as readonly string[]).includes(value)) return value as MemoryKind;
  throw new Error(`Invalid Portia memory kind: ${value}`);
}

function parseDuplicatePolicy(value: string | undefined): PortiaDuplicatePolicy {
  if (value === undefined) return DEFAULT_DUPLICATE_POLICY;
  const normalized = value.trim();
  if (normalized === "warn" || normalized === "blockExact") return normalized;
  throw new Error(`Invalid Portia duplicatePolicy: ${value}`);
}

function resolveScopePath(settings: PortiaSettings, cwd: string, inputScopePath: string): string {
  const raw = stripAtPrefix(inputScopePath.trim() || ".");
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(cwd, raw);

  if (!isPathInside(settings.projectRoot, absolutePath)) {
    throw new Error(`Scope path is outside the Portia project root: ${inputScopePath}`);
  }

  return normalizeScopePath(toProjectRelative(settings.projectRoot, absolutePath));
}

export function createPortiaRecordProposal(settings: PortiaSettings, input: PortiaRecordInput, cwd: string): { proposal: PortiaRecordProposal; warnings: string[] } {
  const warnings: string[] = [];
  const body = input.body.trim();
  if (!body) throw new Error("Portia memory body must not be empty.");
  if (body.length > MAX_BODY_LENGTH) throw new Error(`Portia memory body is too long; maximum is ${MAX_BODY_LENGTH} characters.`);

  const proposal: PortiaRecordProposal = {
    scopePath: resolveScopePath(settings, cwd, input.scopePath),
    kind: parseKind(input.kind),
    title: trimOptional(input.title, MAX_TITLE_LENGTH, "Portia memory title"),
    body,
    importance: parseBoundedInteger(input.importance, DEFAULT_IMPORTANCE, 0, 10, "Portia memory importance"),
    confidence: parseBoundedInteger(input.confidence, DEFAULT_CONFIDENCE, 0, 100, "Portia memory confidence"),
    sourceType: trimOptional(input.sourceType, MAX_SOURCE_TYPE_LENGTH, "Portia sourceType"),
    sourceRef: trimOptional(input.sourceRef, MAX_SOURCE_REF_LENGTH, "Portia sourceRef"),
    evidence: trimOptional(input.evidence, MAX_EVIDENCE_LENGTH, "Portia evidence"),
    supersedesId: trimOptional(input.supersedesId, MAX_SUPERSEDES_ID_LENGTH, "Portia supersedesId"),
    duplicatePolicy: parseDuplicatePolicy(input.duplicatePolicy),
  };

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4) warnings.push("Memory body is very short; record only durable, specific project facts.");
  if (!proposal.title) warnings.push("No title provided; future inspect/map output may be less scannable.");
  if (!proposal.sourceType && !proposal.sourceRef) warnings.push("No provenance source provided; prefer sourceType/sourceRef when recording durable facts.");

  return { proposal, warnings };
}

function validateSupersedesTarget(db: PortiaDatabase, proposal: PortiaRecordProposal, warnings: string[]): MemoryRecord | undefined {
  if (!proposal.supersedesId) return undefined;

  const target = db.getMemory(proposal.supersedesId);
  if (!target) throw new Error(`Portia supersedes target not found: ${proposal.supersedesId}`);
  if (target.status !== "active") {
    throw new Error(`Portia supersedes target must be active; ${proposal.supersedesId} is ${target.status}.`);
  }
  if (target.scopePath !== proposal.scopePath || target.kind !== proposal.kind) {
    warnings.push(`Supersedes target ${target.id} has scope/kind ${target.scopePath}/${target.kind}; replacement is ${proposal.scopePath}/${proposal.kind}.`);
  }

  return target;
}

function analyzeRecord(db: PortiaDatabase, proposal: PortiaRecordProposal): {
  warnings: string[];
  duplicateBlockedBy?: MemoryRecord;
  relatedMemories: MemoryRecord[];
} {
  const warnings: string[] = [];
  const supersedesTarget = validateSupersedesTarget(db, proposal, warnings);
  const exactDuplicate = db.findExactDuplicateMemory({
    scopePath: proposal.scopePath,
    kind: proposal.kind,
    title: proposal.title,
    body: proposal.body,
  });

  const duplicateBlockedBy = proposal.duplicatePolicy === "blockExact" ? exactDuplicate : undefined;
  if (duplicateBlockedBy) {
    warnings.push(`Exact duplicate active memory exists: ${duplicateBlockedBy.id}. duplicatePolicy=blockExact prevented a duplicate write.`);
  } else if (exactDuplicate) {
    warnings.push(`Exact duplicate active memory exists: ${exactDuplicate.id}. duplicatePolicy=warn allows the write.`);
  }

  const excludedIds = new Set([exactDuplicate?.id, supersedesTarget?.id].filter((id): id is string => Boolean(id)));
  const relatedMemories = db.findRelatedMemories({
    scopePath: proposal.scopePath,
    kind: proposal.kind,
    title: proposal.title,
    body: proposal.body,
    limit: 5,
  }).filter((memory) => !excludedIds.has(memory.id));

  if (relatedMemories.length > 0) warnings.push(`Found ${relatedMemories.length} related active memor${relatedMemories.length === 1 ? "y" : "ies"}; inspect candidates before recording overlapping facts.`);

  return {
    warnings,
    duplicateBlockedBy,
    relatedMemories,
  };
}

function createRecordBase(settings: PortiaSettings, input: PortiaRecordInput, cwd: string, db?: PortiaDatabase) {
  if (!settings.enabled) throw new Error("Portia is disabled for this project/session.");

  const { proposal, warnings } = createPortiaRecordProposal(settings, input, cwd);
  let duplicateBlockedBy: MemoryRecord | undefined;
  let relatedMemories: MemoryRecord[] = [];

  if (db) {
    const analysis = analyzeRecord(db, proposal);
    warnings.push(...analysis.warnings);
    duplicateBlockedBy = analysis.duplicateBlockedBy;
    relatedMemories = analysis.relatedMemories;
  }

  return {
    projectRoot: settings.projectRoot,
    dbPath: settings.dbPath,
    writePolicy: settings.effectiveWritePolicy,
    modeOverride: settings.modeOverride,
    proposal,
    warnings,
    duplicateBlockedBy,
    relatedMemories,
  };
}

export function proposePortiaRecord(settings: PortiaSettings, input: PortiaRecordInput, cwd: string, db?: PortiaDatabase): PortiaRecordResult {
  const base = createRecordBase(settings, input, cwd, db);
  const skipReason = settings.effectiveWritePolicy === "confirm" ? "confirm" : "readonly";

  return {
    ...base,
    written: false,
    skipReason,
  };
}

export function recordPortiaMemory(db: PortiaDatabase, settings: PortiaSettings, input: PortiaRecordInput, cwd: string): PortiaRecordResult {
  const base = createRecordBase(settings, input, cwd, db);

  if (settings.effectiveWritePolicy !== "write") {
    return {
      ...base,
      written: false,
      skipReason: settings.effectiveWritePolicy,
    };
  }

  if (base.duplicateBlockedBy) {
    return {
      ...base,
      written: false,
      skipReason: "duplicate",
      memory: base.duplicateBlockedBy,
    };
  }

  const proposal = base.proposal;
  if (proposal.supersedesId) {
    const { memory, event, supersededMemory, supersedeEvent } = db.createMemorySuperseding({
      scopePath: proposal.scopePath,
      kind: proposal.kind,
      title: proposal.title,
      body: proposal.body,
      importance: proposal.importance,
      confidence: proposal.confidence,
      createdBy: "portia_record",
      supersedesId: proposal.supersedesId,
      supersedeReason: "Superseded by replacement memory created by portia_record.",
      sourceType: proposal.sourceType,
      sourceRef: proposal.sourceRef,
      eventPayload: {
        action: "record",
        proposal,
        evidence: proposal.evidence,
      },
    });

    return {
      ...base,
      written: true,
      memory,
      event,
      supersededMemory,
      supersedeEvent,
    };
  }

  const { memory, event } = db.createMemory({
    scopePath: proposal.scopePath,
    kind: proposal.kind,
    title: proposal.title,
    body: proposal.body,
    importance: proposal.importance,
    confidence: proposal.confidence,
    createdBy: "portia_record",
    sourceType: proposal.sourceType,
    sourceRef: proposal.sourceRef,
    eventPayload: {
      action: "record",
      proposal,
      evidence: proposal.evidence,
    },
  });

  return {
    ...base,
    written: true,
    memory,
    event,
  };
}
