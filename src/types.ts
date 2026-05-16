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
export type PortiaRecordSkipReason = "readonly" | "confirm" | "duplicate";
export type PortiaDuplicatePolicy = "warn" | "blockExact";
export type PortiaRepairAction = "stale" | "delete" | "reactivate";
export type PortiaRepairSkipReason = "readonly" | "confirm" | "noop";
export type PheromoneWorkerPolicy = "off" | "low" | "write";
export type PheromoneTraceEventType =
  | "exposed"
  | "followed_scope"
  | "followed_source_ref"
  | "ignored"
  | "validation_passed"
  | "validation_failed"
  | "manual_repair"
  | "manual_delete"
  | "superseded"
  | "decayed";

export interface PortiaSettings {
  enabled: boolean;
  dbPath: string;
  writePolicy: WritePolicy;
  workerWritePolicy: WritePolicy;
  effectiveWritePolicy: WritePolicy;
  maxSenseResults: number;
  searchDefaultLimit: number;
  searchMaxResults: number;
  listDefaultLimit: number;
  listMaxResults: number;
  enableDependencyScan: boolean;
  enableFts: boolean;
  enableVectors: boolean;
  autoPromptGuidance: boolean;
  autoRecordGuidance: boolean;
  autoSense: boolean;
  autoSenseMaxResults: number;
  autoSenseMaxChars: number;
  enablePheromones: boolean;
  pheromoneRanking: boolean;
  pheromoneHalfLifeDays: number;
  pheromoneMaxBoost: number;
  pheromoneFollowWeight: number;
  pheromoneSuccessWeight: number;
  pheromoneFailureWeight: number;
  pheromoneIgnoredWeight: number;
  pheromoneWorkerPolicy: PheromoneWorkerPolicy;
  traceRetentionDays: number;
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

export interface MemoryPheromone {
  memoryId: string;
  strength: number;
  exposedCount: number;
  followedCount: number;
  ignoredCount: number;
  successCount: number;
  failureCount: number;
  lastExposedAt?: string;
  lastFollowedAt?: string;
  lastIgnoredAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastDecayedAt: string;
  updatedAt: string;
}

export interface MemoryPheromoneSummary extends MemoryPheromone {
  memory?: MemoryRecord;
  effectiveStrength?: number;
  boost?: number;
}

export interface MemoryTraceEvent {
  id: string;
  memoryId: string;
  eventType: PheromoneTraceEventType | string;
  scopePath?: string;
  toolName?: string;
  toolCallId?: string;
  sessionFile?: string;
  turnId?: string;
  weight: number;
  payloadJson: string;
  createdAt: string;
}

export interface RecordTraceEventInput {
  memoryId: string;
  eventType: PheromoneTraceEventType | string;
  scopePath?: string;
  toolName?: string;
  toolCallId?: string;
  sessionFile?: string;
  turnId?: string;
  weight?: number;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface ApplyPheromoneDeltaInput {
  memoryId: string;
  eventType: PheromoneTraceEventType | string;
  delta: number;
  halfLifeDays?: number;
  createdAt?: string;
}

export interface ListPheromonesFilters {
  mode?: "top" | "weak";
  limit?: number;
}

export interface PortiaTrailsInput {
  mode?: "top" | "weak" | "recent" | "memory";
  memoryId?: string;
  limit?: number;
}

export interface PortiaTrailsResult {
  projectRoot: string;
  dbPath: string;
  mode: "top" | "weak" | "recent" | "memory";
  memoryId?: string;
  pheromones: MemoryPheromoneSummary[];
  events: MemoryTraceEvent[];
  warnings: string[];
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

export interface CreateMemorySupersedingInput extends CreateMemoryInput {
  supersedesId: string;
  supersedeReason: string;
}

export interface CreateMemorySupersedingResult extends CreateMemoryResult {
  supersededMemory: MemoryRecord;
  supersedeEvent: MemoryEvent;
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
  supersedesId?: string;
  duplicatePolicy?: PortiaDuplicatePolicy;
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
  supersedesId?: string;
  duplicatePolicy: PortiaDuplicatePolicy;
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
  duplicateBlockedBy?: MemoryRecord;
  relatedMemories: MemoryRecord[];
  supersededMemory?: MemoryRecord;
  supersedeEvent?: MemoryEvent;
}

export interface PortiaListPage {
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface MemoryListFilters {
  status?: MemoryListStatus;
  scopePath?: string;
  kind?: MemoryKind | string;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface MemoryListResult {
  memories: MemoryRecord[];
  page: PortiaListPage;
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
    cursor?: string;
  };
  memories: MemoryRecord[];
  page: PortiaListPage;
  warnings: string[];
}

export type PortiaSearchScopeMode = "subtree" | "exact";
export type PortiaSearchOrderBy = "relevance" | "updated" | "importance";
export type PortiaSearchMatchMode = "all" | "any" | "phrase";
export type PortiaSearchMatchType = "fts" | "substring";

export interface PortiaSearchInput {
  query: string;
  status?: MemoryListStatus;
  scopePath?: string;
  scopeMode?: PortiaSearchScopeMode;
  kind?: MemoryKind | string;
  orderBy?: PortiaSearchOrderBy;
  matchMode?: PortiaSearchMatchMode;
  includeSubstringFallback?: boolean;
  limit?: number;
  cursor?: string;
}

export interface PortiaSearchHit {
  memory: MemoryRecord;
  matchType: PortiaSearchMatchType;
  score?: number;
  snippet?: string;
}

export interface PortiaSearchPage {
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface PortiaSearchOutput {
  projectRoot: string;
  dbPath: string;
  filters: {
    query: string;
    status: MemoryListStatus;
    scopePath?: string;
    scopeMode: PortiaSearchScopeMode;
    kind?: MemoryKind;
    orderBy: PortiaSearchOrderBy;
    matchMode: PortiaSearchMatchMode;
    includeSubstringFallback: boolean;
    limit: number;
    cursor?: string;
  };
  hits: PortiaSearchHit[];
  page: PortiaSearchPage;
  warnings: string[];
}

export interface MemorySearchFilters {
  ftsQuery: string;
  rawQuery?: string;
  terms?: string[];
  status?: MemoryListStatus;
  scopePath?: string;
  scopeMode?: PortiaSearchScopeMode;
  kind?: MemoryKind | string;
  orderBy?: PortiaSearchOrderBy;
  matchMode?: PortiaSearchMatchMode;
  includeSubstringFallback?: boolean;
  limit?: number;
  cursor?: string;
}

export interface MemorySearchResult {
  hits: PortiaSearchHit[];
  page: PortiaSearchPage;
}

export type PortiaDoctorStatus = "ok" | "warning" | "error";

export interface PortiaDoctorCheck {
  name: string;
  status: PortiaDoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface PortiaDoctorSummary {
  ok: number;
  warnings: number;
  errors: number;
}

export interface PortiaDoctorResult {
  projectRoot: string;
  dbPath: string;
  enabled: boolean;
  schemaVersion: number;
  settings: {
    writePolicy: string;
    effectiveWritePolicy: string;
    enableFts: boolean;
    enablePheromones: boolean;
  };
  summary: PortiaDoctorSummary;
  checks: PortiaDoctorCheck[];
}

export interface PortiaReindexInput {
  dryRun?: boolean;
}

export interface PortiaReindexStats {
  memoryCount: number;
  nullSearchTerms: number;
  ftsRows?: number;
}

export interface PortiaReindexResult {
  projectRoot: string;
  dbPath: string;
  dryRun: boolean;
  written: boolean;
  writePolicy: string;
  before: PortiaReindexStats;
  after?: PortiaReindexStats;
  recomputedSearchTerms: number;
  rebuiltFts: boolean;
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
  supersededBy: MemoryRecord[];
  pheromone?: MemoryPheromone;
  pheromoneEffectiveStrength?: number;
  pheromoneBoost?: number;
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
  pheromoneTraceEvents: number;
  pheromoneMemoryCount: number;
  reinforcedMemories: number;
  byKind: Array<{ kind: string; count: number }>;
  topScopes: Array<{ scopePath: string; count: number }>;
}

export interface RetrievalSignal {
  type: "proximity" | "dependency" | "chord" | "pheromone";
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
  pheromoneStrength?: number;
  pheromoneEffectiveStrength?: number;
  pheromoneBoost?: number;
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
