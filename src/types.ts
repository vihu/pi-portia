export const MEMORY_KINDS = [
  "purpose",
  "pointer",
  "invariant",
  "gotcha",
  "decision",
  "pattern",
  "plan",
] as const;

export const MEMORY_STATUSES = [
  "active",
  "superseded",
  "stale",
  "deleted",
] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];
export type MemoryStatus = typeof MEMORY_STATUSES[number];
export type MemoryListStatus = MemoryStatus | "any";
export type WritePolicy = "readonly" | "confirm" | "write";
export type PortiaMode = WritePolicy | "off";
export type PortiaRecordSkipReason = "readonly" | "confirm";
export type PortiaRepairAction = "stale" | "delete" | "reactivate";
export type PortiaRepairSkipReason = "readonly" | "confirm" | "noop";

export interface PortiaSettings {
  enabled: boolean;
  dbPath: string;
  writePolicy: WritePolicy;
  workerWritePolicy: WritePolicy;
  effectiveWritePolicy: WritePolicy;
  maxSenseResults: number;
  enableDependencyScan: boolean;
  enableFts: boolean;
  enableVectors: boolean;
  autoPromptGuidance: boolean;
  autoRecordGuidance: boolean;
  autoSense: boolean;
  autoSenseMaxResults: number;
  autoSenseMaxChars: number;
  modeOverride?: PortiaMode;
  projectRoot: string;
  globalSettingsPath: string;
  projectSettingsPath: string;
}

export interface MemoryRecord {
  rowid: number;
  id: string;
  scopePath: string;
  kind: MemoryKind | string;
  title?: string;
  body: string;
  status: MemoryStatus | string;
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  supersedesId?: string;
  sourceType?: string;
  sourceRef?: string;
}

export interface MemoryEvent {
  id: string;
  memoryId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
  createdBy?: string;
}

export interface CreateMemoryInput {
  scopePath: string;
  kind: MemoryKind;
  title?: string;
  body: string;
  importance: number;
  confidence: number;
  createdBy?: string;
  supersedesId?: string;
  sourceType?: string;
  sourceRef?: string;
  eventPayload?: Record<string, unknown>;
}

export interface CreateMemoryResult {
  memory: MemoryRecord;
  event: MemoryEvent;
}

export interface PortiaRecordInput {
  scopePath: string;
  kind: MemoryKind;
  body: string;
  title?: string;
  importance?: number;
  confidence?: number;
  sourceType?: string;
  sourceRef?: string;
  evidence?: string;
}

export interface PortiaRecordProposal {
  scopePath: string;
  kind: MemoryKind;
  title?: string;
  body: string;
  importance: number;
  confidence: number;
  sourceType?: string;
  sourceRef?: string;
  evidence?: string;
}

export interface PortiaRecordResult {
  projectRoot: string;
  dbPath: string;
  writePolicy: WritePolicy;
  modeOverride?: PortiaMode;
  written: boolean;
  skipReason?: PortiaRecordSkipReason;
  proposal: PortiaRecordProposal;
  memory?: MemoryRecord;
  event?: MemoryEvent;
  warnings: string[];
}

export interface MemoryListFilters {
  status?: MemoryListStatus;
  scopePath?: string;
  kind?: MemoryKind | string;
  query?: string;
  limit?: number;
}

export interface PortiaListResult {
  projectRoot: string;
  dbPath: string;
  filters: {
    status: MemoryListStatus;
    scopePath?: string;
    kind?: MemoryKind;
    query?: string;
    limit: number;
  };
  memories: MemoryRecord[];
  warnings: string[];
}

export interface PortiaInspectInput {
  id: string;
  includeEvents?: boolean;
}

export interface PortiaInspectResult {
  projectRoot: string;
  dbPath: string;
  id: string;
  memory?: MemoryRecord;
  events: MemoryEvent[];
  warnings: string[];
}

export interface PortiaRepairInput {
  id: string;
  action: PortiaRepairAction;
  reason: string;
  sourceType?: string;
  sourceRef?: string;
  evidence?: string;
}

export interface PortiaRepairProposal {
  id: string;
  action: PortiaRepairAction;
  targetStatus: MemoryStatus;
  reason: string;
  sourceType?: string;
  sourceRef?: string;
  evidence?: string;
  currentStatus?: string;
}

export interface PortiaRepairResult {
  projectRoot: string;
  dbPath: string;
  writePolicy: WritePolicy;
  modeOverride?: PortiaMode;
  written: boolean;
  skipReason?: PortiaRepairSkipReason;
  proposal: PortiaRepairProposal;
  memory?: MemoryRecord;
  event?: MemoryEvent;
  warnings: string[];
}

export interface UpdateMemoryStatusInput {
  id: string;
  status: MemoryStatus;
  reason: string;
  createdBy?: string;
  sourceType?: string;
  sourceRef?: string;
  evidence?: string;
  eventPayload?: Record<string, unknown>;
}

export interface UpdateMemoryStatusResult {
  memory: MemoryRecord;
  event: MemoryEvent;
}

export interface PortiaStats {
  dbPath: string;
  schemaVersion: number;
  totalMemories: number;
  activeMemories: number;
  staleMemories: number;
  supersededMemories: number;
  deletedMemories: number;
  ftsAvailable: boolean;
  byKind: Array<{ kind: string; count: number }>;
  topScopes: Array<{ scopePath: string; count: number }>;
}

export interface RetrievalSignal {
  type: "proximity" | "dependency" | "chord";
  scopePath?: string;
  strength?: number;
  score?: number;
  query?: string;
  count?: number;
}

export interface RetrievedMemory extends MemoryRecord {
  rank: number;
  reasons: RetrievalSignal[];
  ftsScore?: number;
}

export interface SenseInput {
  path: string;
  query?: string;
  includeDependencies?: boolean;
  limit?: number;
}

export interface SenseResult {
  projectRoot: string;
  dbPath: string;
  targetPath: string;
  targetScope: string;
  query?: string;
  includeDependencies: boolean;
  limit: number;
  signals: RetrievalSignal[];
  memories: RetrievedMemory[];
  warnings: string[];
}
