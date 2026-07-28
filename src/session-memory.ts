import type {
  ContextEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly ancestry: readonly SessionEntry[];
}

export interface SessionMemory {
  restore(snapshot: SessionSnapshot): void;
  observe(snapshot: SessionSnapshot, signal?: AbortSignal): void;
  project(
    snapshot: SessionSnapshot,
    messages: ContextEvent["messages"],
  ): Promise<ContextEvent["messages"]>;
  dispose(): void;
}

export interface SessionMemoryHost {
  appendEntry(customType: string, data?: unknown): void;
}

export function createSessionMemory(_host: SessionMemoryHost): SessionMemory {
  let disposed = false;

  return {
    restore(_snapshot) {
      if (disposed) return;
    },

    observe(_snapshot, _signal) {
      if (disposed) return;
    },

    async project(_snapshot, messages) {
      return messages;
    },

    dispose() {
      disposed = true;
    },
  };
}
