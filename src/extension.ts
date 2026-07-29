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

function snapshot(
  context: ExtensionContext,
  fixedInputTokens?: number,
): SessionSnapshot {
  const model = context.model;
  const inputTokens = context.getContextUsage()?.tokens;
  return {
    sessionId: context.sessionManager.getSessionId(),
    ancestry: [...context.sessionManager.getBranch()],
    ...(model
      ? {
          actor: {
            provider: model.provider,
            model: model.id,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          },
        }
      : {}),
    ...(inputTokens === null || inputTokens === undefined ? {} : { inputTokens }),
    ...(fixedInputTokens === undefined || fixedInputTokens === 0
      ? {}
      : { fixedInputTokens }),
  };
}

function estimateFixedInputTokens(
  pi: ExtensionAPI,
  context: ExtensionContext,
  host: SessionMemoryHost,
): number {
  const activeToolNames = new Set(pi.getActiveTools?.() ?? []);
  const tools = (pi.getAllTools?.() ?? [])
    .filter((tool) => activeToolNames.has(tool.name))
    .map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  const systemPrompt = context.getSystemPrompt?.() ?? "";
  if (!systemPrompt && tools.length === 0) return 0;
  return host.estimateTokens([
    {
      role: "user",
      content: JSON.stringify({ systemPrompt, tools }),
      timestamp: 0,
    },
  ]);
}

export function registerObservationalMemory(
  pi: ExtensionAPI,
  createMemory: SessionMemoryFactory = createSessionMemory,
): void {
  let currentContext: ExtensionContext | undefined;
  const host = createPiHost(pi, () => currentContext);
  let memory: SessionMemory | undefined;

  pi.on("session_start", (_event, context) => {
    currentContext = context;
    memory?.dispose();
    memory = createMemory(host);
    memory.restore(snapshot(context));
  });

  pi.on("session_tree", (_event, context) => {
    if (!memory) return;
    currentContext = context;
    memory.restore(snapshot(context));
  });

  pi.on("turn_end", (_event, context) => {
    currentContext = context;
    memory?.observe(snapshot(context), context.signal);
  });

  pi.on("context", async (event, context) => {
    if (!memory) return;
    currentContext = context;

    return {
      messages: await memory.project(
        snapshot(context, estimateFixedInputTokens(pi, context, host)),
        event.messages,
        context.signal,
      ),
    };
  });

  pi.on("session_shutdown", () => {
    memory?.dispose();
    memory = undefined;
    currentContext = undefined;
  });
}
