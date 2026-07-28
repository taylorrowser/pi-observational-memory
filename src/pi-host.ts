import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { SessionMemoryHost } from "./session-memory.js";

export function createPiHost(pi: ExtensionAPI): SessionMemoryHost {
  return {
    appendEntry(customType, data) {
      pi.appendEntry(customType, data);
    },
  };
}
