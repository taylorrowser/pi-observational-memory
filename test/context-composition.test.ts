import type {
  ContextEvent,
  SessionEntry,
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

function messageEntry(
  id: string,
  parentId: string | null,
  message: ContextEvent["messages"][number],
): SessionEntry {
  const ordinal = id.split("-").at(-1) ?? "0";
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:${ordinal.padStart(2, "0")}.000Z`,
    message,
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
      observations: ["The original exact request has one completed step."],
      activeTask: {
        originalIntent: "Continue the original exact request.",
        constraints: ["Preserve third-party context."],
        decisions: [],
        verifiedProgress: [],
        currentWork: ["Continue with the exact tail."],
        blockers: [],
        unresolvedQuestions: [],
        nextMove: { owner: "assistant", action: "Continue safely." },
      },
    }),
    usage: zeroUsage,
    provider: request.actor.provider,
    model: request.actor.model,
    stopReason: "stop" as const,
  };
}

function committedFixture() {
  const covered: ContextEvent["messages"] = [
    { role: "user", content: "Original exact request", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Completed exact step" }],
      api: "anthropic-messages",
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 2,
    },
  ];
  const tail: ContextEvent["messages"] = [
    { role: "user", content: "Continue with the tail", timestamp: 3 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Current exact work" }],
      api: "anthropic-messages",
      provider: actor.provider,
      model: actor.model,
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 4,
    },
  ];
  const record = {
    protocol: "observational-memory.observation",
    version: 1,
    id: "session-1:observation:1",
    replayEpoch: "session-1",
    parentCommitId: null,
    coverage: {
      entryIds: ["entry-1", "entry-2"],
      startEntryId: "entry-1",
      endEntryId: "entry-2",
    },
    observations: ["The original exact request has one completed step."],
    activeTask: {
      originalIntent: "Continue the original exact request.",
      constraints: ["Preserve third-party context."],
      decisions: [],
      verifiedProgress: [],
      currentWork: ["Continue with the exact tail."],
      blockers: [],
      unresolvedQuestions: [],
      nextMove: { owner: "assistant", action: "Continue safely." },
    },
    lineage: { parentCommitId: null },
    producer: { provider: actor.provider, model: actor.model },
    usage: zeroUsage,
    timestamp: "2026-01-01T00:00:02.000Z",
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate: 20,
    validation: { version: 1, checks: ["contiguous-coverage"] },
  };
  const ancestry: SessionEntry[] = [
    messageEntry("entry-1", null, covered[0]!),
    messageEntry("entry-2", "entry-1", covered[1]!),
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
  return { covered, tail, ancestry };
}

function rewrittenContext(
  covered: ContextEvent["messages"],
  tail: ContextEvent["messages"],
): ContextEvent["messages"] {
  return [
    {
      role: "user",
      content: "Rewritten by another extension",
      timestamp: 1,
    },
    covered[1]!,
    ...tail,
  ];
}

async function readyCompositionFixture(
  inputTokens: number,
  tokensPerMessage: number,
) {
  const { covered, tail } = committedFixture();
  const source = [...covered, ...tail];
  const ancestry = source.map((message, index) =>
    messageEntry(
      `entry-${index + 1}`,
      index === 0 ? null : `entry-${index}`,
      message,
    ),
  );
  const appendEntry = vi.fn();
  const abortActor = vi.fn();
  const attributeUsage = vi.fn();
  const completeObservation = vi.fn(async (request: ObservationRequest) =>
    validObservation(request),
  );
  const memory = createSessionMemory({
    appendEntry,
    attributeUsage,
    estimateTokens: (messages) =>
      messages.length === 1 &&
      messages[0]?.role === "user" &&
      typeof messages[0].content === "string" &&
      messages[0].content.startsWith("{")
        ? 20
        : messages.length * tokensPerMessage,
    completeObservation,
    abortActor,
  });
  const snapshot = {
    sessionId: "session-1",
    ancestry,
    actor,
    inputTokens,
  };
  memory.restore(snapshot);
  memory.observe(snapshot);
  await vi.waitFor(() => expect(attributeUsage).toHaveBeenCalledOnce());
  return {
    memory,
    snapshot,
    incoming: rewrittenContext(covered, tail),
    appendEntry,
    abortActor,
    completeObservation,
  };
}

describe("context-extension composition", () => {
  it("replaces one exact covered baseline sequence and retains surrounding extension messages", async () => {
    const { covered, tail, ancestry } = committedFixture();
    const insertedBefore = {
      role: "user" as const,
      content: "Inserted before covered source",
      timestamp: 10,
    };
    const insertedAfterCoverage = {
      role: "user" as const,
      content: "Inserted between coverage and tail",
      timestamp: 11,
    };
    const insertedInsideTail = {
      role: "user" as const,
      content: "Inserted inside the uncovered tail",
      timestamp: 12,
    };
    const insertedAfterTail = {
      role: "user" as const,
      content: "Inserted after the exact tail",
      timestamp: 13,
    };
    const incoming: ContextEvent["messages"] = [
      insertedBefore,
      ...covered,
      insertedAfterCoverage,
      tail[0]!,
      insertedInsideTail,
      tail[1]!,
      insertedAfterTail,
    ];
    const memory = createSessionMemory({
      appendEntry: vi.fn(),
      attributeUsage: vi.fn(),
      estimateTokens: () => 0,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
    });
    const snapshot = { sessionId: "session-1", ancestry };
    memory.restore(snapshot);

    const first = await memory.project(snapshot, incoming);
    const second = await memory.project(snapshot, incoming);

    expect(first).toHaveLength(7);
    expect(first[0]).toBe(insertedBefore);
    expect(first[1]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("<observational-memory version=\"1\">"),
      }),
    );
    expect(first.slice(2)).toEqual([
      insertedAfterCoverage,
      tail[0],
      insertedInsideTail,
      tail[1],
      insertedAfterTail,
    ]);
    expect(second).toEqual(first);
    expect(
      first.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("<observational-memory"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    [
      "rewritten",
      (covered: ContextEvent["messages"], tail: ContextEvent["messages"]) => [
        {
          role: "user" as const,
          content: "Rewritten by another extension",
          timestamp: 1,
        },
        covered[1]!,
        ...tail,
      ],
    ],
    [
      "missing",
      (covered: ContextEvent["messages"], tail: ContextEvent["messages"]) => [
        covered[1]!,
        ...tail,
      ],
    ],
    [
      "duplicated",
      (covered: ContextEvent["messages"], tail: ContextEvent["messages"]) => [
        ...covered,
        ...covered,
        ...tail,
      ],
    ],
    [
      "reordered",
      (covered: ContextEvent["messages"], tail: ContextEvent["messages"]) => [
        covered[1]!,
        covered[0]!,
        ...tail,
      ],
    ],
    [
      "interleaved",
      (covered: ContextEvent["messages"], tail: ContextEvent["messages"]) => [
        covered[0]!,
        {
          role: "user" as const,
          content: "Inserted inside covered source",
          timestamp: 20,
        },
        covered[1]!,
        ...tail,
      ],
    ],
  ])(
    "preserves the exact incoming context below hard pressure when covered source is %s",
    async (_case, incomingContext) => {
      const { covered, tail, ancestry } = committedFixture();
      const incoming = incomingContext(covered, tail);
      const appendEntry = vi.fn();
      const abortActor = vi.fn();
      const memory = createSessionMemory({
        appendEntry,
        attributeUsage: vi.fn(),
        estimateTokens: () => 10,
        async completeObservation() {
          throw new Error("unexpected observation");
        },
        abortActor,
      });
      const snapshot = {
        sessionId: "session-1",
        ancestry,
        actor,
        inputTokens: 100,
      };
      memory.restore(snapshot);

      expect(await memory.project(snapshot, incoming)).toBe(incoming);
      expect(appendEntry).not.toHaveBeenCalled();
      expect(abortActor).not.toHaveBeenCalled();
    },
  );

  it("does not reflect committed observations whose covered baseline is ambiguous", async () => {
    const { covered, tail, ancestry } = committedFixture();
    const incoming = rewrittenContext(covered, tail);
    const appendEntry = vi.fn();
    const completeReflection = vi.fn(async () => {
      throw new Error("ambiguous coverage must not be reflected");
    });
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens: (messages) =>
        messages.length === 1 &&
        messages[0]?.role === "user" &&
        typeof messages[0].content === "string" &&
        messages[0].content.startsWith("[")
          ? 300
          : messages.length * 10,
      async completeObservation() {
        throw new Error("unexpected observation");
      },
      completeReflection,
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 100,
    };
    memory.restore(snapshot);

    expect(await memory.project(snapshot, incoming)).toBe(incoming);
    expect(completeReflection).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("does not activate ready coverage when another extension rewrote its baseline source", async () => {
    const { memory, snapshot, incoming, appendEntry, abortActor } =
      await readyCompositionFixture(650, 100);

    expect(await memory.project(snapshot, incoming)).toBe(incoming);
    expect(appendEntry).not.toHaveBeenCalled();
    expect(abortActor).not.toHaveBeenCalled();
  });

  it("stops hard pressure without launching more work when ready coverage cannot compose", async () => {
    const {
      memory,
      snapshot,
      incoming,
      appendEntry,
      abortActor,
      completeObservation,
    } = await readyCompositionFixture(900, 250);

    expect(await memory.project(snapshot, incoming)).toBe(incoming);
    expect(completeObservation).toHaveBeenCalledOnce();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(abortActor).toHaveBeenCalledOnce();
  });

  it("stops immediately at hard pressure when covered baseline source was rewritten", async () => {
    const { covered, tail, ancestry } = committedFixture();
    const incoming = rewrittenContext(covered, tail);
    const completeObservation = vi.fn(async () => {
      throw new Error("ambiguous composition must not launch memory work");
    });
    const appendEntry = vi.fn();
    const abortActor = vi.fn();
    const setStatus = vi.fn();
    const memory = createSessionMemory({
      appendEntry,
      attributeUsage: vi.fn(),
      estimateTokens: (messages) =>
        messages.length === 1 &&
        messages[0]?.role === "user" &&
        typeof messages[0].content === "string" &&
        messages[0].content.startsWith("[")
          ? 20
          : messages.length * 10,
      completeObservation,
      setStatus,
      abortActor,
    });
    const snapshot = {
      sessionId: "session-1",
      ancestry,
      actor,
      inputTokens: 900,
    };
    memory.restore(snapshot);

    expect(await memory.project(snapshot, incoming)).toBe(incoming);
    expect(completeObservation).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(abortActor).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith(
      "memory stopped — source preserved",
    );
  });
});
