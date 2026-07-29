import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPiHost } from "../src/pi-host.js";
import type {
  ExtensionUsageAttribution,
  ObservationRequest,
  ReflectionRequest,
} from "../src/session-memory.js";

describe("Pi SessionMemory host", () => {
  it("completes an observation with the selected actor model", async () => {
    const model = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    const find = vi.fn(() => model);
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true as const,
      apiKey: "test-key",
      headers: { "x-test": "yes" },
      env: { TEST_PROVIDER: "yes" },
    }));
    const context = {
      model,
      modelRegistry: { find, getApiKeyAndHeaders },
    } as unknown as ExtensionContext;
    const responseUsage: ExtensionUsageAttribution["usage"] = {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.3,
      },
    };
    const completeModel = vi.fn(async () => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: '{"protocol":"observational-memory.observation"}' }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: responseUsage,
      stopReason: "stop" as const,
      timestamp: 1,
    }));
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const host = createPiHost(pi, () => context, completeModel);
    const sourceEntry = {
      type: "branch_summary",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      fromId: "abandoned-leaf",
      summary: "Approach A may have completed the migration.",
      fromHook: true,
    } satisfies SessionEntry;
    const request: ObservationRequest = {
      passId: "session-1:observation:1",
      parentCommitId: null,
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      pressure: {
        usableInput: 191_808,
        rawTarget: 95_904,
        soft: 115_084,
        hard: 163_036,
        safetyReserve: 28_772,
        observationOutputBudget: 8_192,
        observationTarget: 28_771,
        observationHigh: 47_952,
        reflectionOutputBudget: 8_192,
      },
      source: { entryIds: ["entry-1"], entries: [sourceEntry] },
    };
    const abort = new AbortController();

    const response = await host.completeObservation(request, abort.signal);

    expect(find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(completeModel).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        systemPrompt: expect.stringMatching(
          /branch_summary[\s\S]*derived orientation[\s\S]*not exact\s+source evidence[\s\S]*completion or action-sensitive details[\s\S]*toolResult[\s\S]*isError[\s\S]*failure/,
        ),
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringMatching(
              /"id":"entry-1"[\s\S]*"fromId":"abandoned-leaf"[\s\S]*"fromHook":true/,
            ),
          }),
        ],
      }),
      expect.objectContaining({
        apiKey: "test-key",
        headers: { "x-test": "yes" },
        env: { TEST_PROVIDER: "yes" },
        signal: abort.signal,
        maxTokens: 8_192,
      }),
    );
    expect(response).toEqual({
      text: '{"protocol":"observational-memory.observation"}',
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: responseUsage,
      stopReason: "stop",
    });
  });

  it("completes a reflection with the selected actor model", async () => {
    const model = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    const context = {
      model,
      modelRegistry: {
        find: vi.fn(() => model),
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true as const,
          apiKey: "test-key",
        })),
      },
    } as unknown as ExtensionContext;
    const completeModel = vi.fn(async () => ({
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: '{"protocol":"observational-memory.reflection"}',
        },
      ],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.3,
        },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    }));
    const host = createPiHost(
      { appendEntry: vi.fn() } as unknown as ExtensionAPI,
      () => context,
      completeModel,
    );
    const request = {
      passId: "session-1:reflection:1",
      actor: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      pressure: {
        usableInput: 191_808,
        rawTarget: 95_904,
        soft: 115_084,
        hard: 163_036,
        safetyReserve: 28_772,
        observationOutputBudget: 8_192,
        observationTarget: 28_771,
        observationHigh: 47_952,
        reflectionOutputBudget: 4_096,
      },
      parentReflection: null,
      coverage: { observationIds: ["session-1:observation:1"] },
      observations: [
        {
          id: "session-1:observation:1",
          observations: ["Durable outcome"],
        },
      ],
    } as unknown as ReflectionRequest;

    const response = await host.completeReflection!(request);

    expect(completeModel).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("observational-memory.reflection"),
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("session-1:observation:1"),
          }),
        ],
      }),
      expect.objectContaining({ maxTokens: 4_096 }),
    );
    expect(response.text).toBe(
      '{"protocol":"observational-memory.reflection"}',
    );
  });

  it("routes transient status and terminal actor abort effects through Pi", () => {
    const setStatus = vi.fn();
    const notify = vi.fn();
    const abort = vi.fn();
    const context = {
      ui: { setStatus, notify },
      abort,
    } as unknown as ExtensionContext;
    const host = createPiHost(
      { appendEntry: vi.fn() } as unknown as ExtensionAPI,
      () => context,
    );

    host.setStatus?.("observing");
    host.setStatus?.(undefined);
    host.abortActor?.("Exact source was preserved.");
    host.abortActor?.();

    expect(setStatus).toHaveBeenNthCalledWith(
      1,
      "observational-memory",
      "observing",
    );
    expect(setStatus).toHaveBeenNthCalledWith(
      2,
      "observational-memory",
      undefined,
    );
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("Exact source was preserved.", "error");
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("attributes standalone extension usage through Pi core", () => {
    const appendUsage = vi.fn();
    const pi = { appendUsage } as unknown as ExtensionAPI;
    const host = createPiHost(pi);
    const attribution: ExtensionUsageAttribution = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      operation: "observational-memory:observation",
      passId: "pass-1",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 100,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.3,
          cacheWrite: 0.4,
          total: 1,
        },
      },
    };

    host.attributeUsage(attribution);

    expect(appendUsage).toHaveBeenCalledWith(attribution);
  });
});
