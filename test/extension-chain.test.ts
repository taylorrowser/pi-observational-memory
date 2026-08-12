import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import observationalMemory from "../src/index.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Handler = (event: never, context: ExtensionContext) => unknown;
type ExtensionFactory = (pi: ExtensionAPI) => void;

function fixture() {
  const covered: ContextEvent["messages"] = [
    { role: "user", content: "Original covered request", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Completed covered step" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 2,
    },
  ];
  const tail: ContextEvent["messages"] = [
    { role: "user", content: "Exact uncovered tail", timestamp: 3 },
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
    observations: ["The covered step is complete."],
    activeTask: {
      originalIntent: "Continue the covered request.",
      constraints: ["Preserve chained context."],
      decisions: [],
      verifiedProgress: [],
      currentWork: ["Use the exact uncovered tail."],
      blockers: [],
      unresolvedQuestions: [],
      nextMove: { owner: "assistant", action: "Continue." },
    },
    lineage: { parentCommitId: null },
    producer: { provider: "anthropic", model: "claude-sonnet-4-5" },
    usage: zeroUsage,
    timestamp: "2026-01-01T00:00:02.000Z",
    fidelity: "normal",
    promptVersion: 1,
    outputEstimate: 20,
    validation: { version: 1, checks: ["contiguous-coverage"] },
  };
  const ancestry: SessionEntry[] = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: covered[0]!,
    },
    {
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: covered[1]!,
    },
    {
      type: "custom",
      id: "entry-3",
      parentId: "entry-2",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "observational-memory:observation",
      data: record,
    },
    {
      type: "message",
      id: "entry-4",
      parentId: "entry-3",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: tail[0]!,
    },
  ];
  return { baseline: [...covered, ...tail], ancestry };
}

async function runChain(factories: readonly ExtensionFactory[]) {
  const { baseline, ancestry } = fixture();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    appendEntry: vi.fn(),
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  for (const factory of factories) factory(pi);

  const context = {
    signal: undefined,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => ancestry,
    },
  } as unknown as ExtensionContext;
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" } as never, context);
  }

  let messages = structuredClone(baseline);
  for (const handler of handlers.get("context") ?? []) {
    const result = (await handler(
      { type: "context", messages } as never,
      context,
    )) as { messages?: ContextEvent["messages"] } | undefined;
    if (result?.messages) messages = result.messages;
  }
  return messages;
}

const rewriteCoveredSource: ExtensionFactory = (pi) => {
  pi.on("context", (event) => ({
    messages: event.messages.map((message) =>
      message.role === "user" && message.content === "Original covered request"
        ? { ...message, content: "Rewritten covered request" }
        : message,
    ),
  }));
};

describe("Pi context-hook chaining", () => {
  it("preserves a rewrite from an earlier context extension", async () => {
    const messages = await runChain([rewriteCoveredSource, observationalMemory]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(
      expect.objectContaining({ content: "Rewritten covered request" }),
    );
    expect(
      messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("<observational-memory"),
      ),
    ).toBe(false);
  });

  it("remains safe when a rewriting context extension runs afterward", async () => {
    const messages = await runChain([observationalMemory, rewriteCoveredSource]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("<observational-memory"),
      }),
    );
    expect(messages[1]).toEqual(
      expect.objectContaining({ content: "Exact uncovered tail" }),
    );
  });
});
