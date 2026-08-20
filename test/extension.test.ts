import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  formatMemoryDebugEvent,
  formatMemoryStatus,
  registerObservationalMemory,
} from "../src/extension.js";
import type {
  MemoryDebugEvent,
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
    registerCommand: vi.fn(),
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
    cwd: "/tmp/observational-memory-test",
    signal,
    getContextUsage: () => undefined,
    isProjectTrusted: () => false,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn(),
      editor: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => ancestry,
    },
  } as unknown as ExtensionContext;
}

function memoryCompactionResult() {
  return {
    observationsCreated: 0,
    reflectionsCreated: 0,
    inspection: {
      observations: [],
      metrics: {
        messages: { tokens: 0, limit: 1, percent: 0 },
        observations: { tokens: 0, limit: 1, percent: 0, count: 0 },
        reflection: { tokens: 0, limit: 1, percent: 0 },
      },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    },
  };
}

function memorySpies(): SessionMemory {
  return {
    restore: vi.fn(),
    configure: vi.fn(),
    setEnabled: vi.fn(),
    observe: vi.fn(),
    maintain: vi.fn(async () => memoryCompactionResult()),
    compact: vi.fn(async () => memoryCompactionResult()),
    inspect: vi.fn(() => ({
      observations: [],
      metrics: {
        messages: { tokens: 0, limit: 1, percent: 0 },
        observations: { tokens: 0, limit: 1, percent: 0, count: 0 },
        reflection: { tokens: 0, limit: 1, percent: 0 },
      },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    })),
    editObservation: vi.fn(),
    editReflection: vi.fn(),
    project: vi.fn(async (_snapshot, messages) => messages),
    dispose: vi.fn(),
  };
}

describe("observational-memory extension", () => {
  it("shows threshold overflow and omits separate memory cost", () => {
    expect(
      formatMemoryStatus({
        observations: [],
        metrics: {
          messages: { tokens: 54_000, limit: 40_000, percent: 135 },
          observations: {
            tokens: 8_500,
            limit: 40_000,
            percent: 21.25,
            count: 1,
          },
          reflection: { tokens: 0, limit: 5_000, percent: 0 },
        },
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 3.888,
        },
      }),
    ).toBe("msg 54k (135%) • obs 8.5k (21%) • refl 0 (0%)");
  });

  it("persists debug events and displays them inline in the TUI", async () => {
    const { pi, handlers, appendEntry } = extensionApi();
    const ctx = context([]);
    let host: SessionMemoryHost | undefined;
    registerObservationalMemory(pi, (createdHost) => {
      host = createdHost;
      return memorySpies();
    });
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const event: MemoryDebugEvent = {
      protocol: "observational-memory.event",
      version: 1,
      event: "observation-started",
      operation: "observation",
      reason: "ambient-threshold",
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      passId: "session-1:observation:1",
      metrics: {
        messages: { tokens: 41_300, threshold: 40_000, target: 20_000 },
        observations: { tokens: 3_000, threshold: 40_000, target: 20_000, count: 2 },
        reflection: { tokens: 0, limit: 5_000 },
      },
      coverage: { entryCount: 12 },
    };

    host?.debugEvent?.(event);

    expect(appendEntry).toHaveBeenCalledWith(
      "observational-memory:event",
      event,
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Observation started: message history at 41.3k / 40k tokens",
      "info",
    );
    expect(formatMemoryDebugEvent(event)).toBe(
      "Observation started: message history at 41.3k / 40k tokens",
    );
  });

  it("persists routine maintenance lifecycle events without notifying the user", async () => {
    const { pi, handlers, appendEntry } = extensionApi();
    const ctx = context([]);
    let host: SessionMemoryHost | undefined;
    registerObservationalMemory(pi, (createdHost) => {
      host = createdHost;
      return memorySpies();
    });
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const started: MemoryDebugEvent = {
      protocol: "observational-memory.event",
      version: 1,
      event: "maintenance-started",
      operation: "maintenance",
      reason: "lifecycle-kick",
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      metrics: {
        messages: { tokens: 10_000, threshold: 80_000, target: 20_000 },
        observations: { tokens: 3_000, threshold: 40_000, target: 20_000, count: 2 },
        reflection: { tokens: 0, limit: 5_000 },
      },
    };

    host?.debugEvent?.(started);

    expect(appendEntry).toHaveBeenCalledWith("observational-memory:event", started);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("persists settled no-op maintenance events without notifying the user", async () => {
    const { pi, handlers, appendEntry } = extensionApi();
    const ctx = context([]);
    let host: SessionMemoryHost | undefined;
    registerObservationalMemory(pi, (createdHost) => {
      host = createdHost;
      return memorySpies();
    });
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const event: MemoryDebugEvent = {
      protocol: "observational-memory.event",
      version: 1,
      event: "maintenance-completed",
      operation: "maintenance",
      reason: "settled",
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      metrics: {
        messages: { tokens: 10_000, threshold: 40_000, target: 20_000 },
        observations: { tokens: 3_000, threshold: 40_000, target: 20_000, count: 2 },
        reflection: { tokens: 0, limit: 5_000 },
      },
      detail: "0 observations, 0 reflections",
    };

    host?.debugEvent?.(event);

    expect(appendEntry).toHaveBeenCalledWith("observational-memory:event", event);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("integrates observation and reflection activity into the metrics status", async () => {
    const { pi, handlers } = extensionApi();
    const ctx = context([]);
    let host: SessionMemoryHost | undefined;
    registerObservationalMemory(pi, (createdHost) => {
      host = createdHost;
      return memorySpies();
    });
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const setStatus = vi.mocked(ctx.ui.setStatus);

    host?.setStatus?.("observing");
    expect(setStatus).toHaveBeenLastCalledWith(
      "observational-memory-metrics",
      "msg 0 (0%) • obs 0 (0%) • refl 0 (0%) • observing",
    );

    host?.setStatus?.("reflecting");
    expect(setStatus).toHaveBeenLastCalledWith(
      "observational-memory-metrics",
      "msg 0 (0%) • obs 0 (0%) • refl 0 (0%) • reflecting",
    );
    expect(setStatus).not.toHaveBeenCalledWith(
      "observational-memory",
      expect.anything(),
    );
  });

  it("starts session-owned catch-up immediately for a resumed session", async () => {
    const { pi, handlers } = extensionApi();
    const maintain = vi.fn(
      async (_snapshot: () => unknown, _signal?: AbortSignal) =>
        memoryCompactionResult(),
    );
    const memory = { ...memorySpies(), maintain };
    const resumedAncestry: SessionEntry[] = [
      {
        type: "custom",
        id: "resumed-source",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "fixture",
        data: {},
      },
    ];
    const ctx = context(resumedAncestry, undefined, "resumed-session");

    registerObservationalMemory(pi, () => memory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    await vi.waitFor(() =>
      expect(maintain).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
    expect(maintain.mock.calls[0]?.[0]()).toEqual({
      sessionId: "resumed-session",
      ancestry: resumedAncestry,
    });
  });

  it("runs another maintenance pass when a lifecycle kick arrives during active maintenance", async () => {
    const { pi, handlers } = extensionApi();
    let finishFirstPass!: (
      result: ReturnType<typeof memoryCompactionResult>,
    ) => void;
    const maintain = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof memoryCompactionResult>>((resolve) => {
            finishFirstPass = resolve;
          }),
      )
      .mockResolvedValue(memoryCompactionResult());
    const ctx = context([]);

    registerObservationalMemory(pi, () => ({ ...memorySpies(), maintain }));
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());

    await handlers.get("turn_end")?.(
      { type: "turn_end", turnIndex: 0, message: undefined, toolResults: [] },
      ctx,
    );
    expect(maintain).toHaveBeenCalledOnce();

    finishFirstPass(memoryCompactionResult());

    await vi.waitFor(() => expect(maintain).toHaveBeenCalledTimes(2));
  });

  it("does not access a stale context when background maintenance settles after replacement", async () => {
    const { pi, handlers } = extensionApi();
    let finishMaintenance!: (
      result: ReturnType<typeof memoryCompactionResult>,
    ) => void;
    const maintain = vi.fn(
      () =>
        new Promise<ReturnType<typeof memoryCompactionResult>>((resolve) => {
          finishMaintenance = resolve;
        }),
    );
    const activeContext = context([]);
    const activeUi = activeContext.ui;
    let stale = false;
    let staleReads = 0;
    const ctx = Object.defineProperty(
      { ...activeContext },
      "ui",
      {
        get() {
          if (stale) {
            staleReads += 1;
            throw new Error(
              "This extension ctx is stale after session replacement or reload",
            );
          }
          return activeUi;
        },
      },
    ) as ExtensionContext;

    registerObservationalMemory(pi, () => ({ ...memorySpies(), maintain }));
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());
    await handlers.get("turn_end")?.(
      { type: "turn_end", turnIndex: 0, message: undefined, toolResults: [] },
      ctx,
    );

    stale = true;
    finishMaintenance(memoryCompactionResult());
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledTimes(2));

    expect(staleReads).toBe(0);
  });

  it("reports delayed maintenance rejection without rereading a stale context", async () => {
    const { pi, handlers } = extensionApi();
    let rejectMaintenance!: (error: Error) => void;
    const maintain = vi.fn(
      () =>
        new Promise<ReturnType<typeof memoryCompactionResult>>(
          (_resolve, reject) => {
            rejectMaintenance = reject;
          },
        ),
    );
    const activeContext = context([]);
    const activeUi = activeContext.ui;
    let stale = false;
    let staleReads = 0;
    const ctx = Object.defineProperty(
      { ...activeContext },
      "ui",
      {
        get() {
          if (stale) {
            staleReads += 1;
            throw new Error(
              "This extension ctx is stale after session replacement or reload",
            );
          }
          return activeUi;
        },
      },
    ) as ExtensionContext;

    registerObservationalMemory(pi, () => ({ ...memorySpies(), maintain }));
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());

    stale = true;
    rejectMaintenance(new Error("maintenance failed"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(staleReads).toBe(0);
    expect(activeUi.notify).toHaveBeenCalledWith("maintenance failed", "error");
  });

  it("fences delayed maintenance snapshots before a shutdown context becomes stale", async () => {
    const { pi, handlers } = extensionApi();
    let finishMaintenance!: () => void;
    const maintain = vi.fn(
      (getSnapshot: () => unknown) =>
        new Promise<ReturnType<typeof memoryCompactionResult>>(
          (resolve, reject) => {
            finishMaintenance = () => {
              try {
                getSnapshot();
                resolve(memoryCompactionResult());
              } catch (error) {
                reject(error);
              }
            };
          },
        ),
    );
    const activeContext = context([]);
    const activeUi = activeContext.ui;
    let stale = false;
    let staleReads = 0;
    const ctx = Object.defineProperty(
      { ...activeContext },
      "ui",
      {
        get() {
          if (stale) {
            staleReads += 1;
            throw new Error(
              "This extension ctx is stale after session replacement or reload",
            );
          }
          return activeUi;
        },
      },
    ) as ExtensionContext;
    const memory = { ...memorySpies(), maintain };

    registerObservationalMemory(pi, () => memory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());

    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "reload" },
      ctx,
    );
    stale = true;
    finishMaintenance();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(staleReads).toBe(0);
    expect(memory.dispose).toHaveBeenCalledOnce();
  });

  it("passes active Escape to Pi and uses a later idle Escape to stop background memory", async () => {
    const { pi, handlers } = extensionApi();
    let terminalInput:
      | ((data: string) => { consume?: boolean; data?: string } | undefined)
      | undefined;
    let idle = false;
    const ctx = {
      ...context([]),
      isIdle: () => idle,
      ui: {
        ...context([]).ui,
        onTerminalInput(handler: typeof terminalInput) {
          terminalInput = handler;
          return vi.fn();
        },
      },
    } as unknown as ExtensionContext;
    const maintain = vi.fn(
      (_snapshot: () => unknown, signal: AbortSignal) =>
        new Promise<ReturnType<typeof memoryCompactionResult>>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(memoryCompactionResult()),
            { once: true },
          );
        }),
    );
    registerObservationalMemory(pi, () => ({ ...memorySpies(), maintain }));

    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());

    expect(terminalInput?.("\u001b")).toBeUndefined();
    expect(maintain.mock.calls[0]?.[1].aborted).toBe(false);

    idle = true;
    expect(terminalInput?.("\u001b")).toEqual({ consume: true });
    expect(maintain.mock.calls[0]?.[1].aborted).toBe(true);
  });

  it("aborts in-flight background maintenance before session shutdown disposal", async () => {
    const { pi, handlers } = extensionApi();
    let maintenanceSignal: AbortSignal | undefined;
    const maintain = vi.fn(
      (_snapshot: () => unknown, signal: AbortSignal) =>
        new Promise<ReturnType<typeof memoryCompactionResult>>((resolve) => {
          maintenanceSignal = signal;
          signal.addEventListener(
            "abort",
            () => resolve(memoryCompactionResult()),
            { once: true },
          );
        }),
    );
    const memory = { ...memorySpies(), maintain };
    const ctx = context([]);
    registerObservationalMemory(pi, () => memory);

    await handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());

    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );

    expect(maintenanceSignal?.aborted).toBe(true);
    expect(memory.dispose).toHaveBeenCalledOnce();
  });

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
    expect(memory.maintain).toHaveBeenCalled();
    expect(memory.observe).not.toHaveBeenCalled();
    expect(memory.project).toHaveBeenCalledWith(
      { sessionId: "session-1", ancestry },
      messages,
      abort.signal,
    );
    expect(contextResult).toEqual({ messages });
    expect(memory.dispose).toHaveBeenCalledOnce();
    expect(memory.maintain).toHaveBeenCalledTimes(2);
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
      cwd: "/tmp/observational-memory-test",
      isProjectTrusted: () => false,
      ui: { setStatus: vi.fn() },
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

    expect(memory.maintain).toHaveBeenCalledTimes(2);
    const getSnapshot = vi.mocked(memory.maintain).mock.calls[1]?.[0];
    expect(getSnapshot?.()).toEqual({
      sessionId: "session-1",
      ancestry: [],
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      inputTokens: 125_000,
    });
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
      cwd: "/tmp/observational-memory-test",
      isProjectTrusted: () => false,
      ui: { setStatus: vi.fn() },
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

  it("owns threshold compaction and lets stock Pi recover from overflow", async () => {
    const { pi, handlers } = extensionApi();
    const memory = memorySpies();
    const beforeAncestry: SessionEntry[] = [];
    const compactionEntry: SessionEntry = {
      type: "compaction",
      id: "compaction-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      summary: "Pi summary",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 1_000,
    };
    const afterAncestry = [compactionEntry];

    registerObservationalMemory(pi, () => memory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      context(beforeAncestry),
    );

    const thresholdResult = await handlers.get("session_before_compact")?.(
      { type: "session_before_compact", reason: "threshold" },
      context(beforeAncestry),
    );
    const overflowResult = await handlers.get("session_before_compact")?.(
      { type: "session_before_compact", reason: "overflow" },
      context(beforeAncestry),
    );
    const manualResult = await handlers.get("session_before_compact")?.(
      { type: "session_before_compact", reason: "manual" },
      context(beforeAncestry),
    );
    await handlers.get("session_compact")?.(
      {
        type: "session_compact",
        reason: "manual",
        compactionEntry,
        fromExtension: false,
        willRetry: false,
      },
      context(afterAncestry),
    );

    expect(thresholdResult).toEqual({ cancel: true });
    expect(overflowResult).toBeUndefined();
    expect(manualResult).toEqual({ cancel: true });
    expect(memory.compact).toHaveBeenCalledOnce();
    expect(memory.restore).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      ancestry: beforeAncestry,
    });
    expect(memory.restore).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      ancestry: beforeAncestry,
    });
    expect(memory.restore).toHaveBeenNthCalledWith(3, {
      sessionId: "session-1",
      ancestry: beforeAncestry,
    });
    expect(memory.restore).toHaveBeenNthCalledWith(4, {
      sessionId: "session-1",
      ancestry: beforeAncestry,
    });
    expect(memory.restore).toHaveBeenNthCalledWith(5, {
      sessionId: "session-1",
      ancestry: afterAncestry,
    });
  });

  it("disposes and fences an existing runtime before rebinding its host context", async () => {
    const { pi, handlers } = extensionApi();
    const oldSetStatus = vi.fn();
    const newSetStatus = vi.fn();
    const oldContext = {
      ...context([]),
      ui: { setStatus: oldSetStatus },
    } as unknown as ExtensionContext;
    const newContext = {
      ...context([]),
      ui: { setStatus: newSetStatus },
    } as unknown as ExtensionContext;
    const second = memorySpies();
    let firstHost: SessionMemoryHost | undefined;
    const createMemory = vi.fn((host: SessionMemoryHost) => {
      if (createMemory.mock.calls.length > 1) return second;
      firstHost = host;
      return {
        ...memorySpies(),
        dispose: vi.fn(() => host.setStatus?.("disposing old runtime")),
      };
    });

    registerObservationalMemory(pi, createMemory);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      oldContext,
    );
    const first = createMemory.mock.results[0]?.value;
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "reload" },
      newContext,
    );

    expect(first?.dispose).toHaveBeenCalledOnce();
    expect(oldSetStatus).toHaveBeenCalledWith(
      "observational-memory-metrics",
      "msg 0 (0%) • obs 0 (0%) • refl 0 (0%) • disposing old runtime",
    );
    expect(newSetStatus).toHaveBeenCalledWith(
      "observational-memory-metrics",
      "msg 0 (0%) • obs 0 (0%) • refl 0 (0%)",
    );

    firstHost?.setStatus?.("late old runtime update");

    expect(oldSetStatus).not.toHaveBeenCalledWith(
      "observational-memory-metrics",
      expect.stringContaining("late old runtime update"),
    );
    expect(newSetStatus).not.toHaveBeenCalledWith(
      "observational-memory-metrics",
      expect.stringContaining("late old runtime update"),
    );
    expect(second.restore).toHaveBeenCalledOnce();
  });
});
