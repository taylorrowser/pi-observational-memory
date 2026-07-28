Run with: `node prototypes/context-economics/cli.mjs`

# PROTOTYPE — Context economics explorer

This throwaway logic prototype asks:

> Across representative long Pi conversations, where do full-history replay, Pi's conventional compaction, and observational memory break even on actor cost, observer cost, prompt-cache reuse, and context safety—and how do the target/soft/hard watermarks change that answer?

It is an exploratory model for [issue #7](https://github.com/taylorrowser/pi-observational-memory/issues/7), not production extension code and not benchmark evidence.

## Inputs

The explorer mixes:

- aggregate request token/cost shapes loaded from this repository's local Pi JSONL sessions; and
- synthetic steady, bursty-tool, and uninterrupted-tool-loop traces that extend beyond the local traces' observed context lengths.

The loader retains no conversation text. It derives only call count, model, token usage, cost, stop reason, and monotonic prompt-growth deltas in memory. Local session data is neither copied into the repository nor written by the prototype.

## Controls

- `j` / `k`: next / previous trace
- `p`: aggressive / balanced / conservative observational-memory policy
- `w`: context-window size
- `d`: observer completion lag measured in actor calls
- `q`: quit

## Current assumptions to challenge

- Actor prompt caching uses a stable-prefix model with 1,024-token cache quanta.
- A memory activation invalidates the actor cache only from the first changed projection segment onward.
- Observer rates start at 20% of actor-model rates.
- Observation output is 12% of retired raw tokens; reflection output is 35% of folded memory.
- Pi conventional compaction is eligible only after a completed low-level run and keeps an approximately 20k-token exact tail.
- The local trace transform treats growth in provider-reported prompt tokens as new source-transcript volume. It is useful for shape, but it is not exact source tokenization.
- `risk` counts actor requests above `contextWindow - outputReserve`; it does not claim those requests necessarily failed at the provider.

These assumptions are surfaced because the prototype's purpose is to find which uncertain variables can reverse the decision. Quality is deliberately absent: issue #9 owns acceptance thresholds, while #7 should identify the economic regimes that those evaluations must cover.
