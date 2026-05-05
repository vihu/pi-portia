export const MEMORY_KINDS = [
  "purpose",
  "pointer",
  "invariant",
  "gotcha",
  "decision",
  "pattern",
  "plan",
] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];
export type MemoryStatus = "active" | "superseded" | "stale" | "deleted";
export type WritePolicy = "readonly" | "confirm" | "write";
export type PortiaMode = WritePolicy | "off";
export type PortiaRecordSkipReason = "readonly" | "confirm";

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
