import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { runMonteCarlo } from "../dist/cost-simulation.js";

const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
const REPORT_PATH = process.env.MONTE_CARLO_OUTPUT
  ? resolve(process.env.MONTE_CARLO_OUTPUT)
  : join(process.cwd(), ".cache", "cost-monte-carlo-report.json");
const PRICES = {
  input: 5,
  output: 30,
  cacheRead: 0.5,
  cacheWrite: 6.25,
  provenance:
    "Installed @earendil-works/pi-ai 0.81.1 model catalog entry openai/gpt-5.6-sol: input $5/M, output $30/M, cache read $0.50/M, cache write $6.25/M. Persisted local openai-codex usage independently matches the first three rates and has reported zero cache-write tokens.",
};

function encodedSessionDirectoryPrefix(path) {
  return `--${resolve(path).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}`;
}

function sessionFiles(root) {
  const files = [];
  const userHomePrefix = encodedSessionDirectoryPrefix(homedir());
  for (const directory of readdirSync(root)) {
    const path = join(root, directory);
    // Exclude acceptance/test artifacts rooted in temporary directories. These
    // encoded paths represent interactive sessions under the user's home tree.
    if (!statSync(path).isDirectory() || !directory.startsWith(userHomePrefix)) continue;
    for (const file of readdirSync(path)) {
      if (file.endsWith(".jsonl")) files.push(join(path, file));
    }
  }
  return files;
}

function timestamp(entry) {
  const value = entry.timestamp ?? entry.message?.timestamp;
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fitProfile(files) {
  const sessionLengths = [];
  const initialInputTokens = [];
  const allBlocks = [];
  const observationOutputRatios = [];
  const reflectionOutputRatios = [];
  const stockSummaryOutputRatios = [];
  const seenMemoryRecords = new Set();
  const seenCompactions = new Set();
  const transitionCounts = Object.fromEntries(
    ["conversation", "tool", "heavyTool"].map((state) => [state, { conversation: 1, tool: 1, heavyTool: 1 }]),
  );
  let messageCount = 0;
  let skippedFiles = 0;

  for (const file of files) {
    let entries;
    try {
      entries = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      skippedFiles += 1;
      continue;
    }
    let pendingTokens = 0;
    let pendingToolTokens = 0;
    let assistantCount = 0;
    const sessionBlocks = [];
    let previousAssistantAt;
    for (const entry of entries) {
      if (entry.type === "custom") {
        const usage = entry.data?.usage;
        if (usage?.input >= 1_000 && usage?.output > 0) {
          const ratio = usage.output / usage.input;
          const key = `${entry.customType}:${entry.data?.coverage?.startEntryId ?? ""}:${entry.data?.coverage?.endEntryId ?? ""}:${usage.input}:${usage.output}`;
          if (ratio <= 0.5 && !seenMemoryRecords.has(key)) {
            seenMemoryRecords.add(key);
            if (entry.customType === "observational-memory:observation") observationOutputRatios.push(ratio);
            if (entry.customType === "observational-memory:reflection") reflectionOutputRatios.push(ratio);
          }
        }
        continue;
      }
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        const usage = entry.usage;
        const key = entry.id ?? `${entry.type}:${usage?.input}:${usage?.output}:${entry.timestamp ?? ""}`;
        if (!seenCompactions.has(key) && usage?.input >= 1_000 && usage?.output > 0) {
          seenCompactions.add(key);
          const ratio = usage.output / usage.input;
          if (ratio <= 0.5) stockSummaryOutputRatios.push(ratio);
        }
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;
      const message = entry.message;
      let tokens;
      try {
        tokens = estimateTokens(message);
      } catch {
        continue;
      }
      messageCount += 1;
      if (message.role !== "assistant") {
        pendingTokens += tokens;
        if (message.role === "toolResult" || message.role === "bashExecution") pendingToolTokens += tokens;
        continue;
      }
      const outputTokens = Math.max(1, message.usage?.output ?? tokens);
      const at = timestamp(entry);
      const delaySeconds = previousAssistantAt === undefined || at === undefined
        ? 5
        : Math.max(0, Math.min(3_600, Math.round((at - previousAssistantAt) / 1_000)));
      const state = pendingToolTokens === 0
        ? "conversation"
        : pendingToolTokens >= 4_000 || pendingToolTokens >= pendingTokens * 0.8 && pendingTokens >= 2_000
          ? "heavyTool"
          : "tool";
      const block = { state, addedInputTokens: Math.max(1, pendingTokens), outputTokens, delaySeconds };
      allBlocks.push(block);
      sessionBlocks.push(block);
      if (assistantCount === 0) {
        const promptTokens = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
        const fixed = promptTokens - pendingTokens;
        if (fixed >= 500 && fixed <= 50_000) initialInputTokens.push(fixed);
      }
      assistantCount += 1;
      pendingTokens = 0;
      pendingToolTokens = 0;
      previousAssistantAt = at;
    }
    if (assistantCount > 0) sessionLengths.push(assistantCount);
    for (let index = 1; index < sessionBlocks.length; index += 1) {
      const prior = sessionBlocks[index - 1].state;
      const next = sessionBlocks[index].state;
      transitionCounts[prior][next] += 1;
    }
  }

  const blocks = {
    conversation: allBlocks.filter((block) => block.state === "conversation"),
    tool: allBlocks.filter((block) => block.state === "tool"),
    heavyTool: allBlocks.filter((block) => block.state === "heavyTool"),
  };
  const transitions = Object.fromEntries(
    Object.entries(transitionCounts).map(([state, counts]) => {
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      return [state, Object.fromEntries(Object.entries(counts).map(([next, count]) => [next, count / total]))];
    }),
  );

  const observedObservationCalls = observationOutputRatios.length;
  const observedReflectionCalls = reflectionOutputRatios.length;
  const observedStockCompactions = stockSummaryOutputRatios.length;
  if (initialInputTokens.length === 0) initialInputTokens.push(1_350);
  if (observationOutputRatios.length === 0) observationOutputRatios.push(0.04);
  if (reflectionOutputRatios.length === 0) reflectionOutputRatios.push(0.12);
  if (stockSummaryOutputRatios.length === 0) stockSummaryOutputRatios.push(0.075);
  for (const state of Object.keys(blocks)) {
    if (blocks[state].length === 0) throw new Error(`No ${state} blocks found in trace corpus`);
  }
  return {
    profile: {
      sessionLengths,
      initialInputTokens,
      blocks,
      transitions,
      observationOutputRatios,
      reflectionOutputRatios,
      stockSummaryOutputRatios,
    },
    corpus: {
      files: files.length,
      skippedFiles,
      messages: messageCount,
      actorBlocks: allBlocks.length,
      sessions: sessionLengths.length,
      blocks: Object.fromEntries(Object.entries(blocks).map(([state, values]) => [state, values.length])),
      acceptedObservationRecords: observedObservationCalls,
      acceptedReflectionRecords: observedReflectionCalls,
      stockCompactionRecords: observedStockCompactions,
    },
  };
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: sorted.at(-1) ?? 0 };
}

const files = sessionFiles(SESSION_ROOT);
const { profile, corpus } = fitProfile(files);
const common = {
  seeds: Number.parseInt(process.env.MONTE_CARLO_SEEDS ?? "20000", 10),
  baseSeed: Number.parseInt(process.env.MONTE_CARLO_BASE_SEED ?? String(0x51a7c0de), 10),
  contextWindow: 272_000,
  maxOutputTokens: 128_000,
  stockCompactionTriggerTokens: 272_000,
  stockReserveTokens: 16_384,
  stockKeepRecentTokens: 20_000,
  messageTokensTarget: 20_000,
  messageTokensStartObservation: 40_000,
  observationTokensTarget: 20_000,
  observationTokensStartReflection: 40_000,
  reflectionTokensMax: 5_000,
  observationFailureRate: 0.01,
  reflectionFailureRate: 0.01,
  errorWithoutUsageRate: 0.25,
  prices: PRICES,
};
const conditions = {
  "perfect-cache": {
    enabled: true,
    ttlSeconds: Number.MAX_SAFE_INTEGER,
    affinity: 1,
    minimumPrefixTokens: 1_024,
  },
  "warm-cache": { enabled: true, ttlSeconds: 300, affinity: 0.95, minimumPrefixTokens: 1_024 },
  "no-cache": { enabled: false, ttlSeconds: 0, affinity: 0, minimumPrefixTokens: 1_024 },
  "short-ttl": { enabled: true, ttlSeconds: 30, affinity: 0.95, minimumPrefixTokens: 1_024 },
  "low-affinity": { enabled: true, ttlSeconds: 300, affinity: 0.5, minimumPrefixTokens: 1_024 },
  "priced-cache-writes": {
    enabled: true,
    ttlSeconds: 300,
    affinity: 0.95,
    minimumPrefixTokens: 1_024,
    writeMode: "changed-suffix",
  },
};
const reports = Object.fromEntries(
  Object.entries(conditions).map(([name, cache]) => [name, runMonteCarlo(profile, { ...common, cache })]),
);
const output = {
  generatedAt: new Date().toISOString(),
  pricing: PRICES,
  corpus,
  empirical: {
    sessionActorCalls: quantiles(profile.sessionLengths),
    initialFixedInputTokens: quantiles(profile.initialInputTokens),
    addedInputTokens: Object.fromEntries(Object.entries(profile.blocks).map(([state, blocks]) => [state, quantiles(blocks.map((block) => block.addedInputTokens))])),
    actorOutputTokens: quantiles(Object.values(profile.blocks).flat().map((block) => block.outputTokens)),
    delaysSeconds: quantiles(Object.values(profile.blocks).flat().map((block) => block.delaySeconds)),
    observationOutputRatio: quantiles(profile.observationOutputRatios),
    reflectionOutputRatio: quantiles(profile.reflectionOutputRatios),
    stockSummaryOutputRatio: quantiles(profile.stockSummaryOutputRatios),
    transitions: profile.transitions,
  },
  assumptions: [
    "One token-only workload is generated per seed and shared by all three strategies.",
    "The generator samples correlated conversation/tool/heavy-tool blocks and a fitted Markov transition matrix; it retains no trace text.",
    "Session length is sampled empirically without truncating the observed heavy tail.",
    "For this requested counterfactual, stock Pi preflights the next actor prompt and compacts only when it reaches the full 272,000-token context window; it then follows Pi defaults of a 16,384-token summary reserve and 20,000 retained tokens. This intentionally does not reserve GPT 5.6 Sol's 128,000 maximum output allowance from actor input.",
    "Stock summary output ratios are sampled from deduplicated persisted Pi compaction records and capped at 80% of the 16,384-token reserve; split-turn summaries use a structural 4% (100-2,500) because combined compaction usage does not identify its separate call.",
    "Observation output ratios are sampled from accepted local records. No accepted reflection was present, so reflection output uses an explicit 12% input-ratio assumption capped at 5,000 tokens. Memory calls have no cache because the current host does not pass a cache session ID.",
    "A 1% maintenance-attempt failure rate is assumed; one retry succeeds. One quarter of failures are transport errors with no reported usage; other failed calls are charged.",
    "Actor prompt cache reads use an exact surviving prefix, a 1,024-token minimum, condition-specific TTL, and condition-specific affinity. Perfect-cache is an optimistic upper bound with no expiry and full affinity. Every stock or observational rewrite starts a new cache epoch, so the next actor request can reuse only the fixed prompt prefix; rewrite-specific lost cache-read tokens are reported separately from TTL and affinity misses.",
    "The installed catalog lists cache writes at $6.25/M, but local openai-codex responses report zero cache-write tokens. Primary conditions therefore generate none; priced-cache-writes is a sensitivity that prices each changed suffix as a cache write instead of ordinary input.",
    "Quality, correctness, forgotten facts, and work repeated because of compression are intentionally unmodeled.",
  ],
  reports,
};
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
console.error(`Wrote ${REPORT_PATH}`);
