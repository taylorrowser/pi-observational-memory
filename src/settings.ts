import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface ObservationalMemorySettings {
  enabled: boolean;
  /** Uncovered exact-message target after an observational compaction. */
  messageTokensTarget: number;
  /** Start ambient observation when uncovered exact messages reach this size. */
  messageTokensStartObservation: number;
  /** Active-observation target after reflection. */
  observationTokensTarget: number;
  /** Start reflection when active observations reach this size. */
  observationTokensStartReflection: number;
  /** Maximum tokens accepted from one reflection generation. */
  reflectionTokensMax: number;
}

export type SettingsScope = "global" | "project";

export const DEFAULT_SETTINGS: ObservationalMemorySettings = {
  enabled: true,
  messageTokensTarget: 20_000,
  messageTokensStartObservation: 40_000,
  observationTokensTarget: 20_000,
  observationTokensStartReflection: 40_000,
  reflectionTokensMax: 5_000,
};

const SETTINGS_FILE = "observational-memory.json";
const TOKEN_KEYS = [
  "messageTokensTarget",
  "messageTokensStartObservation",
  "observationTokensTarget",
  "observationTokensStartReflection",
  "reflectionTokensMax",
] as const;

function settingsPath(
  context: Pick<ExtensionContext, "cwd">,
  scope: SettingsScope,
): string {
  return scope === "global"
    ? join(getAgentDir(), SETTINGS_FILE)
    : join(context.cwd, CONFIG_DIR_NAME, SETTINGS_FILE);
}

function parsePartial(value: unknown): Partial<ObservationalMemorySettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("settings must be a JSON object");
  }
  const source = value as Record<string, unknown>;
  const parsed: Partial<ObservationalMemorySettings> = {};
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== "boolean") {
      throw new Error("enabled must be true or false");
    }
    parsed.enabled = source.enabled;
  }
  for (const key of TOKEN_KEYS) {
    const candidate = source[key];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    parsed[key] = candidate as number;
  }
  return parsed;
}

function readPartial(path: string): Partial<ObservationalMemorySettings> {
  try {
    return parsePartial(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    throw new Error(
      `Could not read observational-memory settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function loadSettings(
  context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): ObservationalMemorySettings {
  const global = readPartial(settingsPath(context, "global"));
  const project = context.isProjectTrusted?.()
    ? readPartial(settingsPath(context, "project"))
    : {};
  return validateSettings({ ...DEFAULT_SETTINGS, ...global, ...project });
}

export function validateSettings(value: unknown): ObservationalMemorySettings {
  const settings = { ...DEFAULT_SETTINGS, ...parsePartial(value) };
  if (
    settings.messageTokensTarget >= settings.messageTokensStartObservation
  ) {
    throw new Error(
      "messageTokensTarget must be less than messageTokensStartObservation",
    );
  }
  if (
    settings.observationTokensTarget >=
    settings.observationTokensStartReflection
  ) {
    throw new Error(
      "observationTokensTarget must be less than observationTokensStartReflection",
    );
  }
  return settings;
}

export function saveSettings(
  context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  scope: SettingsScope,
  settings: ObservationalMemorySettings,
): string {
  if (scope === "project" && !context.isProjectTrusted()) {
    throw new Error("Project settings require a trusted project");
  }
  const validated = validateSettings(settings);
  const path = settingsPath(context, scope);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return path;
}
