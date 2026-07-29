import {
  type ContextEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createSessionMemory,
  type ObservationRequest,
} from "../src/session-memory.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const actor = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  contextWindow: 1_100,
  maxTokens: 100,
};

function activeTask(label: string) {
  return {
    originalIntent: "Honor Pi lifecycle boundaries.",
    constraints: ["Preserve exact source status."],
    decisions: [],
    verifiedProgress: [{ claim: label, evidence: [label] }],
    currentWork: ["Continue safely."],
    blockers: [],
    unresolvedQuestions: [],
    nextMove: { owner: "assistant" as const, action: "Continue safely." },
  };
}

function messageEntry(
  id: string,
  parentId: string | null,
  message: ContextEvent["messages"][number],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:${id.at(-1)}.000Z`,
    message,
  };
}

function completedPair(index: number, parentId: string | null) {
  const user = {
    role: "user" as const,
    content: `Request ${index}`,
    timestamp: index * 10,
  };
  const assistant = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `Completed ${index}` }],
    api: "anthropic-messages" as const,
    provider: actor.provider,
    model: actor.model,
    usage: zeroUsage,
    stopReason: "stop" as const,
    timestamp: index * 10 + 1,
  };
  return {
    messages: [user, assistant] satisfies ContextEvent["messages"],
    entries: [
      messageEntry(`user-${index}`, parentId, user),
      messageEntry(`assistant-${index}`, `user-${index}`, assistant),
    ],
  };
}

function observationEntry(parentId: string): SessionEntry {
  return {
    type: "custom",
    id: "observation-entry-1",
    parentId,
    timestamp: "2026-01-01T00:01:00.000Z",
    customType: "observational-memory:observation",
    data: {
      protocol: "observational-memory.observation",
      version: 1,
      id: "session-1:observation:1",
      replayEpoch: "session-1",
      parentCommitId: null,
      coverage: {
        entryIds: ["user-1", "assistant-1"],
        startEntryId: "user-1",
        endEntryId: "assistant-1",
      },
      observations: ["PRE-COMPACTION MEMORY"],
      derivedOrientations: [],
      activeTask: activeTask("First step completed."),
      lineage: { parentCommitId: null },
      producer: { provider: actor.provider, model: actor.model },
      usage: zeroUsage,
      timestamp: "2026-01-01T00:00:11.000Z",
      fidelity: "normal",
      promptVersion: 1,
      outputEstimate: 20,
      validation: { version: 1, checks: ["contiguous-coverage"] },
    },
  };
}

function validObservation(request: ObservationRequest) {
  return {
    text: JSON.stringify({
      protocol: "observational-memory.observation",
      version: 1,
      passId: request.passId,
      parentCommitId: request.parentCommitId,
      coverage: { entryIds: request.source.entryIds },
      observations: ["POST-COMPACTION MEMORY"],
      activeTask: activeTask("Post-compaction step completed."),
    }),
    usage: zeroUsage,
    provider: request.actor.provider,
    model: request.actor.model,
    stopReason: "stop" as const,
  };
}

describe("SessionMemory lifecycle changes", () => {
  it("lets a frozen pass finish across actor-model changes with original producer provenance", async () => {
    const source = completedPair(1, null);
    const oldSnapshot = {
      sessionId: "session-1",
      ancestry: source.entries,
      actor,
      inputTokens: 650,
    };
    const selectedActor = {
      provider: "openai",
      model: "gpt-5.2",
      contextWindow: 2_100,
      maxTokens: 200,
    };
    const changedSnapshot = { ...oldSnapshot, actor: selectedActor };
    let resolveObservation!: (value: ReturnType<typeof validObservation>) => void;
    let frozenRequest: ObservationRequest | undefined;
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens: () => 100,
      completeObservation(request) {
        frozenRequest = request;
        return new Promise((resolve) => {
          resolveObservation = resolve;
        });
      },
    });
    memory.restore(oldSnapshot);

    memory.observe(oldSnapshot);
    if (!frozenRequest) throw new Error("expected a frozen observation request");
    resolveObservation(validObservation(frozenRequest));
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
    const projected = await memory.project(changedSnapshot, source.messages);

    expect(frozenRequest.actor).toEqual(actor);
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry.mock.calls[0]?.[1]).toMatchObject({
      producer: { provider: actor.provider, model: actor.model },
    });
    expect(JSON.stringify(projected)).toContain("POST-COMPACTION MEMORY");
  });

  it("recomputes hard pressure for a smaller selected model without resurrecting covered source for a larger one", async () => {
    const first = completedPair(1, null);
    const committed = observationEntry("assistant-1");
    const tail = completedPair(2, committed.id);
    const ancestry = [...first.entries, committed, ...tail.entries];
    const incoming = [...first.messages, ...tail.messages];
    const smallerActor = {
      provider: "anthropic",
      model: "claude-small",
      contextWindow: 700,
      maxTokens: 100,
    };
    const smallerSnapshot = {
      sessionId: "session-1",
      ancestry,
      actor: smallerActor,
      inputTokens: 710,
    };
    const requests: ObservationRequest[] = [];
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens(messages) {
        const firstMessage = messages[0];
        return messages.length === 1 &&
          firstMessage?.role === "user" &&
          typeof firstMessage.content === "string" &&
          firstMessage.content.startsWith("{")
          ? 20
          : messages.length * 100;
      },
      async completeObservation(request) {
        requests.push(request);
        return validObservation(request);
      },
      abortActor: vi.fn(),
    });
    memory.restore(smallerSnapshot);

    const smallerProjection = await memory.project(smallerSnapshot, incoming);

    expect(requests[0]?.actor).toEqual(smallerActor);
    expect(requests[0]?.pressure).toMatchObject({
      usableInput: 600,
      rawTarget: 300,
      soft: 360,
      hard: 510,
      safetyReserve: 90,
      observationOutputBudget: 60,
    });
    expect(JSON.stringify(smallerProjection)).not.toContain("Request 1");
    expect(JSON.stringify(smallerProjection)).toContain("POST-COMPACTION MEMORY");

    const largerSnapshot = {
      ...smallerSnapshot,
      actor: {
        provider: "anthropic",
        model: "claude-large",
        contextWindow: 4_100,
        maxTokens: 100,
      },
      inputTokens: 550,
    };
    const beforeLargerRequestCount = requests.length;
    const largerProjection = await memory.project(largerSnapshot, incoming);

    expect(requests).toHaveLength(beforeLargerRequestCount);
    expect(JSON.stringify(largerProjection)).not.toContain("Request 1");
    expect(JSON.stringify(largerProjection)).toContain("POST-COMPACTION MEMORY");
  });

  it("uses terminal tool errors as completed boundaries and preserves their failure status", async () => {
    const user = {
      role: "user" as const,
      content: "Run the check",
      timestamp: 1,
    };
    const assistant = {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "tool-call-1",
          name: "bash",
          arguments: { command: "false" },
        },
      ],
      api: "anthropic-messages" as const,
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "toolUse" as const,
      timestamp: 2,
    };
    const toolError = {
      role: "toolResult" as const,
      toolCallId: "tool-call-1",
      toolName: "bash",
      content: [{ type: "text" as const, text: "exit code 1" }],
      isError: true,
      timestamp: 3,
    };
    const entries = [
      messageEntry("tool-user-1", null, user),
      messageEntry("tool-assistant-1", "tool-user-1", assistant),
      messageEntry("tool-result-1", "tool-assistant-1", toolError),
    ];
    const completeObservation = vi.fn(async (request: ObservationRequest) =>
      validObservation(request),
    );
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      completeObservation,
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry: entries,
      actor,
      inputTokens: 650,
    };

    memory.observe(snapshot);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());

    const request = completeObservation.mock.calls[0]?.[0];
    expect(request?.source.entryIds).toEqual([
      "tool-user-1",
      "tool-assistant-1",
      "tool-result-1",
    ]);
    expect(
      (request?.source.entries[2] as Extract<SessionEntry, { type: "message" }>)
        .message,
    ).toMatchObject({ role: "toolResult", isError: true });
  });

  it("keeps failed and aborted assistant responses exact until a later complete boundary", async () => {
    const user = messageEntry("retry-user-1", null, {
      role: "user",
      content: "Retry safely",
      timestamp: 1,
    });
    const failed = messageEntry("retry-error-1", user.id, {
      role: "assistant",
      content: [{ type: "text", text: "provider unavailable" }],
      api: "anthropic-messages",
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "error",
      errorMessage: "retryable 529",
      timestamp: 2,
    });
    const aborted = messageEntry("retry-aborted-1", failed.id, {
      role: "assistant",
      content: [{ type: "text", text: "partial output" }],
      api: "anthropic-messages",
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "aborted",
      timestamp: 3,
    });
    const completed = messageEntry("retry-complete-1", aborted.id, {
      role: "assistant",
      content: [{ type: "text", text: "completed after retry" }],
      api: "anthropic-messages",
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 4,
    });
    const completeObservation = vi.fn(async (request: ObservationRequest) =>
      validObservation(request),
    );
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      completeObservation,
    });
    const incompleteSnapshot = {
      sessionId: "session-1",
      ancestry: [user, failed, aborted],
      actor,
      inputTokens: 650,
    };
    const incompleteMessages = [user, failed, aborted].flatMap(
      sessionEntryToContextMessages,
    );

    memory.observe(incompleteSnapshot);
    expect(completeObservation).not.toHaveBeenCalled();
    expect(await memory.project(incompleteSnapshot, incompleteMessages)).toBe(
      incompleteMessages,
    );

    const completeSnapshot = {
      ...incompleteSnapshot,
      ancestry: [...incompleteSnapshot.ancestry, completed],
    };
    memory.restore(completeSnapshot);
    memory.observe(completeSnapshot);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());

    const statuses = completeObservation.mock.calls[0]?.[0].source.entries
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
          ? [entry.message.stopReason]
          : [],
      );
    expect(statuses).toEqual(["error", "aborted", "stop"]);
  });

  it("keeps an in-flight pass valid when an automatic retry only grows its ancestor prefix", async () => {
    const source = completedPair(1, null);
    const retryError = messageEntry("retry-error-2", "assistant-1", {
      role: "assistant",
      content: [{ type: "text", text: "temporary provider failure" }],
      api: "anthropic-messages",
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "error",
      errorMessage: "retryable 529",
      timestamp: 20,
    });
    const launchSnapshot = {
      sessionId: "session-1",
      ancestry: source.entries,
      actor,
      inputTokens: 650,
    };
    const retrySnapshot = {
      ...launchSnapshot,
      ancestry: [...source.entries, retryError],
    };
    const incoming = [
      ...source.messages,
      ...sessionEntryToContextMessages(retryError),
    ];
    let request: ObservationRequest | undefined;
    let resolveObservation!: (value: ReturnType<typeof validObservation>) => void;
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens: () => 100,
      completeObservation(nextRequest) {
        request = nextRequest;
        return new Promise((resolve) => {
          resolveObservation = resolve;
        });
      },
    });
    memory.restore(launchSnapshot);
    memory.observe(launchSnapshot);
    if (!request) throw new Error("expected observation request");

    resolveObservation(validObservation(request));
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
    const projected = await memory.project(retrySnapshot, incoming);

    expect(appendEntry).toHaveBeenCalledOnce();
    expect(JSON.stringify(projected)).toContain("POST-COMPACTION MEMORY");
    expect(JSON.stringify(projected)).toContain("temporary provider failure");
  });

  it("propagates abort signals without erasing a valid prior commit", async () => {
    const first = completedPair(1, null);
    const committed = observationEntry("assistant-1");
    const tail = completedPair(2, committed.id);
    const snapshot = {
      sessionId: "session-1",
      ancestry: [...first.entries, committed, ...tail.entries],
      actor,
      inputTokens: 650,
    };
    const incoming = [...first.messages, ...tail.messages];
    let memorySignal: AbortSignal | undefined;
    const controller = new AbortController();
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      completeObservation(_request, signal) {
        memorySignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    memory.restore(snapshot);
    memory.observe(snapshot, controller.signal);
    controller.abort("escape");
    await vi.waitFor(() => expect(memorySignal?.aborted).toBe(true));

    const projected = await memory.project(snapshot, incoming, controller.signal);

    expect(JSON.stringify(projected)).toContain("PRE-COMPACTION MEMORY");
    expect(JSON.stringify(projected)).toContain("Request 2");
  });

  it("does not attribute or append a provider response that returns after disposal", async () => {
    const source = completedPair(1, null);
    let resolveObservation!: (value: ReturnType<typeof validObservation>) => void;
    let request: ObservationRequest | undefined;
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens: () => 100,
      completeObservation(nextRequest) {
        request = nextRequest;
        return new Promise((resolve) => {
          resolveObservation = resolve;
        });
      },
    });
    const snapshot = {
      sessionId: "old-session",
      ancestry: source.entries,
      actor,
      inputTokens: 650,
    };
    memory.restore(snapshot);
    memory.observe(snapshot);
    if (!request) throw new Error("expected observation request");

    memory.dispose();
    resolveObservation(validObservation(request));
    await Promise.resolve();
    await Promise.resolve();

    expect(attributeUsage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("makes explicit Pi compaction a fresh replay epoch and restores old memory before it", async () => {
    const first = completedPair(1, null);
    const oldObservation = observationEntry("assistant-1");
    const retained = completedPair(2, oldObservation.id);
    const compaction: SessionEntry = {
      type: "compaction",
      id: "compaction-1",
      parentId: "assistant-2",
      timestamp: "2026-01-01T00:02:00.000Z",
      summary: "PI COMPACTION SUMMARY",
      firstKeptEntryId: "user-2",
      tokensBefore: 900,
    };
    const beforeSnapshot = {
      sessionId: "session-1",
      ancestry: [...first.entries, oldObservation],
    };
    const afterSnapshot = {
      sessionId: "session-1",
      ancestry: [
        ...first.entries,
        oldObservation,
        ...retained.entries,
        compaction,
      ],
      actor,
      inputTokens: 650,
    };
    const incoming = [
      ...sessionEntryToContextMessages(compaction),
      ...retained.messages,
    ];
    const requests: ObservationRequest[] = [];
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens(messages) {
        const firstMessage = messages[0];
        return messages.length === 1 &&
          firstMessage?.role === "user" &&
          typeof firstMessage.content === "string" &&
          firstMessage.content.startsWith("{")
          ? 20
          : messages.length * 100;
      },
      async completeObservation(request) {
        requests.push(request);
        return validObservation(request);
      },
    });

    memory.restore(afterSnapshot);
    expect(await memory.project(afterSnapshot, incoming)).toBe(incoming);

    memory.observe(afterSnapshot);
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
    const projected = await memory.project(afterSnapshot, incoming);

    expect(requests[0]?.source.entryIds).toEqual([
      "compaction-1",
      "user-2",
      "assistant-2",
    ]);
    expect(requests[0]?.passId).toBe(
      "session-1:compaction-1:observation:1",
    );
    expect(requests[0]?.activeMemory).toBeUndefined();
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(JSON.stringify(projected)).toContain("POST-COMPACTION MEMORY");
    expect(JSON.stringify(projected)).not.toContain("PRE-COMPACTION MEMORY");
    expect(JSON.stringify(projected)).not.toContain("PI COMPACTION SUMMARY");

    const persistedData = appendEntry.mock.calls[0]?.[1];
    const persistedEntry: SessionEntry = {
      type: "custom",
      id: "post-compaction-observation-entry",
      parentId: compaction.id,
      timestamp: "2026-01-01T00:03:00.000Z",
      customType: "observational-memory:observation",
      data: persistedData,
    };
    const reloadedSnapshot = {
      ...afterSnapshot,
      ancestry: [...afterSnapshot.ancestry, persistedEntry],
    };
    const reloaded = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
    });
    reloaded.restore(reloadedSnapshot);
    const reloadedProjection = await reloaded.project(
      reloadedSnapshot,
      incoming,
    );
    expect(JSON.stringify(reloadedProjection)).toContain(
      "POST-COMPACTION MEMORY",
    );
    expect(JSON.stringify(reloadedProjection)).not.toContain(
      "PRE-COMPACTION MEMORY",
    );

    memory.restore(beforeSnapshot);
    expect(
      JSON.stringify(await memory.project(beforeSnapshot, first.messages)),
    ).toContain("PRE-COMPACTION MEMORY");
  });
});
