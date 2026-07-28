// PROTOTYPE: load aggregate call shapes from Pi JSONL without retaining message text.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function sessionDirectoryFor(cwd) {
  const encodedPath = cwd.split(path.sep).filter(Boolean).join("-");
  return path.join(os.homedir(), ".pi", "agent", "sessions", `--${encodedPath}--`);
}

function activeBranch(entries) {
  const treeEntries = entries.filter((entry) => entry.id);
  if (treeEntries.length === 0) return [];
  const byId = new Map(treeEntries.map((entry) => [entry.id, entry]));
  const children = new Map();
  for (const entry of treeEntries) {
    if (!entry.parentId) continue;
    children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
  }
  const leaf = [...treeEntries].reverse().find((entry) => !children.has(entry.id)) ?? treeEntries.at(-1);
  const branch = [];
  let cursor = leaf;
  while (cursor) {
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  return branch.reverse();
}

function inferRates(messages) {
  const rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const key of Object.keys(rates)) {
    const sample = messages.find(
      (message) => (message.usage?.[key] ?? 0) > 0 && (message.usage?.cost?.[key] ?? 0) > 0,
    );
    rates[key] = sample
      ? (sample.usage.cost[key] / sample.usage[key]) * 1_000_000
      : key === "cacheRead"
        ? 0.5
        : key === "cacheWrite"
          ? 5
          : key === "output"
            ? 30
            : 5;
  }
  return rates;
}

function traceFromFile(file) {
  const entries = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const branch = activeBranch(entries);
  const assistants = branch
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .map((entry) => entry.message)
    .filter((message) => {
      const usage = message.usage ?? {};
      return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0;
    });
  if (assistants.length < 2) return null;

  const fixedTokens = Math.min(
    5_000,
    ...assistants.map(
      (message) =>
        (message.usage?.input ?? 0) +
        (message.usage?.cacheRead ?? 0) +
        (message.usage?.cacheWrite ?? 0),
    ),
  );
  let priorPrompt = fixedTokens;
  const calls = assistants.map((message, index) => {
    const promptTokens =
      (message.usage?.input ?? 0) +
      (message.usage?.cacheRead ?? 0) +
      (message.usage?.cacheWrite ?? 0);
    const sourceDelta = Math.max(0, promptTokens - priorPrompt);
    priorPrompt = Math.max(priorPrompt, promptTokens);
    return {
      id: index + 1,
      promptTokens,
      sourceDelta,
      outputTokens: message.usage?.output ?? 0,
      observedCacheRead: message.usage?.cacheRead ?? 0,
      turnEnd: message.stopReason !== "toolUse",
    };
  });
  const observed = assistants.reduce(
    (total, message) => {
      const usage = message.usage ?? {};
      total.input += usage.input ?? 0;
      total.output += usage.output ?? 0;
      total.cacheRead += usage.cacheRead ?? 0;
      total.cacheWrite += usage.cacheWrite ?? 0;
      total.cost += usage.cost?.total ?? 0;
      return total;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
  const first = assistants[0];
  const stamp = path.basename(file).slice(0, 19).replace("T", " ");

  return {
    name: `${stamp} · ${assistants.length} calls`,
    source: "local Pi session (aggregate tokens only)",
    model: `${first.provider}/${first.model}`,
    fixedTokens,
    rates: inferRates(assistants),
    observed,
    calls,
  };
}

function syntheticTrace(name, deltas, { turnEvery = 12, output = 500 } = {}) {
  let promptTokens = 5_000;
  return {
    name,
    source: "synthetic",
    model: "openai-codex/gpt-5.6-sol assumptions",
    fixedTokens: 5_000,
    rates: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
    calls: deltas.map((sourceDelta, index) => {
      promptTokens += sourceDelta;
      return {
        id: index + 1,
        promptTokens,
        sourceDelta,
        outputTokens: typeof output === "function" ? output(index) : output,
        turnEnd: (index + 1) % turnEvery === 0 || index === deltas.length - 1,
      };
    }),
  };
}

export function syntheticTraces() {
  return [
    syntheticTrace(
      "Synthetic · steady long session",
      Array.from({ length: 120 }, (_, index) => 900 + ((index * 137) % 900)),
      { turnEvery: 10, output: (index) => 250 + ((index * 83) % 650) },
    ),
    syntheticTrace(
      "Synthetic · bursty tool outputs",
      Array.from({ length: 90 }, (_, index) =>
        index % 11 === 6 ? 18_000 : 500 + ((index * 211) % 1_200),
      ),
      { turnEvery: 15, output: 420 },
    ),
    syntheticTrace(
      "Synthetic · one uninterrupted tool loop",
      Array.from({ length: 150 }, (_, index) =>
        index % 17 === 9 ? 12_000 : 700 + ((index * 97) % 800),
      ),
      { turnEvery: 150, output: 500 },
    ),
  ];
}

export function loadLocalTraces(cwd = process.cwd()) {
  const directory = sessionDirectoryFor(cwd);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .map((file) => traceFromFile(path.join(directory, file)))
    .filter(Boolean)
    .sort((left, right) => right.calls.length - left.calls.length);
}

export function loadTraces(cwd = process.cwd()) {
  return [...loadLocalTraces(cwd), ...syntheticTraces()];
}
