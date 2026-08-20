import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createPiHost } from "./pi-host.js";
import {
  createSessionMemory,
  DEBUG_EVENT_CUSTOM_TYPE,
  type MemoryDebugEvent,
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

export function formatMemoryDebugEvent(event: MemoryDebugEvent): string {
  const tokens = (value: number): string => {
    if (value < 1_000) return String(Math.round(value));
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
  };
  const messages = `${tokens(event.metrics.messages.tokens)} / ${tokens(event.metrics.messages.threshold)} tokens`;
  const observations = `${tokens(event.metrics.observations.tokens)} / ${tokens(event.metrics.observations.threshold)} tokens`;
  switch (event.event) {
    case "observation-started":
      return `Observation started: message history at ${messages}`;
    case "observation-ready":
      return `Observation ready: message history at ${messages}`;
    case "observation-activated":
      return `Observation activated: message history at ${messages}`;
    case "reflection-started":
      return `Reflection started: observations at ${observations}`;
    case "reflection-committed":
      return `Reflection committed: observations at ${observations}`;
    case "maintenance-started":
      return `Memory maintenance started: ${event.reason}`;
    case "maintenance-completed":
      return `Memory maintenance completed: ${event.detail ?? "no work pending"}`;
    default:
      return `Memory ${event.event.replaceAll("-", " ")}: ${event.reason}`;
  }
}

export function formatMemoryStatus(
  inspection: MemoryInspection,
  activity?: string,
): string {
  const metric = (label: string, layer: { tokens: number; percent: number }) =>
    `${label} ${formatTokens(layer.tokens)} (${Math.round(layer.percent)}%)`;
  return [
    metric("msg", inspection.metrics.messages),
    metric("obs", inspection.metrics.observations),
    metric("refl", inspection.metrics.reflection),
    ...(activity ? [activity] : []),
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
  let runtimeGeneration = 0;
  let memory: SessionMemory | undefined;
  let host: SessionMemoryHost | undefined;
  let settings: ObservationalMemorySettings | undefined;
  let activity: string | undefined;
  let refreshRuntimeStatus:
    | ((inspection?: MemoryInspection) => void)
    | undefined;
  let notifyRuntimeError: ((message: string) => void) | undefined;
  let allowNextStockCompaction = false;
  let maintenanceController: AbortController | undefined;
  let maintenanceTask: Promise<unknown> | undefined;
  let maintenanceRequested = false;
  let removeTerminalInputListener: (() => void) | undefined;

  function createRuntimeHost(
    context: ExtensionContext,
    generation: number,
  ): SessionMemoryHost {
    const piHost = createPiHost(
      pi,
      () => (generation === runtimeGeneration ? currentContext : undefined),
    );
    const ui = context.ui;
    const setStatus = ui?.setStatus?.bind(ui);
    const notify = ui?.notify?.bind(ui);
    let lastInspection: MemoryInspection | undefined;
    const renderStatus = (inspection?: MemoryInspection): void => {
      if (generation !== runtimeGeneration || !setStatus) return;
      if (inspection) lastInspection = inspection;
      if (!memory || !settings || !settings.enabled) {
        setStatus("observational-memory-metrics", undefined);
        return;
      }
      if (!lastInspection) return;
      setStatus(
        "observational-memory-metrics",
        formatMemoryStatus(lastInspection, activity),
      );
    };
    refreshRuntimeStatus = renderStatus;
    notifyRuntimeError = (message) => {
      if (generation === runtimeGeneration) notify?.(message, "error");
    };

    return {
      ...piHost,
      debugEvent(event) {
        if (generation !== runtimeGeneration) return;
        pi.appendEntry(DEBUG_EVENT_CUSTOM_TYPE, event);
        const isRoutineMaintenanceEvent =
          event.event === "maintenance-requested" ||
          event.event === "maintenance-started" ||
          (event.event === "maintenance-completed" &&
            event.reason === "settled" &&
            event.detail === "0 observations, 0 reflections");
        if (!isRoutineMaintenanceEvent) {
          notify?.(formatMemoryDebugEvent(event), "info");
        }
      },
      setStatus(next) {
        if (generation !== runtimeGeneration) return;
        activity = next;
        renderStatus();
      },
    };
  }

  function stopMaintenance(
    reason:
      | "idle-escape"
      | "disabled"
      | "navigation"
      | "session-replacement"
      | "shutdown",
  ): void {
    maintenanceRequested = false;
    maintenanceController?.abort(reason);
    maintenanceController = undefined;
    maintenanceTask = undefined;
  }

  function kickMaintenance(context: ExtensionContext): void {
    currentContext = context;
    if (!memory || !settings?.enabled) return;
    if (maintenanceTask) {
      maintenanceRequested = true;
      return;
    }

    maintenanceRequested = false;
    const maintainedMemory = memory;
    const generation = runtimeGeneration;
    const controller = new AbortController();
    maintenanceController = controller;
    const task = maintainedMemory
      .maintain(
        () => {
          if (
            controller.signal.aborted ||
            generation !== runtimeGeneration ||
            !currentContext
          ) {
            throw new Error("Memory maintenance runtime is no longer active");
          }
          return snapshot(currentContext);
        },
        controller.signal,
      )
      .then(
        (result) => {
          if (
            generation === runtimeGeneration &&
            memory === maintainedMemory
          ) {
            refreshRuntimeStatus?.(result.inspection);
          }
        },
        (error: unknown) => {
          if (
            !controller.signal.aborted &&
            generation === runtimeGeneration &&
            memory === maintainedMemory
          ) {
            notifyRuntimeError?.(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      )
      .finally(() => {
        if (
          maintenanceTask !== task ||
          generation !== runtimeGeneration ||
          memory !== maintainedMemory
        ) {
          return;
        }
        const shouldRestart = maintenanceRequested;
        maintenanceRequested = false;
        maintenanceController = undefined;
        maintenanceTask = undefined;
        if (shouldRestart && currentContext && settings?.enabled) {
          kickMaintenance(currentContext);
        }
      });
    maintenanceTask = task;
  }

  function bindTerminalInput(context: ExtensionContext): void {
    removeTerminalInputListener?.();
    removeTerminalInputListener = context.ui?.onTerminalInput?.((data) => {
      if (
        data === "\u001b" &&
        context.isIdle() &&
        maintenanceController &&
        maintenanceTask
      ) {
        stopMaintenance("idle-escape");
        return { consume: true };
      }
      return undefined;
    });
  }

  function refreshStatus(context: ExtensionContext): void {
    if (!memory) return;
    refreshRuntimeStatus?.(memory.inspect(snapshot(context)));
  }

  function applySettings(
    context: ExtensionContext,
    next: ObservationalMemorySettings,
  ): void {
    settings = next;
    memory?.configure(next);
    if (!next.enabled) stopMaintenance("disabled");
    else kickMaintenance(context);
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
    stopMaintenance("session-replacement");
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    memory?.dispose();
    runtimeGeneration += 1;
    activity = undefined;
    currentContext = context;
    settings = loadSettings(context);
    host = createRuntimeHost(context, runtimeGeneration);
    memory =
      createMemory === createSessionMemory
        ? createSessionMemory(host, settings)
        : createMemory(host);
    memory.restore(snapshot(context));
    memory.configure(settings);
    bindTerminalInput(context);
    refreshStatus(context);
    kickMaintenance(context);
  });

  pi.on("session_tree", (_event, context) => {
    if (!memory) return;
    stopMaintenance("navigation");
    currentContext = context;
    memory.restore(snapshot(context));
    kickMaintenance(context);
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
    kickMaintenance(context);
    if (memory && settings?.enabled) refreshStatus(context);
  });

  pi.on("agent_settled", (_event, context) => {
    kickMaintenance(context);
  });

  pi.on("context", async (event, context) => {
    if (!memory) return;
    currentContext = context;

    return {
      messages: await memory.project(
        snapshot(context, estimateFixedInputTokens(pi, context, host!)),
        event.messages,
        context.signal,
      ),
    };
  });

  pi.on("session_shutdown", () => {
    runtimeGeneration += 1;
    currentContext = undefined;
    refreshRuntimeStatus = undefined;
    notifyRuntimeError = undefined;
    stopMaintenance("shutdown");
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    memory?.dispose();
    memory = undefined;
    host = undefined;
    settings = undefined;
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
