import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

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

describe("SessionMemory", () => {
  it("keeps below-pressure context exact without producing persisted effects", async () => {
    const entries: Array<{ customType: string; data: unknown }> = [];
    const memory = createSessionMemory({
      appendEntry(customType, data) {
        entries.push({ customType, data });
      },
      attributeUsage() {},
    });

    memory.restore(snapshot);
    memory.observe(snapshot);
    const projected = await memory.project(snapshot, messages);
    memory.dispose();

    expect(projected).toBe(messages);
    expect(entries).toEqual([]);
  });
});
