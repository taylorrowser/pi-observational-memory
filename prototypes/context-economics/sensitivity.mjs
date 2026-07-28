// PROTOTYPE: parameter sweeps for finding economic break-even regions.

import {
  POLICY_PRESETS,
  resolvePolicy,
  simulateFullReplay,
  simulateObservationalMemory,
  simulatePiCompaction,
} from "./model.mjs";

export const OBSERVER_MULTIPLIERS = [0.05, 0.2, 0.5, 1];
export const COMPRESSION_RATIOS = [0.05, 0.12, 0.25, 0.4];

function observerRates(actorRates, multiplier) {
  return Object.fromEntries(
    Object.entries(actorRates).map(([key, value]) => [key, value * multiplier]),
  );
}

export function withObserverAssumptions(config, multiplier, compression) {
  return {
    ...config,
    observerRateMultiplier: multiplier,
    observerRates: observerRates(config.actorRates, multiplier),
    observationCompression: compression,
  };
}

export function breakEvenGrid(trace, config) {
  const full = simulateFullReplay(trace, config);
  const pi = simulatePiCompaction(trace, config);
  const conventionalCost = Math.min(full.totalCost, pi.totalCost);
  const rows = COMPRESSION_RATIOS.map((compression) => {
    const cells = OBSERVER_MULTIPLIERS.map((multiplier) => {
      const om = simulateObservationalMemory(
        trace,
        withObserverAssumptions(config, multiplier, compression),
      );
      return {
        multiplier,
        cost: om.totalCost,
        deltaPercent: conventionalCost === 0
          ? 0
          : ((om.totalCost - conventionalCost) / conventionalCost) * 100,
        safe: om.overBudgetCalls === 0,
        hardWaits: om.hardWaits,
      };
    });

    const unitRate = simulateObservationalMemory(
      trace,
      withObserverAssumptions(config, 1, compression),
    );
    const breakEvenMultiplier = unitRate.memoryCost === 0
      ? Number.POSITIVE_INFINITY
      : (conventionalCost - unitRate.actorCost) / unitRate.memoryCost;

    return { compression, cells, breakEvenMultiplier };
  });

  return { conventionalCost, rows };
}

export function robustnessSweep(trace, config) {
  const windows = [64_000, 128_000, 272_000];
  const delays = [0, 2, 5, 10];
  const cacheRegimes = [
    { cacheReuseFactor: 0, cacheWriteFraction: 0, group: "read-priced" },
    { cacheReuseFactor: 0.5, cacheWriteFraction: 0, group: "read-priced" },
    { cacheReuseFactor: 1, cacheWriteFraction: 0, group: "read-priced" },
    { cacheReuseFactor: 0, cacheWriteFraction: 1, group: "explicit-write" },
    { cacheReuseFactor: 0.5, cacheWriteFraction: 1, group: "explicit-write" },
    { cacheReuseFactor: 1, cacheWriteFraction: 1, group: "explicit-write" },
  ];
  const observerMultipliers = [0.1, 0.2, 0.5, 1];
  const compressionRatios = [0.08, 0.12, 0.25];
  let cases = 0;
  let cheaper = 0;
  let safe = 0;
  let qualityPressureCases = 0;
  let qualityBetter = 0;
  let noHardWait = 0;
  const cacheGroups = {
    "read-priced": { cases: 0, cheaper: 0, deltaTotal: 0 },
    "explicit-write": { cases: 0, cheaper: 0, deltaTotal: 0 },
  };
  let bestDelta = Number.POSITIVE_INFINITY;
  let worstDelta = Number.NEGATIVE_INFINITY;

  for (const contextWindow of windows) {
    for (const policy of POLICY_PRESETS) {
      for (const observerDelayCalls of delays) {
        for (const cacheRegime of cacheRegimes) {
          const conventionalConfig = {
            ...config,
            ...resolvePolicy(policy, contextWindow - config.outputReserve),
            contextWindow,
            observerDelayCalls,
            cacheReuseFactor: cacheRegime.cacheReuseFactor,
            cacheWriteFraction: cacheRegime.cacheWriteFraction,
          };
          const full = simulateFullReplay(trace, conventionalConfig);
          const pi = simulatePiCompaction(trace, conventionalConfig);
          const conventionalCost = Math.min(full.totalCost, pi.totalCost);
          const conventionalQualityRisk = Math.min(full.qualityRiskCalls, pi.qualityRiskCalls);

          for (const multiplier of observerMultipliers) {
            for (const compression of compressionRatios) {
              const om = simulateObservationalMemory(
                trace,
                withObserverAssumptions(conventionalConfig, multiplier, compression),
              );
              const delta = conventionalCost === 0
                ? 0
                : ((om.totalCost - conventionalCost) / conventionalCost) * 100;
              cases += 1;
              const isCheaper = Number(delta <= 0);
              cheaper += isCheaper;
              cacheGroups[cacheRegime.group].cases += 1;
              cacheGroups[cacheRegime.group].cheaper += isCheaper;
              cacheGroups[cacheRegime.group].deltaTotal += delta;
              safe += Number(om.overBudgetCalls === 0);
              if (conventionalQualityRisk > 0) {
                qualityPressureCases += 1;
                qualityBetter += Number(om.qualityRiskCalls < conventionalQualityRisk);
              }
              noHardWait += Number(om.hardWaits === 0);
              bestDelta = Math.min(bestDelta, delta);
              worstDelta = Math.max(worstDelta, delta);
            }
          }
        }
      }
    }
  }

  return {
    cases,
    cheaper,
    safe,
    qualityPressureCases,
    qualityBetter,
    noHardWait,
    cacheGroups,
    bestDelta,
    worstDelta,
  };
}
