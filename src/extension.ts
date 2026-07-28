import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createPiHost } from "./pi-host.js";
import {
  createSessionMemory,
  type SessionMemory,
  type SessionMemoryHost,
  type SessionSnapshot,
} from "./session-memory.js";

type SessionMemoryFactory = (host: SessionMemoryHost) => SessionMemory;

function snapshot(context: ExtensionContext): SessionSnapshot {
  return {
    sessionId: context.sessionManager.getSessionId(),
    ancestry: [...context.sessionManager.getBranch()],
  };
}

export function registerObservationalMemory(
  pi: ExtensionAPI,
  createMemory: SessionMemoryFactory = createSessionMemory,
): void {
  const host = createPiHost(pi);
  let memory: SessionMemory | undefined;

  pi.on("session_start", (_event, context) => {
    memory?.dispose();
    memory = createMemory(host);
    memory.restore(snapshot(context));
  });

  pi.on("turn_end", (_event, context) => {
    memory?.observe(snapshot(context), context.signal);
  });

  pi.on("context", async (event, context) => {
    if (!memory) return;

    return {
      messages: await memory.project(snapshot(context), event.messages),
    };
  });

  pi.on("session_shutdown", () => {
    memory?.dispose();
    memory = undefined;
  });
}
