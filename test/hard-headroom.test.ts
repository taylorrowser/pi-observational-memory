import type {
  ContextEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createSessionMemory,
  type ObservationRequest,
  type ObservationResponse,
} from "../src/session-memory.js";
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

function sourceFixture() {
  const messages: ContextEvent["messages"] = [
    { role: "user", content: "Original exact request", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "First complete step" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 2,
    },
    { role: "user", content: "Continue exactly", timestamp: 3 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Second complete step" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 4,
    },
  ];
  const ancestry = messages.map((message, index): SessionEntry => ({
    type: "message",
    id: `entry-${index + 1}`,
    parentId: index === 0 ? null : `entry-${index}`,
    timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
    message,
  }));
  return { messages, ancestry };
}

function validResponse(request: ObservationRequest): ObservationResponse {
  return {
    text: JSON.stringify({
      protocol: "observational-memory.observation",
      version: 1,
      passId: request.passId,
      parentCommitId: request.parentCommitId,
      coverage: { entryIds: request.source.entryIds },
      observations: ["Preserve the exact request and completed work."],
      activeTask: {
        originalIntent: "Complete the exact request.",
        constraints: ["Preserve source."],
        decisions: [],
        verifiedProgress: [],
        currentWork: ["Continue."],
        blockers: [],
        unresolvedQuestions: [],
        nextMove: { owner: "assistant", action: "Continue safely." },
      },
    }),
    usage: zeroUsage,
    provider: request.actor.provider,
    model: request.actor.model,
    stopReason: "stop",
  };
}

const actor = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  contextWindow: 1_100,
  maxTokens: 100,
};

describe("hard headroom", () => {
  it("keeps a raw-hard projection pending, retries the identical frozen pass once, and resumes safely", async () => {
    const { messages, ancestry } = sourceFixture();
    const first = deferred<ObservationResponse>();
    const second = deferred<ObservationResponse>();
    const completeObservation = vi
      .fn<
        (
          request: ObservationRequest,
          signal?: AbortSignal,
        ) => Promise<ObservationResponse>
      >()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const setStatus = vi.fn();
    const abortActor = vi.fn();
    const appendEntry = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) =>
        estimatedMessages.length === 1 &&
        estimatedMessages[0]?.role === "user" &&
        typeof estimatedMessages[0].content === "string" &&
        (estimatedMessages[0].content.startsWith("{") ||
          estimatedMessages[0].content.startsWith("["))
          ? 50
          : estimatedMessages.length * 100,
      completeObservation,
      setStatus,
      abortActor,
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 900,
      fixedInputTokens: 0,
    };

    memory.observe(snapshot);
    const projection = memory.project(snapshot, messages);
    let settled = false;
    void projection.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("waiting for memory");

    first.reject(new Error("transient observer failure"));
    await vi.waitFor(() =>
      expect(completeObservation).toHaveBeenCalledTimes(2),
    );
    expect(completeObservation.mock.calls[1]?.[0]).toBe(
      completeObservation.mock.calls[0]?.[0],
    );
    expect(settled).toBe(false);

    second.resolve(validResponse(completeObservation.mock.calls[1]![0]));
    const projected = await projection;

    expect(projected).not.toBe(messages);
    expect(projected[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("observational-memory"),
      }),
    );
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(abortActor).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("does not cancel session-owned observation when the waiting actor is aborted", async () => {
    const { messages, ancestry } = sourceFixture();
    const observation = deferred<ObservationResponse>();
    let observationSignal: AbortSignal | undefined;
    const completeObservation = vi.fn(
      (request: ObservationRequest, signal?: AbortSignal) => {
        observationSignal = signal;
        return new Promise<ObservationResponse>((resolve, reject) => {
          observation.promise.then(resolve, reject);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const abortActor = vi.fn();
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) =>
        estimatedMessages.length === 1 ? 50 : estimatedMessages.length * 100,
      completeObservation,
      setStatus: vi.fn(),
      abortActor,
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 900,
      fixedInputTokens: 0,
    };
    const sessionController = new AbortController();
    const maintenance = memory.maintain(() => snapshot, sessionController.signal);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());

    const actorController = new AbortController();
    const projection = memory.project(snapshot, messages, actorController.signal);
    actorController.abort("actor stopped");
    const projected = await projection;

    expect(projected).toBe(messages);
    expect(abortActor).toHaveBeenCalledOnce();
    expect(sessionController.signal.aborted).toBe(false);
    expect(observationSignal?.aborted).toBe(false);

    observation.resolve(validResponse(completeObservation.mock.calls[0]![0]));
    await maintenance;
  });

  it("blocks on complete projected-request headroom even when raw pressure is below hard", async () => {
    const { messages, ancestry } = sourceFixture();
    const pending = deferred<ObservationResponse>();
    const completeObservation = vi.fn<
      (request: ObservationRequest, signal?: AbortSignal) => Promise<ObservationResponse>
    >(() => pending.promise);
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) => estimatedMessages.length * 100,
      completeObservation,
      setStatus: vi.fn(),
      abortActor: vi.fn(),
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 500,
      fixedInputTokens: 500,
    };

    const projection = memory.project(snapshot, messages);
    let settled = false;
    void projection.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    const request = completeObservation.mock.calls[0]?.[0];
    if (!request) throw new Error("expected a hard-paused observation request");
    pending.resolve(validResponse(request));

    expect(await projection).not.toBe(messages);
  });

  it("continues eligible serial passes until the complete request is safe", async () => {
    const { messages, ancestry } = sourceFixture();
    const first = deferred<ObservationResponse>();
    const second = deferred<ObservationResponse>();
    const completeObservation = vi
      .fn<
        (
          request: ObservationRequest,
          signal?: AbortSignal,
        ) => Promise<ObservationResponse>
      >()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) => {
        const content =
          estimatedMessages.length === 1 &&
          estimatedMessages[0]?.role === "user" &&
          typeof estimatedMessages[0].content === "string"
            ? estimatedMessages[0].content
            : "";
        return content.startsWith("{") || content.startsWith("[")
          ? 50
          : estimatedMessages.length * 100;
      },
      completeObservation,
      setStatus: vi.fn(),
      abortActor: vi.fn(),
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 500,
      fixedInputTokens: 550,
    };

    const projection = memory.project(snapshot, messages);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    const firstRequest = completeObservation.mock.calls[0]?.[0];
    if (!firstRequest) throw new Error("expected first serial pass");
    first.resolve(validResponse(firstRequest));

    await vi.waitFor(() =>
      expect(completeObservation).toHaveBeenCalledTimes(2),
    );
    expect(completeObservation.mock.calls[1]?.[0].source.entryIds).toEqual([
      "entry-3",
      "entry-4",
    ]);
    const secondRequest = completeObservation.mock.calls[1]?.[0];
    if (!secondRequest) throw new Error("expected second serial pass");
    second.resolve(validResponse(secondRequest));

    const projected = await projection;
    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("observational-memory"),
      }),
    );
  });

  it("does not immediately retry a failed pass below hard pressure", async () => {
    const { ancestry } = sourceFixture();
    const completeObservation = vi.fn(async () => {
      throw new Error("observer unavailable");
    });
    const setStatus = vi.fn();
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) => estimatedMessages.length * 100,
      completeObservation,
      setStatus,
      abortActor: vi.fn(),
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 650,
    };

    memory.observe(snapshot);
    expect(setStatus).toHaveBeenCalledWith("observing");
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith(undefined));

    expect(completeObservation).toHaveBeenCalledOnce();
  });

  it("aborts once after two invalid hard-paused attempts without advancing source coverage", async () => {
    const { messages, ancestry } = sourceFixture();
    const completeObservation = vi.fn(async (request: ObservationRequest) => ({
      ...validResponse(request),
      text: "",
    }));
    const appendEntry = vi.fn();
    const setStatus = vi.fn();
    const abortActor = vi.fn();
    const debugEvent = vi.fn();
    const memory = createSessionMemory(
      {
        appendEntry,
        debugEvent,
        attributeUsage: vi.fn(),
        estimateTokens: (estimatedMessages) => estimatedMessages.length * 250,
        completeObservation,
        setStatus,
        abortActor,
      },
      {
        ...DEFAULT_SETTINGS,
        debugLogging: true,
        messageTokensTarget: 200,
        messageTokensStartObservation: 400,
        observationTokensTarget: 100,
        observationTokensStartReflection: 400,
        reflectionTokensMax: 100,
      },
    );
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 900,
      fixedInputTokens: 0,
    };

    const projected = await memory.project(snapshot, messages);

    expect(completeObservation).toHaveBeenCalledTimes(2);
    expect(completeObservation.mock.calls[1]?.[0]).toBe(
      completeObservation.mock.calls[0]?.[0],
    );
    expect(projected).toBe(messages);
    expect(appendEntry).not.toHaveBeenCalled();
    expect(abortActor).toHaveBeenCalledOnce();
    expect(abortActor).toHaveBeenCalledWith(
      "Observational memory could not restore safe headroom; exact source was preserved. Attempts failed: 1) invalid response (empty output); 2) invalid response (empty output).",
    );
    expect(setStatus).toHaveBeenLastCalledWith(
      "memory stopped — source preserved",
    );
    expect(debugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hard-headroom-terminal",
        operation: "hard-headroom",
        reason: "exhausted",
      }),
    );

    expect(await memory.project(snapshot, messages)).toBe(messages);
    expect(abortActor).toHaveBeenNthCalledWith(2);
  });

  it("reports both classified hard-paused attempt failures without advancing source coverage", async () => {
    const { messages, ancestry } = sourceFixture();
    const first = deferred<ObservationResponse>();
    const completeObservation = vi
      .fn<
        (
          request: ObservationRequest,
          signal?: AbortSignal,
        ) => Promise<ObservationResponse>
      >()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (request) => ({
        ...validResponse(request),
        stopReason: "length",
      }));
    const appendEntry = vi.fn();
    const abortActor = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) => estimatedMessages.length * 250,
      completeObservation,
      setStatus: vi.fn(),
      abortActor,
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 900,
      fixedInputTokens: 0,
    };

    memory.observe(snapshot);
    const projection = memory.project(snapshot, messages);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    first.reject(new Error("observer transport unavailable"));

    expect(await projection).toBe(messages);
    expect(completeObservation).toHaveBeenCalledTimes(2);
    expect(completeObservation.mock.calls[1]?.[0]).toBe(
      completeObservation.mock.calls[0]?.[0],
    );
    expect(appendEntry).not.toHaveBeenCalled();
    expect(abortActor).toHaveBeenCalledWith(
      "Observational memory could not restore safe headroom; exact source was preserved. Attempts failed: 1) exception (Error: observer transport unavailable); 2) invalid response (stop reason: length).",
    );
  });

  it("cancels hard-paused memory visibly and never activates a late response", async () => {
    const { messages, ancestry } = sourceFixture();
    const pending = deferred<ObservationResponse>();
    const completeObservation = vi.fn(
      (_request: ObservationRequest, signal?: AbortSignal) => {
        signal?.addEventListener("abort", () => pending.reject(signal.reason), {
          once: true,
        });
        return pending.promise;
      },
    );
    const appendEntry = vi.fn();
    const abortActor = vi.fn();
    const setStatus = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens: (estimatedMessages) => estimatedMessages.length * 250,
      completeObservation,
      setStatus,
      abortActor,
    });
    const controller = new AbortController();
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 900,
      fixedInputTokens: 0,
    };

    memory.observe(snapshot);
    const projection = memory.project(snapshot, messages, controller.signal);
    await vi.waitFor(() => expect(completeObservation).toHaveBeenCalledOnce());
    controller.abort("user cancelled");

    expect(await projection).toBe(messages);
    expect(completeObservation).toHaveBeenCalledOnce();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(abortActor).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith(
      "memory cancelled — source preserved",
    );
  });
});
