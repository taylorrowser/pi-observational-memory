import {
  type ContextEvent,
  type SessionEntry,
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createSessionMemory,
  type ObservationRequest,
  type ReflectionRequest,
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

function activeTask(index: number) {
  return {
    originalIntent: "Keep memory branch-correct.",
    constraints: ["Do not leak sibling memory."],
    decisions: [`Decision ${index}`],
    verifiedProgress: [
      { claim: `Step ${index} is verified.`, evidence: [`entry ${index}`] },
    ],
    currentWork: [`Step ${index + 1}`],
    blockers: [],
    unresolvedQuestions: [],
    nextMove: { owner: "assistant" as const, action: `Do step ${index + 1}.` },
  };
}

function sourcePair(index: number, parentId: string | null) {
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
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: `user-${index}`,
      parentId,
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
      message: user,
    },
    {
      type: "message",
      id: `assistant-${index}`,
      parentId: `user-${index}`,
      timestamp: `2026-01-01T00:00:1${index}.000Z`,
      message: assistant,
    },
  ];
  return { entries, messages: [user, assistant] satisfies ContextEvent["messages"] };
}

function observationRecord(
  index: number,
  parentCommitId: string | null,
  sessionId = "session-1",
) {
  return {
    protocol: "observational-memory.observation",
    version: 1,
    id: `${sessionId}:observation:${index}`,
    replayEpoch: sessionId,
    parentCommitId,
    coverage: {
      entryIds: [`user-${index}`, `assistant-${index}`],
      startEntryId: `user-${index}`,
      endEntryId: `assistant-${index}`,
    },
    observations: [`MEMORY ${index}: branch-specific outcome.`],
    activeTask: activeTask(index),
    lineage: { parentCommitId },
    producer: { provider: actor.provider, model: actor.model },
    usage: zeroUsage,
    timestamp: `2026-01-01T00:00:1${index}.000Z`,
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate: 20,
    validation: { version: 1, checks: ["contiguous-coverage"] },
  };
}

function observationEntry(
  index: number,
  parentId: string,
  parentCommitId: string | null,
  sessionId = "session-1",
): SessionEntry {
  return {
    type: "custom",
    id: `observation-entry-${index}`,
    parentId,
    timestamp: `2026-01-01T00:01:0${index}.000Z`,
    customType: "observational-memory:observation",
    data: observationRecord(index, parentCommitId, sessionId),
  };
}

function reflectionRecord(parentId: string): SessionEntry {
  return {
    type: "custom",
    id: "reflection-entry-1",
    parentId,
    timestamp: "2026-01-01T00:02:01.000Z",
    customType: "observational-memory:reflection",
    data: {
      protocol: "observational-memory.reflection",
      version: 1,
      id: "session-1:reflection:1",
      replayEpoch: "session-1",
      parentReflectionId: null,
      coverage: {
        observationIds: [
          "session-1:observation:1",
          "session-1:observation:2",
        ],
        startObservationId: "session-1:observation:1",
        endObservationId: "session-1:observation:2",
      },
      foldedObservationIds: [
        "session-1:observation:1",
        "session-1:observation:2",
      ],
      reflectedHistory: ["PARENT REFLECTION: inherited outcome."],
      lineage: { parentReflectionId: null },
      producer: { provider: actor.provider, model: actor.model },
      usage: zeroUsage,
      timestamp: "2026-01-01T00:02:01.000Z",
      fidelity: "normal",
      promptVersion: 1,
      outputEstimate: 20,
      validation: {
        version: 1,
        checks: ["contiguous-observation-coverage"],
      },
    },
  };
}

function validCandidate(
  request: {
    passId: string;
    parentCommitId: string | null;
    source: { entryIds: readonly string[] };
  },
) {
  return {
    text: JSON.stringify({
      protocol: "observational-memory.observation",
      version: 1,
      passId: request.passId,
      parentCommitId: request.parentCommitId,
      coverage: { entryIds: request.source.entryIds },
      observations: ["Destination memory."],
      activeTask: activeTask(1),
    }),
    usage: zeroUsage,
    provider: actor.provider,
    model: actor.model,
    stopReason: "stop" as const,
  };
}

describe("SessionMemory branch lifecycle", () => {
  it("does not project memory from the sibling branch being left", async () => {
    const shared = sourcePair(1, null);
    const oldMemory = observationEntry(1, "assistant-1", null);
    const oldDescendant = sourcePair(2, oldMemory.id);
    const oldSnapshot = {
      sessionId: "session-1",
      ancestry: [...shared.entries, oldMemory, ...oldDescendant.entries],
    };
    const sibling = sourcePair(3, "assistant-1");
    const siblingSnapshot = {
      sessionId: "session-1",
      ancestry: [...shared.entries, ...sibling.entries],
    };
    const incoming = [...shared.messages, ...sibling.messages];
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 0,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
    });
    memory.restore(oldSnapshot);
    expect(JSON.stringify(await memory.project(oldSnapshot, [
      ...shared.messages,
      ...oldDescendant.messages,
    ]))).toContain("MEMORY 1");

    memory.restore(siblingSnapshot);

    expect(await memory.project(siblingSnapshot, incoming)).toBe(incoming);
  });

  it("keeps a branch summary as the sole explicit cross-branch handoff", async () => {
    const shared = sourcePair(1, null);
    const oldMemory = observationEntry(1, "assistant-1", null);
    const oldDescendant = sourcePair(2, oldMemory.id);
    const oldSnapshot = {
      sessionId: "session-1",
      ancestry: [...shared.entries, oldMemory, ...oldDescendant.entries],
    };
    const summary = {
      type: "branch_summary" as const,
      id: "branch-summary",
      parentId: "assistant-1",
      timestamp: "2026-01-01T00:03:00.000Z",
      fromId: "assistant-2",
      summary: "Derived orientation: approach A may have completed the migration.",
      fromHook: true,
    };
    const destinationSnapshot = {
      sessionId: "session-1",
      ancestry: [...shared.entries, summary],
    };
    const incoming = [
      ...shared.messages,
      ...sessionEntryToContextMessages(summary),
    ];
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 0,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
    });
    memory.restore(oldSnapshot);

    memory.restore(destinationSnapshot);
    const projected = await memory.project(destinationSnapshot, incoming);

    expect(projected).toBe(incoming);
    expect(projected.at(-1)).toEqual(
      expect.objectContaining({
        role: "branchSummary",
        fromId: "assistant-2",
        summary: expect.stringContaining("Derived orientation"),
      }),
    );
    expect(JSON.stringify(projected)).not.toContain("MEMORY 1");
  });

  it.each([
    ["fork", false],
    ["clone", true],
  ] as const)(
    "%s inherits stable committed records copied by Pi",
    async (_operation, includeTail) => {
      const manager = SessionManager.inMemory("/test/project");
      const parentSessionId = manager.getSessionId();
      const userId = manager.appendMessage({
        role: "user",
        content: "Parent request",
        timestamp: 1,
      });
      const assistantId = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Parent completion" }],
        api: "anthropic-messages",
        provider: actor.provider,
        model: actor.model,
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 2,
      });
      const inheritedRecord = {
        ...observationRecord(1, null, parentSessionId),
        coverage: {
          entryIds: [userId, assistantId],
          startEntryId: userId,
          endEntryId: assistantId,
        },
      };
      const observationId = manager.appendCustomEntry(
        "observational-memory:observation",
        inheritedRecord,
      );
      manager.appendMessage({
        role: "user",
        content: "Exact copied tail",
        timestamp: 3,
      });
      const tailAssistantId = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Tail completion" }],
        api: "anthropic-messages",
        provider: actor.provider,
        model: actor.model,
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 4,
      });
      const copiedLeafId = includeTail ? tailAssistantId : observationId;

      manager.createBranchedSession(copiedLeafId);

      const childSnapshot = {
        sessionId: manager.getSessionId(),
        ancestry: manager.getBranch(),
      };
      const childMessages = manager.buildSessionContext().messages;
      const completeObservation = vi.fn(async () => {
        throw new Error("unexpected observation");
      });
      const memory = createSessionMemory({
        appendEntry: vi.fn(),
        attributeUsage: vi.fn(),
        estimateTokens: () => 0,
        completeObservation,
      });
      memory.restore(childSnapshot);

      const projected = await memory.project(childSnapshot, childMessages);

      expect(childSnapshot.sessionId).not.toBe(parentSessionId);
      const copiedRecord = childSnapshot.ancestry.find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "observational-memory:observation",
      );
      expect(copiedRecord).toEqual(
        expect.objectContaining({
          id: observationId,
          data: expect.objectContaining({
            id: `${parentSessionId}:observation:1`,
            replayEpoch: parentSessionId,
            producer: { provider: actor.provider, model: actor.model },
          }),
        }),
      );
      expect(JSON.stringify(projected[0])).toContain("MEMORY 1");
      if (includeTail) {
        expect(projected.slice(1)).toEqual(childMessages.slice(2));
      } else {
        expect(projected).toHaveLength(1);
      }
      expect(completeObservation).not.toHaveBeenCalled();
    },
  );

  it("persists and projects branch-summary provenance only as derived orientation", async () => {
    const first = sourcePair(1, null);
    const summary = {
      type: "branch_summary" as const,
      id: "branch-summary",
      parentId: "assistant-1",
      timestamp: "2026-01-01T00:03:00.000Z",
      fromId: "abandoned-leaf",
      summary: "Approach A may have completed the migration.",
      fromHook: true,
    };
    const second = sourcePair(2, summary.id);
    const ancestry = [...first.entries, summary, ...second.entries];
    const incoming = ancestry.flatMap(sessionEntryToContextMessages);
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 650,
    };
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens: () => 50,
      async completeObservation(request) {
        return {
          text: JSON.stringify({
            protocol: "observational-memory.observation",
            version: 1,
            passId: request.passId,
            parentCommitId: null,
            coverage: { entryIds: request.source.entryIds },
            observations: [
              "ORIENTATION: Approach A is an unverified branch summary, not completion evidence.",
            ],
            activeTask: {
              ...activeTask(2),
              verifiedProgress: [],
            },
          }),
          usage: zeroUsage,
          provider: actor.provider,
          model: actor.model,
          stopReason: "stop",
        };
      },
    });
    memory.restore(snapshot);
    memory.observe(snapshot);
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());

    const projected = await memory.project(snapshot, incoming);

    const derivedOrientation = {
      evidenceStatus: "derived-orientation",
      sourceEntryId: "branch-summary",
      fromEntryId: "abandoned-leaf",
      producer: "extension",
      summary: "Approach A may have completed the migration.",
    };
    expect(appendEntry).toHaveBeenCalledWith(
      "observational-memory:observation",
      expect.objectContaining({
        derivedOrientations: [derivedOrientation],
      }),
    );
    const memoryMessage = projected[0];
    if (memoryMessage?.role !== "user") {
      throw new Error("expected observational-memory message");
    }
    expect(memoryMessage.content).toContain(JSON.stringify(derivedOrientation));
  });

  it("inherits copied commits while binding new work to the child session", async () => {
    const first = sourcePair(1, null);
    const inherited = observationEntry(1, "assistant-1", null);
    const second = sourcePair(2, inherited.id);
    const childSnapshot = {
      sessionId: "session-2",
      ancestry: [...first.entries, inherited, ...second.entries],
      actor,
      inputTokens: 650,
    };
    const completeObservation = vi.fn(
      () => new Promise<ReturnType<typeof validCandidate>>(() => {}),
    );
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      completeObservation,
    });

    memory.restore(childSnapshot);
    const projected = await memory.project(childSnapshot, [
      ...first.messages,
      ...second.messages,
    ]);
    memory.observe(childSnapshot);

    expect(projected).toHaveLength(3);
    expect(JSON.stringify(projected[0])).toContain(
      "MEMORY 1: branch-specific outcome.",
    );
    expect(projected.slice(1)).toEqual(second.messages);
    expect(completeObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        passId: "session-2:observation:2",
        parentCommitId: "session-1:observation:1",
        source: expect.objectContaining({
          entryIds: ["user-2", "assistant-2"],
        }),
      }),
      expect.any(AbortSignal),
    );
    memory.dispose();
  });

  it("inherits a reflection lineage and persists its child generation under the child session", async () => {
    const ancestry: SessionEntry[] = [];
    const messages: ContextEvent["messages"] = [];
    let parentEntryId: string | null = null;
    let parentCommitId: string | null = null;
    for (let index = 1; index <= 5; index += 1) {
      const pair = sourcePair(index, parentEntryId);
      const observation = observationEntry(
        index,
        `assistant-${index}`,
        parentCommitId,
      );
      ancestry.push(...pair.entries, observation);
      messages.push(...pair.messages);
      parentEntryId = observation.id;
      parentCommitId = `session-1:observation:${index}`;
      if (index === 2) {
        const reflection = reflectionRecord(observation.id);
        ancestry.push(reflection);
        parentEntryId = reflection.id;
      }
    }
    const snapshot = {
      sessionId: "session-2",
      ancestry,
      actor,
      inputTokens: 400,
    };
    const appendEntry = vi.fn();
    const completeReflection = vi.fn(async (request: ReflectionRequest) => ({
      text: JSON.stringify({
        protocol: "observational-memory.reflection",
        version: 1,
        passId: request.passId,
        parentReflectionId: request.parentReflection?.id ?? null,
        coverage: request.coverage,
        reflectedHistory: ["CHILD REFLECTION: inherited and newer outcomes."],
      }),
      usage: zeroUsage,
      provider: actor.provider,
      model: actor.model,
      stopReason: "stop" as const,
    }));
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens(messagesToEstimate) {
        const content = JSON.stringify(messagesToEstimate);
        return (content.match(/MEMORY/g) ?? []).length * 100 || 20;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    memory.restore(snapshot);

    const projected = await memory.project(snapshot, messages);

    expect(completeReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        passId: "session-2:reflection:2",
        parentReflection: expect.objectContaining({
          id: "session-1:reflection:1",
        }),
        coverage: {
          observationIds: [
            "session-1:observation:3",
            "session-1:observation:4",
          ],
        },
      }),
      expect.any(AbortSignal),
    );
    expect(appendEntry).toHaveBeenCalledWith(
      "observational-memory:reflection",
      expect.objectContaining({
        id: "session-2:reflection:2",
        replayEpoch: "session-2",
        parentReflectionId: "session-1:reflection:1",
        foldedObservationIds: [
          "session-1:observation:1",
          "session-1:observation:2",
          "session-1:observation:3",
          "session-1:observation:4",
        ],
      }),
    );
    expect(JSON.stringify(projected[0])).toContain("CHILD REFLECTION");
    expect(JSON.stringify(projected[0])).toContain("MEMORY 5");
    expect(JSON.stringify(projected[0])).not.toContain("MEMORY 4");
  });

  it.each([
    [
      "orphaned source",
      () => {
        const record = observationRecord(1, null);
        return {
          parentId: "assistant-1",
          data: {
            ...record,
            coverage: {
              entryIds: ["missing-user", "missing-assistant"],
              startEntryId: "missing-user",
              endEntryId: "missing-assistant",
            },
          },
        };
      },
    ],
    [
      "mis-parented memory lineage",
      () => {
        const record = observationRecord(1, "missing-memory-parent");
        return { parentId: "assistant-1", data: record };
      },
    ],
    [
      "non-contiguous coverage",
      () => {
        const record = observationRecord(1, null);
        return {
          parentId: "assistant-1",
          data: {
            ...record,
            coverage: {
              ...record.coverage,
              entryIds: ["assistant-1", "user-1"],
            },
          },
        };
      },
    ],
    [
      "mismatched stable identity",
      () => {
        const record = observationRecord(1, null);
        return {
          parentId: "assistant-1",
          data: { ...record, id: "session-2:observation:1" },
        };
      },
    ],
    [
      "mis-parented physical record",
      () => ({
        parentId: "user-1",
        data: observationRecord(1, null),
      }),
    ],
  ] as const)(
    "ignores %s records without repair or coverage advance",
    async (_case, invalidRecord) => {
      const source = sourcePair(1, null);
      const { parentId, data } = invalidRecord();
      const snapshot = {
        sessionId: "session-1",
        ancestry: [
          ...source.entries,
          {
            type: "custom" as const,
            id: "invalid-memory-entry",
            parentId,
            timestamp: "2026-01-01T00:02:00.000Z",
            customType: "observational-memory:observation",
            data,
          },
        ],
      };
      const appendEntry = vi.fn();
      const memory = createSessionMemory({
        appendEntry,
        attributeUsage: vi.fn(),
        estimateTokens: () => 0,
        async completeObservation() {
          throw new Error("unexpected observation");
        },
      });

      memory.restore(snapshot);

      expect(await memory.project(snapshot, source.messages)).toBe(
        source.messages,
      );
      expect(appendEntry).not.toHaveBeenCalled();
    },
  );

  it("does not terminally stop a restored branch when an obsolete hard pause is cancelled", async () => {
    const first = sourcePair(1, null);
    const second = sourcePair(2, "assistant-1");
    const messages = [...first.messages, ...second.messages];
    const oldSnapshot = {
      sessionId: "session-1",
      ancestry: [...first.entries, ...second.entries],
      actor,
      inputTokens: 900,
    };
    const destinationSnapshot = {
      sessionId: "session-1",
      ancestry: [] satisfies SessionEntry[],
      actor,
      inputTokens: 0,
    };
    const abortActor = vi.fn();
    const completeObservation = vi.fn(
      (_request: ObservationRequest, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) => estimatedMessages.length * 100,
      completeObservation,
      setStatus: vi.fn(),
      abortActor,
    });
    memory.restore(oldSnapshot);
    memory.observe(oldSnapshot);
    const obsoleteProjection = memory.project(oldSnapshot, messages);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());

    memory.restore(destinationSnapshot);

    expect(await obsoleteProjection).toBe(messages);
    expect(abortActor).not.toHaveBeenCalled();
    expect(await memory.project(destinationSnapshot, [])).toEqual([]);
  });

  it("cancels old work and restores an ancestor without waiting for the old response", async () => {
    const first = sourcePair(1, null);
    const committed = observationEntry(1, "assistant-1", null);
    const second = sourcePair(2, committed.id);
    const oldSnapshot = {
      sessionId: "session-1",
      ancestry: [...first.entries, committed, ...second.entries],
      actor,
      inputTokens: 650,
    };
    const ancestorSnapshot = {
      sessionId: "session-1",
      ancestry: first.entries,
      actor,
      inputTokens: 650,
    };
    const resolvers: Array<(response: ReturnType<typeof validCandidate>) => void> = [];
    const signals: AbortSignal[] = [];
    const completeObservation = vi.fn(
      (request: ObservationRequest, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
        return new Promise<ReturnType<typeof validCandidate>>((resolve) => {
          resolvers.push(resolve);
        });
      },
    );
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens: () => 100,
      completeObservation,
    });
    memory.restore(oldSnapshot);
    memory.observe(oldSnapshot);
    expect(completeObservation).toHaveBeenCalledOnce();

    memory.restore(ancestorSnapshot);
    expect(signals[0]?.aborted).toBe(true);
    expect(await memory.project(ancestorSnapshot, first.messages)).toBe(
      first.messages,
    );

    memory.observe(ancestorSnapshot);
    expect(completeObservation).toHaveBeenCalledTimes(2);
    const oldRequest = completeObservation.mock.calls[0]?.[0];
    if (!oldRequest) throw new Error("expected old request");
    resolvers[0]?.(validCandidate(oldRequest));
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
    memory.observe(ancestorSnapshot);

    expect(completeObservation).toHaveBeenCalledTimes(2);
    expect(appendEntry).not.toHaveBeenCalled();
    memory.dispose();
  });
});
