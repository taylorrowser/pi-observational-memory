import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createSessionMemory } from "../src/session-memory.js";

const snapshot = {
  sessionId: "session-1",
  ancestry: [] satisfies SessionEntry[],
};

const messages: ContextEvent["messages"] = [
  {
    role: "user",
    content: "Keep this exact",
    timestamp: 1,
  },
];

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageEntry(
  id: string,
  parentId: string | null,
  message: ContextEvent["messages"][number],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
    message,
  };
}

describe("SessionMemory", () => {
  it("starts one observation without blocking when a complete prefix crosses soft pressure", () => {
    const source: ContextEvent["messages"] = [
      { role: "user", content: "Original request", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "First completed step" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: "Continue", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Recent completed step" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 4,
      },
    ];
    const ancestry = source.map((message, index) =>
      messageEntry(`entry-${index + 1}`, index === 0 ? null : `entry-${index}`, message),
    );
    const pressuredSnapshot = {
      sessionId: "session-1",
      ancestry,
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 1_100,
        maxTokens: 100,
      },
      inputTokens: 650,
    };
    const completeObservation = vi.fn(() => new Promise<never>(() => {}));
    const host = {
      appendEntry() {},
      attributeUsage() {},
      estimateTokens: vi.fn(() => 100),
      completeObservation,
    };
    const memory = createSessionMemory(host);

    const result = memory.observe(pressuredSnapshot);
    memory.observe(pressuredSnapshot);

    expect(result).toBeUndefined();
    expect(completeObservation).toHaveBeenCalledOnce();
    expect(completeObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        pressure: {
          usableInput: 1_000,
          rawTarget: 500,
          soft: 600,
          hard: 850,
          safetyReserve: 150,
          observationOutputBudget: 100,
          observationTarget: 150,
          observationHigh: 250,
          reflectionOutputBudget: 100,
        },
        source: expect.objectContaining({
          entryIds: ["entry-1", "entry-2"],
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("attributes, commits, and replays a valid observation on the next projection", async () => {
    const source: ContextEvent["messages"] = [
      { role: "user", content: "Fix login without changing the public API", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Verified the failing authentication test" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: "Continue with the implementation", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Inspecting src/auth.ts" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 4,
      },
    ];
    const ancestry = source.map((message, index) =>
      messageEntry(`entry-${index + 1}`, index === 0 ? null : `entry-${index}`, message),
    );
    const pressuredSnapshot = {
      sessionId: "session-1",
      ancestry,
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 1_100,
        maxTokens: 100,
      },
      inputTokens: 650,
    };
    const usage = {
      ...zeroUsage,
      input: 40,
      output: 60,
      totalTokens: 100,
      cost: { ...zeroUsage.cost, total: 0.5 },
    };
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const completeObservation = vi.fn(async () => ({
      text: JSON.stringify({
        protocol: "observational-memory.observation",
        version: 1,
        passId: "session-1:observation:1",
        parentCommitId: null,
        coverage: { entryIds: ["entry-1", "entry-2"] },
        observations: [
          "REQUEST: Fix login without changing the public API.",
          "EVIDENCE: authentication test failed at src/auth.ts:42.",
          "STATUS: The fix is proposed, not completed.",
          "UNCERTAINTY: Token refresh behavior remains unverified.",
          "REVERSAL: Abandoned cookie replacement after the failing test.",
          "CONFLICT: Existing docs disagree with runtime behavior.",
          "EXACT: run `npm test -- auth`; error `invalid session`; version 2.4.1.",
        ],
        activeTask: {
          originalIntent: "Fix login without changing the public API.",
          constraints: ["Keep the exported authenticate() signature."],
          decisions: ["Patch token refresh rather than replace cookies."],
          verifiedProgress: [
            {
              claim: "The authentication failure is reproduced.",
              evidence: ["`npm test -- auth` reports `invalid session`."],
            },
          ],
          currentWork: ["Inspecting src/auth.ts token refresh."],
          blockers: ["No refresh-token fixture exists."],
          unresolvedQuestions: ["Does version 2.4.1 rotate refresh tokens?"],
          nextMove: {
            owner: "assistant",
            action: "Add the failing refresh-token fixture.",
          },
        },
      }),
      usage,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "stop" as const,
    }));
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens: () => 100,
      completeObservation,
    });

    memory.restore(pressuredSnapshot);
    memory.observe(pressuredSnapshot);
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
    memory.observe(pressuredSnapshot);
    expect(completeObservation).toHaveBeenCalledOnce();
    expect(appendEntry).not.toHaveBeenCalled();

    const firstProjection = await memory.project(pressuredSnapshot, source);
    const secondProjection = await memory.project(pressuredSnapshot, source);

    expect(attributeUsage).toHaveBeenCalledWith({
      usage,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      operation: "observational-memory:observation",
      passId: "session-1:observation:1",
    });
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      "observational-memory:observation",
      expect.objectContaining({
        protocol: "observational-memory.observation",
        version: 1,
        id: "session-1:observation:1",
        parentCommitId: null,
        coverage: {
          entryIds: ["entry-1", "entry-2"],
          startEntryId: "entry-1",
          endEntryId: "entry-2",
        },
        observations: expect.arrayContaining([
          "REQUEST: Fix login without changing the public API.",
          "EVIDENCE: authentication test failed at src/auth.ts:42.",
          "STATUS: The fix is proposed, not completed.",
          "UNCERTAINTY: Token refresh behavior remains unverified.",
          "REVERSAL: Abandoned cookie replacement after the failing test.",
          "CONFLICT: Existing docs disagree with runtime behavior.",
          "EXACT: run `npm test -- auth`; error `invalid session`; version 2.4.1.",
        ]),
        activeTask: expect.objectContaining({
          originalIntent: "Fix login without changing the public API.",
          constraints: ["Keep the exported authenticate() signature."],
          decisions: ["Patch token refresh rather than replace cookies."],
          verifiedProgress: [
            {
              claim: "The authentication failure is reproduced.",
              evidence: ["`npm test -- auth` reports `invalid session`."],
            },
          ],
          currentWork: ["Inspecting src/auth.ts token refresh."],
          blockers: ["No refresh-token fixture exists."],
          unresolvedQuestions: ["Does version 2.4.1 rotate refresh tokens?"],
          nextMove: {
            owner: "assistant",
            action: "Add the failing refresh-token fixture.",
          },
        }),
        lineage: { parentCommitId: null },
        producer: { provider: "anthropic", model: "claude-sonnet-4-5" },
        usage,
        fidelity: "normal",
        promptVersion: 1,
        validation: expect.objectContaining({ version: 1 }),
      }),
    );
    expect(firstProjection).toHaveLength(3);
    expect(firstProjection[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Fix login without changing the public API."),
      }),
    );
    const projectedMemory = firstProjection[0];
    expect(projectedMemory?.role).toBe("user");
    if (projectedMemory?.role !== "user") throw new Error("expected memory message");
    expect(projectedMemory.content).toContain("`npm test -- auth`");
    expect(firstProjection.slice(1)).toEqual(source.slice(2));
    expect(secondProjection[0]).toEqual(firstProjection[0]);
    expect(secondProjection.slice(1)).toEqual(source.slice(2));
  });

  it("discards a ready observation when its ancestry fence no longer succeeds", async () => {
    const originalMessages: ContextEvent["messages"] = [
      { role: "user", content: "Shared original request", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Completed shared step" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: "Original branch descendant", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Original descendant step" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 4,
      },
    ];
    const originalSnapshot = {
      sessionId: "session-1",
      ancestry: originalMessages.map((message, index) =>
        messageEntry(
          `entry-${index + 1}`,
          index === 0 ? null : `entry-${index}`,
          message,
        ),
      ),
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 1_100,
        maxTokens: 100,
      },
      inputTokens: 650,
    };
    const staleMessages: ContextEvent["messages"] = [
      originalMessages[0]!,
      originalMessages[1]!,
      { role: "user", content: "Sibling branch descendant", timestamp: 5 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Sibling descendant step" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 6,
      },
    ];
    const staleSnapshot = {
      ...originalSnapshot,
      ancestry: [
        originalSnapshot.ancestry[0]!,
        originalSnapshot.ancestry[1]!,
        messageEntry("sibling-3", "entry-2", staleMessages[2]!),
        messageEntry("sibling-4", "sibling-3", staleMessages[3]!),
      ],
    };
    const appendEntry = vi.fn();
    const attributeUsage = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage,
      estimateTokens: () => 100,
      async completeObservation(request) {
        return {
          text: JSON.stringify({
            protocol: "observational-memory.observation",
            version: 1,
            passId: request.passId,
            parentCommitId: null,
            coverage: { entryIds: request.source.entryIds },
            observations: ["REQUEST: Preserve the original branch."],
            activeTask: {
              originalIntent: "Preserve the original branch.",
              constraints: [],
              decisions: [],
              verifiedProgress: [],
              currentWork: [],
              blockers: [],
              unresolvedQuestions: [],
              nextMove: { owner: "assistant", action: "Continue." },
            },
          }),
          usage: zeroUsage,
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          stopReason: "stop",
        };
      },
    });

    memory.observe(originalSnapshot);
    await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
    expect(await memory.project(staleSnapshot, staleMessages)).toBe(staleMessages);
    expect(await memory.project(originalSnapshot, originalMessages)).toBe(originalMessages);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("reconstructs a committed observation, preserves its tail, and continues a sparse audit identity", async () => {
    const firstUser: ContextEvent["messages"][number] = {
      role: "user",
      content: "Original intent",
      timestamp: 1,
    };
    const firstAssistant: ContextEvent["messages"][number] = {
      role: "assistant",
      content: [{ type: "text", text: "Completed old work" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 2,
    };
    const tail: ContextEvent["messages"] = [
      { role: "user", content: "Recent correction", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Current work" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 4,
      },
    ];
    const record = {
      protocol: "observational-memory.observation",
      version: 1,
      id: "session-1:observation:2",
      replayEpoch: "session-1",
      parentCommitId: null,
      coverage: {
        entryIds: ["entry-1", "entry-2"],
        startEntryId: "entry-1",
        endEntryId: "entry-2",
      },
      observations: ["REQUEST: Preserve original intent."],
      activeTask: {
        originalIntent: "Preserve original intent.",
        constraints: [],
        decisions: [],
        verifiedProgress: [
          { claim: "Old work completed.", evidence: ["Assistant response entry-2."] },
        ],
        currentWork: ["Apply the recent correction."],
        blockers: [],
        unresolvedQuestions: [],
        nextMove: { owner: "assistant", action: "Continue current work." },
      },
      lineage: { parentCommitId: null },
      producer: { provider: "anthropic", model: "claude-sonnet-4-5" },
      usage: zeroUsage,
      timestamp: "2026-01-01T00:00:02.000Z",
      fidelity: "normal",
      promptVersion: 1,
      outputEstimate: 40,
      validation: { version: 1, checks: ["contiguous-coverage"] },
    };
    const ancestry: SessionEntry[] = [
      messageEntry("entry-1", null, firstUser),
      messageEntry("entry-2", "entry-1", firstAssistant),
      {
        type: "custom",
        id: "entry-3",
        parentId: "entry-2",
        timestamp: "2026-01-01T00:00:03.000Z",
        customType: "observational-memory:observation",
        data: record,
      },
      messageEntry("entry-4", "entry-3", tail[0]!),
      messageEntry("entry-5", "entry-4", tail[1]!),
    ];
    const reloadedSnapshot = {
      sessionId: "session-1",
      ancestry,
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 1_100,
        maxTokens: 100,
      },
      inputTokens: 650,
    };
    const incoming = [firstUser, firstAssistant, ...tail];
    const completeObservation = vi.fn(() => new Promise<never>(() => {}));
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      completeObservation,
    });

    memory.restore(reloadedSnapshot);
    const projected = await memory.project(reloadedSnapshot, incoming);

    expect(projected).toHaveLength(3);
    expect(projected[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Preserve original intent."),
      }),
    );
    expect(projected.slice(1)).toEqual(tail);

    memory.observe(reloadedSnapshot);
    expect(completeObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        passId: "session-1:observation:3",
        parentCommitId: "session-1:observation:2",
        activeMemory: expect.objectContaining({
          observations: ["REQUEST: Preserve original intent."],
          activeTask: expect.objectContaining({
            originalIntent: "Preserve original intent.",
          }),
        }),
        source: expect.objectContaining({ entryIds: ["entry-4", "entry-5"] }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("replays observations separated by observational-memory debug events", () => {
    const firstUser = { role: "user" as const, content: "First request", timestamp: 1 };
    const firstAssistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "First completed step" }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: 2,
    };
    const secondUser = { role: "user" as const, content: "Second request", timestamp: 3 };
    const secondAssistant = {
      ...firstAssistant,
      content: [{ type: "text" as const, text: "Second completed step" }],
      timestamp: 4,
    };
    const observation = (
      ordinal: number,
      parentCommitId: string | null,
      entryIds: string[],
    ) => ({
      protocol: "observational-memory.observation",
      version: 1,
      id: `session-1:observation:${ordinal}`,
      replayEpoch: "session-1",
      parentCommitId,
      coverage: {
        entryIds,
        startEntryId: entryIds[0],
        endEntryId: entryIds.at(-1),
      },
      observations: [`Completed observation ${ordinal}.`],
      activeTask: {
        originalIntent: "Complete both requests.",
        constraints: [],
        decisions: [],
        verifiedProgress: [],
        currentWork: [],
        blockers: [],
        unresolvedQuestions: [],
        nextMove: { owner: "assistant", action: "Continue." },
      },
      lineage: { parentCommitId },
      producer: { provider: "anthropic", model: "claude-sonnet-4-5" },
      usage: zeroUsage,
      timestamp: `2026-01-01T00:00:0${ordinal + 2}.000Z`,
      fidelity: "normal",
      promptVersion: 1,
      outputEstimate: 10,
      validation: { version: 1, checks: ["contiguous-coverage"] },
    });
    const ancestry: SessionEntry[] = [
      messageEntry("entry-1", null, firstUser),
      messageEntry("entry-2", "entry-1", firstAssistant),
      {
        type: "custom",
        id: "entry-3",
        parentId: "entry-2",
        timestamp: "2026-01-01T00:00:03.000Z",
        customType: "observational-memory:observation",
        data: observation(1, null, ["entry-1", "entry-2"]),
      },
      {
        type: "custom",
        id: "entry-4",
        parentId: "entry-3",
        timestamp: "2026-01-01T00:00:04.000Z",
        customType: "observational-memory:event",
        data: { event: "observation-activated" },
      },
      messageEntry("entry-5", "entry-4", secondUser),
      messageEntry("entry-6", "entry-5", secondAssistant),
      {
        type: "custom",
        id: "entry-7",
        parentId: "entry-6",
        timestamp: "2026-01-01T00:00:07.000Z",
        customType: "observational-memory:observation",
        data: observation(2, "session-1:observation:1", ["entry-5", "entry-6"]),
      },
    ];
    const restoredSnapshot = { sessionId: "session-1", ancestry };
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 100,
      completeObservation: vi.fn(() => new Promise<never>(() => {})),
    });

    memory.restore(restoredSnapshot);

    expect(memory.inspect(restoredSnapshot).metrics.observations.count).toBe(2);
    expect(memory.inspect(restoredSnapshot).metrics.messages.tokens).toBe(0);
  });

  it("projects covered Pi-derived messages without duplication", async () => {
    const user = { role: "user" as const, content: "Original intent", timestamp: 1 };
    const derived = {
      role: "custom" as const,
      customType: "orientation",
      content: "Derived branch orientation",
      display: false,
      details: undefined,
      timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
    };
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Completed step" }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: 3,
    };
    const record = {
      protocol: "observational-memory.observation",
      version: 1,
      id: "session-1:observation:1",
      replayEpoch: "session-1",
      parentCommitId: null,
      coverage: {
        entryIds: ["entry-1", "entry-2", "entry-3"],
        startEntryId: "entry-1",
        endEntryId: "entry-3",
      },
      observations: ["ORIENTATION: Derived branch orientation is not exact evidence."],
      activeTask: {
        originalIntent: "Preserve original intent.",
        constraints: [],
        decisions: [],
        verifiedProgress: [],
        currentWork: [],
        blockers: [],
        unresolvedQuestions: [],
        nextMove: { owner: "assistant", action: "Continue." },
      },
      lineage: { parentCommitId: null },
      producer: { provider: "anthropic", model: "claude-sonnet-4-5" },
      usage: zeroUsage,
      timestamp: "2026-01-01T00:00:03.000Z",
      fidelity: "normal",
      promptVersion: 1,
      outputEstimate: 20,
      validation: { version: 1, checks: ["contiguous-coverage"] },
    };
    const ancestry: SessionEntry[] = [
      messageEntry("entry-1", null, user),
      {
        type: "custom_message",
        id: "entry-2",
        parentId: "entry-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        customType: "orientation",
        content: "Derived branch orientation",
        display: false,
      },
      messageEntry("entry-3", "entry-2", assistant),
      {
        type: "custom",
        id: "entry-4",
        parentId: "entry-3",
        timestamp: "2026-01-01T00:00:04.000Z",
        customType: "observational-memory:observation",
        data: record,
      },
    ];
    const reloadedSnapshot = { sessionId: "session-1", ancestry };
    const incoming: ContextEvent["messages"] = [user, derived, assistant];
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 0,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
    });

    memory.restore(reloadedSnapshot);
    const projected = await memory.project(reloadedSnapshot, incoming);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Derived branch orientation is not exact evidence."),
      }),
    );
  });

  it.each([
    ["malformed", { protocol: "observational-memory.observation", version: 1 }],
    ["unsupported", { protocol: "observational-memory.observation", version: 2 }],
  ])("ignores %s persisted observation records", async (_case, data) => {
    const source: ContextEvent["messages"] = [
      { role: "user", content: "Canonical source", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Exact tail" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 2,
      },
    ];
    const ancestry: SessionEntry[] = [
      messageEntry("entry-1", null, source[0]!),
      messageEntry("entry-2", "entry-1", source[1]!),
      {
        type: "custom",
        id: "entry-3",
        parentId: "entry-2",
        timestamp: "2026-01-01T00:00:03.000Z",
        customType: "observational-memory:observation",
        data,
      },
    ];
    const snapshotWithInvalidRecord = { sessionId: "session-1", ancestry };
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 0,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
    });

    memory.restore(snapshotWithInvalidRecord);

    expect(await memory.project(snapshotWithInvalidRecord, source)).toBe(source);
  });

  it.each([
    ["empty", "", "stop", false],
    ["truncated", "candidate", "length", false],
    ["cancelled", "candidate", "aborted", false],
    ["malformed", "not-json", "stop", false],
    ["over-budget", "valid", "stop", true],
    ["mis-parented", "mis-parented", "stop", false],
    ["non-contiguous", "non-contiguous", "stop", false],
    ["incomplete anchor", "incomplete-anchor", "stop", false],
  ] as const)(
    "attributes but does not activate %s observation output",
    async (_case, candidateKind, stopReason, overBudget) => {
      const source: ContextEvent["messages"] = [
        { role: "user", content: "Original request", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Completed step" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: 2,
        },
      ];
      const ancestry = source.map((message, index) =>
        messageEntry(`entry-${index + 1}`, index === 0 ? null : `entry-${index}`, message),
      );
      const pressuredSnapshot = {
        sessionId: "session-1",
        ancestry,
        actor: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          contextWindow: 1_100,
          maxTokens: 100,
        },
        inputTokens: 650,
      };
      const candidate = {
        protocol: "observational-memory.observation",
        version: 1,
        passId: "session-1:observation:1",
        parentCommitId: candidateKind === "mis-parented" ? "wrong-parent" : null,
        coverage: {
          entryIds:
            candidateKind === "non-contiguous"
              ? ["entry-2", "entry-1"]
              : ["entry-1", "entry-2"],
        },
        observations: ["REQUEST: Preserve the original request."],
        activeTask: {
          originalIntent: "Preserve the original request.",
          constraints: [],
          decisions: [],
          verifiedProgress: [],
          currentWork: [],
          blockers: [],
          unresolvedQuestions: [],
          ...(candidateKind === "incomplete-anchor"
            ? {}
            : { nextMove: { owner: "assistant", action: "Continue." } }),
        },
      };
      const text =
        candidateKind === "valid" ||
        candidateKind === "mis-parented" ||
        candidateKind === "non-contiguous" ||
        candidateKind === "incomplete-anchor"
          ? JSON.stringify(candidate)
          : candidateKind;
      const appendEntry = vi.fn();
      const attributeUsage = vi.fn();
      const memory = createSessionMemory({
        appendEntry,
        attributeUsage,
        estimateTokens(messagesToEstimate) {
          const first = messagesToEstimate[0];
          return overBudget && first?.role === "user" && first.content === text ? 101 : 100;
        },
        async completeObservation() {
          return {
            text,
            usage: zeroUsage,
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            stopReason,
          };
        },
      });

      memory.observe(pressuredSnapshot);
      await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
      const projected = await memory.project(pressuredSnapshot, source);

      expect(appendEntry).not.toHaveBeenCalled();
      expect(projected).toBe(source);
    },
  );

  it("freezes complete tool-call batches in source order without descendant growth", () => {
    const user = messageEntry("entry-1", null, {
      role: "user",
      content: "Run both checks",
      timestamp: 1,
    });
    const assistant = messageEntry("entry-2", "entry-1", {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "a" } },
        { type: "toolCall", id: "call-b", name: "bash", arguments: { command: "b" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    const resultB = messageEntry("entry-3", "entry-2", {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "bash",
      content: [{ type: "text", text: "b passed" }],
      isError: false,
      timestamp: 3,
    });
    const resultA = messageEntry("entry-4", "entry-3", {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "bash",
      content: [{ type: "text", text: "a failed" }],
      isError: true,
      timestamp: 4,
    });
    const recentUser = messageEntry("entry-5", "entry-4", {
      role: "user",
      content: "Use the failure as evidence",
      timestamp: 5,
    });
    const recentAssistant = messageEntry("entry-6", "entry-5", {
      role: "assistant",
      content: [{ type: "text", text: "Investigating" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 6,
    });
    const actor = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      contextWindow: 1_100,
      maxTokens: 100,
    };
    const completeObservation = vi.fn(() => new Promise<never>(() => {}));
    const memory = createSessionMemory({
      appendEntry() {},
      attributeUsage() {},
      estimateTokens: () => 100,
      completeObservation,
    });

    memory.observe({
      sessionId: "session-1",
      ancestry: [user, assistant, resultB],
      actor,
      inputTokens: 650,
    });
    expect(completeObservation).not.toHaveBeenCalled();

    const completedSnapshot = {
      sessionId: "session-1",
      ancestry: [user, assistant, resultB, resultA, recentUser, recentAssistant],
      actor,
      inputTokens: 650,
    };
    memory.observe(completedSnapshot);
    memory.observe({
      ...completedSnapshot,
      ancestry: [
        ...completedSnapshot.ancestry,
        messageEntry("entry-7", "entry-6", {
          role: "user",
          content: "A later descendant",
          timestamp: 7,
        }),
        messageEntry("entry-8", "entry-7", {
          role: "assistant",
          content: [{ type: "text", text: "Later work remains exact" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: 8,
        }),
      ],
    });

    expect(completeObservation).toHaveBeenCalledOnce();
    expect(completeObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          entryIds: ["entry-1", "entry-2", "entry-3", "entry-4"],
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("keeps below-pressure context exact without model or persisted effects", async () => {
    const entries: Array<{ customType: string; data: unknown }> = [];
    const completeObservation = vi.fn(() => new Promise<never>(() => {}));
    const memory = createSessionMemory({
      appendEntry(customType, data) {
        entries.push({ customType, data });
      },
      attributeUsage() {},
      estimateTokens() {
        return 0;
      },
      completeObservation,
    });
    const belowPressureSnapshot = {
      ...snapshot,
      ancestry: [messageEntry("entry-1", null, messages[0]!)],
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 1_100,
        maxTokens: 100,
      },
      inputTokens: 599,
    };

    memory.restore(belowPressureSnapshot);
    memory.observe(belowPressureSnapshot);
    const projected = await memory.project(belowPressureSnapshot, messages);
    memory.dispose();

    expect(projected).toBe(messages);
    expect(completeObservation).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });
});
