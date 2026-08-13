# GPT 5.6 Sol cost simulation

This document records the token-flow Monte Carlo experiment used to compare Pi stock compaction with observational memory. It is an economic model, not a model-quality benchmark.

## Headline result

The source-matched run generated at `2026-08-13T17:33:21.379Z` used 20,000 paired workloads. In the primary warm-cache condition, modeled mean cost was **$23.03 with stock compaction** and **$14.10 with observational memory**. The paired mean saving was **$8.93 per workload**, or **$13.54 among workloads where either strategy activated**. Observational memory was cheaper in **82.78% of activated workloads**.

This result includes observational-memory maintenance calls. It also models the downside of incremental rewriting: under warm-cache assumptions, observational memory had an 80.11% actor cache-read rate versus 83.32% for stock, and lost about 358,483 otherwise reusable cache-read tokens per workload specifically to rewrites versus 21,254 for stock. In this model, smaller actor prompts outweighed that cache disadvantage in the mean.

This reference supersedes the earlier exploratory run that treated 144,000 tokens as the stock-compaction boundary. The recorded counterfactual deliberately lets stock Pi grow to GPT 5.6 Sol's full **272,000-token context window** before compacting.

## Question and strategies

For every seed, the simulator generates one model-independent token workload and feeds that same workload to three strategies:

- **Full history:** retain exact history until it no longer fits. This is a boundary reference, not a completed-workload cost baseline for long sessions.
- **Stock compaction:** preflight the next prompt and compact at 272,000 tokens, retaining 20,000 exact tokens and generating a summary. The model includes Pi's possible split-turn summary call.
- **Observational memory:** observe incrementally when uncovered exact messages reach 40,000 tokens, contract that layer toward 20,000, and reflect when active observations reach 40,000 tokens, contracting them toward 20,000.

The stock strategy is a requested mathematical counterfactual. It intentionally does not subtract GPT 5.6 Sol's 128,000 maximum output allowance from the 272,000-token actor-input trigger.

## Empirical workload fit

The runner scans Pi JSONL sessions below `~/.pi/agent/sessions`. It keeps only session directories rooted under the current user's home directory, excluding temporary acceptance/runtime-suite artifacts. It reads token counts and transitions but does not copy message text into the generated report.

The recorded run read 125 sessions with no parse skips:

| Sample | Count |
|---|---:|
| Messages | 52,445 |
| Actor blocks | 21,477 |
| Conversation blocks | 1,182 |
| Ordinary-tool blocks | 17,858 |
| Heavy-tool blocks | 2,437 |
| Deduplicated accepted observations | 26 |
| Accepted reflections | 0 |
| Stock compaction records | 105 |

Session actor-call counts retained the empirical heavy tail: p50 52, p90 273, p99 1,399, maximum 7,429.

The generator is a seeded state machine over conversation, ordinary-tool, and heavy-tool blocks. It samples whole token blocks from the fitted corpus and uses transition probabilities measured only within session boundaries. Session length and fixed prompt input are also sampled empirically. This preserves correlations and bursts better than sampling user, assistant, and tool-result sizes independently.

Observation output/input ratios are sampled from deduplicated accepted records after filtering implausibly small or synthetic records. Their recorded p50/p90/p99 were 3.35%/6.12%/7.68%. Stock-summary ratios come from persisted Pi compaction records; their p50/p90/p99 were 7.47%/14.15%/21.82% and are capped at 80% of Pi's 16,384-token reserve.

No accepted reflection existed in the corpus. Reflection output is therefore an explicit **12% of input assumption**, capped at 5,000 tokens. Reflection economics are assumption-based rather than empirically fitted.

## Pricing

The simulation uses the GPT 5.6 Sol rates in the installed `@earendil-works/pi-ai` 0.81.1 model catalog:

| Usage | USD per million tokens |
|---|---:|
| Uncached input | $5.00 |
| Output | $30.00 |
| Cache read | $0.50 |
| Cache write | $6.25 |

Persisted local `openai-codex` usage independently matched input, output, and cache-read rates, but reported zero cache-write tokens. Primary conditions therefore treat cache writes as unreported. A separate sensitivity prices changed prompt suffixes as cache writes.

## Prompt-cache model

Each actor request reuses the exact surviving serialized prompt prefix when caching is enabled. Cache reuse is controlled by a minimum 1,024-token prefix, TTL, and provider-affinity probability. Actor, stock-summary, observation, and reflection operations have separate request accounting.

Every stock summary or observational observation/reflection changes the actor rewrite epoch. On the next cache-eligible actor request, only the fixed prompt prefix survives. The simulator records the reusable prefix lost specifically to this rewrite separately from misses caused by TTL expiry or affinity.

Current observation and reflection calls receive no cache benefit because the host does not pass a cache session ID for those calls.

## Results

All costs are means over the same 20,000 paired workloads.

| Cache condition | Stock | Observational | Mean stock − observational | Mean saving when active | Observational cheaper when active |
|---|---:|---:|---:|---:|---:|
| Perfect cache | $15.45 | $11.34 | $4.11 | $6.23 | 73.07% |
| Warm cache | $23.03 | $14.10 | $8.93 | $13.54 | 82.78% |
| Short TTL | $34.63 | $18.24 | $16.39 | $24.86 | 90.15% |
| Low affinity | $65.16 | $29.36 | $35.80 | $54.29 | 94.42% |
| No cache | $112.01 | $46.31 | $65.70 | $99.63 | 98.72% |
| Priced cache writes | $25.49 | $15.57 | $9.91 | $15.03 | 82.80% |

Either compression strategy activated in 13,188 workloads (65.94%). Perfect cache is an optimistic upper bound with infinite TTL and full affinity; warm cache is the primary modeled condition (300-second TTL and 95% affinity).

### Warm-cache decomposition

| Metric | Stock | Observational |
|---|---:|---:|
| Mean actor cost | $21.84 | $11.59 |
| Mean maintenance cost | $1.19 | $2.51 |
| Actor cache-read rate | 83.32% | 80.11% |
| Rewrite-specific lost cache-read tokens | 21,254 | 358,483 |
| Mean rewrites | 0.73 | 9.81 |
| Mean maximum actor context | 107,643 | 38,086 |
| p90 maximum actor context | 270,458 | 55,951 |
| p99 maximum actor context | 271,972 | 84,792 |

Observational maintenance was more expensive and disrupted cache prefixes more often. Its modeled advantage came from substantially reducing the actor tokens repeatedly sent after each rewrite.

Three additional 10,000-seed warm-cache runs used base seeds 1001, 2002, and 3003. Mean paired savings were $8.45, $8.14, and $8.20; activated-workload savings were $13.04, $12.53, and $12.65. Observational memory was cheaper in 82.77%, 82.56%, and 82.49% of activated workloads.

## Maintenance failures and accounting

Observation and reflection attempts have an assumed 1% failure probability and one successful retry. One quarter of modeled failures are transport errors with no reported usage; other rejected calls are charged. Stock summary and split-turn calls, observation and reflection calls, retries, cache reads, and cache writes are represented in the request ledger. No cancellation is injected, so modeled aborted-request count is zero.

## Reproduction

From a checkout with local Pi sessions available:

```bash
npm install
npm run build
MONTE_CARLO_SEEDS=20000 node scripts/run-cost-monte-carlo.mjs
```

Useful controls:

```bash
MONTE_CARLO_BASE_SEED=1001 \
MONTE_CARLO_SEEDS=10000 \
MONTE_CARLO_OUTPUT=/tmp/cost-1001.json \
node scripts/run-cost-monte-carlo.mjs
```

The complete report is written to `.cache/cost-monte-carlo-report.json`. `.cache/` is intentionally ignored because the report is reproducible, machine-specific derived data. The implementation is in `src/cost-simulation.ts`, the corpus runner is `scripts/run-cost-monte-carlo.mjs`, and deterministic tests are in `test/cost-simulation.test.ts`.

## Limits

This simulation estimates token flow, provider charges, cache behavior, maintenance frequency, and context pressure. It does **not** measure:

- compression quality or factual correctness;
- forgotten facts;
- repeated work caused by memory loss;
- end-to-end task success;
- latency or user-perceived responsiveness; or
- how a provider might change undocumented cache behavior.

The paired workload deliberately holds generated token traffic fixed across strategies. Real agents may produce different future actions after receiving a stock summary or observational memory. The result is therefore evidence about modeled economics and context shape, not a universal claim that one memory strategy yields better answers.
