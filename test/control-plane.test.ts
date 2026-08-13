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
