import {
  type ContextEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

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

export interface SessionMemory {
  restore(snapshot: SessionSnapshot): void;
  observe(snapshot: SessionSnapshot, signal?: AbortSignal): void;
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

export interface SessionMemoryHost {
  appendEntry(customType: string, data?: unknown): void;
  attributeUsage(attribution: ExtensionUsageAttribution): void;
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

function pressurePolicy(actor: ActorModel): ObservationRequest["pressure"] {
  const usableInput = Math.max(1, actor.contextWindow - actor.maxTokens);
  return {
    usableInput,
    rawTarget: Math.floor(usableInput * RAW_TARGET_RATIO),
    soft: Math.floor(usableInput * SOFT_PRESSURE_RATIO),
    hard: Math.floor(usableInput * HARD_PRESSURE_RATIO),
    safetyReserve:
      usableInput - Math.floor(usableInput * HARD_PRESSURE_RATIO),
    observationOutputBudget: Math.min(
      actor.maxTokens,
      Math.max(1, Math.floor(usableInput * OBSERVATION_OUTPUT_RATIO)),
    ),
    observationTarget: Math.max(
      1,
      Math.floor(usableInput * OBSERVATION_TARGET_RATIO),
    ),
    observationHigh: Math.max(
      1,
      Math.floor(usableInput * OBSERVATION_HIGH_RATIO),
    ),
    reflectionOutputBudget: Math.min(
      actor.maxTokens,
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

function sourceEntries(ancestry: readonly SessionEntry[]): SessionEntry[] {
  return ancestry.filter(
    (entry) => !isObservationEntry(entry) && !isReflectionEntry(entry),
  );
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

function uncoveredRawTokens(
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
  const coveredMessages = allSourceEntries
    .slice(0, coveredEntryIds.length)
    .flatMap(entryMessages);
  const uncoveredMessages = allSourceEntries
    .slice(coveredEntryIds.length)
    .flatMap(entryMessages);
  const estimatedUncovered =
    uncoveredMessages.length === 0 ? 0 : host.estimateTokens(uncoveredMessages);
  if (snapshot.inputTokens === undefined) return estimatedUncovered;
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
): SessionEntry[] | undefined {
  if (!snapshot.actor) return undefined;
  const policy = pressurePolicy(snapshot.actor);
  const allSourceEntries = sourceEntries(snapshot.ancestry);
  const uncoveredTokens = uncoveredRawTokens(host, snapshot, coveredEntryIds);
  const inputTokens = force
    ? uncoveredTokens
    : (snapshot.inputTokens ??
      host.estimateTokens(allSourceEntries.flatMap(entryMessages)));
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

function parseCandidate(
  host: SessionMemoryHost,
  request: ObservationRequest,
  response: ObservationResponse,
  expectedParentCommitId: string | null,
): ObservationCommit | undefined {
  host.attributeUsage({
    usage: response.usage,
    provider: response.provider,
    model: response.model,
    operation: "observational-memory:observation",
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

  const entryIds = candidate.coverage.entryIds;
  const observations = candidate.observations;
  const activeTask = parseActiveTask(candidate.activeTask);
  if (
    candidate.protocol !== "observational-memory.observation" ||
    candidate.version !== 1 ||
    candidate.passId !== request.passId ||
    candidate.parentCommitId !== expectedParentCommitId ||
    !isStringArray(entryIds) ||
    entryIds.length !== request.source.entryIds.length ||
    !entryIds.every(
      (entryId, index) => entryId === request.source.entryIds[index],
    ) ||
    !isStringArray(observations) ||
    observations.length === 0 ||
    !activeTask
  ) {
    return undefined;
  }

  const outputEstimate = host.estimateTokens([
    { role: "user", content: response.text, timestamp: 0 },
  ]);
  if (outputEstimate > request.pressure.observationOutputBudget) return undefined;

  const firstEntry = request.source.entries[0];
  const lastEntry = request.source.entries.at(-1);
  if (!firstEntry || !lastEntry) return undefined;

  return {
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
): ObservationCommit[] | undefined {
  const policy = pressurePolicy(actor);
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
): ObservationCommit[] {
  const policy = pressurePolicy(actor);
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
  host.attributeUsage({
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
  const seenSource: SessionEntry[] = [];
  const commits: ObservationCommit[] = [];
  const reflections: ReflectionGeneration[] = [];
  let coveredCount = 0;
  let observationEntryCount = 0;
  let reflectionEntryCount = 0;

  for (const [index, entry] of snapshot.ancestry.entries()) {
    const expectedPhysicalParentId = snapshot.ancestry[index - 1]?.id ?? null;
    const isPhysicallyContiguous = entry.parentId === expectedPhysicalParentId;
    if (isObservationEntry(entry)) {
      observationEntryCount += 1;
      if (!isPhysicallyContiguous) continue;
      const data = entry.data;
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

    if (isReflectionEntry(entry)) {
      reflectionEntryCount += 1;
      if (!isPhysicallyContiguous) continue;
      const data = entry.data;
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

    seenSource.push(entry);
  }

  return {
    commits,
    reflections,
    observationEntryCount,
    reflectionEntryCount,
  };
}

function sameMessage(
  left: ContextEvent["messages"][number],
  right: ContextEvent["messages"][number],
): boolean {
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

export function createSessionMemory(host: SessionMemoryHost): SessionMemory {
  type PassOutcome = "ready" | "failed" | "cancelled";
  interface FrozenObservation {
    readonly request: ObservationRequest;
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
  let passNumber = 0;
  let reflectionPassNumber = 0;
  let ready: ReadyObservation | undefined;
  let activeCommits: ObservationCommit[] = [];
  let activeReflections: ReflectionGeneration[] = [];
  let lifecycleRevision = 0;
  let status: string | undefined;
  let terminal = false;

  function setStatus(next: string | undefined): void {
    if (status === next) return;
    status = next;
    host.setStatus?.(next);
  }

  function stopActor(kind: "cancelled" | "exhausted"): void {
    if (terminal) return;
    terminal = true;
    const cancelled = kind === "cancelled";
    setStatus(
      cancelled
        ? "memory cancelled — source preserved"
        : "memory stopped — source preserved",
    );
    host.abortActor?.(
      cancelled
        ? "Observational memory was cancelled; exact source was preserved."
        : "Observational memory could not restore safe headroom; exact source was preserved.",
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
    const prefix = frozenPrefix(host, snapshot, coveredEntryIds(), force);
    if (!prefix) return undefined;

    passNumber += 1;
    const newestCommit = activeCommits.at(-1);
    const activeReflection = activeReflections.at(-1);
    const foldedCount = activeReflection?.foldedObservationIds.length ?? 0;
    const expectedParentCommitId = newestCommit?.id ?? null;
    return {
      sessionId: snapshot.sessionId,
      launchLeafId: snapshot.ancestry.at(-1)?.id ?? null,
      expectedParentCommitId,
      launchRevision: lifecycleRevision,
      request: {
        passId: `${snapshot.sessionId}:observation:${passNumber}`,
        parentCommitId: expectedParentCommitId,
        actor: snapshot.actor,
        pressure: pressurePolicy(snapshot.actor),
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
  ): Promise<PassOutcome> {
    running = true;
    runningObservation = frozen;
    if (!hardPaused) setStatus("observing");
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
        const record = parseCandidate(
          host,
          frozen.request,
          response,
          frozen.expectedParentCommitId,
        );
        if (
          disposed ||
          controller.signal.aborted ||
          lifecycleRevision !== frozen.launchRevision
        ) {
          return "cancelled";
        }
        if (!record) return "failed";
        ready = {
          sessionId: frozen.sessionId,
          launchLeafId: frozen.launchLeafId,
          expectedParentCommitId: frozen.expectedParentCommitId,
          record,
        };
        return "ready";
      } catch {
        return controller.signal.aborted ? "cancelled" : "failed";
      } finally {
        signal?.removeEventListener("abort", abort);
        if (runningController === controller) {
          runningController = undefined;
          running = false;
          runningPromise = undefined;
          runningObservation = undefined;
          if (status === "observing") setStatus(undefined);
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
      reflectionPrefix(host, snapshot.actor, activeCommits, activeReflection)
        ? safeProjectionCommits(
            host,
            snapshot.actor,
            activeCommits,
            activeReflection,
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

  function isIncomingHardUnsafe(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
  ): boolean {
    if (!snapshot.actor) return false;
    const policy = pressurePolicy(snapshot.actor);
    const incomingTokens = host.estimateTokens(messages);
    const rawTokens = Math.max(incomingTokens, snapshot.inputTokens ?? 0);
    return (
      rawTokens >= policy.hard ||
      (snapshot.fixedInputTokens ?? 0) +
        incomingTokens +
        snapshot.actor.maxTokens +
        policy.safetyReserve >=
        snapshot.actor.contextWindow
    );
  }

  function isHardUnsafe(
    snapshot: SessionSnapshot,
    projectedMessages: ContextEvent["messages"],
  ): boolean {
    if (!snapshot.actor) return false;
    const policy = pressurePolicy(snapshot.actor);
    const rawTokens = uncoveredRawTokens(host, snapshot, coveredEntryIds());
    if (rawTokens === undefined || rawTokens >= policy.hard) return true;

    const projectedInput =
      (snapshot.fixedInputTokens ?? 0) + host.estimateTokens(projectedMessages);
    return (
      projectedInput + snapshot.actor.maxTokens + policy.safetyReserve >=
      snapshot.actor.contextWindow
    );
  }

  async function reflect(
    snapshot: SessionSnapshot,
    signal: AbortSignal | undefined,
    hardPaused: boolean,
  ): Promise<"accepted" | "failed" | "cancelled"> {
    const activeReflection = activeReflections.at(-1);
    const prefix = snapshot.actor
      ? reflectionPrefix(host, snapshot.actor, activeCommits, activeReflection)
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
      passId: `${snapshot.sessionId}:reflection:${reflectionPassNumber}`,
      actor: snapshot.actor,
      pressure: pressurePolicy(snapshot.actor),
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
      running = true;
      if (!hardPaused) setStatus("observing");
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
        const record = parseReflectionCandidate(
          host,
          request,
          response,
          activeReflection,
        );
        const fenceIsValid =
          !disposed &&
          lifecycleRevision === launchRevision &&
          !controller.signal.aborted &&
          record !== undefined &&
          snapshot.sessionId === record.replayEpoch &&
          (activeReflections.at(-1)?.id ?? null) ===
            (activeReflection?.id ?? null) &&
          prefix.every(
            (commit, index) =>
              activeCommits[foldedCount + index]?.id === commit.id,
          );
        if (fenceIsValid) {
          host.appendEntry(REFLECTION_CUSTOM_TYPE, record);
          activeReflections.push(record);
          return "accepted";
        }
        if (controller.signal.aborted || lifecycleRevision !== launchRevision) {
          return "cancelled";
        }
      } catch {
        if (controller.signal.aborted) return "cancelled";
      } finally {
        signal?.removeEventListener("abort", abort);
        if (runningController === controller) {
          runningController = undefined;
          running = false;
          if (status === "observing") setStatus(undefined);
        }
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
      running = false;
      setStatus(undefined);
      const replayed = replayMemory(snapshot);
      activeCommits = replayed.commits;
      activeReflections = replayed.reflections;
      passNumber = replayed.observationEntryCount;
      reflectionPassNumber = replayed.reflectionEntryCount;
    },

    observe(snapshot, signal) {
      if (disposed || terminal || running || ready || signal?.aborted) return;
      if (
        snapshot.actor &&
        reflectionPrefix(
          host,
          snapshot.actor,
          activeCommits,
          activeReflections.at(-1),
        )
      ) {
        return;
      }
      const frozen = freezeObservation(snapshot, false);
      if (!frozen) return;
      void executeObservation(frozen, signal, false);
    },

    async project(snapshot, messages, signal) {
      if (disposed) return messages;
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
          if (isIncomingHardUnsafe(snapshot, messages)) stopActor("exhausted");
          return messages;
        }
        const composition = projection(snapshot, messages);
        const projected = composition.messages;
        if (composition.ambiguous) {
          if (isIncomingHardUnsafe(snapshot, messages)) stopActor("exhausted");
          return messages;
        }
        const hardUnsafe = isHardUnsafe(snapshot, projected);
        const reflectionRequired =
          snapshot.actor &&
          reflectionPrefix(
            host,
            snapshot.actor,
            activeCommits,
            activeReflections.at(-1),
          );

        if (reflectionRequired) {
          if (hardUnsafe) setStatus("waiting for memory");
          const outcome = await reflect(snapshot, signal, hardUnsafe);
          if (disposed || lifecycleRevision !== projectRevision) return messages;
          if (outcome === "accepted") continue;
          if (hardUnsafe) {
            stopActor(outcome === "cancelled" ? "cancelled" : "exhausted");
          }
          return projected;
        }

        if (!hardUnsafe) {
          if (status === "waiting for memory") setStatus(undefined);
          return projected;
        }

        setStatus("waiting for memory");
        if (signal?.aborted) {
          runningController?.abort(signal.reason);
          stopActor("cancelled");
          return messages;
        }

        const inFlight = runningPromise;
        const inFlightFrozen = runningObservation;
        if (inFlight && inFlightFrozen) {
          const abortInFlight = () => runningController?.abort(signal?.reason);
          signal?.addEventListener("abort", abortInFlight, { once: true });
          if (signal?.aborted) abortInFlight();
          const firstOutcome = await inFlight;
          signal?.removeEventListener("abort", abortInFlight);
          if (disposed || lifecycleRevision !== projectRevision) return messages;
          if (firstOutcome === "ready") continue;
          if (firstOutcome === "cancelled") {
            stopActor("cancelled");
            return messages;
          }
          const retryOutcome = await executeObservation(
            inFlightFrozen,
            signal,
            true,
          );
          if (disposed || lifecycleRevision !== projectRevision) return messages;
          if (retryOutcome === "ready") continue;
          stopActor(retryOutcome === "cancelled" ? "cancelled" : "exhausted");
          return messages;
        }

        const frozen = freezeObservation(snapshot, true);
        if (!frozen) {
          stopActor(signal?.aborted ? "cancelled" : "exhausted");
          return messages;
        }
        const firstOutcome = await executeObservation(frozen, signal, true);
        if (disposed || lifecycleRevision !== projectRevision) return messages;
        if (firstOutcome === "ready") continue;
        if (firstOutcome === "cancelled") {
          stopActor("cancelled");
          return messages;
        }
        const retryOutcome = await executeObservation(frozen, signal, true);
        if (disposed || lifecycleRevision !== projectRevision) return messages;
        if (retryOutcome === "ready") continue;
        stopActor(retryOutcome === "cancelled" ? "cancelled" : "exhausted");
        return messages;
      }
      return messages;
    },

    dispose() {
      disposed = true;
      lifecycleRevision += 1;
      ready = undefined;
      runningController?.abort("session memory disposed");
      runningController = undefined;
      runningPromise = undefined;
      runningObservation = undefined;
      running = false;
      setStatus(undefined);
    },
  };
}
