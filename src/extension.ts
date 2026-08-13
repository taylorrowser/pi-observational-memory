import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createPiHost } from "./pi-host.js";
import {
  createSessionMemory,
  type MemoryInspection,
  type SessionMemory,
  type SessionMemoryHost,
  type SessionSnapshot,
} from "./session-memory.js";
import {
  loadSettings,
  saveSettings,
  validateSettings,
  type ObservationalMemorySettings,
  type SettingsScope,
} from "./settings.js";

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

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

export function formatMemoryStatus(inspection: MemoryInspection): string {
  const metric = (label: string, layer: { tokens: number; percent: number }) =>
    `${label} ${formatTokens(layer.tokens)} (${Math.round(layer.percent)}%)`;
  return [
    metric("msg", inspection.metrics.messages),
    metric("obs", inspection.metrics.observations),
    metric("refl", inspection.metrics.reflection),
  ].join(" • ");
}

function parseEditedLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
  let settings: ObservationalMemorySettings | undefined;
  let allowNextStockCompaction = false;

  function refreshStatus(context: ExtensionContext): void {
    if (!context.ui?.setStatus) return;
    if (!memory || !settings || !settings.enabled) {
      context.ui.setStatus("observational-memory-metrics", undefined);
      return;
    }
    context.ui.setStatus(
      "observational-memory-metrics",
      formatMemoryStatus(memory.inspect(snapshot(context))),
    );
  }

  function applySettings(
    context: ExtensionContext,
    next: ObservationalMemorySettings,
  ): void {
    settings = next;
    memory?.configure(next);
    refreshStatus(context);
  }

  function updateSettings(
    context: ExtensionContext,
    scope: SettingsScope,
    next: ObservationalMemorySettings,
  ): void {
    saveSettings(context, scope, next);
    applySettings(context, next);
  }

  pi.on("session_start", (_event, context) => {
    memory?.dispose();
    currentContext = context;
    settings = loadSettings(context);
    memory =
      createMemory === createSessionMemory
        ? createSessionMemory(host, settings)
        : createMemory(host);
    memory.restore(snapshot(context));
    memory.configure(settings);
    refreshStatus(context);
  });

  pi.on("session_tree", (_event, context) => {
    if (!memory) return;
    currentContext = context;
    memory.restore(snapshot(context));
  });

  pi.on("session_before_compact", async (event, context) => {
    if (!memory || !settings?.enabled) return;
    currentContext = context;
    memory.restore(snapshot(context));
    if (event.reason === "overflow") return;
    if (event.reason === "manual" && allowNextStockCompaction) {
      allowNextStockCompaction = false;
      return;
    }
    if (event.reason === "threshold") return { cancel: true };
    try {
      const result = await memory.compact(snapshot(context), event.signal);
      refreshStatus(context);
      context.ui.notify(
        `Observational compaction complete: ${result.observationsCreated} observation(s), ${result.reflectionsCreated} reflection(s).`,
        "info",
      );
    } catch (error) {
      context.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
    return { cancel: true };
  });

  pi.on("session_compact", (_event, context) => {
    if (!memory) return;
    currentContext = context;
    memory.restore(snapshot(context));
    refreshStatus(context);
  });

  pi.on("turn_end", (_event, context) => {
    currentContext = context;
    memory?.observe(snapshot(context), context.signal);
    if (memory && settings?.enabled) refreshStatus(context);
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
    settings = undefined;
    currentContext = undefined;
  });

  pi.registerCommand?.("stock-compact", {
    description: "Run Pi's stock compaction instead of observational compaction",
    handler: async (_args, context) => {
      if (!context.isIdle()) {
        context.ui.notify("Wait for the current turn before compacting.", "warning");
        return;
      }
      allowNextStockCompaction = true;
      context.compact({
        onComplete: () => {
          allowNextStockCompaction = false;
        },
        onError: (error) => {
          allowNextStockCompaction = false;
          context.ui.notify(error.message, "error");
        },
      });
    },
  });

  pi.registerCommand?.("memory", {
    description: "Enable or disable observational memory",
    handler: async (args, context) => {
      if (!memory || !settings) return;
      const requested = args.trim().toLowerCase();
      const enabled =
        requested === "on"
          ? true
          : requested === "off"
            ? false
            : await context.ui.confirm(
                "Observational memory",
                settings.enabled ? "Disable it?" : "Enable it?",
              );
      const next = { ...settings, enabled: requested ? enabled : settings.enabled ? !enabled : enabled };
      updateSettings(context, "global", next);
      context.ui.notify(
        `Observational memory ${next.enabled ? "enabled" : "disabled"}.`,
        "info",
      );
    },
  });

  pi.registerCommand?.("memory-settings", {
    description: "Edit observational-memory settings",
    handler: async (_args, context) => {
      if (!settings) return;
      const scopeChoice = await context.ui.select("Save settings in", [
        "Project",
        "Global",
      ]);
      if (!scopeChoice) return;
      const edited = await context.ui.editor(
        "Observational memory settings (JSON)",
        JSON.stringify(settings, null, 2),
      );
      if (!edited) return;
      try {
        const scope: SettingsScope =
          scopeChoice === "Project" ? "project" : "global";
        const parsed = validateSettings(JSON.parse(edited));
        updateSettings(context, scope, parsed);
        context.ui.notify(`Saved ${scope} memory settings.`, "info");
      } catch (error) {
        context.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerCommand?.("observations", {
    description: "Inspect or edit observations",
    handler: async (_args, context) => {
      if (!memory) return;
      const inspection = memory.inspect(snapshot(context));
      if (inspection.observations.length === 0) {
        context.ui.notify("No observations in this replay epoch.", "info");
        return;
      }
      const labels = inspection.observations.map(
        (item) => `${item.id}${item.folded ? " (folded)" : ""}`,
      );
      const selected = await context.ui.select("Observations", labels);
      if (!selected) return;
      const item = inspection.observations[labels.indexOf(selected)];
      if (!item) return;
      const edited = await context.ui.editor(
        `Edit ${item.id} (one observation per line)`,
        item.observations.join("\n"),
      );
      if (edited === undefined) return;
      try {
        memory.editObservation(item.id, parseEditedLines(edited));
        refreshStatus(context);
        context.ui.notify("Observation correction appended.", "info");
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand?.("reflection", {
    description: "Inspect or edit the active reflection",
    handler: async (_args, context) => {
      if (!memory) return;
      const reflection = memory.inspect(snapshot(context)).reflection;
      if (!reflection) {
        context.ui.notify("No active reflection in this replay epoch.", "info");
        return;
      }
      const edited = await context.ui.editor(
        `Edit ${reflection.id} (one history item per line)`,
        reflection.reflectedHistory.join("\n"),
      );
      if (edited === undefined) return;
      try {
        memory.editReflection(parseEditedLines(edited));
        refreshStatus(context);
        context.ui.notify("Reflection correction appended.", "info");
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
