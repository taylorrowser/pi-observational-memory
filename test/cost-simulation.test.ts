import { describe, expect, it } from "vitest";

import {
  generateWorkload,
  runMonteCarlo,
  type EmpiricalProfile,
  type SimulationConfig,
} from "../src/cost-simulation.js";

const profile: EmpiricalProfile = {
  sessionLengths: [4],
  initialInputTokens: [1_000],
  blocks: {
    conversation: [{ state: "conversation", addedInputTokens: 500, outputTokens: 100, delaySeconds: 1 }],
    tool: [{ state: "tool", addedInputTokens: 5_000, outputTokens: 200, delaySeconds: 1 }],
    heavyTool: [{ state: "heavyTool", addedInputTokens: 20_000, outputTokens: 300, delaySeconds: 1 }],
  },
  transitions: {
    conversation: { conversation: 0, tool: 1, heavyTool: 0 },
    tool: { conversation: 0, tool: 0, heavyTool: 1 },
    heavyTool: { conversation: 1, tool: 0, heavyTool: 0 },
  },
  observationOutputRatios: [0.05],
  reflectionOutputRatios: [0.1],
};

const config: SimulationConfig = {
  seeds: 2,
  baseSeed: 42,
  contextWindow: 50_000,
  maxOutputTokens: 10_000,
  stockCompactionTriggerTokens: 50_000,
  stockReserveTokens: 5_000,
  stockKeepRecentTokens: 5_000,
  messageTokensTarget: 5_000,
  messageTokensStartObservation: 10_000,
  observationTokensTarget: 2_000,
  observationTokensStartReflection: 4_000,
  reflectionTokensMax: 1_000,
  observationFailureRate: 0,
  reflectionFailureRate: 0,
  errorWithoutUsageRate: 0,
  cache: { enabled: false, ttlSeconds: 0, affinity: 0, minimumPrefixTokens: 1_024 },
  prices: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, provenance: "test" },
};

describe("cost simulation", () => {
  it("generates the same workload for the same seed and preserves correlated state transitions", () => {
    const first = generateWorkload(profile, 7);
    const second = generateWorkload(profile, 7);

    expect(first).toEqual(second);
    expect(first.blocks.map((block) => block.state)).toEqual([
      "conversation",
      "tool",
      "heavyTool",
      "conversation",
    ]);
  });

  it("is reproducible and compares every strategy over paired workloads", () => {
    const first = runMonteCarlo(profile, config);
    const second = runMonteCarlo(profile, config);

    expect(first).toEqual(second);
    expect(Object.keys(first.strategies)).toEqual([
      "full-history",
      "stock-compaction",
      "observational-memory",
    ]);
    expect(first.strategies["observational-memory"].meanRequests.observation).toBeGreaterThan(0);
    expect(first.strategies["full-history"].maintenanceCost.mean).toBe(0);
  });

  it("prices exact-prefix cache reads at the cache-read rate", () => {
    const cached = runMonteCarlo(profile, {
      ...config,
      seeds: 1,
      cache: { enabled: true, ttlSeconds: 60, affinity: 1, minimumPrefixTokens: 1 },
    });
    const uncached = runMonteCarlo(profile, { ...config, seeds: 1 });

    expect(cached.strategies["full-history"].actorCost.mean).toBeLessThan(
      uncached.strategies["full-history"].actorCost.mean,
    );
  });

  it("counts charged failed maintenance attempts and their retry", () => {
    const report = runMonteCarlo(profile, {
      ...config,
      seeds: 1,
      observationFailureRate: 1,
      errorWithoutUsageRate: 0,
    });
    const memory = report.strategies["observational-memory"];

    expect(memory.meanRetries).toBeGreaterThan(0);
    expect(memory.meanRequests.observation).toBeGreaterThanOrEqual(2);
  });

  it("prices changed cache suffixes in the cache-write sensitivity", () => {
    const unreported = runMonteCarlo(profile, {
      ...config,
      seeds: 1,
      cache: { enabled: true, ttlSeconds: 60, affinity: 1, minimumPrefixTokens: 1 },
      prices: { ...config.prices, cacheWrite: 6.25 },
    });
    const pricedWrites = runMonteCarlo(profile, {
      ...config,
      seeds: 1,
      cache: {
        enabled: true,
        ttlSeconds: 60,
        affinity: 1,
        minimumPrefixTokens: 1,
        writeMode: "changed-suffix",
      },
      prices: { ...config.prices, cacheWrite: 6.25 },
    });

    expect(pricedWrites.strategies["full-history"].actorCost.mean).toBeGreaterThan(
      unreported.strategies["full-history"].actorCost.mean,
    );
  });

  it("lets stock context grow to its explicit compaction trigger instead of reserving maximum output", () => {
    const report = runMonteCarlo({
      ...profile,
      sessionLengths: [3],
      blocks: {
        ...profile.blocks,
        conversation: [{ state: "conversation", addedInputTokens: 15_000, outputTokens: 100, delaySeconds: 1 }],
      },
      transitions: {
        conversation: { conversation: 1, tool: 0, heavyTool: 0 },
        tool: { conversation: 1, tool: 0, heavyTool: 0 },
        heavyTool: { conversation: 1, tool: 0, heavyTool: 0 },
      },
    }, {
      ...config,
      seeds: 1,
      contextWindow: 50_000,
      maxOutputTokens: 40_000,
      stockCompactionTriggerTokens: 50_000,
    });

    expect(report.strategies["stock-compaction"].maximumActorContext.mean).toBeGreaterThan(10_000);
    expect(report.strategies["stock-compaction"].meanRewrites).toBe(0);
  });

  it("reports the actor cache lost to observational rewrites", () => {
    const report = runMonteCarlo(profile, {
      ...config,
      seeds: 1,
      cache: { enabled: true, ttlSeconds: 60, affinity: 1, minimumPrefixTokens: 1 },
    });
    const memory = report.strategies["observational-memory"];

    expect(memory.meanRewrites).toBeGreaterThan(0);
    expect(memory.actorCacheReadRate.mean).toBeLessThan(1);
    expect(memory.meanActorCacheReadTokens).toBeGreaterThan(0);
  });

  it("samples stock summary output ratios from the empirical profile", () => {
    const stockConfig = {
      ...config,
      contextWindow: 25_000,
      maxOutputTokens: 5_000,
      stockCompactionTriggerTokens: 20_000,
      stockReserveTokens: 5_000,
    };
    const lowOutput = runMonteCarlo({ ...profile, stockSummaryOutputRatios: [0.01] }, stockConfig);
    const highOutput = runMonteCarlo({ ...profile, stockSummaryOutputRatios: [0.2] }, stockConfig);

    expect(highOutput.strategies["stock-compaction"].maintenanceCost.mean).toBeGreaterThan(
      lowOutput.strategies["stock-compaction"].maintenanceCost.mean,
    );
  });
});
