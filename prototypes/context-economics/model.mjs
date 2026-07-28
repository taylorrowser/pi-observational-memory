// PROTOTYPE: pure economics model for issue #7. Not production extension code.

export const POLICY_PRESETS = [
  {
    name: "aggressive",
    rawTarget: 12_000,
    rawSoft: 24_000,
    rawHard: 40_000,
    observationTarget: 14_000,
    observationHigh: 28_000,
  },
  {
    name: "balanced",
    rawTarget: 20_000,
    rawSoft: 40_000,
    rawHard: 60_000,
    observationTarget: 20_000,
    observationHigh: 40_000,
  },
  {
    name: "conservative",
    rawTarget: 32_000,
    rawSoft: 64_000,
    rawHard: 96_000,
    observationTarget: 32_000,
    observationHigh: 64_000,
  },
];

export function defaultConfig(trace, overrides = {}) {
  const actorRates = overrides.actorRates ?? trace.rates ?? {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 5,
  };
  const observerRateMultiplier = overrides.observerRateMultiplier ?? 0.2;
  const observerRates = overrides.observerRates ?? Object.fromEntries(
    Object.entries(actorRates).map(([key, value]) => [key, value * observerRateMultiplier]),
  );

  return {
    contextWindow: 272_000,
    outputReserve: 16_384,
    qualityThresholdFraction: 0.5,
    fixedTokens: trace.fixedTokens ?? 5_000,
    cacheQuantum: 1_024,
    cacheReuseFactor: 1,
    cacheWriteFraction: 0,
    actorRates,
    observerRateMultiplier,
    observerRates,
    piKeepRecent: 20_000,
    piSummaryCompression: 0.15,
    piSummaryMax: 8_000,
    observerDelayCalls: 2,
    observerPromptTokens: 1_000,
    previousObserverTokens: 2_000,
    observationCompression: 0.12,
    anchorTokens: 900,
    reflectionCompression: 0.35,
    ...POLICY_PRESETS[1],
    ...overrides,
  };
}

function tokenCost(tokens, rate) {
  return (tokens * (rate ?? 0)) / 1_000_000;
}

function billRequest({
  projection,
  previousProjection,
  outputTokens,
  config,
  rates,
  maxCacheRead = Number.POSITIVE_INFINITY,
}) {
  const totalInput = projection.reduce((sum, segment) => sum + segment.tokens, 0);
  const previousInput = previousProjection.reduce((sum, segment) => sum + segment.tokens, 0);
  const stablePrefix = commonPrefixTokens(previousProjection, projection);
  const cacheEligible = Math.min(
    maxCacheRead,
    Math.floor(stablePrefix / config.cacheQuantum) * config.cacheQuantum,
  );
  const cacheRead = Math.round(cacheEligible * config.cacheReuseFactor);
  const invalidatedPrefix = Math.max(0, previousInput - stablePrefix);
  const uncached = Math.max(0, totalInput - cacheRead);
  const cacheWrite = Math.round(uncached * config.cacheWriteFraction);
  const input = uncached - cacheWrite;
  const cost =
    tokenCost(input, rates.input) +
    tokenCost(cacheRead, rates.cacheRead) +
    tokenCost(cacheWrite, rates.cacheWrite) +
    tokenCost(outputTokens, rates.output);

  return {
    totalInput,
    input,
    cacheRead,
    cacheWrite,
    invalidatedPrefix,
    output: outputTokens,
    cost,
  };
}

function commonPrefixTokens(left = [], right = []) {
  let total = 0;
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index].id !== right[index].id) break;
    total += Math.min(left[index].tokens, right[index].tokens);
    if (left[index].tokens !== right[index].tokens) break;
  }
  return total;
}

function emptyMetrics(strategy) {
  return {
    strategy,
    actorInput: 0,
    actorOutput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    memoryInput: 0,
    memoryOutput: 0,
    actorCost: 0,
    memoryCost: 0,
    maxContext: 0,
    overBudgetCalls: 0,
    qualityRiskCalls: 0,
    invalidatedPrefix: 0,
    contractions: 0,
    hardWaits: 0,
    contextSeries: [],
  };
}

function recordActor(metrics, bill, safeInput, qualityThreshold) {
  metrics.actorInput += bill.input;
  metrics.actorOutput += bill.output;
  metrics.cacheRead += bill.cacheRead;
  metrics.cacheWrite += bill.cacheWrite;
  metrics.invalidatedPrefix += bill.invalidatedPrefix;
  metrics.actorCost += bill.cost;
  metrics.maxContext = Math.max(metrics.maxContext, bill.totalInput);
  metrics.overBudgetCalls += Number(bill.totalInput > safeInput);
  metrics.qualityRiskCalls += Number(bill.totalInput > qualityThreshold);
  metrics.contextSeries.push(bill.totalInput);
}

function recordMemory(metrics, bill) {
  metrics.memoryInput += bill.input + bill.cacheRead + bill.cacheWrite;
  metrics.memoryOutput += bill.output;
  metrics.memoryCost += bill.cost;
}

function rawSegment(call, index) {
  return { id: `raw-${index}`, tokens: Math.max(0, call.sourceDelta ?? 0) };
}

function projection(fixedTokens, summarySegments, rawSegments) {
  return [
    { id: "fixed", tokens: fixedTokens },
    ...summarySegments,
    ...rawSegments.filter((segment) => segment.tokens > 0),
  ];
}

export function simulateFullReplay(trace, config) {
  const metrics = emptyMetrics("Full replay");
  const raw = [];
  let previousProjection = [];
  const safeInput = config.contextWindow - config.outputReserve;
  const qualityThreshold = safeInput * config.qualityThresholdFraction;

  trace.calls.forEach((call, index) => {
    raw.push(rawSegment(call, index));
    const current = projection(config.fixedTokens, [], raw);
    const bill = billRequest({
      projection: current,
      previousProjection,
      outputTokens: call.outputTokens,
      config,
      rates: config.actorRates,
      maxCacheRead: call.observedCacheRead,
    });
    recordActor(metrics, bill, safeInput, qualityThreshold);
    previousProjection = current;
  });

  return finalize(metrics);
}

export function simulatePiCompaction(trace, config) {
  const metrics = emptyMetrics("Pi compaction");
  let raw = [];
  let summary = null;
  let summaryVersion = 0;
  let previousProjection = [];
  const safeInput = config.contextWindow - config.outputReserve;
  const qualityThreshold = safeInput * config.qualityThresholdFraction;

  trace.calls.forEach((call, index) => {
    raw.push(rawSegment(call, index));
    const current = projection(config.fixedTokens, summary ? [summary] : [], raw);
    const bill = billRequest({
      projection: current,
      previousProjection,
      outputTokens: call.outputTokens,
      config,
      rates: config.actorRates,
      maxCacheRead: call.observedCacheRead,
    });
    recordActor(metrics, bill, safeInput, qualityThreshold);
    previousProjection = current;

    if (call.turnEnd && bill.totalInput > safeInput) {
      const kept = [];
      let keptTokens = 0;
      for (let cursor = raw.length - 1; cursor >= 0; cursor -= 1) {
        kept.unshift(raw[cursor]);
        keptTokens += raw[cursor].tokens;
        if (keptTokens >= config.piKeepRecent) break;
      }
      const retiredCount = raw.length - kept.length;
      const retired = raw.slice(0, retiredCount);
      const retiredTokens = retired.reduce((sum, segment) => sum + segment.tokens, 0);
      const previousSummaryTokens = summary?.tokens ?? 0;
      const memoryInput = retiredTokens + previousSummaryTokens + config.observerPromptTokens;
      const memoryOutput = Math.min(
        config.piSummaryMax,
        Math.max(500, Math.round((retiredTokens + previousSummaryTokens) * config.piSummaryCompression)),
      );
      const memoryBill = billRequest({
        projection: [{ id: `pi-summary-input-${summaryVersion}`, tokens: memoryInput }],
        previousProjection: [],
        outputTokens: memoryOutput,
        config,
        rates: config.actorRates,
      });
      recordMemory(metrics, memoryBill);
      summaryVersion += 1;
      summary = { id: `pi-summary-${summaryVersion}`, tokens: memoryOutput };
      raw = kept;
      metrics.contractions += 1;
    }
  });

  return finalize(metrics);
}

function selectFrozenPrefix(raw, target) {
  const total = raw.reduce((sum, segment) => sum + segment.tokens, 0);
  let remaining = total;
  const ids = [];
  let selectedTokens = 0;
  for (const segment of raw) {
    if (remaining <= target) break;
    ids.push(segment.id);
    selectedTokens += segment.tokens;
    remaining -= segment.tokens;
  }
  return { ids, selectedTokens };
}

export function simulateObservationalMemory(trace, config) {
  const metrics = emptyMetrics("Observational memory");
  let raw = [];
  let observations = [];
  let reflection = null;
  let anchor = null;
  let pipeline = null;
  let observationVersion = 0;
  let reflectionVersion = 0;
  let previousActorProjection = [];
  let previousObserverProjection = [];
  const safeInput = config.contextWindow - config.outputReserve;
  const qualityThreshold = safeInput * config.qualityThresholdFraction;

  function activeProjection() {
    return projection(
      config.fixedTokens,
      [reflection, ...observations, anchor].filter(Boolean),
      raw,
    );
  }

  function launchIfDue() {
    const rawTokens = raw.reduce((sum, segment) => sum + segment.tokens, 0);
    if (pipeline || rawTokens < config.rawSoft) return false;
    const frozen = selectFrozenPrefix(raw, config.rawTarget);
    if (frozen.ids.length === 0) return false;
    pipeline = { ...frozen, remainingCalls: config.observerDelayCalls };
    return true;
  }

  function activatePipeline() {
    const selected = new Set(pipeline.ids);
    raw = raw.filter((segment) => !selected.has(segment.id));
    const observerInput =
      pipeline.selectedTokens +
      Math.min(
        config.previousObserverTokens,
        observations.reduce((sum, segment) => sum + segment.tokens, 0),
      ) +
      config.observerPromptTokens;
    const observerOutput = Math.max(
      200,
      Math.round(pipeline.selectedTokens * config.observationCompression),
    );
    observationVersion += 1;
    const observerProjection = [
      { id: "observer-prompt", tokens: config.observerPromptTokens },
      { id: `observer-source-${observationVersion}`, tokens: observerInput - config.observerPromptTokens },
    ];
    const observerBill = billRequest({
      projection: observerProjection,
      previousProjection: previousObserverProjection,
      outputTokens: observerOutput,
      config,
      rates: config.observerRates,
    });
    recordMemory(metrics, observerBill);
    previousObserverProjection = observerProjection;
    observations.push({ id: `observation-${observationVersion}`, tokens: observerOutput });
    anchor = { id: `anchor-${observationVersion}`, tokens: config.anchorTokens };
    metrics.contractions += 1;
    pipeline = null;

    const observationTokens = observations.reduce((sum, segment) => sum + segment.tokens, 0);
    if (observationTokens >= config.observationHigh) {
      let remaining = observationTokens;
      const folded = [];
      while (observations.length > 0 && remaining > config.observationTarget) {
        const segment = observations.shift();
        folded.push(segment);
        remaining -= segment.tokens;
      }
      const foldedTokens = folded.reduce((sum, segment) => sum + segment.tokens, 0);
      const reflectionInput = foldedTokens + (reflection?.tokens ?? 0) + config.observerPromptTokens;
      const reflectionOutput = Math.max(
        500,
        Math.round((foldedTokens + (reflection?.tokens ?? 0)) * config.reflectionCompression),
      );
      reflectionVersion += 1;
      const reflectionBill = billRequest({
        projection: [{ id: `reflection-input-${reflectionVersion}`, tokens: reflectionInput }],
        previousProjection: [],
        outputTokens: reflectionOutput,
        config,
        rates: config.observerRates,
      });
      recordMemory(metrics, reflectionBill);
      reflection = { id: `reflection-${reflectionVersion}`, tokens: reflectionOutput };
    }
  }

  trace.calls.forEach((call, index) => {
    if (pipeline) {
      pipeline.remainingCalls -= 1;
      if (pipeline.remainingCalls <= 0) activatePipeline();
    }

    raw.push(rawSegment(call, index));
    launchIfDue();

    let current = activeProjection();
    const rawTokens = raw.reduce((sum, segment) => sum + segment.tokens, 0);
    if (pipeline && (rawTokens >= config.rawHard || sumTokens(current) > safeInput)) {
      metrics.hardWaits += 1;
      activatePipeline();
      launchIfDue();
      current = activeProjection();
    }

    const bill = billRequest({
      projection: current,
      previousProjection: previousActorProjection,
      outputTokens: call.outputTokens,
      config,
      rates: config.actorRates,
      maxCacheRead: call.observedCacheRead,
    });
    recordActor(metrics, bill, safeInput, qualityThreshold);
    previousActorProjection = current;
  });

  return finalize(metrics);
}

function sumTokens(segments) {
  return segments.reduce((sum, segment) => sum + segment.tokens, 0);
}

function finalize(metrics) {
  return {
    ...metrics,
    totalCost: metrics.actorCost + metrics.memoryCost,
    totalInput: metrics.actorInput + metrics.cacheRead + metrics.cacheWrite + metrics.memoryInput,
  };
}

export function compareStrategies(trace, config) {
  return [
    simulateFullReplay(trace, config),
    simulatePiCompaction(trace, config),
    simulateObservationalMemory(trace, config),
  ];
}
