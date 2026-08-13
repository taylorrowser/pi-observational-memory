import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createSessionMemory } from "../src/session-memory.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};
const actor = {
  provider: "anthropic",
  model: "observer",
  contextWindow: 10_000,
  maxTokens: 1_000,
};

function history(count: number) {
  const ancestry: SessionEntry[] = [];
  const messages: ContextEvent["messages"] = [];
  let parentId: string | null = null;
  for (let index = 1; index <= count; index += 1) {
    const user = { role: "user" as const, content: `request ${index}`, timestamp: index };
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `result ${index}` }],
      api: "anthropic-messages" as const,
      provider: actor.provider,
      model: actor.model,
      usage,
      stopReason: "stop" as const,
      timestamp: index + 0.5,
    };
    ancestry.push({
      type: "message",
      id: `user-${index}`,
      parentId,
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
      message: user,
    });
    ancestry.push({
      type: "message",
      id: `assistant-${index}`,
      parentId: `user-${index}`,
      timestamp: `2026-01-01T00:00:0${index}.500Z`,
      message: assistant,
    });
    parentId = `assistant-${index}`;
    messages.push(user, assistant);
  }
  return { ancestry, messages };
}

function candidate(request: Parameters<NonNullable<Parameters<typeof createSessionMemory>[0]["completeObservation"]>>[0]) {
  return {
    text: JSON.stringify({
      protocol: "observational-memory.observation",
      version: 1,
      passId: request.passId,
      parentCommitId: request.parentCommitId,
      coverage: { entryIds: request.source.entryIds },
      observations: [`Observed ${request.source.entryIds.join(", ")}`],
      activeTask: {
        originalIntent: "Finish the work.",
        constraints: [], decisions: [],
        verifiedProgress: [{ claim: "A step completed.", evidence: ["fixture"] }],
        currentWork: ["Continue."], blockers: [], unresolvedQuestions: [],
        nextMove: { owner: "assistant", action: "Continue." },
      },
    }),
    usage,
    provider: actor.provider,
    model: actor.model,
    stopReason: "stop" as const,
  };
}

describe("SessionMemory control plane", () => {
  it("forces observations to the configured message target and stops there", async () => {
    const source = history(3);
    const appendEntry = vi.fn();
    const completeObservation = vi.fn(async (request) => candidate(request));
    const settings = {
      ...DEFAULT_SETTINGS,
      messageTokensTarget: 200,
      messageTokensStartObservation: 400,
      observationTokensTarget: 100,
      observationTokensStartReflection: 1_000,
    };
    const memory = createSessionMemory(
      {
        appendEntry,
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation,
      },
      settings,
    );
    const snapshot = { sessionId: "session-1", ancestry: source.ancestry, actor, inputTokens: 600 };
    memory.restore(snapshot);

    const result = await memory.compact(snapshot);

    expect(result.observationsCreated).toBe(1);
    expect(result.inspection.metrics.messages.tokens).toBe(200);
    expect(completeObservation).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      "observational-memory:observation",
      expect.objectContaining({ coverage: { entryIds: ["user-1", "assistant-1", "user-2", "assistant-2"], startEntryId: "user-1", endEntryId: "assistant-2" } }),
    );
  });

  it("does not start ambient observation before uncovered messages reach their threshold", () => {
    const source = history(1);
    const completeObservation = vi.fn(async (request) => candidate(request));
    const memory = createSessionMemory(
      {
        appendEntry: vi.fn(),
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation,
      },
      {
        ...DEFAULT_SETTINGS,
        messageTokensTarget: 200,
        messageTokensStartObservation: 400,
        observationTokensStartReflection: 10_000,
      },
    );
    const snapshot = {
      sessionId: "session-1",
      ancestry: source.ancestry,
      actor,
      // Fixed prompts and tool schemas can put the complete actor request over
      // the configured message threshold while uncovered messages remain below it.
      inputTokens: 600,
    };
    memory.restore(snapshot);
    expect(memory.inspect(snapshot).metrics.messages.tokens).toBe(200);

    memory.observe(snapshot);

    expect(completeObservation).not.toHaveBeenCalled();
  });

  it("does not emit lifecycle telemetry when debug logging is disabled", async () => {
    const source = history(2);
    const debugEvent = vi.fn();
    const memory = createSessionMemory(
      {
        appendEntry: vi.fn(),
        debugEvent,
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation: async (request) => candidate(request),
      },
      {
        ...DEFAULT_SETTINGS,
        messageTokensTarget: 200,
        messageTokensStartObservation: 400,
      },
    );
    const snapshot = { sessionId: "session-1", ancestry: source.ancestry, actor };
    memory.restore(snapshot);

    await memory.maintain(() => snapshot);

    expect(debugEvent).not.toHaveBeenCalled();
  });

  it("logs and announces an observation start with its triggering message metric in debug mode", async () => {
    const source = history(2);
    const debugEvent = vi.fn();
    const completeObservation = vi.fn(async (request) => candidate(request));
    const memory = createSessionMemory(
      {
        appendEntry: vi.fn(),
        debugEvent,
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation,
      },
      {
        ...DEFAULT_SETTINGS,
        debugLogging: true,
        messageTokensTarget: 200,
        messageTokensStartObservation: 400,
        observationTokensStartReflection: 10_000,
      },
    );
    const snapshot = {
      sessionId: "session-1",
      ancestry: source.ancestry,
      actor,
      inputTokens: 600,
    };
    memory.restore(snapshot);

    memory.observe(snapshot);

    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    await memory.maintain(() => snapshot);
    expect(debugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "observational-memory.event",
        version: 1,
        event: "observation-started",
        operation: "observation",
        reason: "ambient-threshold",
        sessionId: "session-1",
        passId: expect.any(String),
        metrics: expect.objectContaining({
          messages: { tokens: 400, threshold: 400, target: 200 },
        }),
        coverage: { entryCount: 2 },
      }),
    );
    expect(debugEvent.mock.calls.map(([event]) => event.event)).toEqual([
      "observation-started",
      "observation-ready",
      "maintenance-requested",
      "maintenance-started",
      "observation-activated",
      "maintenance-completed",
    ]);
  });

  it("records the bounded owner reason when background maintenance is cancelled", async () => {
    const source = history(2);
    const debugEvent = vi.fn();
    const completeObservation = vi.fn(
      (_request: unknown, signal?: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const memory = createSessionMemory(
      {
        appendEntry: vi.fn(),
        debugEvent,
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation,
      },
      {
        ...DEFAULT_SETTINGS,
        debugLogging: true,
        messageTokensTarget: 200,
        messageTokensStartObservation: 400,
      },
    );
    const snapshot = { sessionId: "session-1", ancestry: source.ancestry, actor };
    memory.restore(snapshot);
    const controller = new AbortController();

    const maintenance = memory.maintain(() => snapshot, controller.signal);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    controller.abort("idle-escape");
    await maintenance;

    expect(debugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "observation-cancelled",
        reason: "idle-escape",
      }),
    );
    expect(debugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "maintenance-cancelled",
        reason: "idle-escape",
      }),
    );
  });

  it("excludes debug telemetry from observer source and actor projection", async () => {
    const source = history(2);
    const debugEntry: SessionEntry = {
      type: "custom",
      id: "debug-event",
      parentId: "assistant-2",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "observational-memory:event",
      data: {
        protocol: "observational-memory.event",
        version: 1,
        event: "observation-started",
        operation: "observation",
        reason: "ambient-threshold",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        metrics: {},
      },
    };
    const ancestry = [...source.ancestry, debugEntry];
    const completeObservation = vi.fn(async (request) => candidate(request));
    const memory = createSessionMemory(
      {
        appendEntry: vi.fn(),
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation,
      },
      {
        ...DEFAULT_SETTINGS,
        messageTokensTarget: 200,
        messageTokensStartObservation: 400,
      },
    );
    const snapshot = { sessionId: "session-1", ancestry, actor };
    memory.restore(snapshot);

    memory.observe(snapshot);

    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    const request = completeObservation.mock.calls[0]?.[0];
    expect(request?.source.entryIds).not.toContain("debug-event");
    expect(request?.source.entries).not.toContainEqual(debugEntry);
    await memory.maintain(() => snapshot);
    await expect(memory.project(snapshot, source.messages)).resolves.not.toContainEqual(
      expect.objectContaining({ content: expect.stringContaining("observation-started") }),
    );
  });

  it("starts another ambient observation when the uncovered message layer reaches its threshold", async () => {
    const initial = history(3);
    const expanded = history(4);
    const completeObservation = vi.fn(async (request) => candidate(request));
    const settings = {
      ...DEFAULT_SETTINGS,
      messageTokensTarget: 200,
      messageTokensStartObservation: 400,
      observationTokensStartReflection: 10_000,
    };
    const memory = createSessionMemory(
      {
        appendEntry: vi.fn(),
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation,
      },
      settings,
    );
    const initialSnapshot = {
      sessionId: "session-1",
      ancestry: initial.ancestry,
      actor,
      inputTokens: 600,
    };
    memory.restore(initialSnapshot);
    await memory.compact(initialSnapshot);

    const expandedSnapshot = {
      sessionId: "session-1",
      ancestry: expanded.ancestry,
      actor,
      // Pi reports projected actor context here, which can remain below the
      // threshold while the exact uncovered source grows beyond it.
      inputTokens: 250,
    };
    expect(memory.inspect(expandedSnapshot).metrics.messages.percent).toBe(100);

    memory.observe(expandedSnapshot);

    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledTimes(2));
  });

  it("serially catches up observations and then reflects in background", async () => {
    const source = history(3);
    const appendEntry = vi.fn();
    const completeObservation = vi.fn(async (request) => candidate(request));
    const completeReflection = vi.fn(async (request) => ({
      text: JSON.stringify({
        protocol: "observational-memory.reflection",
        version: 1,
        passId: request.passId,
        parentReflectionId: request.parentReflection?.id ?? null,
        coverage: { observationIds: request.coverage.observationIds },
        reflectedHistory: ["Folded durable history."],
      }),
      usage,
      provider: actor.provider,
      model: actor.model,
      stopReason: "stop" as const,
    }));
    const memory = createSessionMemory(
      {
        appendEntry,
        estimateTokens(messages) {
          return messages.length * 100;
        },
        completeObservation,
        completeReflection,
      },
      {
        ...DEFAULT_SETTINGS,
        messageTokensTarget: 200,
        messageTokensStartObservation: 400,
        observationTokensTarget: 50,
        observationTokensStartReflection: 100,
      },
    );
    const snapshot = {
      sessionId: "session-1",
      ancestry: source.ancestry,
      actor,
      inputTokens: 600,
    };
    memory.restore(snapshot);

    const result = await memory.maintain(() => snapshot);

    expect(result.observationsCreated).toBe(1);
    expect(result.reflectionsCreated).toBe(1);
    expect(completeObservation).toHaveBeenCalledOnce();
    expect(completeReflection).toHaveBeenCalledOnce();
    expect(appendEntry.mock.calls.map(([type]) => type)).toEqual([
      "observational-memory:observation",
      "observational-memory:reflection",
    ]);
  });

  it("disabling preserves exact source and enabling restores projection", async () => {
    const source = history(3);
    const memory = createSessionMemory(
      {
        appendEntry: vi.fn(),
        estimateTokens(messages) { return messages.length * 100; },
        async completeObservation(request) { return candidate(request); },
      },
      { ...DEFAULT_SETTINGS, messageTokensTarget: 200, messageTokensStartObservation: 400, observationTokensStartReflection: 10_000 },
    );
    const snapshot = { sessionId: "session-1", ancestry: source.ancestry, actor, inputTokens: 600 };
    memory.restore(snapshot);
    await memory.compact(snapshot);

    const enabledProjection = await memory.project(snapshot, source.messages);
    memory.setEnabled(false);
    expect(await memory.project(snapshot, source.messages)).toEqual(enabledProjection);
    memory.setEnabled(true);
    const projected = await memory.project(snapshot, source.messages);
    expect(projected).toEqual(enabledProjection);
    expect(JSON.stringify(projected)).toContain("observational-memory");
  });

  it("appends replay-safe corrections for observations", async () => {
    const source = history(3);
    const appendEntry = vi.fn();
    const settings = { ...DEFAULT_SETTINGS, messageTokensTarget: 200, messageTokensStartObservation: 400, observationTokensStartReflection: 10_000 };
    const host = {
      appendEntry,
      estimateTokens(messages: ContextEvent["messages"]) { return messages.length * 100; },
      async completeObservation(request: Parameters<NonNullable<Parameters<typeof createSessionMemory>[0]["completeObservation"]>>[0]) { return candidate(request); },
    };
    const memory = createSessionMemory(host, settings);
    const snapshot = { sessionId: "session-1", ancestry: source.ancestry, actor, inputTokens: 600 };
    memory.restore(snapshot);
    await memory.compact(snapshot);
    const id = memory.inspect(snapshot).observations[0]!.id;

    memory.editObservation(id, ["Corrected durable fact."]);

    expect(memory.inspect(snapshot).observations[0]?.observations).toEqual(["Corrected durable fact."]);
    expect(appendEntry).toHaveBeenLastCalledWith(
      "observational-memory:observation-edit",
      expect.objectContaining({ targetId: id, observations: ["Corrected durable fact."] }),
    );
  });
});
