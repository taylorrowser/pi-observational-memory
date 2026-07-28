import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
  ExtensionUsageAttribution,
  SessionMemoryHost,
} from "./session-memory.js";

type UsageCapablePi = ExtensionAPI & {
  appendUsage(attribution: ExtensionUsageAttribution): void;
};

export function createPiHost(pi: ExtensionAPI): SessionMemoryHost {
  return {
    appendEntry(customType, data) {
      pi.appendEntry(customType, data);
    },
    attributeUsage(attribution) {
      (pi as UsageCapablePi).appendUsage(attribution);
    },
  };
}
