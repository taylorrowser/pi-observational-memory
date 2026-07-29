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
}

export interface SessionMemory {
  restore(snapshot: SessionSnapshot): void;
  observe(snapshot: SessionSnapshot, signal?: AbortSignal): void;
  project(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
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
    readonly observationOutputBudget: number;
  };
  readonly activeMemory?: {
    readonly observations: readonly string[];
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
}

const RAW_TARGET_RATIO = 0.5;
const SOFT_PRESSURE_RATIO = 0.6;
const HARD_PRESSURE_RATIO = 0.85;
const OBSERVATION_OUTPUT_RATIO = 0.1;
const OBSERVATION_CUSTOM_TYPE = "observational-memory:observation";

function pressurePolicy(actor: ActorModel): ObservationRequest["pressure"] {
  const usableInput = Math.max(1, actor.contextWindow - actor.maxTokens);
  return {
    usableInput,
    rawTarget: Math.floor(usableInput * RAW_TARGET_RATIO),
    soft: Math.floor(usableInput * SOFT_PRESSURE_RATIO),
    hard: Math.floor(usableInput * HARD_PRESSURE_RATIO),
    observationOutputBudget: Math.min(
      actor.maxTokens,
      Math.max(1, Math.floor(usableInput * OBSERVATION_OUTPUT_RATIO)),
    ),
  };
}

function isObservationEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && entry.customType === OBSERVATION_CUSTOM_TYPE;
}

function sourceEntries(ancestry: readonly SessionEntry[]): SessionEntry[] {
  return ancestry.filter((entry) => !isObservationEntry(entry));
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

function frozenPrefix(
  host: SessionMemoryHost,
  snapshot: SessionSnapshot,
  coveredEntryIds: readonly string[],
): SessionEntry[] | undefined {
  if (!snapshot.actor) return undefined;
  const policy = pressurePolicy(snapshot.actor);
  const allSourceEntries = sourceEntries(snapshot.ancestry);
  if (
    !coveredEntryIds.every(
      (entryId, index) => allSourceEntries[index]?.id === entryId,
    )
  ) {
    return undefined;
  }
  const inputTokens =
    snapshot.inputTokens ??
    host.estimateTokens(allSourceEntries.flatMap(entryMessages));
  if (inputTokens < policy.soft) return undefined;

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

function parsePersistedCommit(
  value: unknown,
  sessionId: string,
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
    !isNonemptyString(value.id) ||
    value.replayEpoch !== sessionId ||
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
    replayEpoch: sessionId,
    parentCommitId: expectedParentCommitId,
    coverage: {
      entryIds: expectedSource.map((entry) => entry.id),
      startEntryId: expectedSource[0]!.id,
      endEntryId: expectedSource.at(-1)!.id,
    },
    observations,
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

function replayObservations(snapshot: SessionSnapshot): ObservationCommit[] {
  const seenSource: SessionEntry[] = [];
  const commits: ObservationCommit[] = [];
  let coveredCount = 0;

  for (const entry of snapshot.ancestry) {
    if (!isObservationEntry(entry)) {
      seenSource.push(entry);
      continue;
    }

    const data = entry.data;
    const coverage =
      isRecord(data) && isRecord(data.coverage)
        ? data.coverage.entryIds
        : undefined;
    if (!Array.isArray(coverage) || coverage.length === 0) continue;
    const expectedSource = seenSource.slice(coveredCount, coveredCount + coverage.length);
    const candidate = parsePersistedCommit(
      data,
      snapshot.sessionId,
      commits.at(-1)?.id ?? null,
      expectedSource,
    );
    if (!candidate) continue;
    const endIndex = coveredCount + candidate.coverage.entryIds.length - 1;
    if (!completedStepBoundaries(seenSource).includes(endIndex)) continue;

    coveredCount += candidate.coverage.entryIds.length;
    commits.push(candidate);
  }

  return commits;
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
): ContextEvent["messages"][number] {
  const newest = commits.at(-1);
  if (!newest) throw new Error("Cannot render empty observational memory");
  return {
    role: "user",
    content: `<observational-memory version="1">\n${JSON.stringify({
      observations: commits.flatMap((commit) => commit.observations),
      activeTask: newest.activeTask,
    })}\n</observational-memory>`,
    timestamp: 0,
  };
}

export function createSessionMemory(host: SessionMemoryHost): SessionMemory {
  let disposed = false;
  let running = false;
  let runningController: AbortController | undefined;
  let passNumber = 0;
  let ready: ReadyObservation | undefined;
  let activeCommits: ObservationCommit[] = [];

  return {
    restore(snapshot) {
      if (disposed) return;
      ready = undefined;
      activeCommits = replayObservations(snapshot);
      passNumber = activeCommits.length;
    },

    observe(snapshot, signal) {
      if (disposed || running || ready || signal?.aborted) return;
      const coveredEntryIds = activeCommits.flatMap(
        (commit) => commit.coverage.entryIds,
      );
      const prefix = frozenPrefix(host, snapshot, coveredEntryIds);
      if (!prefix || !snapshot.actor) return;

      running = true;
      const controller = new AbortController();
      runningController = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      passNumber += 1;
      const newestCommit = activeCommits.at(-1);
      const expectedParentCommitId = newestCommit?.id ?? null;
      const request: ObservationRequest = {
        passId: `${snapshot.sessionId}:observation:${passNumber}`,
        parentCommitId: expectedParentCommitId,
        actor: snapshot.actor,
        pressure: pressurePolicy(snapshot.actor),
        ...(newestCommit
          ? {
              activeMemory: {
                observations: activeCommits.flatMap(
                  (commit) => commit.observations,
                ),
                activeTask: newestCommit.activeTask,
              },
            }
          : {}),
        source: {
          entryIds: prefix.map((entry) => entry.id),
          entries: prefix,
        },
      };
      void host
        .completeObservation(request, controller.signal)
        .then((response) => {
          const record = parseCandidate(
            host,
            request,
            response,
            expectedParentCommitId,
          );
          if (disposed || controller.signal.aborted || !record) return;
          ready = {
            sessionId: snapshot.sessionId,
            launchLeafId: snapshot.ancestry.at(-1)?.id ?? null,
            expectedParentCommitId,
            record,
          };
        })
        .catch(() => {})
        .finally(() => {
          signal?.removeEventListener("abort", abort);
          if (runningController === controller) runningController = undefined;
          running = false;
        });
    },

    async project(snapshot, messages) {
      if (disposed) return messages;
      if (ready) {
        const coveredCount = activeCommits.reduce(
          (count, commit) => count + commit.coverage.entryIds.length,
          0,
        );
        const fenceIsValid =
          ready.sessionId === snapshot.sessionId &&
          (ready.launchLeafId === null ||
            snapshot.ancestry.some(
              (entry) => entry.id === ready?.launchLeafId,
            )) &&
          ready.expectedParentCommitId === (activeCommits.at(-1)?.id ?? null) &&
          ready.record.coverage.entryIds.every(
            (entryId, index) =>
              sourceEntries(snapshot.ancestry)[coveredCount + index]?.id ===
              entryId,
          );
        if (fenceIsValid) {
          host.appendEntry(OBSERVATION_CUSTOM_TYPE, ready.record);
          activeCommits.push(ready.record);
        }
        ready = undefined;
      }

      if (activeCommits.length === 0) return messages;
      const coveredIds = new Set(
        activeCommits.flatMap((commit) => commit.coverage.entryIds),
      );
      const coveredMessages = sourceEntries(snapshot.ancestry)
        .filter((entry) => coveredIds.has(entry.id))
        .flatMap(entryMessages);
      const match = findUniqueSequence(messages, coveredMessages);
      if (match === undefined) return messages;

      return [
        ...messages.slice(0, match),
        renderMemory(activeCommits),
        ...messages.slice(match + coveredMessages.length),
      ];
    },

    dispose() {
      disposed = true;
      ready = undefined;
      runningController?.abort("session memory disposed");
      runningController = undefined;
    },
  };
}
