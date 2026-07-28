import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerObservationalMemory } from "../src/extension.js";
import type { SessionMemory } from "../src/session-memory.js";

type Handler = (event: unknown, context: ExtensionContext) => unknown;

function extensionApi() {
  const handlers = new Map<string, Handler>();
  const appendEntry = vi.fn();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    appendEntry,
  } as unknown as ExtensionAPI;

  return { pi, handlers, appendEntry };
}

function context(ancestry: SessionEntry[], signal?: AbortSignal) {
  return {
    signal,
    sessionManager: {
      getSessionId: () => "session-1",
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
    );
    expect(contextResult).toEqual({ messages });
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(memory.observe).toHaveBeenCalledOnce();
    expect(memory.project).toHaveBeenCalledOnce();
    expect(lateContextResult).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
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
