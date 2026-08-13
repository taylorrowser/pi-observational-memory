export type WorkloadState = "conversation" | "tool" | "heavyTool";
export type StrategyName = "full-history" | "stock-compaction" | "observational-memory";
export type Operation = "actor" | "stock-summary" | "stock-split-turn" | "observation" | "reflection";

export interface TokenBlock {
  readonly state: WorkloadState;
  readonly addedInputTokens: number;
  readonly outputTokens: number;
  readonly delaySeconds: number;
}

export interface EmpiricalProfile {
  readonly sessionLengths: readonly number[];
  readonly initialInputTokens: readonly number[];
  readonly blocks: Readonly<Record<WorkloadState, readonly TokenBlock[]>>;
  readonly transitions: Readonly<Record<WorkloadState, Readonly<Record<WorkloadState, number>>>>;
  readonly observationOutputRatios: readonly number[];
  readonly reflectionOutputRatios: readonly number[];
  readonly stockSummaryOutputRatios?: readonly number[];
}

export interface PriceSchedule {
  /** USD per million tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly provenance: string;
}

export interface CachePolicy {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly affinity: number;
  readonly minimumPrefixTokens: number;
  /** `changed-suffix` is a priced sensitivity; openai-codex reports `unreported`. */
  readonly writeMode?: "unreported" | "changed-suffix";
}

export interface SimulationConfig {
  readonly seeds: number;
  readonly baseSeed: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** Actor-input size at which stock Pi compacts. Usually the full context window. */
  readonly stockCompactionTriggerTokens: number;
  readonly stockReserveTokens: number;
  readonly stockKeepRecentTokens: number;
  readonly messageTokensTarget: number;
  readonly messageTokensStartObservation: number;
  readonly observationTokensTarget: number;
  readonly observationTokensStartReflection: number;
  readonly reflectionTokensMax: number;
  readonly observationFailureRate: number;
  readonly reflectionFailureRate: number;
  readonly errorWithoutUsageRate: number;
  readonly cache: CachePolicy;
  readonly prices: PriceSchedule;
}

export interface GeneratedWorkload {
  readonly fixedInputTokens: number;
  readonly blocks: readonly TokenBlock[];
}

interface CacheState {
  promptTokens: number;
  epoch: number;
  timestamp: number;
}

interface RequestTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface StrategyResult {
  readonly strategy: StrategyName;
  readonly cost: number;
  readonly actorCost: number;
  readonly maintenanceCost: number;
  readonly maximumActorContext: number;
  /** The strategy crossed the configured actor-input context limit at least once. */
  readonly overflowed: boolean;
  readonly terminalOverflow: boolean;
  readonly overflowRecoveries: number;
  readonly rewrites: number;
  readonly retries: number;
  readonly rejectedRequests: number;
  readonly errorsWithoutUsage: number;
  /** Actor cache-read tokens unavailable specifically because a context rewrite changed the prefix. */
  readonly cacheReadTokensLostToRewrites: number;
  /** Cancellation is not injected by the baseline workload, so this is normally zero. */
  readonly abortedRequests: number;
  readonly requests: Readonly<Record<Operation, RequestTotals>>;
}

export interface DistributionSummary {
  readonly mean: number;
  readonly median: number;
  readonly p90: number;
  readonly p99: number;
}

export interface StrategySummary {
  readonly cost: DistributionSummary;
  readonly actorCost: DistributionSummary;
  readonly maintenanceCost: DistributionSummary;
  readonly maximumActorContext: DistributionSummary;
  readonly actorCacheReadRate: DistributionSummary;
  readonly meanActorCacheReadTokens: number;
  readonly meanActorCacheWriteTokens: number;
  readonly meanCacheReadTokensLostToRewrites: number;
  readonly overflowProbability: number;
  readonly terminalOverflowProbability: number;
  readonly overflowRecoveryProbability: number;
  readonly activationProbability: number;
  readonly meanRewrites: number;
  readonly meanRetries: number;
  readonly meanRejectedRequests: number;
  readonly meanErrorsWithoutUsage: number;
  readonly meanAbortedRequests: number;
  readonly meanRequests: Readonly<Record<Operation, number>>;
}

export interface MonteCarloReport {
  readonly config: SimulationConfig;
  readonly strategies: Readonly<Record<StrategyName, StrategySummary>>;
  readonly pairedCostDifference: {
    readonly stockMinusObservational: DistributionSummary;
    readonly observationalCheaperProbability: number;
    readonly activeWorkloads: {
      readonly count: number;
      readonly probability: number;
      readonly stockMinusObservational: DistributionSummary;
      readonly observationalCheaperProbability: number;
    };
  };
}

const OPERATIONS: readonly Operation[] = [
  "actor",
  "stock-summary",
  "stock-split-turn",
  "observation",
  "reflection",
];
const STRATEGIES: readonly StrategyName[] = [
  "full-history",
  "stock-compaction",
  "observational-memory",
];

class Random {
  private value: number;
  constructor(seed: number) {
    this.value = seed >>> 0;
  }
  next(): number {
    this.value += 0x6d2b79f5;
    let value = this.value;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }
  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("Cannot sample an empty empirical pool");
    return values[Math.min(values.length - 1, Math.floor(this.next() * values.length))] as T;
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

function weightedState(
  random: Random,
  weights: Readonly<Record<WorkloadState, number>>,
): WorkloadState {
  const draw = random.next();
  let cumulative = 0;
  for (const state of ["conversation", "tool", "heavyTool"] as const) {
    cumulative += weights[state];
    if (draw <= cumulative) return state;
  }
  return "heavyTool";
}

/** Generates one strategy-independent workload. All strategies consume this exact object. */
export function generateWorkload(profile: EmpiricalProfile, seed: number): GeneratedWorkload {
  const random = new Random(seed);
  const length = Math.max(1, Math.round(random.pick(profile.sessionLengths)));
  const blocks: TokenBlock[] = [];
  let state: WorkloadState = "conversation";
  for (let index = 0; index < length; index += 1) {
    if (index > 0) state = weightedState(random, profile.transitions[state]);
    blocks.push({ ...random.pick(profile.blocks[state]), state });
  }
  return {
    fixedInputTokens: Math.max(1, Math.round(random.pick(profile.initialInputTokens))),
    blocks,
  };
}

function emptyRequests(): Record<Operation, RequestTotals> {
  return Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ]),
  ) as Record<Operation, RequestTotals>;
}

function request(
  totals: Record<Operation, RequestTotals>,
  operation: Operation,
  promptTokens: number,
  outputTokens: number,
  prices: PriceSchedule,
  cacheRead = 0,
  cacheWrite = 0,
): number {
  const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
  const cost =
    (input * prices.input + outputTokens * prices.output + cacheRead * prices.cacheRead + cacheWrite * prices.cacheWrite) /
    1_000_000;
  const target = totals[operation];
  target.calls += 1;
  target.input += input;
  target.output += outputTokens;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.cost += cost;
  return cost;
}

function actorCache(
  cache: CacheState | undefined,
  policy: CachePolicy,
  random: Random,
  promptTokens: number,
  fixedInputTokens: number,
  epoch: number,
  timestamp: number,
): { read: number; lostToRewrite: number } {
  if (
    !policy.enabled ||
    !cache ||
    timestamp - cache.timestamp > policy.ttlSeconds ||
    !random.chance(policy.affinity)
  ) return { read: 0, lostToRewrite: 0 };
  const potential = Math.min(cache.promptTokens, promptTokens);
  const common = cache.epoch === epoch ? potential : Math.min(fixedInputTokens, promptTokens);
  const read = common >= policy.minimumPrefixTokens ? common : 0;
  const cacheablePotential = potential >= policy.minimumPrefixTokens ? potential : 0;
  return { read, lostToRewrite: Math.max(0, cacheablePotential - read) };
}

function outputFromRatio(random: Random, pool: readonly number[], input: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.round(input * random.pick(pool))));
}

function simulateStrategy(
  strategy: StrategyName,
  workload: GeneratedWorkload,
  profile: EmpiricalProfile,
  config: SimulationConfig,
  seed: number,
): StrategyResult {
  const random = new Random(seed ^ 0x9e3779b9);
  const requests = emptyRequests();
  const actorInputLimit = config.contextWindow;
  let exactTokens = 0;
  let summaryTokens = 0;
  let observationTokens = 0;
  let reflectionTokens = 0;
  let uncoveredTokens = 0;
  let maximumActorContext = 0;
  let overflowed = false;
  let terminalOverflow = false;
  let overflowRecoveries = 0;
  let rewrites = 0;
  let retries = 0;
  let rejectedRequests = 0;
  let errorsWithoutUsage = 0;
  let cacheReadTokensLostToRewrites = 0;
  let epoch = 0;
  let timestamp = 0;
  let cache: CacheState | undefined;

  const maintenance = (
    operation: Exclude<Operation, "actor">,
    input: number,
    output: number,
    failureRate: number,
  ): void => {
    if (random.chance(failureRate)) {
      retries += 1;
      rejectedRequests += 1;
      if (random.chance(config.errorWithoutUsageRate)) {
        errorsWithoutUsage += 1;
      } else {
        request(requests, operation, input, output, config.prices);
      }
    }
    // The single permitted retry is modeled as successful. Failed calls with
    // reported usage are charged above; transport errors without usage are not.
    request(requests, operation, input, output, config.prices);
  };

  for (const block of workload.blocks) {
    timestamp += block.delaySeconds;
    exactTokens += block.addedInputTokens;
    uncoveredTokens += block.addedInputTokens;

    if (strategy === "stock-compaction") {
      const projected = workload.fixedInputTokens + summaryTokens + exactTokens;
      if (projected >= config.stockCompactionTriggerTokens) {
        const retained = Math.min(config.stockKeepRecentTokens, exactTokens);
        const retired = Math.max(0, exactTokens - retained);
        const summaryInput = retired + summaryTokens + 900;
        const summaryOutput = outputFromRatio(
          random,
          profile.stockSummaryOutputRatios ?? [0.075],
          summaryInput,
          Math.floor(config.stockReserveTokens * 0.8),
        );
        maintenance("stock-summary", summaryInput, summaryOutput, 0.01);
        if (
          block.state !== "conversation" &&
          (block.addedInputTokens > config.stockKeepRecentTokens || retained >= exactTokens * 0.7)
        ) {
          const splitInput = Math.min(retained, Math.max(500, Math.round(block.addedInputTokens * 0.6)));
          const splitOutput = Math.max(100, Math.min(2_500, Math.round(splitInput * 0.04)));
          maintenance("stock-split-turn", splitInput + 500, splitOutput, 0.01);
          summaryTokens = summaryOutput + splitOutput;
        } else {
          summaryTokens = summaryOutput;
        }
        exactTokens = retained;
        rewrites += 1;
        epoch += 1;
      }
    }

    if (strategy === "observational-memory" && uncoveredTokens >= config.messageTokensStartObservation) {
      const retired = Math.max(1, uncoveredTokens - config.messageTokensTarget);
      const observationInput = retired + observationTokens + reflectionTokens + 1_000;
      const observationOutput = outputFromRatio(random, profile.observationOutputRatios, retired, 8_000);
      maintenance("observation", observationInput, observationOutput, config.observationFailureRate);
      exactTokens = Math.max(0, exactTokens - retired);
      uncoveredTokens = Math.max(0, uncoveredTokens - retired);
      observationTokens += observationOutput;
      rewrites += 1;
      epoch += 1;

      if (observationTokens >= config.observationTokensStartReflection) {
        const folded = Math.max(1, observationTokens - config.observationTokensTarget);
        const reflectionInput = folded + reflectionTokens + 900;
        const reflectionOutput = outputFromRatio(random, profile.reflectionOutputRatios, folded, config.reflectionTokensMax);
        maintenance("reflection", reflectionInput, reflectionOutput, config.reflectionFailureRate);
        observationTokens = Math.max(0, observationTokens - folded);
        reflectionTokens = reflectionOutput;
        rewrites += 1;
        epoch += 1;
      }
    }

    const promptTokens = strategy === "observational-memory"
      ? workload.fixedInputTokens + exactTokens + observationTokens + reflectionTokens
      : workload.fixedInputTokens + exactTokens + summaryTokens;
    maximumActorContext = Math.max(maximumActorContext, promptTokens);
    if (promptTokens > actorInputLimit) {
      overflowed = true;
      terminalOverflow = true;
      errorsWithoutUsage += 1;
      break;
    }
    const cacheResult = actorCache(
      cache,
      config.cache,
      random,
      promptTokens,
      workload.fixedInputTokens,
      epoch,
      timestamp,
    );
    cacheReadTokensLostToRewrites += cacheResult.lostToRewrite;
    const cacheWrite = config.cache.enabled && config.cache.writeMode === "changed-suffix"
      ? Math.max(0, promptTokens - cacheResult.read)
      : 0;
    request(requests, "actor", promptTokens, block.outputTokens, config.prices, cacheResult.read, cacheWrite);
    cache = { promptTokens, epoch, timestamp };
    exactTokens += block.outputTokens;
    uncoveredTokens += block.outputTokens;
  }

  const actorCost = requests.actor.cost;
  const maintenanceCost = OPERATIONS.filter((operation) => operation !== "actor").reduce(
    (sum, operation) => sum + requests[operation].cost,
    0,
  );
  return {
    strategy,
    cost: actorCost + maintenanceCost,
    actorCost,
    maintenanceCost,
    maximumActorContext,
    overflowed,
    terminalOverflow,
    overflowRecoveries,
    rewrites,
    retries,
    rejectedRequests,
    errorsWithoutUsage,
    cacheReadTokensLostToRewrites,
    abortedRequests: 0,
    requests,
  };
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] as number;
}

function distribution(values: readonly number[]): DistributionSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
  };
}

export function runMonteCarlo(profile: EmpiricalProfile, config: SimulationConfig): MonteCarloReport {
  const results: Record<StrategyName, StrategyResult[]> = {
    "full-history": [],
    "stock-compaction": [],
    "observational-memory": [],
  };
  const paired: number[] = [];
  const activePaired: number[] = [];
  let observationalWins = 0;
  let activeObservationalWins = 0;
  for (let index = 0; index < config.seeds; index += 1) {
    const seed = config.baseSeed + index;
    const workload = generateWorkload(profile, seed);
    const run = Object.fromEntries(
      STRATEGIES.map((strategy, strategyIndex) => [
        strategy,
        simulateStrategy(strategy, workload, profile, config, seed + strategyIndex * 1_000_003),
      ]),
    ) as Record<StrategyName, StrategyResult>;
    for (const strategy of STRATEGIES) results[strategy].push(run[strategy]);
    const difference = run["stock-compaction"].cost - run["observational-memory"].cost;
    paired.push(difference);
    if (difference > 0) observationalWins += 1;
    if (run["stock-compaction"].rewrites > 0 || run["observational-memory"].rewrites > 0) {
      activePaired.push(difference);
      if (difference > 0) activeObservationalWins += 1;
    }
  }

  const summaries = Object.fromEntries(
    STRATEGIES.map((strategy) => {
      const strategyResults = results[strategy];
      const meanRequests = Object.fromEntries(
        OPERATIONS.map((operation) => [
          operation,
          strategyResults.reduce((sum, result) => sum + result.requests[operation].calls, 0) / config.seeds,
        ]),
      ) as Record<Operation, number>;
      return [strategy, {
        cost: distribution(strategyResults.map((result) => result.cost)),
        actorCost: distribution(strategyResults.map((result) => result.actorCost)),
        maintenanceCost: distribution(strategyResults.map((result) => result.maintenanceCost)),
        maximumActorContext: distribution(strategyResults.map((result) => result.maximumActorContext)),
        actorCacheReadRate: distribution(strategyResults.map((result) => {
          const actor = result.requests.actor;
          const promptTokens = actor.input + actor.cacheRead + actor.cacheWrite;
          return promptTokens === 0 ? 0 : actor.cacheRead / promptTokens;
        })),
        meanActorCacheReadTokens: strategyResults.reduce(
          (sum, result) => sum + result.requests.actor.cacheRead,
          0,
        ) / config.seeds,
        meanActorCacheWriteTokens: strategyResults.reduce(
          (sum, result) => sum + result.requests.actor.cacheWrite,
          0,
        ) / config.seeds,
        meanCacheReadTokensLostToRewrites: strategyResults.reduce(
          (sum, result) => sum + result.cacheReadTokensLostToRewrites,
          0,
        ) / config.seeds,
        overflowProbability: strategyResults.filter((result) => result.overflowed).length / config.seeds,
        terminalOverflowProbability: strategyResults.filter((result) => result.terminalOverflow).length / config.seeds,
        overflowRecoveryProbability: strategyResults.filter((result) => result.overflowRecoveries > 0).length / config.seeds,
        activationProbability: strategyResults.filter((result) => result.rewrites > 0).length / config.seeds,
        meanRewrites: strategyResults.reduce((sum, result) => sum + result.rewrites, 0) / config.seeds,
        meanRetries: strategyResults.reduce((sum, result) => sum + result.retries, 0) / config.seeds,
        meanRejectedRequests: strategyResults.reduce((sum, result) => sum + result.rejectedRequests, 0) / config.seeds,
        meanErrorsWithoutUsage: strategyResults.reduce((sum, result) => sum + result.errorsWithoutUsage, 0) / config.seeds,
        meanAbortedRequests: strategyResults.reduce((sum, result) => sum + result.abortedRequests, 0) / config.seeds,
        meanRequests,
      } satisfies StrategySummary];
    }),
  ) as unknown as Record<StrategyName, StrategySummary>;

  return {
    config,
    strategies: summaries,
    pairedCostDifference: {
      stockMinusObservational: distribution(paired),
      observationalCheaperProbability: observationalWins / config.seeds,
      activeWorkloads: {
        count: activePaired.length,
        probability: activePaired.length / config.seeds,
        stockMinusObservational: distribution(activePaired),
        observationalCheaperProbability: activeObservationalWins / Math.max(1, activePaired.length),
      },
    },
  };
}
