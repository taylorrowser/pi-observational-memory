import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPiHost } from "../src/pi-host.js";
import type { ExtensionUsageAttribution } from "../src/session-memory.js";

describe("Pi SessionMemory host", () => {
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
