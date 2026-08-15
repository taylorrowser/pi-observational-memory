import {
  buildContextEntries,
  type ContextEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

import type { ObservationalMemorySettings } from "./settings.js";

export interface ActorModel {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly ancestry: readonly SessionEntry[];
  readonly actor?: ActorModel;
  readonly inputTokens?: number;
  /** Estimated system-prompt and active-tool tokens for the next actor request. */
  readonly fixedInputTokens?: number;
}

export interface MemoryLayerMetric {
  readonly tokens: number;
  readonly limit: number;
  readonly percent: number;
}

export interface MemoryInspection {
  readonly observations: readonly {
    readonly id: string;
    readonly timestamp: string;
    readonly observations: readonly string[];
    readonly folded: boolean;
  }[];
  readonly reflection?: {
    readonly id: string;
    readonly reflectedHistory: readonly string[];
  };
  readonly metrics: {
    readonly messages: MemoryLayerMetric;
    readonly observations: MemoryLayerMetric & { readonly count: number };
    readonly reflection: MemoryLayerMetric;
  };
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: number;
  };
}

export interface MemoryCompactionResult {
  readonly observationsCreated: number;
  readonly reflectionsCreated: number;
  readonly inspection: MemoryInspection;
}

export interface SessionMemory {
  restore(snapshot: SessionSnapshot): void;
  configure(settings: ObservationalMemorySettings): void;
  setEnabled(enabled: boolean): void;
  observe(snapshot: SessionSnapshot, signal?: AbortSignal): void;
  maintain(
    snapshot: () => SessionSnapshot,
    signal?: AbortSignal,
  ): Promise<MemoryCompactionResult>;
  compact(
    snapshot: SessionSnapshot,
    signal?: AbortSignal,
  ): Promise<MemoryCompactionResult>;
  inspect(snapshot: SessionSnapshot): MemoryInspection;
  editObservation(id: string, observations: readonly string[]): void;
  editReflection(reflectedHistory: readonly string[]): void;
  project(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
    signal?: AbortSignal,
  ): Promise<ContextEvent["messages"]>;
  dispose(): void;
}

type AssistantMessage = Extract<
  ContextEvent["messages"][number],
  { role: "assistant" }
>;

export interface ExtensionUsageAttribution {
  readonly usage: AssistantMessage["usage"];
  readonly provider: string;
  readonly model: string;
  readonly operation: `${string}:${string}`;
  readonly passId?: string;
}

export interface ObservationRequest {
  readonly passId: string;
  readonly parentCommitId: string | null;
  readonly actor: ActorModel;
  readonly pressure: {
    readonly usableInput: number;
    readonly rawTarget: number;
    readonly soft: number;
    readonly hard: number;
    readonly safetyReserve: number;
    readonly observationOutputBudget: number;
    readonly observationTarget: number;
    readonly observationHigh: number;
    readonly reflectionOutputBudget: number;
  };
  readonly activeMemory?: {
    readonly reflectedHistory?: readonly string[];
    readonly observations: readonly string[];
    readonly derivedOrientations: readonly DerivedOrientation[];
    readonly activeTask: ActiveTaskAnchor;
  };
  readonly source: {
    readonly entryIds: readonly string[];
    readonly entries: readonly SessionEntry[];
  };
}

export interface ObservationResponse {
  readonly text: string;
  readonly usage: ExtensionUsageAttribution["usage"];
  readonly provider: string;
  readonly model: string;
  readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly errorMessage?: string;
}

export interface ReflectionObservation {
  readonly id: string;
  readonly timestamp: string;
  readonly observations: readonly string[];
  readonly derivedOrientations: readonly DerivedOrientation[];
}

export interface ReflectionRequest {
  readonly passId: string;
  readonly actor: ActorModel;
  readonly pressure: ObservationRequest["pressure"];
  readonly parentReflection: {
    readonly id: string;
    readonly reflectedHistory: readonly string[];
    readonly foldedObservationIds: readonly string[];
  } | null;
  readonly coverage: { readonly observationIds: readonly string[] };
  readonly observations: readonly ReflectionObservation[];
}

export type ReflectionResponse = ObservationResponse;

interface VerifiedProgress {
  readonly claim: string;
  readonly evidence: readonly string[];
}

interface ActiveTaskAnchor {
  readonly originalIntent: string;
  readonly constraints: readonly string[];
  readonly decisions: readonly string[];
  readonly verifiedProgress: readonly VerifiedProgress[];
  readonly currentWork: readonly string[];
  readonly blockers: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly nextMove: {
    readonly owner: "user" | "assistant" | "shared";
    readonly action: string;
  };
}

export interface DerivedOrientation {
  readonly evidenceStatus: "derived-orientation";
  readonly sourceEntryId: string;
  readonly fromEntryId: string;
  readonly producer: "pi" | "extension";
  readonly summary: string;
}

interface ObservationCommit {
  readonly protocol: "observational-memory.observation";
  readonly version: 1;
  readonly id: string;
  readonly replayEpoch: string;
  readonly parentCommitId: string | null;
  readonly coverage: {
    readonly entryIds: readonly string[];
    readonly startEntryId: string;
    readonly endEntryId: string;
  };
  readonly observations: readonly string[];
  readonly derivedOrientations: readonly DerivedOrientation[];
  readonly activeTask: ActiveTaskAnchor;
  readonly lineage: { readonly parentCommitId: string | null };
  readonly producer: { readonly provider: string; readonly model: string };
  readonly usage: ExtensionUsageAttribution["usage"];
  readonly timestamp: string;
  readonly fidelity: "normal";
  readonly promptVersion: 1;
  readonly outputEstimate: number;
  readonly validation: {
    readonly version: 1;
    readonly checks: readonly string[];
  };
}

interface ReflectionGeneration {
  readonly protocol: "observational-memory.reflection";
  readonly version: 1;
  readonly id: string;
  readonly replayEpoch: string;
  readonly parentReflectionId: string | null;
  readonly coverage: {
    readonly observationIds: readonly string[];
    readonly startObservationId: string;
    readonly endObservationId: string;
  };
  readonly foldedObservationIds: readonly string[];
  readonly reflectedHistory: readonly string[];
  readonly lineage: { readonly parentReflectionId: string | null };
  readonly producer: { readonly provider: string; readonly model: string };
  readonly usage: ExtensionUsageAttribution["usage"];
  readonly timestamp: string;
  readonly fidelity: "normal";
  readonly promptVersion: 1;
  readonly outputEstimate: number;
  readonly validation: {
    readonly version: 1;
    readonly checks: readonly string[];
  };
}

interface ReadyObservation {
  readonly sessionId: string;
  readonly launchLeafId: string | null;
  readonly expectedParentCommitId: string | null;
  readonly record: ObservationCommit;
}

export type MemoryDebugEventName =
  | "maintenance-requested"
  | "maintenance-started"
  | "maintenance-completed"
  | "maintenance-cancelled"
  | "observation-started"
  | "observation-ready"
  | "observation-activated"
  | "observation-rejected"
  | "observation-failed"
  | "observation-cancelled"
  | "observation-retry"
  | "reflection-started"
  | "reflection-committed"
  | "reflection-rejected"
  | "reflection-failed"
  | "reflection-cancelled"
  | "reflection-retry"
  | "hard-headroom-wait"
  | "hard-headroom-terminal";

export type MemoryDebugReason =
  | "ambient-threshold"
  | "observation-threshold"
  | "manual-compaction"
  | "hard-headroom"
  | "validated"
  | "safe-composition"
  | "stop-reason"
  | "empty-output"
  | "provider-mismatch"
  | "model-mismatch"
  | "malformed-json"
  | "invalid-envelope"
  | "protocol-mismatch"
  | "version-mismatch"
  | "pass-mismatch"
  | "parent-mismatch"
  | "coverage-mismatch"
  | "empty-observations"
  | "incomplete-active-task"
  | "output-budget-exceeded"
  | "empty-source"
  | "invalid-response"
  | "exception"
  | "first-attempt-failed"
  | "lifecycle-fence"
  | "signal-aborted"
  | "idle-escape"
  | "disabled"
  | "navigation"
  | "session-replacement"
  | "shutdown"
  | "lifecycle-kick"
  | "settled"
  | "memory-operation-running"
  | "observation-required"
  | "reflection-required"
  | "cancelled"
  | "exhausted";

export interface MemoryDebugEvent {
  readonly protocol: "observational-memory.event";
  readonly version: 1;
  readonly event: MemoryDebugEventName;
  readonly operation: "maintenance" | "observation" | "reflection" | "hard-headroom";
  readonly reason: MemoryDebugReason;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly passId?: string;
  readonly attempt?: number;
  readonly metrics: {
    readonly messages: { readonly tokens: number; readonly threshold: number; readonly target: number };
    readonly observations: { readonly tokens: number; readonly threshold: number; readonly target: number; readonly count: number };
    readonly reflection: { readonly tokens: number; readonly limit: number };
    readonly actorInputTokens?: number;
    readonly fixedInputTokens?: number;
    readonly hardLimit?: number;
  };
  readonly coverage?: {
    readonly entryCount?: number;
    readonly observationCount?: number;
  };
  readonly detail?: string;
}

export interface SessionMemoryHost {
  appendEntry(customType: string, data?: unknown): void;
  /** Optional bounded lifecycle instrumentation. */
  debugEvent?(event: MemoryDebugEvent): void;
  /** Optional instrumentation for hosts that track standalone model usage. */
  attributeUsage?(attribution: ExtensionUsageAttribution): void;
  estimateTokens(messages: ContextEvent["messages"]): number;
  completeObservation(
    request: ObservationRequest,
    signal?: AbortSignal,
  ): Promise<ObservationResponse>;
  completeReflection?(
    request: ReflectionRequest,
    signal?: AbortSignal,
  ): Promise<ReflectionResponse>;
  setStatus?(status: string | undefined): void;
  abortActor?(message?: string): void;
}

const RAW_TARGET_RATIO = 0.5;
const SOFT_PRESSURE_RATIO = 0.6;
const HARD_PRESSURE_RATIO = 0.85;
const OBSERVATION_OUTPUT_RATIO = 0.1;
const OBSERVATION_TARGET_RATIO = 0.15;
const OBSERVATION_HIGH_RATIO = 0.25;
const OBSERVATION_CUSTOM_TYPE = "observational-memory:observation";
const REFLECTION_CUSTOM_TYPE = "observational-memory:reflection";
const OBSERVATION_EDIT_CUSTOM_TYPE = "observational-memory:observation-edit";
const REFLECTION_EDIT_CUSTOM_TYPE = "observational-memory:reflection-edit";
const USAGE_CUSTOM_TYPE = "observational-memory:usage";
export const DEBUG_EVENT_CUSTOM_TYPE = "observational-memory:event";

function pressurePolicy(
  actor: ActorModel,
  settings?: ObservationalMemorySettings,
): ObservationRequest["pressure"] {
  const usableInput = Math.max(1, actor.contextWindow - actor.maxTokens);
  const hard = settings
    ? Math.min(settings.hardHeadroomTokens, actor.contextWindow)
    : Math.floor(usableInput * HARD_PRESSURE_RATIO);
  return {
    usableInput,
    rawTarget: settings?.messageTokensTarget ?? Math.floor(usableInput * RAW_TARGET_RATIO),
    soft:
      settings?.messageTokensStartObservation ??
      Math.floor(usableInput * SOFT_PRESSURE_RATIO),
    hard,
    safetyReserve: settings
      ? Math.max(0, actor.contextWindow - hard)
      : Math.max(0, usableInput - hard),
    observationOutputBudget: Math.min(
      actor.maxTokens,
      Math.max(1, Math.floor(usableInput * OBSERVATION_OUTPUT_RATIO)),
    ),
    observationTarget:
      settings?.observationTokensTarget ??
      Math.max(1, Math.floor(usableInput * OBSERVATION_TARGET_RATIO)),
    observationHigh:
      settings?.observationTokensStartReflection ??
      Math.max(1, Math.floor(usableInput * OBSERVATION_HIGH_RATIO)),
    reflectionOutputBudget: Math.min(
      actor.maxTokens,
      settings?.reflectionTokensMax ??
        Math.max(1, Math.floor(usableInput * OBSERVATION_OUTPUT_RATIO)),
    ),
  };
}

function isObservationEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" }> & {
  readonly customType: typeof OBSERVATION_CUSTOM_TYPE;
} {
  return entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;
}

function isReflectionEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" }> & {
  readonly customType: typeof REFLECTION_CUSTOM_TYPE;
} {
  return entry.type === "custom" && entry.customType === REFLECTION_CUSTOM_TYPE;
}

function isMemoryEntry(entry: SessionEntry): boolean {
  if ((entry as { readonly type: string }).type === "extension_usage") {
    return true;
  }
  return (
    entry.type === "custom" &&
    (entry.customType === OBSERVATION_CUSTOM_TYPE ||
      entry.customType === REFLECTION_CUSTOM_TYPE ||
      entry.customType === OBSERVATION_EDIT_CUSTOM_TYPE ||
      entry.customType === REFLECTION_EDIT_CUSTOM_TYPE ||
      entry.customType === USAGE_CUSTOM_TYPE ||
      entry.customType === DEBUG_EVENT_CUSTOM_TYPE)
  );
}

function sourceEntries(ancestry: readonly SessionEntry[]): SessionEntry[] {
  return buildContextEntries([...ancestry]).filter(
    (entry) => !isMemoryEntry(entry),
  );
}

interface CompactionBoundary {
  readonly entry: Extract<SessionEntry, { type: "compaction" }>;
  readonly index: number;
}

function latestCompaction(
  ancestry: readonly SessionEntry[],
): CompactionBoundary | undefined {
  let latest: CompactionBoundary | undefined;
  for (const [index, entry] of ancestry.entries()) {
    if (entry.type === "compaction") latest = { entry, index };
  }
  return latest;
}

function replayEpoch(snapshot: SessionSnapshot): string {
  const compaction = latestCompaction(snapshot.ancestry)?.entry;
  return compaction ? `${snapshot.sessionId}:${compaction.id}` : snapshot.sessionId;
}

function derivedOrientations(
  entries: readonly SessionEntry[],
): DerivedOrientation[] {
  return entries
    .filter(
      (
        entry,
      ): entry is Extract<SessionEntry, { type: "branch_summary" }> =>
        entry.type === "branch_summary",
    )
    .map((entry) => ({
      evidenceStatus: "derived-orientation",
      sourceEntryId: entry.id,
      fromEntryId: entry.fromId,
      producer: entry.fromHook ? "extension" : "pi",
      summary: entry.summary,
    }));
}

function entryMessages(entry: SessionEntry): ContextEvent["messages"] {
  return sessionEntryToContextMessages(entry);
}

function completedStepBoundaries(entries: readonly SessionEntry[]): number[] {
  const boundaries: number[] = [];
  let pendingToolCalls: Set<string> | undefined;

  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (
      message.role === "user" &&
      pendingToolCalls &&
      pendingToolCalls.size > 0
    ) {
      // The session advanced to a new user turn before the outstanding results
      // were persisted (for example, after a process or computer restart). Keep
      // the orphaned calls in source, but let later completed work establish a
      // new safe boundary instead of blocking observation forever.
      pendingToolCalls = undefined;
      continue;
    }

    if (message.role === "assistant") {
      if (pendingToolCalls && pendingToolCalls.size > 0) continue;
      if (
        message.stopReason === "aborted" ||
        message.stopReason === "error" ||
        message.stopReason === "length"
      ) {
        pendingToolCalls = undefined;
        continue;
      }
      pendingToolCalls = new Set(
        message.content
          .filter((content) => content.type === "toolCall")
          .map((content) => content.id),
      );
      if (pendingToolCalls.size === 0) boundaries.push(index);
      continue;
    }

    if (
      message.role === "toolResult" &&
      pendingToolCalls?.delete(message.toolCallId) &&
      pendingToolCalls.size === 0
    ) {
      boundaries.push(index);
    }
  }

  return boundaries;
}

function uncoveredMessageTokens(
  host: SessionMemoryHost,
  snapshot: SessionSnapshot,
  coveredEntryIds: readonly string[],
): number | undefined {
  const allSourceEntries = sourceEntries(snapshot.ancestry);
  if (
    !coveredEntryIds.every(
      (entryId, index) => allSourceEntries[index]?.id === entryId,
    )
  ) {
    return undefined;
  }
  const uncoveredMessages = allSourceEntries
    .slice(coveredEntryIds.length)
    .flatMap(entryMessages);
  return uncoveredMessages.length === 0
    ? 0
    : host.estimateTokens(uncoveredMessages);
}

function uncoveredRawTokens(
  host: SessionMemoryHost,
  snapshot: SessionSnapshot,
  coveredEntryIds: readonly string[],
): number | undefined {
  const allSourceEntries = sourceEntries(snapshot.ancestry);
  const estimatedUncovered = uncoveredMessageTokens(
    host,
    snapshot,
    coveredEntryIds,
  );
  if (estimatedUncovered === undefined || snapshot.inputTokens === undefined) {
    return estimatedUncovered;
  }
  const coveredMessages = allSourceEntries
    .slice(0, coveredEntryIds.length)
    .flatMap(entryMessages);
  const estimatedCovered =
    coveredMessages.length === 0 ? 0 : host.estimateTokens(coveredMessages);
  return Math.max(
    estimatedUncovered,
    Math.max(0, snapshot.inputTokens - estimatedCovered),
  );
}

function frozenPrefix(
  host: SessionMemoryHost,
  snapshot: SessionSnapshot,
  coveredEntryIds: readonly string[],
  force = false,
  settings?: ObservationalMemorySettings,
): SessionEntry[] | undefined {
  if (!snapshot.actor) return undefined;
  const policy = pressurePolicy(snapshot.actor, settings);
  const allSourceEntries = sourceEntries(snapshot.ancestry);
  const uncoveredTokens = uncoveredMessageTokens(
    host,
    snapshot,
    coveredEntryIds,
  );
  const actorInputTokens =
    snapshot.inputTokens ??
    host.estimateTokens(allSourceEntries.flatMap(entryMessages));
  const inputTokens =
    force || settings
      ? uncoveredTokens
      : uncoveredTokens === undefined
        ? actorInputTokens
        : Math.max(actorInputTokens, uncoveredTokens);
  if (inputTokens === undefined || (!force && inputTokens < policy.soft)) {
    return undefined;
  }

  const tokensToRetire = Math.max(1, inputTokens - policy.rawTarget);
  const entries = allSourceEntries.slice(coveredEntryIds.length);
  const boundaries = completedStepBoundaries(entries);
  let estimatedTokens = 0;
  let boundaryCursor = 0;

  for (const [index, entry] of entries.entries()) {
    estimatedTokens += host.estimateTokens(entryMessages(entry));
    if (index !== boundaries[boundaryCursor]) continue;
    boundaryCursor += 1;
    if (estimatedTokens >= tokensToRetire) return entries.slice(0, index + 1);
  }

  const lastBoundary = boundaries.at(-1);
  return lastBoundary === undefined ? undefined : entries.slice(0, lastBoundary + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonemptyString(item));
}

function isVerifiedProgress(value: unknown): value is VerifiedProgress {
  return (
    isRecord(value) &&
    isNonemptyString(value.claim) &&
    isStringArray(value.evidence) &&
    value.evidence.length > 0
  );
}

function parseActiveTask(value: unknown): ActiveTaskAnchor | undefined {
  if (!isRecord(value) || !isRecord(value.nextMove)) return undefined;
  const verifiedProgress = value.verifiedProgress;
  if (
    !isNonemptyString(value.originalIntent) ||
    !isStringArray(value.constraints) ||
    !isStringArray(value.decisions) ||
    !Array.isArray(verifiedProgress) ||
    !verifiedProgress.every(isVerifiedProgress) ||
    !isStringArray(value.currentWork) ||
    !isStringArray(value.blockers) ||
    !isStringArray(value.unresolvedQuestions) ||
    (value.nextMove.owner !== "user" &&
      value.nextMove.owner !== "assistant" &&
      value.nextMove.owner !== "shared") ||
    !isNonemptyString(value.nextMove.action)
  ) {
    return undefined;
  }

  return {
    originalIntent: value.originalIntent,
    constraints: value.constraints,
    decisions: value.decisions,
    verifiedProgress,
    currentWork: value.currentWork,
    blockers: value.blockers,
    unresolvedQuestions: value.unresolvedQuestions,
    nextMove: {
      owner: value.nextMove.owner,
      action: value.nextMove.action,
    },
  };
}

type ObservationRejection =
  | {
      readonly kind: "stop-reason";
      readonly stopReason: ObservationResponse["stopReason"];
      readonly errorMessage?: string;
    }
  | { readonly kind: "empty-output" }
  | {
      readonly kind: "provider-mismatch";
      readonly expected: string;
      readonly received: string;
    }
  | {
      readonly kind: "model-mismatch";
      readonly expected: string;
      readonly received: string;
    }
  | { readonly kind: "malformed-json" }
  | { readonly kind: "invalid-envelope" }
  | { readonly kind: "protocol-mismatch" }
  | { readonly kind: "version-mismatch" }
  | { readonly kind: "pass-mismatch" }
  | { readonly kind: "parent-mismatch" }
  | { readonly kind: "coverage-mismatch" }
  | { readonly kind: "empty-observations" }
  | { readonly kind: "incomplete-active-task" }
  | {
      readonly kind: "output-budget-exceeded";
      readonly estimatedTokens: number;
      readonly budgetTokens: number;
    }
  | { readonly kind: "empty-source" };

type ObservationCandidateResult =
  | { readonly kind: "accepted"; readonly record: ObservationCommit }
  | { readonly kind: "rejected"; readonly rejection: ObservationRejection };

function parseCandidate(
  host: SessionMemoryHost,
  request: ObservationRequest,
  response: ObservationResponse,
  expectedParentCommitId: string | null,
): ObservationCandidateResult {
  host.attributeUsage?.({
    usage: response.usage,
    provider: response.provider,
    model: response.model,
    operation: "observational-memory:observation",
    passId: request.passId,
  });

  if (response.stopReason !== "stop") {
    return {
      kind: "rejected",
      rejection: {
        kind: "stop-reason",
        stopReason: response.stopReason,
        ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
      },
    };
  }
  if (!response.text.trim()) {
    return { kind: "rejected", rejection: { kind: "empty-output" } };
  }
  if (response.provider !== request.actor.provider) {
    return {
      kind: "rejected",
      rejection: {
        kind: "provider-mismatch",
        expected: request.actor.provider,
        received: response.provider,
      },
    };
  }
  if (response.model !== request.actor.model) {
    return {
      kind: "rejected",
      rejection: {
        kind: "model-mismatch",
        expected: request.actor.model,
        received: response.model,
      },
    };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(response.text);
  } catch {
    return { kind: "rejected", rejection: { kind: "malformed-json" } };
  }
  if (!isRecord(candidate) || !isRecord(candidate.coverage)) {
    return { kind: "rejected", rejection: { kind: "invalid-envelope" } };
  }
  if (candidate.protocol !== "observational-memory.observation") {
    return { kind: "rejected", rejection: { kind: "protocol-mismatch" } };
  }
  if (candidate.version !== 1) {
    return { kind: "rejected", rejection: { kind: "version-mismatch" } };
  }
  if (candidate.passId !== request.passId) {
    return { kind: "rejected", rejection: { kind: "pass-mismatch" } };
  }
  if (
    request.passId === expectedParentCommitId ||
    candidate.parentCommitId !== expectedParentCommitId
  ) {
    return { kind: "rejected", rejection: { kind: "parent-mismatch" } };
  }

  const entryIds = candidate.coverage.entryIds;
  if (
    !isStringArray(entryIds) ||
    entryIds.length !== request.source.entryIds.length ||
    !entryIds.every(
      (entryId, index) => entryId === request.source.entryIds[index],
    )
  ) {
    return { kind: "rejected", rejection: { kind: "coverage-mismatch" } };
  }

  const observations = candidate.observations;
  if (!isStringArray(observations) || observations.length === 0) {
    return { kind: "rejected", rejection: { kind: "empty-observations" } };
  }
  const activeTask = parseActiveTask(candidate.activeTask);
  if (!activeTask) {
    return {
      kind: "rejected",
      rejection: { kind: "incomplete-active-task" },
    };
  }

  const outputEstimate = host.estimateTokens([
    { role: "user", content: response.text, timestamp: 0 },
  ]);
  if (outputEstimate > request.pressure.observationOutputBudget) {
    return {
      kind: "rejected",
      rejection: {
        kind: "output-budget-exceeded",
        estimatedTokens: outputEstimate,
        budgetTokens: request.pressure.observationOutputBudget,
      },
    };
  }

  const firstEntry = request.source.entries[0];
  const lastEntry = request.source.entries.at(-1);
  if (!firstEntry || !lastEntry) {
    return { kind: "rejected", rejection: { kind: "empty-source" } };
  }

  return {
    kind: "accepted",
    record: {
      protocol: "observational-memory.observation",
      version: 1,
      id: request.passId,
      replayEpoch: request.passId.split(":observation:")[0] ?? request.passId,
      parentCommitId: expectedParentCommitId,
      coverage: {
        entryIds: [...request.source.entryIds],
        startEntryId: firstEntry.id,
        endEntryId: lastEntry.id,
      },
      observations,
      derivedOrientations: derivedOrientations(request.source.entries),
      activeTask,
      lineage: { parentCommitId: expectedParentCommitId },
      producer: { provider: response.provider, model: response.model },
      usage: response.usage,
      timestamp: lastEntry.timestamp,
      fidelity: "normal",
      promptVersion: 1,
      outputEstimate,
      validation: {
        version: 1,
        checks: [
          "protocol",
          "complete-response",
          "output-budget",
          "parent-lineage",
          "contiguous-coverage",
          "complete-active-task",
          "derived-orientation-provenance",
        ],
      },
    },
  };
}

function observationLayerTokens(
  host: SessionMemoryHost,
  commits: readonly ObservationCommit[],
): number {
  if (commits.length === 0) return 0;
  return host.estimateTokens([
    {
      role: "user",
      content: JSON.stringify(
        commits.flatMap((commit) => commit.observations),
      ),
      timestamp: 0,
    },
  ]);
}

function reflectionPrefix(
  host: SessionMemoryHost,
  actor: ActorModel,
  commits: readonly ObservationCommit[],
  activeReflection: ReflectionGeneration | undefined,
  settings?: ObservationalMemorySettings,
): ObservationCommit[] | undefined {
  const policy = pressurePolicy(actor, settings);
  const foldedCount = activeReflection?.foldedObservationIds.length ?? 0;
  const activeObservations = commits.slice(foldedCount);
  if (observationLayerTokens(host, activeObservations) < policy.observationHigh) {
    return undefined;
  }

  for (let count = 1; count <= activeObservations.length; count += 1) {
    if (
      observationLayerTokens(host, activeObservations.slice(count)) <=
      policy.observationTarget
    ) {
      return activeObservations.slice(0, count);
    }
  }
  return activeObservations;
}

function safeProjectionCommits(
  host: SessionMemoryHost,
  actor: ActorModel,
  commits: readonly ObservationCommit[],
  activeReflection: ReflectionGeneration | undefined,
  settings?: ObservationalMemorySettings,
): ObservationCommit[] {
  const policy = pressurePolicy(actor, settings);
  const foldedCount = activeReflection?.foldedObservationIds.length ?? 0;
  let visibleCount = foldedCount;

  for (let index = foldedCount; index < commits.length; index += 1) {
    const candidate = commits.slice(foldedCount, index + 1);
    if (observationLayerTokens(host, candidate) >= policy.observationHigh) break;
    visibleCount = index + 1;
  }

  return commits.slice(0, visibleCount);
}

function parseReflectionCandidate(
  host: SessionMemoryHost,
  request: ReflectionRequest,
  response: ReflectionResponse,
  activeReflection: ReflectionGeneration | undefined,
): ReflectionGeneration | undefined {
  host.attributeUsage?.({
    usage: response.usage,
    provider: response.provider,
    model: response.model,
    operation: "observational-memory:reflection",
    passId: request.passId,
  });

  if (
    response.stopReason !== "stop" ||
    !response.text.trim() ||
    response.provider !== request.actor.provider ||
    response.model !== request.actor.model
  ) {
    return undefined;
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(response.text);
  } catch {
    return undefined;
  }
  if (!isRecord(candidate) || !isRecord(candidate.coverage)) return undefined;

  const observationIds = candidate.coverage.observationIds;
  const reflectedHistory = candidate.reflectedHistory;
  const expectedParentReflectionId = activeReflection?.id ?? null;
  if (
    candidate.protocol !== "observational-memory.reflection" ||
    candidate.version !== 1 ||
    candidate.passId !== request.passId ||
    request.passId === expectedParentReflectionId ||
    candidate.parentReflectionId !== expectedParentReflectionId ||
    !isStringArray(observationIds) ||
    observationIds.length !== request.coverage.observationIds.length ||
    !observationIds.every(
      (observationId, index) =>
        observationId === request.coverage.observationIds[index],
    ) ||
    !isStringArray(reflectedHistory) ||
    reflectedHistory.length === 0
  ) {
    return undefined;
  }

  const outputEstimate = host.estimateTokens([
    { role: "user", content: response.text, timestamp: 0 },
  ]);
  if (outputEstimate > request.pressure.reflectionOutputBudget) return undefined;
  const firstObservation = request.observations[0];
  const lastObservation = request.observations.at(-1);
  if (!firstObservation || !lastObservation) return undefined;

  return {
    protocol: "observational-memory.reflection",
    version: 1,
    id: request.passId,
    replayEpoch: request.passId.split(":reflection:")[0] ?? request.passId,
    parentReflectionId: expectedParentReflectionId,
    coverage: {
      observationIds: [...request.coverage.observationIds],
      startObservationId: firstObservation.id,
      endObservationId: lastObservation.id,
    },
    foldedObservationIds: [
      ...(activeReflection?.foldedObservationIds ?? []),
      ...request.coverage.observationIds,
    ],
    reflectedHistory,
    lineage: { parentReflectionId: expectedParentReflectionId },
    producer: { provider: response.provider, model: response.model },
    usage: response.usage,
    timestamp: lastObservation.timestamp,
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate,
    validation: {
      version: 1,
      checks: [
        "protocol",
        "complete-response",
        "output-budget",
        "parent-lineage",
        "contiguous-observation-coverage",
        "nonempty-history",
      ],
    },
  };
}

function isUsage(value: unknown): value is ExtensionUsageAttribution["usage"] {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  const cost = value.cost;
  return (
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    ) &&
    ["input", "output", "cacheRead", "cacheWrite", "total"].every(
      (key) => typeof cost[key] === "number" && Number.isFinite(cost[key]),
    )
  );
}

function memoryIdentityOrdinal(
  value: unknown,
  operation: "observation" | "reflection",
): number | undefined {
  if (
    !isRecord(value) ||
    !isNonemptyString(value.id) ||
    !isNonemptyString(value.replayEpoch)
  ) {
    return undefined;
  }
  const prefix = `${value.replayEpoch}:${operation}:`;
  if (!value.id.startsWith(prefix)) return undefined;
  const suffix = value.id.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix)) return undefined;
  const ordinal = Number(suffix);
  return Number.isSafeInteger(ordinal) && ordinal < Number.MAX_SAFE_INTEGER
    ? ordinal
    : undefined;
}

function hasStableMemoryIdentity(
  value: Record<string, unknown>,
  operation: "observation" | "reflection",
): value is Record<string, unknown> & { id: string; replayEpoch: string } {
  if (!isNonemptyString(value.id) || !isNonemptyString(value.replayEpoch)) {
    return false;
  }
  const prefix = `${value.replayEpoch}:${operation}:`;
  return (
    value.id.startsWith(prefix) &&
    /^[1-9]\d*$/.test(value.id.slice(prefix.length))
  );
}

function parsePersistedCommit(
  value: unknown,
  expectedParentCommitId: string | null,
  expectedSource: readonly SessionEntry[],
): ObservationCommit | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.coverage) ||
    !isRecord(value.lineage) ||
    !isRecord(value.producer) ||
    !isRecord(value.validation)
  ) {
    return undefined;
  }
  const entryIds = value.coverage.entryIds;
  const observations = value.observations;
  const validationChecks = value.validation.checks;
  const activeTask = parseActiveTask(value.activeTask);
  if (
    value.protocol !== "observational-memory.observation" ||
    value.version !== 1 ||
    !hasStableMemoryIdentity(value, "observation") ||
    value.parentCommitId !== expectedParentCommitId ||
    value.id === expectedParentCommitId ||
    value.lineage.parentCommitId !== expectedParentCommitId ||
    !isStringArray(entryIds) ||
    entryIds.length === 0 ||
    entryIds.length !== expectedSource.length ||
    !entryIds.every((entryId, index) => entryId === expectedSource[index]?.id) ||
    value.coverage.startEntryId !== expectedSource[0]?.id ||
    value.coverage.endEntryId !== expectedSource.at(-1)?.id ||
    !isStringArray(observations) ||
    observations.length === 0 ||
    !activeTask ||
    !isNonemptyString(value.producer.provider) ||
    !isNonemptyString(value.producer.model) ||
    !isUsage(value.usage) ||
    !isNonemptyString(value.timestamp) ||
    value.fidelity !== "normal" ||
    value.promptVersion !== 1 ||
    typeof value.outputEstimate !== "number" ||
    value.outputEstimate < 0 ||
    value.validation.version !== 1 ||
    !isStringArray(validationChecks)
  ) {
    return undefined;
  }

  return {
    protocol: "observational-memory.observation",
    version: 1,
    id: value.id,
    replayEpoch: value.replayEpoch,
    parentCommitId: expectedParentCommitId,
    coverage: {
      entryIds: expectedSource.map((entry) => entry.id),
      startEntryId: expectedSource[0]!.id,
      endEntryId: expectedSource.at(-1)!.id,
    },
    observations,
    derivedOrientations: derivedOrientations(expectedSource),
    activeTask,
    lineage: { parentCommitId: expectedParentCommitId },
    producer: {
      provider: value.producer.provider,
      model: value.producer.model,
    },
    usage: value.usage,
    timestamp: value.timestamp,
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate: value.outputEstimate,
    validation: {
      version: 1,
      checks: validationChecks,
    },
  };
}

function parsePersistedReflection(
  value: unknown,
  activeReflection: ReflectionGeneration | undefined,
  expectedObservations: readonly ObservationCommit[],
): ReflectionGeneration | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.coverage) ||
    !isRecord(value.lineage) ||
    !isRecord(value.producer) ||
    !isRecord(value.validation)
  ) {
    return undefined;
  }
  const observationIds = value.coverage.observationIds;
  const foldedObservationIds = value.foldedObservationIds;
  const reflectedHistory = value.reflectedHistory;
  const validationChecks = value.validation.checks;
  const expectedParentReflectionId = activeReflection?.id ?? null;
  const expectedFoldedObservationIds = [
    ...(activeReflection?.foldedObservationIds ?? []),
    ...expectedObservations.map((observation) => observation.id),
  ];
  if (
    value.protocol !== "observational-memory.reflection" ||
    value.version !== 1 ||
    !hasStableMemoryIdentity(value, "reflection") ||
    value.parentReflectionId !== expectedParentReflectionId ||
    value.id === expectedParentReflectionId ||
    value.lineage.parentReflectionId !== expectedParentReflectionId ||
    !isStringArray(observationIds) ||
    observationIds.length === 0 ||
    observationIds.length !== expectedObservations.length ||
    !observationIds.every(
      (observationId, index) =>
        observationId === expectedObservations[index]?.id,
    ) ||
    !isStringArray(foldedObservationIds) ||
    foldedObservationIds.length !== expectedFoldedObservationIds.length ||
    !foldedObservationIds.every(
      (observationId, index) =>
        observationId === expectedFoldedObservationIds[index],
    ) ||
    value.coverage.startObservationId !== expectedObservations[0]?.id ||
    value.coverage.endObservationId !== expectedObservations.at(-1)?.id ||
    !isStringArray(reflectedHistory) ||
    reflectedHistory.length === 0 ||
    !isNonemptyString(value.producer.provider) ||
    !isNonemptyString(value.producer.model) ||
    !isUsage(value.usage) ||
    !isNonemptyString(value.timestamp) ||
    value.fidelity !== "normal" ||
    value.promptVersion !== 1 ||
    typeof value.outputEstimate !== "number" ||
    value.outputEstimate < 0 ||
    value.validation.version !== 1 ||
    !isStringArray(validationChecks)
  ) {
    return undefined;
  }

  return {
    protocol: "observational-memory.reflection",
    version: 1,
    id: value.id,
    replayEpoch: value.replayEpoch,
    parentReflectionId: expectedParentReflectionId,
    coverage: {
      observationIds: expectedObservations.map((observation) => observation.id),
      startObservationId: expectedObservations[0]!.id,
      endObservationId: expectedObservations.at(-1)!.id,
    },
    foldedObservationIds: expectedFoldedObservationIds,
    reflectedHistory,
    lineage: { parentReflectionId: expectedParentReflectionId },
    producer: {
      provider: value.producer.provider,
      model: value.producer.model,
    },
    usage: value.usage,
    timestamp: value.timestamp,
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate: value.outputEstimate,
    validation: { version: 1, checks: validationChecks },
  };
}

interface ReplayedMemory {
  readonly commits: ObservationCommit[];
  readonly reflections: ReflectionGeneration[];
  readonly observationEntryCount: number;
  readonly reflectionEntryCount: number;
}

function replayMemory(snapshot: SessionSnapshot): ReplayedMemory {
  const commits: ObservationCommit[] = [];
  const reflections: ReflectionGeneration[] = [];
  let coveredCount = 0;
  let observationEntryCount = 0;
  let reflectionEntryCount = 0;
  let greatestObservationOrdinal = 0;
  let greatestReflectionOrdinal = 0;
  const compactionIndex = latestCompaction(snapshot.ancestry)?.index ?? -1;
  const postCompactionIds = new Set(
    snapshot.ancestry.slice(compactionIndex + 1).map((entry) => entry.id),
  );
  const seenSource =
    compactionIndex < 0
      ? []
      : sourceEntries(snapshot.ancestry).filter(
          (entry) => !postCompactionIds.has(entry.id),
        );

  for (
    let index = compactionIndex + 1;
    index < snapshot.ancestry.length;
    index += 1
  ) {
    const entry = snapshot.ancestry[index]!;
    const expectedPhysicalParentId = snapshot.ancestry[index - 1]?.id ?? null;
    const isPhysicallyContiguous = entry.parentId === expectedPhysicalParentId;
    if (isObservationEntry(entry)) {
      observationEntryCount += 1;
      const data = entry.data;
      greatestObservationOrdinal = Math.max(
        greatestObservationOrdinal,
        memoryIdentityOrdinal(data, "observation") ?? 0,
      );
      if (!isPhysicallyContiguous) continue;
      const coverage =
        isRecord(data) && isRecord(data.coverage)
          ? data.coverage.entryIds
          : undefined;
      if (!Array.isArray(coverage) || coverage.length === 0) continue;
      const expectedSource = seenSource.slice(
        coveredCount,
        coveredCount + coverage.length,
      );
      const candidate = parsePersistedCommit(
        data,
        commits.at(-1)?.id ?? null,
        expectedSource,
      );
      if (!candidate) continue;
      const endIndex = coveredCount + candidate.coverage.entryIds.length - 1;
      if (!completedStepBoundaries(seenSource).includes(endIndex)) continue;

      coveredCount += candidate.coverage.entryIds.length;
      commits.push(candidate);
      continue;
    }

    if (
      entry.type === "custom" &&
      entry.customType === OBSERVATION_EDIT_CUSTOM_TYPE
    ) {
      if (!isPhysicallyContiguous || !isRecord(entry.data)) continue;
      const targetId = entry.data.targetId;
      const observations = entry.data.observations;
      if (typeof targetId !== "string" || !isStringArray(observations)) continue;
      const targetIndex = commits.findIndex((commit) => commit.id === targetId);
      const target = commits[targetIndex];
      if (!target || observations.length === 0) continue;
      commits[targetIndex] = { ...target, observations };
      continue;
    }

    if (isReflectionEntry(entry)) {
      reflectionEntryCount += 1;
      const data = entry.data;
      greatestReflectionOrdinal = Math.max(
        greatestReflectionOrdinal,
        memoryIdentityOrdinal(data, "reflection") ?? 0,
      );
      if (!isPhysicallyContiguous) continue;
      const coverage =
        isRecord(data) && isRecord(data.coverage)
          ? data.coverage.observationIds
          : undefined;
      if (!Array.isArray(coverage) || coverage.length === 0) continue;
      const activeReflection = reflections.at(-1);
      const foldedCount = activeReflection?.foldedObservationIds.length ?? 0;
      const expectedObservations = commits.slice(
        foldedCount,
        foldedCount + coverage.length,
      );
      const candidate = parsePersistedReflection(
        data,
        activeReflection,
        expectedObservations,
      );
      if (candidate) reflections.push(candidate);
      continue;
    }

    if (
      entry.type === "custom" &&
      entry.customType === REFLECTION_EDIT_CUSTOM_TYPE
    ) {
      if (!isPhysicallyContiguous || !isRecord(entry.data)) continue;
      const targetId = entry.data.targetId;
      const reflectedHistory = entry.data.reflectedHistory;
      const target = reflections.at(-1);
      if (
        !target ||
        target.id !== targetId ||
        !isStringArray(reflectedHistory) ||
        reflectedHistory.length === 0
      ) {
        continue;
      }
      reflections[reflections.length - 1] = { ...target, reflectedHistory };
      continue;
    }

    if (isMemoryEntry(entry)) continue;

    seenSource.push(entry);
  }

  return {
    commits,
    reflections,
    observationEntryCount: Math.max(
      observationEntryCount,
      greatestObservationOrdinal,
    ),
    reflectionEntryCount: Math.max(
      reflectionEntryCount,
      greatestReflectionOrdinal,
    ),
  };
}

function sameMessage(
  left: ContextEvent["messages"][number],
  right: ContextEvent["messages"][number],
): boolean {
  if (left.role === "custom" && right.role === "custom") {
    // Pi timestamps a custom message when it is queued, then timestamps its
    // CustomMessageEntry again when the queued message is persisted. Content
    // identity is stable across those two representations; the timestamp is not.
    const { timestamp: _leftTimestamp, ...leftStable } = left;
    const { timestamp: _rightTimestamp, ...rightStable } = right;
    return JSON.stringify(leftStable) === JSON.stringify(rightStable);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function findUniqueSequence(
  messages: ContextEvent["messages"],
  sequence: ContextEvent["messages"],
): number | undefined {
  if (sequence.length === 0 || sequence.length > messages.length) return undefined;
  let match: number | undefined;
  for (let start = 0; start <= messages.length - sequence.length; start += 1) {
    if (
      !sequence.every((message, index) =>
        sameMessage(message, messages[start + index]!),
      )
    ) {
      continue;
    }
    if (match !== undefined) return undefined;
    match = start;
  }
  return match;
}

function renderMemory(
  commits: readonly ObservationCommit[],
  activeReflection?: ReflectionGeneration,
): ContextEvent["messages"][number] {
  const newest = commits.at(-1);
  if (!newest) throw new Error("Cannot render empty observational memory");
  const foldedCount = activeReflection?.foldedObservationIds.length ?? 0;
  const orientations = commits.flatMap(
    (commit) => commit.derivedOrientations,
  );
  return {
    role: "user",
    content: `<observational-memory version="1">\n${JSON.stringify({
      ...(activeReflection
        ? { reflectedHistory: activeReflection.reflectedHistory }
        : {}),
      observations: commits
        .slice(foldedCount)
        .flatMap((commit) => commit.observations),
      ...(orientations.length > 0
        ? { derivedOrientations: orientations }
        : {}),
      activeTask: newest.activeTask,
    })}\n</observational-memory>`,
    timestamp: 0,
  };
}

export function createSessionMemory(
  host: SessionMemoryHost,
  initialSettings?: ObservationalMemorySettings,
): SessionMemory {
  type ObservationFailure =
    | { readonly kind: "exception"; readonly detail: string }
    | {
        readonly kind: "invalid-response";
        readonly rejection: ObservationRejection;
      };
  type PassOutcome =
    | { readonly kind: "ready" }
    | { readonly kind: "failed"; readonly failure: ObservationFailure }
    | { readonly kind: "cancelled" };
  interface FrozenObservation {
    readonly request: ObservationRequest;
    readonly snapshot: SessionSnapshot;
    readonly sessionId: string;
    readonly launchLeafId: string | null;
    readonly expectedParentCommitId: string | null;
    readonly launchRevision: number;
  }

  let disposed = false;
  let running = false;
  let runningController: AbortController | undefined;
  let runningPromise: Promise<PassOutcome> | undefined;
  let runningObservation: FrozenObservation | undefined;
  let runningCompletion: Promise<void> | undefined;

  function emitDebugEvent(
    snapshot: SessionSnapshot,
    event: Omit<MemoryDebugEvent, "protocol" | "version" | "sessionId" | "timestamp" | "metrics">,
  ): void {
    if (!settings?.debugLogging || !host.debugEvent) return;
    const current = inspection(snapshot);
    const policy = snapshot.actor ? pressurePolicy(snapshot.actor, settings) : undefined;
    host.debugEvent({
      protocol: "observational-memory.event",
      version: 1,
      ...(event.detail === undefined
        ? event
        : { ...event, detail: boundedDetail(event.detail) }),
      sessionId: snapshot.sessionId,
      timestamp: new Date().toISOString(),
      metrics: {
        messages: {
          tokens: current.metrics.messages.tokens,
          threshold: current.metrics.messages.limit,
          target: settings.messageTokensTarget,
        },
        observations: {
          tokens: current.metrics.observations.tokens,
          threshold: current.metrics.observations.limit,
          target: settings.observationTokensTarget,
          count: current.metrics.observations.count,
        },
        reflection: {
          tokens: current.metrics.reflection.tokens,
          limit: current.metrics.reflection.limit,
        },
        ...(snapshot.inputTokens === undefined
          ? {}
          : { actorInputTokens: snapshot.inputTokens }),
        ...(snapshot.fixedInputTokens === undefined
          ? {}
          : { fixedInputTokens: snapshot.fixedInputTokens }),
        ...(policy ? { hardLimit: policy.hard } : {}),
      },
    });
  }

  function beginRunning(): () => void {
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    runningCompletion = completion;
    return () => {
      resolveCompletion();
      if (runningCompletion === completion) runningCompletion = undefined;
    };
  }

  async function waitForRunning(
    signal: AbortSignal | undefined,
  ): Promise<"settled" | "cancelled"> {
    const completion = runningCompletion;
    if (!completion) return "settled";
    if (signal?.aborted) return "cancelled";
    let removeAbortListener = (): void => {};
    const cancelled = new Promise<"cancelled">((resolve) => {
      const abortWait = () => resolve("cancelled");
      signal?.addEventListener("abort", abortWait, { once: true });
      removeAbortListener = () =>
        signal?.removeEventListener("abort", abortWait);
    });
    const outcome = await Promise.race([
      completion.then(() => "settled" as const),
      cancelled,
    ]);
    removeAbortListener();
    return outcome;
  }
  let passNumber = 0;
  let reflectionPassNumber = 0;
  let ready: ReadyObservation | undefined;
  let activeCommits: ObservationCommit[] = [];
  let activeReflections: ReflectionGeneration[] = [];
  let usageRecords: ExtensionUsageAttribution[] = [];
  const accountingHost: SessionMemoryHost = {
    ...host,
    attributeUsage(attribution) {
      usageRecords.push(attribution);
      host.attributeUsage?.(attribution);
    },
  };
  let lifecycleRevision = 0;
  let status: string | undefined;
  let terminal = false;
  let settings = initialSettings;
  let enabled = settings?.enabled ?? true;

  function setStatus(next: string | undefined): void {
    if (status === next) return;
    status = next;
    host.setStatus?.(next);
  }

  function setWaitingStatus(): void {
    setStatus(
      runningObservation
        ? "observing — waiting for memory"
        : running
          ? "reflecting — waiting for memory"
          : "waiting for memory",
    );
  }

  function clearWaitingStatus(): void {
    if (!status?.includes("waiting for memory")) return;
    setStatus(
      runningObservation ? "observing" : running ? "reflecting" : undefined,
    );
  }

  function describeRejection(rejection: ObservationRejection): string {
    switch (rejection.kind) {
      case "stop-reason":
        return `stop reason: ${rejection.stopReason}${
          rejection.errorMessage
            ? ` (${boundedDetail(rejection.errorMessage)})`
            : ""
        }`;
      case "empty-output":
        return "empty output";
      case "provider-mismatch":
        return `provider mismatch: expected ${rejection.expected}, received ${rejection.received}`;
      case "model-mismatch":
        return `model mismatch: expected ${rejection.expected}, received ${rejection.received}`;
      case "malformed-json":
        return "malformed JSON";
      case "invalid-envelope":
        return "invalid response envelope";
      case "protocol-mismatch":
        return "protocol mismatch";
      case "version-mismatch":
        return "version mismatch";
      case "pass-mismatch":
        return "pass mismatch";
      case "parent-mismatch":
        return "parent lineage mismatch";
      case "coverage-mismatch":
        return "coverage mismatch";
      case "empty-observations":
        return "empty observations";
      case "incomplete-active-task":
        return "incomplete active task";
      case "output-budget-exceeded":
        return `output budget exceeded: estimated ${rejection.estimatedTokens}, budget ${rejection.budgetTokens}`;
      case "empty-source":
        return "empty frozen source";
    }
  }

  function cancellationReason(
    signal: AbortSignal | undefined,
  ): Extract<
    MemoryDebugReason,
    | "signal-aborted"
    | "idle-escape"
    | "disabled"
    | "navigation"
    | "session-replacement"
    | "shutdown"
  > {
    const reason = signal?.reason;
    switch (reason) {
      case "idle-escape":
      case "disabled":
      case "navigation":
      case "session-replacement":
      case "shutdown":
        return reason;
      default:
        return "signal-aborted";
    }
  }

  function boundedDetail(value: string): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
  }

  function describeException(error: unknown): string {
    return boundedDetail(
      error instanceof Error
        ? `${error.name || "Error"}${error.message ? `: ${error.message}` : ""}`
        : `non-Error rejection: ${String(error)}`,
    );
  }

  function describeFailure(failure: ObservationFailure): string {
    return failure.kind === "exception"
      ? `exception (${failure.detail})`
      : `invalid response (${describeRejection(failure.rejection)})`;
  }

  function stopActor(
    snapshot: SessionSnapshot,
    kind: "cancelled" | "exhausted",
    failures: readonly ObservationFailure[] = [],
  ): void {
    if (terminal) return;
    terminal = true;
    const cancelled = kind === "cancelled";
    setStatus(
      cancelled
        ? "memory cancelled — source preserved"
        : "memory stopped — source preserved",
    );
    const failureDetails =
      !cancelled && failures.length > 0
        ? ` Attempts failed: ${failures
            .map((failure, index) => `${index + 1}) ${describeFailure(failure)}`)
            .join("; ")}.`
        : "";
    emitDebugEvent(snapshot, {
      event: "hard-headroom-terminal",
      operation: "hard-headroom",
      reason: kind,
      ...(failureDetails ? { detail: failureDetails } : {}),
    });
    host.abortActor?.(
      cancelled
        ? "Observational memory was cancelled; exact source was preserved."
        : `Observational memory could not restore safe headroom; exact source was preserved.${failureDetails}`,
    );
  }

  function coveredEntryIds(): string[] {
    return activeCommits.flatMap((commit) => commit.coverage.entryIds);
  }

  function freezeObservation(
    snapshot: SessionSnapshot,
    force: boolean,
  ): FrozenObservation | undefined {
    if (!snapshot.actor) return undefined;
    const prefix = frozenPrefix(
      host,
      snapshot,
      coveredEntryIds(),
      force,
      settings,
    );
    if (!prefix) return undefined;

    passNumber += 1;
    const newestCommit = activeCommits.at(-1);
    const activeReflection = activeReflections.at(-1);
    const foldedCount = activeReflection?.foldedObservationIds.length ?? 0;
    const expectedParentCommitId = newestCommit?.id ?? null;
    return {
      snapshot,
      sessionId: snapshot.sessionId,
      launchLeafId: snapshot.ancestry.at(-1)?.id ?? null,
      expectedParentCommitId,
      launchRevision: lifecycleRevision,
      request: {
        passId: `${replayEpoch(snapshot)}:observation:${passNumber}`,
        parentCommitId: expectedParentCommitId,
        actor: snapshot.actor,
        pressure: pressurePolicy(snapshot.actor, settings),
        ...(newestCommit
          ? {
              activeMemory: {
                ...(activeReflection
                  ? { reflectedHistory: activeReflection.reflectedHistory }
                  : {}),
                observations: activeCommits
                  .slice(foldedCount)
                  .flatMap((commit) => commit.observations),
                derivedOrientations: activeCommits.flatMap(
                  (commit) => commit.derivedOrientations,
                ),
                activeTask: newestCommit.activeTask,
              },
            }
          : {}),
        source: {
          entryIds: prefix.map((entry) => entry.id),
          entries: prefix,
        },
      },
    };
  }

  function executeObservation(
    frozen: FrozenObservation,
    signal: AbortSignal | undefined,
    hardPaused: boolean,
    trigger: "ambient-threshold" | "manual-compaction" | "hard-headroom" =
      hardPaused ? "hard-headroom" : "ambient-threshold",
  ): Promise<PassOutcome> {
    emitDebugEvent(
      frozen.snapshot,
      {
        event: "observation-started",
        operation: "observation",
        reason: trigger,
        passId: frozen.request.passId,
        coverage: { entryCount: frozen.request.source.entryIds.length },
      },
    );
    running = true;
    runningObservation = frozen;
    const finishRunning = beginRunning();
    const previousStatus = status;
    setStatus(
      previousStatus === "waiting for memory"
        ? "observing — waiting for memory"
        : "observing",
    );
    const controller = new AbortController();
    runningController = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);

    const promise = (async (): Promise<PassOutcome> => {
      try {
        const response = await host.completeObservation(
          frozen.request,
          controller.signal,
        );
        if (
          disposed ||
          controller.signal.aborted ||
          lifecycleRevision !== frozen.launchRevision
        ) {
          emitDebugEvent(frozen.snapshot, {
            event: "observation-cancelled",
            operation: "observation",
            reason: "lifecycle-fence",
            passId: frozen.request.passId,
          });
          return { kind: "cancelled" };
        }
        const candidate = parseCandidate(
          accountingHost,
          frozen.request,
          response,
          frozen.expectedParentCommitId,
        );
        if (
          disposed ||
          controller.signal.aborted ||
          lifecycleRevision !== frozen.launchRevision
        ) {
          emitDebugEvent(frozen.snapshot, {
            event: "observation-cancelled",
            operation: "observation",
            reason: "lifecycle-fence",
            passId: frozen.request.passId,
          });
          return { kind: "cancelled" };
        }
        if (candidate.kind === "rejected") {
          emitDebugEvent(frozen.snapshot, {
            event: "observation-rejected",
            operation: "observation",
            reason: candidate.rejection.kind,
            passId: frozen.request.passId,
            detail: describeRejection(candidate.rejection),
          });
          return {
            kind: "failed",
            failure: {
              kind: "invalid-response",
              rejection: candidate.rejection,
            },
          };
        }
        ready = {
          sessionId: frozen.sessionId,
          launchLeafId: frozen.launchLeafId,
          expectedParentCommitId: frozen.expectedParentCommitId,
          record: candidate.record,
        };
        emitDebugEvent(frozen.snapshot, {
          event: "observation-ready",
          operation: "observation",
          reason: "validated",
          passId: frozen.request.passId,
          coverage: { entryCount: frozen.request.source.entryIds.length },
        });
        return { kind: "ready" };
      } catch (error) {
        if (controller.signal.aborted) {
          emitDebugEvent(frozen.snapshot, {
            event: "observation-cancelled",
            operation: "observation",
            reason: cancellationReason(controller.signal),
            passId: frozen.request.passId,
          });
          return { kind: "cancelled" };
        }
        const detail = describeException(error);
        emitDebugEvent(frozen.snapshot, {
          event: "observation-failed",
          operation: "observation",
          reason: "exception",
          passId: frozen.request.passId,
          detail,
        });
        return {
          kind: "failed",
          failure: { kind: "exception", detail },
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        finishRunning();
        if (runningController === controller) {
          runningController = undefined;
          running = false;
          runningPromise = undefined;
          runningObservation = undefined;
          if (status === "observing" || status === "observing — waiting for memory") {
            setStatus(previousStatus);
          }
        }
      }
    })();
    runningPromise = promise;
    return promise;
  }

  function coveredBaselineMessages(
    snapshot: SessionSnapshot,
    commits: readonly ObservationCommit[],
  ): ContextEvent["messages"] | undefined {
    const baselineEntries = sourceEntries(snapshot.ancestry);
    const coveredIds = commits.flatMap((commit) => commit.coverage.entryIds);
    if (
      !coveredIds.every(
        (entryId, index) => baselineEntries[index]?.id === entryId,
      )
    ) {
      return undefined;
    }
    return baselineEntries.slice(0, coveredIds.length).flatMap(entryMessages);
  }

  function canCompose(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
    commits: readonly ObservationCommit[],
  ): boolean {
    if (commits.length === 0) return true;
    const coveredMessages = coveredBaselineMessages(snapshot, commits);
    return (
      coveredMessages !== undefined &&
      findUniqueSequence(messages, coveredMessages) !== undefined
    );
  }

  function activateReady(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
  ): "none" | "activated" | "ambiguous" {
    if (!ready) return "none";
    const coveredCount = activeCommits.reduce(
      (count, commit) => count + commit.coverage.entryIds.length,
      0,
    );
    const candidate = ready;
    const fenceIsValid =
      candidate.sessionId === snapshot.sessionId &&
      (candidate.launchLeafId === null ||
        snapshot.ancestry.some(
          (entry) => entry.id === candidate.launchLeafId,
        )) &&
      candidate.expectedParentCommitId === (activeCommits.at(-1)?.id ?? null) &&
      candidate.record.coverage.entryIds.every(
        (entryId, index) =>
          sourceEntries(snapshot.ancestry)[coveredCount + index]?.id ===
          entryId,
      );
    if (!fenceIsValid) {
      ready = undefined;
      return "none";
    }

    const candidateCommits = [...activeCommits, candidate.record];
    if (!canCompose(snapshot, messages, candidateCommits)) return "ambiguous";

    host.appendEntry(OBSERVATION_CUSTOM_TYPE, candidate.record);
    activeCommits.push(candidate.record);
    ready = undefined;
    emitDebugEvent(snapshot, {
      event: "observation-activated",
      operation: "observation",
      reason: "safe-composition",
      passId: candidate.record.id,
      coverage: { entryCount: candidate.record.coverage.entryIds.length },
    });
    return "activated";
  }

  function projection(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
  ): {
    readonly messages: ContextEvent["messages"];
    readonly ambiguous: boolean;
  } {
    const activeReflection = activeReflections.at(-1);
    const projectedCommits =
      snapshot.actor &&
      reflectionPrefix(
        host,
        snapshot.actor,
        activeCommits,
        activeReflection,
        settings,
      )
        ? safeProjectionCommits(
            host,
            snapshot.actor,
            activeCommits,
            activeReflection,
            settings,
          )
        : activeCommits;
    if (projectedCommits.length === 0) {
      return { messages, ambiguous: false };
    }
    const coveredMessages = coveredBaselineMessages(snapshot, projectedCommits);
    if (!coveredMessages) return { messages, ambiguous: true };
    const match = findUniqueSequence(messages, coveredMessages);
    if (match === undefined) return { messages, ambiguous: true };

    return {
      messages: [
        ...messages.slice(0, match),
        renderMemory(projectedCommits, activeReflection),
        ...messages.slice(match + coveredMessages.length),
      ],
      ambiguous: false,
    };
  }

  function projectedInputTokens(
    snapshot: SessionSnapshot,
    incomingMessages: ContextEvent["messages"],
    projectedMessages: ContextEvent["messages"],
  ): number {
    const incomingMessageTokens = host.estimateTokens(incomingMessages);
    const nonMessageTokens = Math.max(
      snapshot.fixedInputTokens ?? 0,
      Math.max(0, (snapshot.inputTokens ?? 0) - incomingMessageTokens),
    );
    return nonMessageTokens + host.estimateTokens(projectedMessages);
  }

  function isIncomingHardUnsafe(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
  ): boolean {
    if (!snapshot.actor) return false;
    const policy = pressurePolicy(snapshot.actor, settings);
    return projectedInputTokens(snapshot, messages, messages) >= policy.hard;
  }

  function inspection(snapshot: SessionSnapshot): MemoryInspection {
    const policy = snapshot.actor
      ? pressurePolicy(snapshot.actor, settings)
      : {
          rawTarget: settings?.messageTokensTarget ?? 20_000,
          soft: settings?.messageTokensStartObservation ?? 40_000,
          observationTarget: settings?.observationTokensTarget ?? 20_000,
          observationHigh:
            settings?.observationTokensStartReflection ?? 40_000,
          reflectionOutputBudget: settings?.reflectionTokensMax ?? 5_000,
        };
    const messageTokens =
      uncoveredMessageTokens(host, snapshot, coveredEntryIds()) ??
      host.estimateTokens(
        sourceEntries(snapshot.ancestry).flatMap(entryMessages),
      );
    const activeReflection = activeReflections.at(-1);
    const folded = new Set(activeReflection?.foldedObservationIds ?? []);
    const observationTokens = host.estimateTokens([
      {
        role: "user",
        content: JSON.stringify(
          activeCommits
            .filter((commit) => !folded.has(commit.id))
            .map((commit) => commit.observations),
        ),
        timestamp: 0,
      },
    ]);
    const reflectionTokens = activeReflection
      ? host.estimateTokens([
          {
            role: "user",
            content: JSON.stringify(activeReflection.reflectedHistory),
            timestamp: 0,
          },
        ])
      : 0;
    const accountedUsage =
      usageRecords.length > 0
        ? usageRecords.map((record) => record.usage)
        : [...activeCommits, ...activeReflections].map((record) => record.usage);
    const usage = accountedUsage.reduce(
      (totals, record) => ({
        input: totals.input + record.input,
        output: totals.output + record.output,
        cacheRead: totals.cacheRead + record.cacheRead,
        cacheWrite: totals.cacheWrite + record.cacheWrite,
        cost: totals.cost + record.cost.total,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    );
    const layer = (tokens: number, limit: number): MemoryLayerMetric => ({
      tokens,
      limit,
      percent: limit > 0 ? (tokens / limit) * 100 : 0,
    });
    return {
      observations: activeCommits.map((commit) => ({
        id: commit.id,
        timestamp: commit.timestamp,
        observations: commit.observations,
        folded: folded.has(commit.id),
      })),
      ...(activeReflection
        ? {
            reflection: {
              id: activeReflection.id,
              reflectedHistory: activeReflection.reflectedHistory,
            },
          }
        : {}),
      metrics: {
        messages: layer(messageTokens, policy.soft),
        observations: {
          ...layer(observationTokens, policy.observationHigh),
          count: activeCommits.length,
        },
        reflection: layer(
          reflectionTokens,
          policy.reflectionOutputBudget,
        ),
      },
      usage,
    };
  }

  function isHardUnsafe(
    snapshot: SessionSnapshot,
    incomingMessages: ContextEvent["messages"],
    projectedMessages: ContextEvent["messages"],
  ): boolean {
    if (!snapshot.actor) return false;
    const policy = pressurePolicy(snapshot.actor, settings);
    return (
      projectedInputTokens(snapshot, incomingMessages, projectedMessages) >=
      policy.hard
    );
  }

  async function reflect(
    snapshot: SessionSnapshot,
    signal: AbortSignal | undefined,
    hardPaused: boolean,
  ): Promise<"accepted" | "failed" | "cancelled"> {
    const activeReflection = activeReflections.at(-1);
    const prefix = snapshot.actor
      ? reflectionPrefix(
          host,
          snapshot.actor,
          activeCommits,
          activeReflection,
          settings,
        )
      : undefined;
    if (
      !prefix ||
      !snapshot.actor ||
      !host.completeReflection ||
      running ||
      signal?.aborted
    ) {
      return signal?.aborted ? "cancelled" : "failed";
    }

    reflectionPassNumber += 1;
    const launchRevision = lifecycleRevision;
    const foldedCount = activeReflection?.foldedObservationIds.length ?? 0;
    const request: ReflectionRequest = {
      passId: `${replayEpoch(snapshot)}:reflection:${reflectionPassNumber}`,
      actor: snapshot.actor,
      pressure: pressurePolicy(snapshot.actor, settings),
      parentReflection: activeReflection
        ? {
            id: activeReflection.id,
            reflectedHistory: activeReflection.reflectedHistory,
            foldedObservationIds: activeReflection.foldedObservationIds,
          }
        : null,
      coverage: { observationIds: prefix.map((commit) => commit.id) },
      observations: prefix.map((commit) => ({
        id: commit.id,
        timestamp: commit.timestamp,
        observations: commit.observations,
        derivedOrientations: commit.derivedOrientations,
      })),
    };
    const attempts = hardPaused ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      emitDebugEvent(snapshot, {
        event: "reflection-started",
        operation: "reflection",
        reason: hardPaused ? "hard-headroom" : "observation-threshold",
        passId: request.passId,
        attempt: attempt + 1,
        coverage: { observationCount: prefix.length },
      });
      running = true;
      const finishRunning = beginRunning();
      const previousStatus = status;
      setStatus(
        previousStatus === "waiting for memory"
          ? "reflecting — waiting for memory"
          : "reflecting",
      );
      const controller = new AbortController();
      runningController = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort(signal.reason);
      try {
        const response = await host.completeReflection(
          request,
          controller.signal,
        );
        if (
          disposed ||
          controller.signal.aborted ||
          lifecycleRevision !== launchRevision
        ) {
          emitDebugEvent(snapshot, {
            event: "reflection-cancelled",
            operation: "reflection",
            reason: "lifecycle-fence",
            passId: request.passId,
            attempt: attempt + 1,
          });
          return "cancelled";
        }
        const record = parseReflectionCandidate(
          accountingHost,
          request,
          response,
          activeReflection,
        );
        const fenceIsValid =
          record !== undefined &&
          replayEpoch(snapshot) === record.replayEpoch &&
          (activeReflections.at(-1)?.id ?? null) ===
            (activeReflection?.id ?? null) &&
          prefix.every(
            (commit, index) =>
              activeCommits[foldedCount + index]?.id === commit.id,
          );
        if (fenceIsValid) {
          host.appendEntry(REFLECTION_CUSTOM_TYPE, record);
          activeReflections.push(record);
          emitDebugEvent(snapshot, {
            event: "reflection-committed",
            operation: "reflection",
            reason: "validated",
            passId: request.passId,
            attempt: attempt + 1,
            coverage: { observationCount: prefix.length },
          });
          return "accepted";
        }
        if (controller.signal.aborted || lifecycleRevision !== launchRevision) {
          emitDebugEvent(snapshot, {
            event: "reflection-cancelled",
            operation: "reflection",
            reason: "lifecycle-fence",
            passId: request.passId,
            attempt: attempt + 1,
          });
          return "cancelled";
        }
        emitDebugEvent(snapshot, {
          event: "reflection-rejected",
          operation: "reflection",
          reason: "invalid-response",
          passId: request.passId,
          attempt: attempt + 1,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          emitDebugEvent(snapshot, {
            event: "reflection-cancelled",
            operation: "reflection",
            reason: cancellationReason(controller.signal),
            passId: request.passId,
            attempt: attempt + 1,
          });
          return "cancelled";
        }
        emitDebugEvent(snapshot, {
          event: "reflection-failed",
          operation: "reflection",
          reason: "exception",
          passId: request.passId,
          attempt: attempt + 1,
          detail: describeException(error),
        });
      } finally {
        signal?.removeEventListener("abort", abort);
        finishRunning();
        if (runningController === controller) {
          runningController = undefined;
          running = false;
          if (
            status === "reflecting" ||
            status === "reflecting — waiting for memory"
          ) {
            setStatus(previousStatus);
          }
        }
      }
      if (attempt + 1 < attempts) {
        emitDebugEvent(snapshot, {
          event: "reflection-retry",
          operation: "reflection",
          reason: "first-attempt-failed",
          passId: request.passId,
          attempt: attempt + 2,
        });
      }
    }
    return "failed";
  }

  return {
    restore(snapshot) {
      if (disposed) return;
      lifecycleRevision += 1;
      ready = undefined;
      terminal = false;
      runningController?.abort("session ancestry restored");
      runningController = undefined;
      runningPromise = undefined;
      runningObservation = undefined;
      runningCompletion = undefined;
      running = false;
      setStatus(undefined);
      const replayed = replayMemory(snapshot);
      activeCommits = replayed.commits;
      activeReflections = replayed.reflections;
      usageRecords = snapshot.ancestry.flatMap((entry) => {
        if (
          entry.type === "custom" &&
          entry.customType === USAGE_CUSTOM_TYPE &&
          isRecord(entry.data) &&
          isRecord(entry.data.usage) &&
          typeof entry.data.provider === "string" &&
          typeof entry.data.model === "string" &&
          typeof entry.data.operation === "string"
        ) {
          return [entry.data as unknown as ExtensionUsageAttribution];
        }
        const extensionUsage = entry as unknown as {
          readonly type: string;
          readonly usage?: unknown;
          readonly provider?: unknown;
          readonly model?: unknown;
          readonly operation?: unknown;
          readonly passId?: unknown;
        };
        if (
          extensionUsage.type === "extension_usage" &&
          isRecord(extensionUsage.usage) &&
          typeof extensionUsage.provider === "string" &&
          typeof extensionUsage.model === "string" &&
          typeof extensionUsage.operation === "string"
        ) {
          return [extensionUsage as unknown as ExtensionUsageAttribution];
        }
        return [];
      });
      passNumber = replayed.observationEntryCount;
      reflectionPassNumber = replayed.reflectionEntryCount;
    },

    configure(next) {
      settings = next;
      enabled = next.enabled;
      if (!enabled) {
        ready = undefined;
        runningController?.abort("disabled");
        setStatus(undefined);
      }
    },

    setEnabled(next) {
      enabled = next;
      if (!enabled) {
        ready = undefined;
        runningController?.abort("disabled");
        setStatus(undefined);
      }
    },

    observe(snapshot, signal) {
      if (
        !enabled ||
        disposed ||
        terminal ||
        running ||
        ready ||
        signal?.aborted
      ) {
        return;
      }
      if (
        snapshot.actor &&
        reflectionPrefix(
          host,
          snapshot.actor,
          activeCommits,
          activeReflections.at(-1),
          settings,
        )
      ) {
        return;
      }
      const frozen = freezeObservation(snapshot, false);
      if (!frozen) return;
      void executeObservation(frozen, signal, false);
    },

    async maintain(getSnapshot, signal) {
      let observationsCreated = 0;
      let reflectionsCreated = 0;
      const initialSnapshot = getSnapshot();
      emitDebugEvent(initialSnapshot, {
        event: "maintenance-requested",
        operation: "maintenance",
        reason: "lifecycle-kick",
      });
      emitDebugEvent(initialSnapshot, {
        event: "maintenance-started",
        operation: "maintenance",
        reason: "lifecycle-kick",
      });
      while (!disposed && enabled && !terminal && !signal?.aborted) {
        const snapshot = getSnapshot();
        if (ready) {
          const messages = sourceEntries(snapshot.ancestry).flatMap(entryMessages);
          const activation = activateReady(snapshot, messages);
          if (activation === "ambiguous") break;
          if (activation === "activated") {
            observationsCreated += 1;
            continue;
          }
        }
        if (running) {
          if ((await waitForRunning(signal)) === "cancelled") break;
          continue;
        }

        if (
          snapshot.actor &&
          reflectionPrefix(
            host,
            snapshot.actor,
            activeCommits,
            activeReflections.at(-1),
            settings,
          )
        ) {
          const outcome = await reflect(snapshot, signal, false);
          if (outcome !== "accepted") break;
          reflectionsCreated += 1;
          continue;
        }

        const frozen = freezeObservation(snapshot, false);
        if (!frozen) break;
        const outcome = await executeObservation(frozen, signal, false);
        if (outcome.kind !== "ready") break;
      }
      const finalSnapshot = getSnapshot();
      emitDebugEvent(finalSnapshot, {
        event: signal?.aborted ? "maintenance-cancelled" : "maintenance-completed",
        operation: "maintenance",
        reason: signal?.aborted ? cancellationReason(signal) : "settled",
        detail: `${observationsCreated} observations, ${reflectionsCreated} reflections`,
      });
      return {
        observationsCreated,
        reflectionsCreated,
        inspection: inspection(finalSnapshot),
      };
    },

    async compact(snapshot, signal) {
      if (!enabled) throw new Error("Observational memory is disabled");
      if (!snapshot.actor) throw new Error("No actor model is selected");
      if (disposed) throw new Error("Session memory is disposed");
      let observationsCreated = 0;
      let reflectionsCreated = 0;
      setStatus("compacting memory");
      try {
        while (!signal?.aborted) {
          if (
            inspection(snapshot).metrics.messages.tokens <=
            pressurePolicy(snapshot.actor, settings).rawTarget
          ) {
            break;
          }
          const frozen = freezeObservation(snapshot, true);
          if (!frozen) break;
          let outcome = await executeObservation(
            frozen,
            signal,
            true,
            "manual-compaction",
          );
          if (outcome.kind === "failed") {
            emitDebugEvent(snapshot, {
              event: "observation-retry",
              operation: "observation",
              reason: "first-attempt-failed",
              passId: frozen.request.passId,
              attempt: 2,
            });
            outcome = await executeObservation(
              frozen,
              signal,
              true,
              "manual-compaction",
            );
          }
          if (outcome.kind !== "ready") {
            throw new Error(
              outcome.kind === "cancelled"
                ? "Observational compaction was cancelled"
                : `Observational compaction failed: ${describeFailure(outcome.failure)}`,
            );
          }
          const candidate = ready;
          if (!candidate) throw new Error("Observer produced no ready memory");
          host.appendEntry(OBSERVATION_CUSTOM_TYPE, candidate.record);
          activeCommits.push(candidate.record);
          ready = undefined;
          emitDebugEvent(snapshot, {
            event: "observation-activated",
            operation: "observation",
            reason: "manual-compaction",
            passId: candidate.record.id,
            coverage: { entryCount: candidate.record.coverage.entryIds.length },
          });
          observationsCreated += 1;
        }
        while (
          reflectionPrefix(
            host,
            snapshot.actor,
            activeCommits,
            activeReflections.at(-1),
            settings,
          )
        ) {
          const outcome = await reflect(snapshot, signal, true);
          if (outcome !== "accepted") {
            throw new Error(
              outcome === "cancelled"
                ? "Observational compaction was cancelled"
                : "Observational reflection failed",
            );
          }
          reflectionsCreated += 1;
        }
        return {
          observationsCreated,
          reflectionsCreated,
          inspection: inspection(snapshot),
        };
      } finally {
        if (!terminal) setStatus(undefined);
      }
    },

    inspect(snapshot) {
      return inspection(snapshot);
    },

    editObservation(id, observations) {
      const commit = activeCommits.find((candidate) => candidate.id === id);
      const replacement = observations.map((value) => value.trim()).filter(Boolean);
      if (!commit) throw new Error(`Unknown observation ${id}`);
      if (replacement.length === 0) throw new Error("An observation cannot be empty");
      host.appendEntry(OBSERVATION_EDIT_CUSTOM_TYPE, {
        protocol: "observational-memory.observation-edit",
        version: 1,
        targetId: id,
        observations: replacement,
        timestamp: new Date().toISOString(),
      });
      activeCommits = activeCommits.map((candidate) =>
        candidate.id === id ? { ...candidate, observations: replacement } : candidate,
      );
    },

    editReflection(reflectedHistory) {
      const active = activeReflections.at(-1);
      const replacement = reflectedHistory
        .map((value) => value.trim())
        .filter(Boolean);
      if (!active) throw new Error("There is no active reflection");
      if (replacement.length === 0) throw new Error("A reflection cannot be empty");
      host.appendEntry(REFLECTION_EDIT_CUSTOM_TYPE, {
        protocol: "observational-memory.reflection-edit",
        version: 1,
        targetId: active.id,
        reflectedHistory: replacement,
        timestamp: new Date().toISOString(),
      });
      activeReflections = activeReflections.map((candidate) =>
        candidate.id === active.id
          ? { ...candidate, reflectedHistory: replacement }
          : candidate,
      );
    },

    async project(snapshot, messages, signal) {
      if (disposed) return messages;
      if (!enabled) return projection(snapshot, messages).messages;
      if (terminal) {
        host.abortActor?.();
        return messages;
      }
      const projectRevision = lifecycleRevision;

      while (!disposed && lifecycleRevision === projectRevision) {
        let activation: "none" | "activated" | "ambiguous" = "none";
        if (signal?.aborted) ready = undefined;
        else activation = activateReady(snapshot, messages);
        if (
          activation === "ambiguous" ||
          !canCompose(snapshot, messages, activeCommits)
        ) {
          if (isIncomingHardUnsafe(snapshot, messages)) stopActor(snapshot, "exhausted");
          return messages;
        }
        const composition = projection(snapshot, messages);
        const projected = composition.messages;
        if (composition.ambiguous) {
          if (isIncomingHardUnsafe(snapshot, messages)) stopActor(snapshot, "exhausted");
          return messages;
        }
        const hardUnsafe = isHardUnsafe(snapshot, messages, projected);
        const reflectionRequired =
          snapshot.actor &&
          reflectionPrefix(
            host,
            snapshot.actor,
            activeCommits,
            activeReflections.at(-1),
            settings,
          );

        if (reflectionRequired) {
          if (hardUnsafe) {
            setWaitingStatus();
            emitDebugEvent(snapshot, {
              event: "hard-headroom-wait",
              operation: "hard-headroom",
              reason: running ? "memory-operation-running" : "reflection-required",
            });
          }
          if (running) {
            if (!hardUnsafe) return projected;
            if ((await waitForRunning(signal)) === "cancelled") {
              clearWaitingStatus();
              host.abortActor?.();
              return messages;
            }
            if (disposed || lifecycleRevision !== projectRevision) return messages;
            continue;
          }
          const outcome = await reflect(snapshot, signal, hardUnsafe);
          if (disposed || lifecycleRevision !== projectRevision) return messages;
          if (outcome === "accepted") continue;
          if (hardUnsafe) {
            stopActor(snapshot, outcome === "cancelled" ? "cancelled" : "exhausted");
          }
          return projected;
        }

        if (!hardUnsafe) {
          clearWaitingStatus();
          return projected;
        }

        setWaitingStatus();
        emitDebugEvent(snapshot, {
          event: "hard-headroom-wait",
          operation: "hard-headroom",
          reason: running ? "memory-operation-running" : "observation-required",
        });
        if (signal?.aborted) {
          stopActor(snapshot, "cancelled");
          return messages;
        }

        const inFlight = runningPromise;
        const inFlightFrozen = runningObservation;
        if (inFlight && inFlightFrozen) {
          let removeAbortListener = (): void => {};
          const actorAborted = new Promise<undefined>((resolve) => {
            const abortWait = () => resolve(undefined);
            signal?.addEventListener("abort", abortWait, { once: true });
            removeAbortListener = () =>
              signal?.removeEventListener("abort", abortWait);
          });
          const firstOutcome = await Promise.race([inFlight, actorAborted]);
          removeAbortListener();
          if (firstOutcome === undefined) {
            clearWaitingStatus();
            host.abortActor?.();
            return messages;
          }
          if (disposed || lifecycleRevision !== projectRevision) return messages;
          if (firstOutcome.kind === "ready") continue;
          if (firstOutcome.kind === "cancelled") {
            stopActor(snapshot, "cancelled");
            return messages;
          }
          emitDebugEvent(snapshot, {
            event: "observation-retry",
            operation: "observation",
            reason: "first-attempt-failed",
            passId: inFlightFrozen.request.passId,
            attempt: 2,
          });
          const retryOutcome = await executeObservation(
            inFlightFrozen,
            signal,
            true,
          );
          if (disposed || lifecycleRevision !== projectRevision) return messages;
          if (retryOutcome.kind === "ready") continue;
          if (retryOutcome.kind === "cancelled") stopActor(snapshot, "cancelled");
          else stopActor(snapshot, "exhausted", [firstOutcome.failure, retryOutcome.failure]);
          return messages;
        }

        const frozen = freezeObservation(snapshot, true);
        if (!frozen) {
          stopActor(snapshot, signal?.aborted ? "cancelled" : "exhausted");
          return messages;
        }
        const firstOutcome = await executeObservation(frozen, signal, true);
        if (disposed || lifecycleRevision !== projectRevision) return messages;
        if (firstOutcome.kind === "ready") continue;
        if (firstOutcome.kind === "cancelled") {
          stopActor(snapshot, "cancelled");
          return messages;
        }
        emitDebugEvent(snapshot, {
          event: "observation-retry",
          operation: "observation",
          reason: "first-attempt-failed",
          passId: frozen.request.passId,
          attempt: 2,
        });
        const retryOutcome = await executeObservation(frozen, signal, true);
        if (disposed || lifecycleRevision !== projectRevision) return messages;
        if (retryOutcome.kind === "ready") continue;
        if (retryOutcome.kind === "cancelled") stopActor(snapshot, "cancelled");
        else stopActor(snapshot, "exhausted", [firstOutcome.failure, retryOutcome.failure]);
        return messages;
      }
      return messages;
    },

    dispose() {
      disposed = true;
      lifecycleRevision += 1;
      ready = undefined;
      runningController?.abort("shutdown");
      runningController = undefined;
      runningPromise = undefined;
      runningObservation = undefined;
      runningCompletion = undefined;
      running = false;
      setStatus(undefined);
    },
  };
}
