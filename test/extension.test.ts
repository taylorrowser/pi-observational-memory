import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerObservationalMemory } from "../src/extension.js";
import type {
  SessionMemory,
  SessionMemoryHost,
} from "../src/session-memory.js";

type Handler = (event: unknown, context: ExtensionContext) => unknown;

function extensionApi() {
  const handlers = new Map<string, Handler>();
  const appendEntry = vi.fn();
  const getActiveTools = vi.fn((): string[] => []);
  const getAllTools = vi.fn(() => []);
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    appendEntry,
    getActiveTools,
    getAllTools,
  } as unknown as ExtensionAPI;

  return { pi, handlers, appendEntry, getActiveTools, getAllTools };
}

function context(
  ancestry: SessionEntry[],
  signal?: AbortSignal,
  sessionId = "session-1",
) {
  return {
    signal,
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => ancestry,
    },
  } as unknown as ExtensionContext;
}

function memorySpies(): SessionMemory {
  return {
    restore: vi.fn(),
    observe: vi.fn(),
    project: vi.fn(async (_snapshot, messages) => messages),
    dispose: vi.fn(),
  };
}

describe("observational-memory extension", () => {
  it("routes the selected session lifecycle through one SessionMemory", async () => {
    const { pi, handlers, appendEntry } = extensionApi();
    const memory = memorySpies();
    const createMemory = vi.fn(() => memory);
    const ancestry: SessionEntry[] = [
      {
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "fixture",
        data: {},
      },
    ];
    const abort = new AbortController();
    const ctx = context(ancestry, abort.signal);
    const messages: ContextEvent["messages"] = [
      { role: "user", content: "Exact source", timestamp: 1 },
    ];

    registerObservationalMemory(pi, createMemory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    await handlers.get("turn_end")?.(
      {
        type: "turn_end",
        turnIndex: 0,
        message: messages[0],
        toolResults: [],
      },
      ctx,
    );
    const contextResult = await handlers.get("context")?.(
      { type: "context", messages },
      ctx,
    );
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    await handlers.get("turn_end")?.(
      {
        type: "turn_end",
        turnIndex: 1,
        message: messages[0],
        toolResults: [],
      },
      ctx,
    );
    const lateContextResult = await handlers.get("context")?.(
      { type: "context", messages },
      ctx,
    );

    expect(createMemory).toHaveBeenCalledOnce();
    expect(memory.restore).toHaveBeenCalledWith({
      sessionId: "session-1",
      ancestry,
    });
    expect(memory.observe).toHaveBeenCalledWith(
      { sessionId: "session-1", ancestry },
      abort.signal,
    );
    expect(memory.project).toHaveBeenCalledWith(
      { sessionId: "session-1", ancestry },
      messages,
      abort.signal,
    );
    expect(contextResult).toEqual({ messages });
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(memory.observe).toHaveBeenCalledOnce();
    expect(memory.project).toHaveBeenCalledOnce();
    expect(lateContextResult).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("restores the selected ancestry immediately after tree navigation", async () => {
    const { pi, handlers } = extensionApi();
    const memory = memorySpies();
    const createMemory = vi.fn(() => memory);
    const oldAncestry: SessionEntry[] = [
      {
        type: "custom",
        id: "old-leaf",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "fixture",
        data: {},
      },
    ];
    const destinationAncestry: SessionEntry[] = [
      {
        type: "branch_summary",
        id: "branch-summary",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        fromId: "old-leaf",
        summary: "Derived orientation from the abandoned branch.",
        fromHook: false,
      },
    ];

    registerObservationalMemory(pi, createMemory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      context(oldAncestry),
    );
    await handlers.get("session_tree")?.(
      {
        type: "session_tree",
        oldLeafId: "old-leaf",
        newLeafId: "branch-summary",
        summaryEntry: destinationAncestry[0],
        fromExtension: false,
      },
      context(destinationAncestry),
    );

    expect(memory.restore).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      ancestry: oldAncestry,
    });
    expect(memory.restore).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      ancestry: destinationAncestry,
    });
    expect(memory.dispose).not.toHaveBeenCalled();
  });

  it("supplies the current actor budget at the completed-step seam", async () => {
    const { pi, handlers } = extensionApi();
    const memory = memorySpies();
    const createMemory = vi.fn(() => memory);
    const ctx = {
      signal: undefined,
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      getContextUsage: () => ({
        tokens: 125_000,
        contextWindow: 200_000,
        percent: 62.5,
      }),
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;

    registerObservationalMemory(pi, createMemory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    await handlers.get("turn_end")?.(
      { type: "turn_end", turnIndex: 0, message: undefined, toolResults: [] },
      ctx,
    );

    expect(memory.observe).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        ancestry: [],
        actor: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
        inputTokens: 125_000,
      },
      undefined,
    );
  });

  it("includes the effective system prompt and active tool schemas in pre-request headroom", async () => {
    const { pi, handlers, getActiveTools, getAllTools } = extensionApi();
    getActiveTools.mockReturnValue(["read"]);
    getAllTools.mockReturnValue([
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "inactive",
        description: "Must not be counted",
        parameters: { type: "object", properties: {} },
      },
    ] as never[]);
    const memory = memorySpies();
    const ctx = {
      signal: undefined,
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      getContextUsage: () => ({
        tokens: 1_000,
        contextWindow: 200_000,
        percent: 0.5,
      }),
      getSystemPrompt: () => "Fixed actor instructions",
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;
    const messages: ContextEvent["messages"] = [
      { role: "user", content: "Exact source", timestamp: 1 },
    ];

    let sessionHost: SessionMemoryHost | undefined;
    registerObservationalMemory(pi, (host) => {
      sessionHost = host;
      return memory;
    });
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    if (!sessionHost) throw new Error("expected the session host");
    const estimateTokens = vi.spyOn(sessionHost, "estimateTokens");
    await handlers.get("context")?.({ type: "context", messages }, ctx);

    const fixedRequest = estimateTokens.mock.calls[0]?.[0]?.[0];
    expect(fixedRequest?.role).toBe("user");
    if (fixedRequest?.role !== "user") throw new Error("expected fixed input");
    expect(fixedRequest.content).toContain("Fixed actor instructions");
    expect(fixedRequest.content).toContain("Read a file");
    expect(fixedRequest.content).toContain('"path"');
    expect(fixedRequest.content).not.toContain("Must not be counted");
    const projectedSnapshot = vi.mocked(memory.project).mock.calls[0]?.[0];
    expect(projectedSnapshot?.fixedInputTokens).toBeGreaterThan(0);
    expect(getActiveTools).toHaveBeenCalledOnce();
    expect(getAllTools).toHaveBeenCalledOnce();
  });

  it("reconstructs a resumed path and starts a new empty session without memory", async () => {
    const { pi, handlers } = extensionApi();
    const originalMemory = memorySpies();
    const resumedMemory = memorySpies();
    const emptyMemory = memorySpies();
    const createMemory = vi
      .fn()
      .mockReturnValueOnce(originalMemory)
      .mockReturnValueOnce(resumedMemory)
      .mockReturnValueOnce(emptyMemory);
    const originalAncestry: SessionEntry[] = [];
    const resumedAncestry: SessionEntry[] = [
      {
        type: "custom",
        id: "resumed-record",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "observational-memory:observation",
        data: {},
      },
    ];

    registerObservationalMemory(pi, createMemory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      context(originalAncestry, undefined, "original-session"),
    );
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "resume" },
      context(originalAncestry, undefined, "original-session"),
    );
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      context(resumedAncestry, undefined, "resumed-session"),
    );
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "new" },
      context(resumedAncestry, undefined, "resumed-session"),
    );
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "new" },
      context([], undefined, "empty-session"),
    );

    expect(originalMemory.dispose).toHaveBeenCalledOnce();
    expect(resumedMemory.restore).toHaveBeenCalledWith({
      sessionId: "resumed-session",
      ancestry: resumedAncestry,
    });
    expect(resumedMemory.dispose).toHaveBeenCalledOnce();
    expect(emptyMemory.restore).toHaveBeenCalledWith({
      sessionId: "empty-session",
      ancestry: [],
    });
  });

  it("does not migrate in-memory work into a fork or clone replacement runtime", async () => {
    const { pi, handlers } = extensionApi();
    const parentMemory = memorySpies();
    const childMemory = memorySpies();
    const createMemory = vi
      .fn()
      .mockReturnValueOnce(parentMemory)
      .mockReturnValueOnce(childMemory);
    const parentAncestry: SessionEntry[] = [
      {
        type: "custom",
        id: "parent-work",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "fixture",
        data: {},
      },
    ];
    const copiedAncestry = [...parentAncestry];

    registerObservationalMemory(pi, createMemory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      context(parentAncestry),
    );
    await handlers.get("turn_end")?.(
      { type: "turn_end", turnIndex: 0, message: undefined, toolResults: [] },
      context(parentAncestry),
    );
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "fork" },
      context(parentAncestry),
    );
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "fork" },
      context(copiedAncestry),
    );

    expect(parentMemory.dispose).toHaveBeenCalledOnce();
    expect(childMemory.restore).toHaveBeenCalledWith({
      sessionId: "session-1",
      ancestry: copiedAncestry,
    });
    expect(childMemory.observe).not.toHaveBeenCalled();
  });

  it("disposes an existing runtime before replacing it", async () => {
    const { pi, handlers } = extensionApi();
    const first = memorySpies();
    const second = memorySpies();
    const createMemory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const ctx = context([]);

    registerObservationalMemory(pi, createMemory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "reload" },
      ctx,
    );

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.restore).toHaveBeenCalledOnce();
  });
});
