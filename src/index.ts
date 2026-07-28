import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerObservationalMemory } from "./extension.js";

export default function observationalMemory(pi: ExtensionAPI): void {
  registerObservationalMemory(pi);
}
