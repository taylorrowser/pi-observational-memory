import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createSessionMemory } from "../src/session-memory.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const actor = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  contextWindow: 1_100,
  maxTokens: 100,
};

function activeTask(index: number) {
  return {
    originalIntent: "Finish the migration.",
    constraints: ["Keep the public API stable."],
    decisions: [`Decision ${index}`],
    verifiedProgress: [
      { claim: `Step ${index} is verified.`, evidence: [`test-${index} passed`] },
    ],
    currentWork: [`Working on step ${index + 1}.`],
    blockers: [],
    unresolvedQuestions: [`Question ${index}`],
    nextMove: { owner: "assistant", action: `Implement step ${index + 1}.` },
  } as const;
}

function observationRecord(index: number, parentCommitId: string | null) {
  const id = `session-1:observation:${index}`;
  return {
    protocol: "observational-memory.observation",
    version: 1,
    id,
    replayEpoch: "session-1",
    parentCommitId,
    coverage: {
      entryIds: [`user-${index}`, `assistant-${index}`],
      startEntryId: `user-${index}`,
      endEntryId: `assistant-${index}`,
    },
    observations: [`OBSERVATION ${index}: durable outcome ${index}.`],
    activeTask: activeTask(index),
    lineage: { parentCommitId },
    producer: { provider: actor.provider, model: actor.model },
    usage: zeroUsage,
    timestamp: `2026-01-01T00:00:0${index}.000Z`,
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate: 100,
    validation: { version: 1, checks: ["contiguous-coverage"] },
  };
}

function observedHistory(count: number): {
  ancestry: SessionEntry[];
  messages: ContextEvent["messages"];
} {
  const ancestry: SessionEntry[] = [];
  const messages: ContextEvent["messages"] = [];
  let parentEntryId: string | null = null;
  let parentCommitId: string | null = null;

  for (let index = 1; index <= count; index += 1) {
    const user = {
      role: "user" as const,
      content: `Request ${index}`,
      timestamp: index * 10,
    };
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `Completed step ${index}` }],
      api: "anthropic-messages" as const,
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: index * 10 + 1,
    };
    ancestry.push({
      type: "message",
      id: `user-${index}`,
      parentId: parentEntryId,
      timestamp: `2026-01-01T00:00:${index * 2 - 1}.000Z`,
      message: user,
    });
    ancestry.push({
      type: "message",
      id: `assistant-${index}`,
      parentId: `user-${index}`,
      timestamp: `2026-01-01T00:00:${index * 2}.000Z`,
      message: assistant,
    });
    const record = observationRecord(index, parentCommitId);
    ancestry.push({
      type: "custom",
      id: `observation-entry-${index}`,
      parentId: `assistant-${index}`,
      timestamp: `2026-01-01T00:01:0${index}.000Z`,
      customType: "observational-memory:observation",
      data: record,
    });
    messages.push(user, assistant);
    parentEntryId = `observation-entry-${index}`;
    parentCommitId = record.id;
  }

  return { ancestry, messages };
}

function projectedMemoryContent(
  projected: ContextEvent["messages"],
): string {
  const memory = projected[0];
  return memory && "content" in memory ? String(memory.content) : "";
}

function observationTokenEstimate(
  messages: ContextEvent["messages"],
  fallback = 10,
): number {
  const count = (JSON.stringify(messages).match(/OBSERVATION/g) ?? []).length;
  return count * 100 || fallback;
}

function reflectionRecord(
  generation: number,
  parentReflectionId: string | null,
  observationIds: string[],
  foldedObservationIds: string[],
) {
  const id = `session-1:reflection:${generation}`;
  return {
    protocol: "observational-memory.reflection",
    version: 1,
    id,
    replayEpoch: "session-1",
    parentReflectionId,
    coverage: {
      observationIds,
      startObservationId: observationIds[0],
      endObservationId: observationIds.at(-1),
    },
    foldedObservationIds,
    reflectedHistory: [`REFLECTION ${generation}: coherent folded history.`],
    lineage: { parentReflectionId },
    producer: { provider: actor.provider, model: actor.model },
    usage: zeroUsage,
    timestamp: `2026-01-01T00:02:0${generation}.000Z`,
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate: 80,
    validation: {
      version: 1,
      checks: ["contiguous-observation-coverage"],
    },
  };
}

function reflectionCandidate(
  observationIds: string[],
  options: {
    passId?: string;
    parentReflectionId?: string | null;
    reflectedHistory?: string[];
  } = {},
) {
  return {
    text: JSON.stringify({
      protocol: "observational-memory.reflection",
      version: 1,
      passId: options.passId ?? "session-1:reflection:1",
      parentReflectionId: options.parentReflectionId ?? null,
      coverage: { observationIds },
      reflectedHistory: options.reflectedHistory ?? [
        "HISTORY: Steps 1 and 2 produced durable outcomes with passing tests.",
      ],
    }),
    usage: {
      ...zeroUsage,
      input: 30,
      output: 20,
      totalTokens: 50,
      cost: { ...zeroUsage.cost, total: 0.25 },
    },
    provider: actor.provider,
    model: actor.model,
    stopReason: "stop" as const,
  };
}

function changedReflectionCandidate(
  change: (candidate: Record<string, unknown>) => void,
) {
  const response = reflectionCandidate([
    "session-1:observation:1",
    "session-1:observation:2",
  ]);
  const candidate = JSON.parse(response.text) as Record<string, unknown>;
  change(candidate);
  return { ...response, text: JSON.stringify(candidate) };
}

describe("SessionMemory reflection", () => {
  it("retries the identical reflection once when hard headroom is paused", async () => {
    const history = observedHistory(3);
    const snapshot = {
      sessionId: "session-1",
      ancestry: history.ancestry,
      actor,
      inputTokens: 400,
      fixedInputTokens: 700,
    };
    const completeReflection = vi
      .fn()
      .mockResolvedValueOnce({
        ...reflectionCandidate([
          "session-1:observation:1",
          "session-1:observation:2",
        ]),
        text: "",
      })
      .mockResolvedValueOnce(
        reflectionCandidate([
          "session-1:observation:1",
          "session-1:observation:2",
        ]),
      );
    const appendEntry = vi.fn();
    const setStatus = vi.fn();
    const debugEvent = vi.fn();
    const memory = createSessionMemory(
      {
        appendEntry,
        debugEvent,
        attributeUsage: vi.fn(),
        estimateTokens: observationTokenEstimate,
        async completeObservation() {
          throw new Error("unexpected observation");
        },
        completeReflection,
        setStatus,
        abortActor: vi.fn(),
      },
      {
        ...DEFAULT_SETTINGS,
        debugLogging: true,
        messageTokensTarget: 100,
        hardHeadroomTokens: 850,
        messageTokensStartObservation: 200,
        observationTokensTarget: 100,
        observationTokensStartReflection: 250,
        reflectionTokensMax: 100,
      },
    );
    memory.restore(snapshot);

    const projected = await memory.project(snapshot, history.messages);

    expect(completeReflection).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledWith("reflecting — waiting for memory");
    expect(completeReflection.mock.calls[1]?.[0]).toBe(
      completeReflection.mock.calls[0]?.[0],
    );
    expect(appendEntry).toHaveBeenCalledWith(
      "observational-memory:reflection",
      expect.objectContaining({ id: "session-1:reflection:1" }),
    );
    expect(projectedMemoryContent(projected)).toContain("HISTORY:");
    expect(debugEvent.mock.calls.map(([event]) => event.event)).toEqual(
      expect.arrayContaining([
        "hard-headroom-wait",
        "reflection-started",
        "reflection-rejected",
        "reflection-retry",
        "reflection-committed",
      ]),
    );
  });

  it("does not fail hard projection while session-owned reflection is running", async () => {
    const history = observedHistory(3);
    const snapshot = {
      sessionId: "session-1",
      ancestry: history.ancestry,
      actor,
      inputTokens: 400,
      fixedInputTokens: 700,
    };
    const pending = deferred<ReturnType<typeof reflectionCandidate>>();
    let reflectionSignal: AbortSignal | undefined;
    const completeReflection = vi.fn(
      (
        _request: unknown,
        signal?: AbortSignal,
      ): Promise<ReturnType<typeof reflectionCandidate>> => {
        reflectionSignal = signal;
        return new Promise((resolve, reject) => {
          pending.promise.then(resolve, reject);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const abortActor = vi.fn();
    const setStatus = vi.fn();
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: observationTokenEstimate,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
      setStatus,
      abortActor,
    });
    memory.restore(snapshot);

    const sessionController = new AbortController();
    const maintenance = memory.maintain(() => snapshot, sessionController.signal);
    await vi.waitFor(() => expect(completeReflection).toHaveBeenCalledOnce());

    const actorController = new AbortController();
    const projection = memory.project(
      snapshot,
      history.messages,
      actorController.signal,
    );
    let settled = false;
    void projection.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(abortActor).not.toHaveBeenCalled();

    actorController.abort("actor stopped");
    await projection;

    expect(abortActor).toHaveBeenCalledOnce();
    expect(sessionController.signal.aborted).toBe(false);
    expect(reflectionSignal?.aborted).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("reflecting");

    pending.resolve(
      reflectionCandidate([
        "session-1:observation:1",
        "session-1:observation:2",
      ]),
    );
    await maintenance;
    expect(setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("does not reflect below observation high pressure", async () => {
    const history = observedHistory(2);
    const snapshot = {
      sessionId: "session-1",
      ancestry: history.ancestry,
      actor,
      inputTokens: 400,
    };
    const completeReflection = vi.fn();
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens(messages) {
        return JSON.stringify(messages).includes("OBSERVATION") ? 200 : 10;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    memory.restore(snapshot);

    const projected = await memory.project(snapshot, history.messages);

    expect(completeReflection).not.toHaveBeenCalled();
    expect(projected).toHaveLength(1);
    const content = projectedMemoryContent(projected);
    expect(content).toContain("OBSERVATION 1:");
    expect(content).toContain("OBSERVATION 2:");
  });

  it("replays only the newest reflection with newer observations and the newest anchor", async () => {
    const history = observedHistory(4);
    const firstReflection = reflectionRecord(
      1,
      null,
      ["session-1:observation:1", "session-1:observation:2"],
      ["session-1:observation:1", "session-1:observation:2"],
    );
    const secondReflection = reflectionRecord(
      2,
      "session-1:reflection:1",
      ["session-1:observation:3"],
      [
        "session-1:observation:1",
        "session-1:observation:2",
        "session-1:observation:3",
      ],
    );
    const firstEntry: SessionEntry = {
      type: "custom",
      id: "reflection-entry-1",
      parentId: "observation-entry-2",
      timestamp: "2026-01-01T00:02:01.000Z",
      customType: "observational-memory:reflection",
      data: firstReflection,
    };
    const secondEntry: SessionEntry = {
      type: "custom",
      id: "reflection-entry-2",
      parentId: "observation-entry-3",
      timestamp: "2026-01-01T00:02:02.000Z",
      customType: "observational-memory:reflection",
      data: secondReflection,
    };
    const ancestry = [
      ...history.ancestry.slice(0, 6),
      firstEntry,
      ...history.ancestry.slice(6, 9),
      secondEntry,
      ...history.ancestry.slice(9),
    ];
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 400,
    };
    const completeReflection = vi.fn();
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens(messages) {
        return JSON.stringify(messages).includes("OBSERVATION") ? 100 : 10;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    memory.restore(snapshot);

    const projected = await memory.project(snapshot, history.messages);

    expect(completeReflection).not.toHaveBeenCalled();
    expect(projected).toHaveLength(1);
    const content = projectedMemoryContent(projected);
    expect(content).toContain("REFLECTION 2: coherent folded history.");
    expect(content).toContain("OBSERVATION 4: durable outcome 4.");
    expect(content).toContain("Question 4");
    expect(content).not.toContain("REFLECTION 1:");
    expect(content).not.toContain("OBSERVATION 1:");
    expect(content).not.toContain("OBSERVATION 2:");
    expect(content).not.toContain("OBSERVATION 3:");
    expect(await memory.project(snapshot, history.messages)).toEqual(projected);
  });

  it("continues a sparse reflection audit identity after reload", async () => {
    const history = observedHistory(5);
    const firstReflection = reflectionRecord(
      1,
      null,
      ["session-1:observation:1", "session-1:observation:2"],
      ["session-1:observation:1", "session-1:observation:2"],
    );
    const unsupportedReflection = {
      ...reflectionRecord(
        4,
        "session-1:reflection:1",
        ["session-1:observation:3"],
        [
          "session-1:observation:1",
          "session-1:observation:2",
          "session-1:observation:3",
        ],
      ),
      version: 2,
    };
    const ancestry = [
      ...history.ancestry.slice(0, 6),
      {
        type: "custom" as const,
        id: "reflection-entry-1",
        parentId: "observation-entry-2",
        timestamp: "2026-01-01T00:02:01.000Z",
        customType: "observational-memory:reflection",
        data: firstReflection,
      },
      ...history.ancestry.slice(6, 9),
      {
        type: "custom" as const,
        id: "reflection-entry-2",
        parentId: "observation-entry-3",
        timestamp: "2026-01-01T00:02:02.000Z",
        customType: "observational-memory:reflection",
        data: unsupportedReflection,
      },
      ...history.ancestry.slice(9),
    ];
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 400,
    };
    const completeReflection = vi.fn(async () =>
      reflectionCandidate(
        ["session-1:observation:3", "session-1:observation:4"],
        {
          passId: "session-1:reflection:5",
          parentReflectionId: "session-1:reflection:1",
          reflectedHistory: [
            "REFLECTION 5: valid history after ignored generation.",
          ],
        },
      ),
    );
    const appendEntry = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens(messages) {
        return (JSON.stringify(messages).match(/OBSERVATION/g) ?? []).length * 100 || 10;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    memory.restore(snapshot);

    const projected = await memory.project(snapshot, history.messages);

    expect(completeReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        passId: "session-1:reflection:5",
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
      expect.objectContaining({ id: "session-1:reflection:5" }),
    );
    const content = projectedMemoryContent(projected);
    expect(content).toContain(
      "REFLECTION 5: valid history after ignored generation.",
    );
    expect(content).toContain("OBSERVATION 5:");
    expect(content).not.toContain("REFLECTION 1:");
    expect(content).not.toContain("REFLECTION 2:");
    expect(content).not.toContain("OBSERVATION 4:");
  });

  it("feeds the active reflection and only newer observations into the next Observer pass", () => {
    const history = observedHistory(3);
    const reflection = reflectionRecord(
      1,
      null,
      ["session-1:observation:1", "session-1:observation:2"],
      ["session-1:observation:1", "session-1:observation:2"],
    );
    const nextUser = {
      role: "user" as const,
      content: "Request 4",
      timestamp: 40,
    };
    const nextAssistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Completed step 4" }],
      api: "anthropic-messages" as const,
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: 41,
    };
    const ancestry: SessionEntry[] = [
      ...history.ancestry.slice(0, 6),
      {
        type: "custom",
        id: "reflection-entry-1",
        parentId: "observation-entry-2",
        timestamp: "2026-01-01T00:02:01.000Z",
        customType: "observational-memory:reflection",
        data: reflection,
      },
      ...history.ancestry.slice(6),
      {
        type: "message",
        id: "user-4",
        parentId: "observation-entry-3",
        timestamp: "2026-01-01T00:00:07.000Z",
        message: nextUser,
      },
      {
        type: "message",
        id: "assistant-4",
        parentId: "user-4",
        timestamp: "2026-01-01T00:00:08.000Z",
        message: nextAssistant,
      },
    ];
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 650,
    };
    const completeObservation = vi.fn(() => new Promise<never>(() => {}));
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      completeObservation,
      completeReflection: vi.fn(),
    });
    memory.restore(snapshot);

    memory.observe(snapshot);

    expect(completeObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        activeMemory: {
          reflectedHistory: ["REFLECTION 1: coherent folded history."],
          observations: ["OBSERVATION 3: durable outcome 3."],
          derivedOrientations: [],
          activeTask: activeTask(3),
        },
        source: expect.objectContaining({
          entryIds: ["user-4", "assistant-4"],
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("folds the active reflection into the next immutable generation", async () => {
    const history = observedHistory(5);
    const firstReflection = reflectionRecord(
      1,
      null,
      ["session-1:observation:1", "session-1:observation:2"],
      ["session-1:observation:1", "session-1:observation:2"],
    );
    const reflectionEntry: SessionEntry = {
      type: "custom",
      id: "reflection-entry-1",
      parentId: "observation-entry-2",
      timestamp: "2026-01-01T00:02:01.000Z",
      customType: "observational-memory:reflection",
      data: firstReflection,
    };
    const ancestry = [
      ...history.ancestry.slice(0, 6),
      reflectionEntry,
      ...history.ancestry.slice(6),
    ];
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 400,
    };
    const appendEntry = vi.fn();
    const completeReflection = vi.fn(async () =>
      reflectionCandidate(
        ["session-1:observation:3", "session-1:observation:4"],
        {
          passId: "session-1:reflection:2",
          parentReflectionId: "session-1:reflection:1",
          reflectedHistory: ["REFLECTION 2: outcomes from steps 1 through 4."],
        },
      ),
    );
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens(messages) {
        const content = JSON.stringify(messages);
        return (content.match(/OBSERVATION/g) ?? []).length * 100 || 80;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    memory.restore(snapshot);

    const projected = await memory.project(snapshot, history.messages);

    expect(completeReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        passId: "session-1:reflection:2",
        parentReflection: {
          id: "session-1:reflection:1",
          reflectedHistory: ["REFLECTION 1: coherent folded history."],
          foldedObservationIds: [
            "session-1:observation:1",
            "session-1:observation:2",
          ],
        },
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
        id: "session-1:reflection:2",
        parentReflectionId: "session-1:reflection:1",
        foldedObservationIds: [
          "session-1:observation:1",
          "session-1:observation:2",
          "session-1:observation:3",
          "session-1:observation:4",
        ],
      }),
    );
    const content = projectedMemoryContent(projected);
    expect(content).toContain("REFLECTION 2: outcomes from steps 1 through 4.");
    expect(content).toContain("OBSERVATION 5: durable outcome 5.");
    expect(content).not.toContain("REFLECTION 1:");
    expect(content).not.toContain("OBSERVATION 4:");
  });

  it.each([
    [
      "unsupported protocol",
      () =>
        changedReflectionCandidate((candidate) => {
          candidate.version = 2;
        }),
    ],
    [
      "wrong parent",
      () =>
        changedReflectionCandidate((candidate) => {
          candidate.parentReflectionId = "wrong-parent";
        }),
    ],
    [
      "non-contiguous coverage",
      () => reflectionCandidate(["session-1:observation:2"]),
    ],
    [
      "empty history",
      () =>
        changedReflectionCandidate((candidate) => {
          candidate.reflectedHistory = [];
        }),
    ],
    [
      "truncated output",
      () => ({
        ...reflectionCandidate([
          "session-1:observation:1",
          "session-1:observation:2",
        ]),
        stopReason: "length" as const,
      }),
    ],
    [
      "over-budget output",
      () =>
        changedReflectionCandidate((candidate) => {
          candidate.reflectedHistory = ["OVER_BUDGET"];
        }),
    ],
  ])(
    "keeps the previous safe projection authoritative for %s",
    async (_name, invalidResponse) => {
    const history = observedHistory(3);
    const snapshot = {
      sessionId: "session-1",
      ancestry: history.ancestry,
      actor,
      inputTokens: 400,
    };
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens(messages) {
        const content = JSON.stringify(messages);
        if (content.includes("OVER_BUDGET")) return 101;
        return (content.match(/OBSERVATION/g) ?? []).length * 100 || 10;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      async completeReflection() {
        return invalidResponse();
      },
    });
    memory.restore(snapshot);

    const projected = await memory.project(snapshot, history.messages);

    expect(attributeUsage).toHaveBeenCalledOnce();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(projected).toHaveLength(3);
    const content = projectedMemoryContent(projected);
    expect(content).toContain("OBSERVATION 1:");
    expect(content).toContain("OBSERVATION 2:");
    expect(content).not.toContain("OBSERVATION 3:");
    expect(projected.slice(1)).toEqual(history.messages.slice(4));
    },
  );

  it("reflects a newly appended observation before returning its active projection", async () => {
    const base = observedHistory(2);
    const user = {
      role: "user" as const,
      content: "Request 3",
      timestamp: 30,
    };
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Completed step 3" }],
      api: "anthropic-messages" as const,
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: 31,
    };
    const ancestry: SessionEntry[] = [
      ...base.ancestry,
      {
        type: "message",
        id: "user-3",
        parentId: "observation-entry-2",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: user,
      },
      {
        type: "message",
        id: "assistant-3",
        parentId: "user-3",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: assistant,
      },
    ];
    const messages = [...base.messages, user, assistant];
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 650,
    };
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    let observationInFlight = false;
    const completeObservation = vi.fn(async (request) => {
      observationInFlight = true;
      const response = {
        text: JSON.stringify({
          protocol: "observational-memory.observation",
          version: 1,
          passId: request.passId,
          parentCommitId: "session-1:observation:2",
          coverage: { entryIds: ["user-3", "assistant-3"] },
          observations: ["OBSERVATION 3: durable outcome 3."],
          activeTask: activeTask(3),
        }),
        usage: zeroUsage,
        provider: actor.provider,
        model: actor.model,
        stopReason: "stop" as const,
      };
      observationInFlight = false;
      return response;
    });
    const completeReflection = vi.fn(async () => {
      expect(observationInFlight).toBe(false);
      return reflectionCandidate([
        "session-1:observation:1",
        "session-1:observation:2",
      ]);
    });
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens(messagesToEstimate) {
        const content = JSON.stringify(messagesToEstimate);
        return (content.match(/OBSERVATION/g) ?? []).length * 100 || 100;
      },
      completeObservation,
      completeReflection,
    });
    memory.restore(snapshot);

    memory.observe(snapshot);
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
    const projected = await memory.project(snapshot, messages);

    expect(completeObservation).toHaveBeenCalledOnce();
    expect(completeReflection).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(appendEntry.mock.calls[0]?.[0]).toBe(
      "observational-memory:observation",
    );
    expect(appendEntry.mock.calls[1]?.[0]).toBe(
      "observational-memory:reflection",
    );
    const content = projectedMemoryContent(projected);
    expect(content).toContain("HISTORY: Steps 1 and 2");
    expect(content).toContain("OBSERVATION 3:");
    expect(content).not.toContain("OBSERVATION 1:");
    expect(content).not.toContain("OBSERVATION 2:");
  });

  it("does not attribute or activate a reflection returned after disposal", async () => {
    const history = observedHistory(3);
    const snapshot = {
      sessionId: "session-1",
      ancestry: history.ancestry,
      actor,
      inputTokens: 400,
    };
    let resolveReflection!: (value: ReturnType<typeof reflectionCandidate>) => void;
    let reflectionSignal: AbortSignal | undefined;
    const completeReflection = vi.fn(
      (_request: unknown, signal?: AbortSignal) => {
        reflectionSignal = signal;
        return new Promise<ReturnType<typeof reflectionCandidate>>((resolve) => {
          resolveReflection = resolve;
        });
      },
    );
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens(messages) {
        return (JSON.stringify(messages).match(/OBSERVATION/g) ?? []).length * 100 || 10;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    memory.restore(snapshot);

    const projection = memory.project(snapshot, history.messages);
    await vi.waitFor(() => expect(completeReflection).toHaveBeenCalledOnce());
    memory.dispose();
    expect(reflectionSignal?.aborted).toBe(true);
    resolveReflection(
      reflectionCandidate([
        "session-1:observation:1",
        "session-1:observation:2",
      ]),
    );
    await projection;

    expect(attributeUsage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("discards a reflection result after its launch leaf leaves active ancestry", async () => {
    const history = observedHistory(3);
    const launchSnapshot = {
      sessionId: "session-1",
      ancestry: history.ancestry,
      actor,
      inputTokens: 400,
    };
    const sibling = observedHistory(2);
    const siblingUser = {
      role: "user" as const,
      content: "Sibling branch work",
      timestamp: 99,
    };
    const siblingSnapshot = {
      ...launchSnapshot,
      ancestry: [
        ...sibling.ancestry,
        {
          type: "message" as const,
          id: "sibling-user-3",
          parentId: "observation-entry-2",
          timestamp: "2026-01-01T00:03:00.000Z",
          message: siblingUser,
        },
      ],
    };
    let resolveReflection!: (value: ReturnType<typeof reflectionCandidate>) => void;
    let reflectionSignal: AbortSignal | undefined;
    const completeReflection = vi.fn(
      (_request: unknown, signal?: AbortSignal) => {
        reflectionSignal = signal;
        return new Promise<ReturnType<typeof reflectionCandidate>>((resolve) => {
          resolveReflection = resolve;
        });
      },
    );
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens(messages) {
        return (JSON.stringify(messages).match(/OBSERVATION/g) ?? []).length * 100 || 10;
      },
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    memory.restore(launchSnapshot);

    const projection = memory.project(launchSnapshot, history.messages);
    await vi.waitFor(() => expect(completeReflection).toHaveBeenCalledOnce());
    memory.restore(siblingSnapshot);
    expect(reflectionSignal?.aborted).toBe(true);
    resolveReflection(
      reflectionCandidate([
        "session-1:observation:1",
        "session-1:observation:2",
      ]),
    );
    await projection;

    expect(attributeUsage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("reflects the oldest observation prefix before returning an oversized projection", async () => {
    const history = observedHistory(3);
    const snapshot = {
      sessionId: "session-1",
      ancestry: history.ancestry,
      actor,
      inputTokens: 400,
    };
    let resolveReflection!: (value: ReturnType<typeof reflectionCandidate>) => void;
    const completeReflection = vi.fn(
      () =>
        new Promise<ReturnType<typeof reflectionCandidate>>((resolve) => {
          resolveReflection = resolve;
        }),
    );
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const completeObservation = vi.fn(async () => {
      throw new Error("observation must not overlap reflection");
    });
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens(messages) {
        const content = messages
          .map((message) =>
            "content" in message
              ? typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content)
              : JSON.stringify(message),
          )
          .join("\n");
        if (content.includes("OBSERVATION")) {
          return (content.match(/OBSERVATION/g) ?? []).length * 100;
        }
        if (content.includes("HISTORY:")) return 80;
        return 10;
      },
      completeObservation,
      completeReflection,
    });
    memory.restore(snapshot);

    let projectionSettled = false;
    const projection = memory.project(snapshot, history.messages).then((value) => {
      projectionSettled = true;
      return value;
    });
    await vi.waitFor(() => expect(completeReflection).toHaveBeenCalledOnce());

    memory.observe(snapshot);
    expect(projectionSettled).toBe(false);
    expect(completeObservation).not.toHaveBeenCalled();
    expect(completeReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        passId: "session-1:reflection:1",
        parentReflection: null,
        pressure: expect.objectContaining({
          observationTarget: 150,
          observationHigh: 250,
        }),
        coverage: {
          observationIds: [
            "session-1:observation:1",
            "session-1:observation:2",
          ],
        },
        observations: [
          expect.objectContaining({ id: "session-1:observation:1" }),
          expect.objectContaining({ id: "session-1:observation:2" }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(appendEntry).not.toHaveBeenCalled();

    resolveReflection(
      reflectionCandidate([
        "session-1:observation:1",
        "session-1:observation:2",
      ]),
    );
    const projected = await projection;

    expect(attributeUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "observational-memory:reflection",
        passId: "session-1:reflection:1",
      }),
    );
    expect(appendEntry).toHaveBeenCalledWith(
      "observational-memory:reflection",
      expect.objectContaining({
        protocol: "observational-memory.reflection",
        version: 1,
        id: "session-1:reflection:1",
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
        reflectedHistory: [
          "HISTORY: Steps 1 and 2 produced durable outcomes with passing tests.",
        ],
      }),
    );
    expect(projected).toHaveLength(1);
    const memoryContent = projectedMemoryContent(projected);
    expect(memoryContent).toContain("HISTORY: Steps 1 and 2");
    expect(memoryContent).toContain("OBSERVATION 3: durable outcome 3.");
    expect(memoryContent).toContain("Question 3");
    expect(memoryContent).not.toContain("OBSERVATION 1:");
    expect(memoryContent).not.toContain("OBSERVATION 2:");
  });
});
