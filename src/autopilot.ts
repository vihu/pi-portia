import * as fs from "node:fs";
import * as path from "node:path";
import type { PortiaDatabase } from "./db.ts";
import { renderAutopilotContext } from "./render.ts";
import { senseMemories } from "./retrieval.ts";
import { isPathInside, toProjectRelative } from "./root.ts";
import { searchPortiaMemories } from "./search.ts";
import type { MemoryListStatus, PortiaSearchInput, PortiaSearchOutput, PortiaSettings, SenseResult } from "./types.ts";

const MAX_QUERY_CHARS = 500;
const MAX_AUTOPILOT_SEARCH_QUERY_CHARS = 220;
const PATH_TOKEN_RE = /@?[A-Za-z0-9._~/-]+/g;
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,12}$/;
const TOPIC_INTRO_RE = /\b(?:about|for|related\s+to|relating\s+to|mentioning|regarding|on)\s+(.+)$/iu;
const DECISION_TOPIC_RE = /\b(?:decide|decided|conclude|concluded|investigate|investigated)\s+(?:how|whether|if|why|what)?\s*(.+)$/iu;
const QUERY_TOKEN_RE = /[\p{L}\p{N}_./:@-]+/gu;

const HIGH_CONFIDENCE_PATTERNS = [
  /\b(?:find|search|look\s+up)\s+(?:\S+\s+){0,4}(?:portia\s+)?memories?\b/u,
  /\bmemories?\s+(?:mentioning|about|related\s+to|for)\b/u,
  /\bdid\s+we\s+already\s+decid(?:e|ed)\b/u,
  /\bhave\s+we\s+already\s+(?:investigated|looked\s+into|decid(?:e|ed)|covered)\b/u,
  /\balready\s+(?:decid(?:e|ed)|investigated|looked\s+into)\b/u,
  /\b(?:what\s+did\s+we|did\s+we)\s+(?:decide|conclude).*\b(?:earlier|previously|before|last\s+time)\b/u,
  /\bwhy\s+do\s+you\s+believe\b/u,
  /\bwhat\s+(?:source|provenance|evidence)\s+supports?\b/u,
  /\bsource\/provenance\b/u,
  /\b(?:find|search|look\s+up)\b.*\b(?:stale|deleted|superseded|repaired|reactivated|inactive|all\s+statuses?|any\s+status|old\s+records?)\b.*\bmemories?\b/u,
  /\b(?:stale|deleted|superseded|repaired|reactivated|inactive)\s+memories?\b/u,
  /\bmemories?\b.*\b(?:stale|deleted|superseded|repaired|reactivated|inactive|all\s+statuses?|any\s+status|old\s+records?)\b/u,
  /\b(?:all\s+statuses?|any\s+status|old\s+records?)\b/u,
  /\b(?:old|prior|previous)\s+validation\s+notes?\b/u,
  /\b(?:old|prior|previous)\s+(?:test\s+failures?|error\s+strings?|package\/?version\s+notes?)\b/u,
  /\b(?:observation|reflection)\s+ids?\b/u,
  /\bsourceref\b/u,
  /\bsourcetype\b/u,
  /\bcompacted\s+history\b/u,
];

const AUDIT_STATUS_PATTERNS = [
  /\b(?:find|search|look\s+up)\b.*\b(?:stale|deleted|superseded|repaired|reactivated|inactive|all\s+statuses?|any\s+status|old\s+records?)\b.*\bmemories?\b/u,
  /\b(?:stale|deleted|superseded|repaired|reactivated|inactive)\s+memories?\b/u,
  /\bmemories?\b.*\b(?:stale|deleted|superseded|repaired|reactivated|inactive|all\s+statuses?|any\s+status|old\s+records?)\b/u,
  /\b(?:all\s+statuses?|any\s+status|old\s+records?)\b/u,
];

const PROVENANCE_PATTERNS = [
  /\bwhy\s+do\s+you\s+believe\b/u,
  /\bwhat\s+(?:source|provenance|evidence)\s+supports?\b/u,
  /\bsource\/provenance\b/u,
];

const OBSERVATIONAL_BRIDGE_PATTERNS = [
  /\b(?:observation|reflection)\s+ids?\b/u,
  /\bsourceref\b/u,
  /\bsourcetype\b/u,
  /\bcompacted\s+history\b/u,
];

const MEDIUM_HISTORY_PATTERNS = [
  /\b(?:earlier|previously|previous|prior|last\s+time|history|remember|recall|recorded|stored)\b/u,
  /\b(?:decision|decided|rationale|concluded)\b/u,
];

const ROUTINE_PROMPT_RE = /^\s*(?:fix|read|run|implement|edit|update|change|inspect|summarize|summarise|test|typecheck)\b/iu;

const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "ask",
  "at",
  "be",
  "been",
  "before",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "exist",
  "exists",
  "find",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "last",
  "look",
  "lookup",
  "me",
  "memory",
  "memories",
  "of",
  "old",
  "on",
  "or",
  "please",
  "portia",
  "prior",
  "previous",
  "previously",
  "record",
  "recorded",
  "recall",
  "remember",
  "should",
  "source",
  "stored",
  "that",
  "the",
  "these",
  "this",
  "those",
  "time",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "why",
  "with",
  "work",
  "you",
]);

const WEAK_SINGLE_TERM_QUERIES = new Set(["error", "it", "setting", "source", "that", "this"]);

export interface AutopilotTarget {
  path: string;
  includeDependencies: boolean;
  matchedPromptPath?: string;
}

export interface AutopilotContextResult {
  result: SenseResult;
  rendered: string;
}

export type AutopilotSearchConfidence = "medium" | "high";

export interface AutopilotSearchSuggestion {
  query: string;
  status: Extract<MemoryListStatus, "active" | "any">;
  matchMode: "any";
  orderBy: "relevance";
  limit: number;
  scopePath?: string;
  confidence: AutopilotSearchConfidence;
  reason: string;
}

export interface AutopilotSearchPreviewResult {
  suggestion: AutopilotSearchSuggestion;
  result: PortiaSearchOutput;
  rendered: string;
}

export interface AutopilotSearchPreviewOptions {
  suggestion?: AutopilotSearchSuggestion;
  excludeMemoryIds?: Iterable<string>;
}

export interface AutopilotSearchSuggestionRenderOptions {
  toolAvailable?: boolean;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, Math.max(0, maxLength));
  return `${text.slice(0, maxLength - 1)}…`;
}

function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > 40 ? sliced.slice(0, lastSpace) : sliced).trim();
}

function normalizePromptWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cleanPromptPathToken(token: string): string | undefined {
  let cleaned = token
    .trim()
    .replace(/^[`'"([{<]+/, "")
    .replace(/[`'"\])}>.,;:!?]+$/, "");

  if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
  if (!cleaned || cleaned.includes("://") || cleaned.includes("*")) return undefined;
  if (cleaned === "." || cleaned === ".." || cleaned === "~") return undefined;
  return cleaned;
}

function looksLikePath(candidate: string): boolean {
  return candidate.includes("/") || candidate.startsWith(".") || FILE_EXTENSION_RE.test(candidate);
}

function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existingPathCandidate(projectRoot: string, cwd: string, candidate: string): string | undefined {
  const candidates = path.isAbsolute(candidate)
    ? [path.resolve(candidate)]
    : [path.resolve(cwd, candidate), path.resolve(projectRoot, candidate)];

  for (const absolutePath of candidates) {
    if (isPathInside(projectRoot, absolutePath) && pathExists(absolutePath)) return absolutePath;
  }

  const fallback = candidates.find((absolutePath) => isPathInside(projectRoot, absolutePath));
  if (!fallback) return undefined;

  const parent = path.dirname(fallback);
  if (FILE_EXTENSION_RE.test(candidate) && isPathInside(projectRoot, parent) && pathExists(parent)) return fallback;
  return undefined;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeSearchSourceText(text: string): string {
  return normalizePromptWhitespace(text)
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/[?!.,;:]+$/u, "");
}

function extractTopicText(prompt: string): string | undefined {
  const normalized = normalizeSearchSourceText(prompt);
  const topicIntro = normalized.match(TOPIC_INTRO_RE)?.[1]?.trim();
  if (topicIntro) return topicIntro;

  const decisionTopic = normalized.match(DECISION_TOPIC_RE)?.[1]?.trim();
  if (decisionTopic) return decisionTopic;

  return undefined;
}

function cleanQueryToken(token: string): string | undefined {
  const cleaned = token
    .trim()
    .replace(/^[`'"([{<]+/u, "")
    .replace(/[`'"\])}>.,;:!?]+$/u, "");
  if (!cleaned || cleaned === "-" || cleaned === "_") return undefined;
  return cleaned;
}

function isCodeLikeToken(token: string): boolean {
  return /[._/@:-]/u.test(token) || /[\p{Ll}\p{N}][\p{Lu}]/u.test(token) || /\d/u.test(token);
}

function queryTermsFromText(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const match of normalizeSearchSourceText(text).matchAll(QUERY_TOKEN_RE)) {
    const token = cleanQueryToken(match[0]);
    if (!token) continue;

    const normalized = token.toLowerCase();
    if (!isCodeLikeToken(token) && QUERY_STOPWORDS.has(normalized)) continue;
    if (normalized.length < 2) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    terms.push(token);
  }

  return terms;
}

function queryFromTerms(terms: string[]): string | undefined {
  if (terms.length === 0) return undefined;
  if (terms.length === 1 && WEAK_SINGLE_TERM_QUERIES.has(terms[0].toLowerCase())) return undefined;
  return truncateAtWord(terms.join(" "), MAX_AUTOPILOT_SEARCH_QUERY_CHARS);
}

function fallbackQueryForIntent(normalizedLowerPrompt: string): string | undefined {
  if (matchesAny(normalizedLowerPrompt, OBSERVATIONAL_BRIDGE_PATTERNS)) return "observation reflection sourceRef sourceType";
  if (matchesAny(normalizedLowerPrompt, PROVENANCE_PATTERNS)) return "source provenance evidence";
  return undefined;
}

function buildAutopilotSearchQuery(prompt: string, normalizedLowerPrompt: string): string | undefined {
  const topic = extractTopicText(prompt);
  const topicQuery = topic ? queryFromTerms(queryTermsFromText(topic)) : undefined;
  if (topicQuery) return topicQuery;

  const promptQuery = queryFromTerms(queryTermsFromText(prompt));
  if (promptQuery) return promptQuery;

  return fallbackQueryForIntent(normalizedLowerPrompt);
}

function searchIntentReason(normalizedLowerPrompt: string, confidence: AutopilotSearchConfidence): string {
  if (matchesAny(normalizedLowerPrompt, AUDIT_STATUS_PATTERNS)) return "audit/status memory recall";
  if (matchesAny(normalizedLowerPrompt, OBSERVATIONAL_BRIDGE_PATTERNS)) return "observational-memory provenance bridge";
  if (matchesAny(normalizedLowerPrompt, PROVENANCE_PATTERNS)) return "source/provenance evidence recall";
  if (confidence === "high") return "explicit historical project-memory recall";
  return "possible historical project-memory recall";
}

function hasMediumConfidenceIntent(normalizedLowerPrompt: string, prompt: string): boolean {
  if (!matchesAny(normalizedLowerPrompt, MEDIUM_HISTORY_PATTERNS)) return false;
  if (ROUTINE_PROMPT_RE.test(prompt) && !matchesAny(normalizedLowerPrompt, HIGH_CONFIDENCE_PATTERNS)) return false;
  return queryTermsFromText(prompt).length > 0;
}

function compactSearchResultForPreview(result: PortiaSearchOutput, excludeMemoryIds?: Iterable<string>): PortiaSearchOutput {
  const excluded = new Set(excludeMemoryIds ?? []);
  if (excluded.size === 0) return result;
  return {
    ...result,
    hits: result.hits.filter((hit) => !excluded.has(hit.memory.id)),
  };
}

export function extractPromptPathCandidates(prompt: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const match of prompt.matchAll(PATH_TOKEN_RE)) {
    const cleaned = cleanPromptPathToken(match[0]);
    if (!cleaned || !looksLikePath(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    candidates.push(cleaned);
  }

  return candidates;
}

export function selectAutopilotTarget(settings: PortiaSettings, prompt: string, cwd: string): AutopilotTarget {
  for (const candidate of extractPromptPathCandidates(prompt)) {
    const absolutePath = existingPathCandidate(settings.projectRoot, cwd, candidate);
    if (!absolutePath) continue;

    return {
      path: toProjectRelative(settings.projectRoot, absolutePath),
      includeDependencies: isExistingFile(absolutePath),
      matchedPromptPath: candidate,
    };
  }

  return {
    path: ".",
    includeDependencies: false,
  };
}

export function buildAutopilotSenseQuery(prompt: string): string | undefined {
  const normalized = normalizePromptWhitespace(prompt);
  return normalized ? truncate(normalized, MAX_QUERY_CHARS) : undefined;
}

export function buildAutopilotSearchSuggestion(settings: PortiaSettings, prompt: string, cwd: string): AutopilotSearchSuggestion | undefined {
  if (settings.autoSearchMode === "off") return undefined;

  const normalized = normalizePromptWhitespace(prompt);
  if (!normalized) return undefined;

  const normalizedLower = normalized.toLowerCase();
  const highConfidence = matchesAny(normalizedLower, HIGH_CONFIDENCE_PATTERNS);
  const mediumConfidence = highConfidence ? false : hasMediumConfidenceIntent(normalizedLower, normalized);
  if (!highConfidence && !mediumConfidence) return undefined;

  const query = buildAutopilotSearchQuery(normalized, normalizedLower);
  if (!query) return undefined;

  const target = selectAutopilotTarget(settings, prompt, cwd);
  const status = matchesAny(normalizedLower, AUDIT_STATUS_PATTERNS) ? "any" : "active";
  const confidence: AutopilotSearchConfidence = highConfidence ? "high" : "medium";

  return {
    query,
    status,
    matchMode: "any",
    orderBy: "relevance",
    limit: settings.autoSearchMaxResults,
    scopePath: target.path !== "." ? target.path : undefined,
    confidence,
    reason: searchIntentReason(normalizedLower, confidence),
  };
}

export function shouldBuildAutopilotSearchPreview(settings: PortiaSettings, suggestion: AutopilotSearchSuggestion | undefined): boolean {
  if (!suggestion) return false;
  if (settings.autoSearchMode === "context") return true;
  if (settings.autoSearchMode === "assist") return suggestion.confidence === "high";
  return false;
}

export function renderAutopilotGuidance(settings: PortiaSettings): string | undefined {
  if (!settings.autoPromptGuidance) return undefined;

  const lines: string[] = [];
  lines.push("## Portia project memory autopilot");
  lines.push("");
  lines.push("Portia is persistent project memory. Treat Portia memories as pointers, not ground truth.");
  lines.push("- Before non-trivial work in unfamiliar project areas, use `portia_sense` with the relevant path/query.");
  lines.push("- Use `portia_search` for explicit keyword/history lookup when you need broader recall than the bounded context pack.");

  if (settings.autoRecordGuidance) {
    lines.push("- After verified durable project-specific findings, use `portia_record` for decisions, gotchas, invariants, pointers, patterns, purpose, or plans.");
    lines.push("- Do not record generic advice, raw conversation summaries, every file read, or unverified speculation.");
    if (settings.effectiveWritePolicy === "write") {
      lines.push("- Current Portia write policy is `write`: record durable memories without asking the user for confirmation.");
    } else {
      lines.push(`- Current Portia write policy is \`${settings.effectiveWritePolicy}\`: use/return structured proposals instead of assuming a durable write happened.`);
    }
  }

  return lines.join("\n");
}

export function renderAutopilotSearchSuggestion(
  suggestion: AutopilotSearchSuggestion,
  options: AutopilotSearchSuggestionRenderOptions = {},
): string | undefined {
  if (options.toolAvailable === false) return undefined;

  const lines: string[] = [];
  lines.push("## Portia historical recall suggestion");
  lines.push("");
  lines.push("This prompt appears to ask for broad or historical project-memory recall.");
  lines.push("Consider calling `portia_search` before answering:");
  lines.push("");
  lines.push(`- query: ${JSON.stringify(suggestion.query)}`);
  lines.push(`- status: ${JSON.stringify(suggestion.status)}`);
  if (suggestion.scopePath) lines.push(`- scopePath: ${JSON.stringify(suggestion.scopePath)}`);
  lines.push(`- matchMode: ${JSON.stringify(suggestion.matchMode)}`);
  lines.push(`- orderBy: ${JSON.stringify(suggestion.orderBy)}`);
  lines.push(`- limit: ${suggestion.limit}`);
  lines.push("");
  lines.push("Treat search hits as pointers and verify source/provenance before relying on them.");
  return lines.join("\n");
}

export function renderAutopilotSearchPreview(result: PortiaSearchOutput, maxChars: number): string | undefined {
  if (result.hits.length === 0) return undefined;

  const lines: string[] = [];
  lines.push("## Portia Historical Recall Preview");
  lines.push("");
  lines.push("Durable-memory matches for this turn. Treat as pointers; verify source/provenance.");
  lines.push("");

  for (const hit of result.hits) {
    const memory = hit.memory;
    const status = result.filters.status === "any" || memory.status !== "active" ? `${memory.status} ` : "";
    const title = memory.title ? truncate(memory.title.replace(/\s+/g, " ").trim(), 96) : truncate(memory.body.replace(/\s+/g, " ").trim(), 96);
    const snippetSource = hit.snippet || memory.body;
    const snippet = truncate(snippetSource.replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim(), 180);
    const entryLines = [`- [${memory.id}] ${status}${memory.kind} ${memory.scopePath} — ${title}`];
    if (snippet && snippet !== title) entryLines.push(`  ${snippet}`);

    const candidate = [...lines, ...entryLines].join("\n");
    if (candidate.length > maxChars) break;
    lines.push(...entryLines);
  }

  if (lines.length <= 4) return undefined;
  return truncate(lines.join("\n"), maxChars);
}

export function buildAutopilotContextResult(db: PortiaDatabase, settings: PortiaSettings, prompt: string, cwd: string): AutopilotContextResult | undefined {
  if (!settings.autoSense) return undefined;

  const target = selectAutopilotTarget(settings, prompt, cwd);
  const result = senseMemories(db, settings, {
    path: target.path,
    query: buildAutopilotSenseQuery(prompt),
    includeDependencies: target.includeDependencies,
    limit: settings.autoSenseMaxResults,
  }, cwd);
  const rendered = renderAutopilotContext(result, settings.autoSenseMaxChars);
  if (!rendered) return undefined;
  return { result, rendered };
}

export function buildAutopilotSearchPreviewResult(
  db: PortiaDatabase,
  settings: PortiaSettings,
  prompt: string,
  cwd: string,
  options: AutopilotSearchPreviewOptions = {},
): AutopilotSearchPreviewResult | undefined {
  const suggestion = options.suggestion ?? buildAutopilotSearchSuggestion(settings, prompt, cwd);
  if (!suggestion || !shouldBuildAutopilotSearchPreview(settings, suggestion)) return undefined;

  const input: PortiaSearchInput = {
    query: suggestion.query,
    status: suggestion.status,
    orderBy: suggestion.orderBy,
    matchMode: suggestion.matchMode,
    includeSubstringFallback: true,
    limit: suggestion.limit,
  };
  if (suggestion.scopePath) {
    input.scopePath = suggestion.scopePath;
    input.scopeMode = "subtree";
  }

  const result = compactSearchResultForPreview(searchPortiaMemories(db, settings, input, cwd), options.excludeMemoryIds);
  const rendered = renderAutopilotSearchPreview(result, settings.autoSearchMaxChars);
  if (!rendered) return undefined;
  return { suggestion, result, rendered };
}

export function buildAutopilotContext(db: PortiaDatabase, settings: PortiaSettings, prompt: string, cwd: string): string | undefined {
  return buildAutopilotContextResult(db, settings, prompt, cwd)?.rendered;
}
