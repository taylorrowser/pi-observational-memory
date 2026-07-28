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

## Current answer

Observational memory is economically plausible, but it should not be justified by a universal cost-savings claim. Its robust advantage is bounded actor context; its cost advantage depends mainly on session length, observer price, and compression quality.

Under the balanced 272k-window baseline (12% observation size, observer priced at 20% of the actor), the longest loaded local trace performs four observation calls, lowers modeled cost from $6.12 to $4.28 (-30%), and lowers maximum actor context from 139k to 59k tokens. The other local traces that activate memory save 14–39%; short traces do no memory work and remain cost-neutral. The three synthetic long traces save 22–37%.

The baseline 12% compression break-even observer price ranges from about 0.67× to 3.0× actor rates on activated local traces and 1.3× to 2.4× on the synthetic long traces. The sweep still finds losing regimes: expensive observers plus weak compression can cost roughly 59% more on a shorter activated trace. Explicit cache-write pricing changes the magnitude but does not reverse the central dependence on observer price, compression, and session length.

Context timing is the stronger result. At a 272k window, conventional Pi compaction does not activate on the loaded local traces. In the uninterrupted synthetic tool loop it cannot compact until turn end, after five actor requests have already crossed safe headroom. Proactive observation keeps that trace below headroom. Conversely, hard waits are common when observer completion lag approaches the soft-to-hard watermark gap, so observer latency and watermark calibration belong in the acceptance matrix.

This prototype cannot establish that compressed memory preserves task quality. Issue #9 should evaluate at least short/no-activation, steady, bursty-tool, and uninterrupted-tool-loop traces across the observer-price, 8–25% compression, latency, context-window, watermark, and cache-accounting regimes surfaced here.

## Controls

- `j` / `k`: next / previous trace
- `p`: aggressive / balanced / conservative observational-memory policy
- `w`: context-window size
- `d`: observer completion lag measured in actor calls
- `s`: toggle between the single-policy outcome and the break-even/sensitivity sweep
- `q`: quit

## Current assumptions to challenge

- Actor prompt caching uses a stable-prefix model with 1,024-token cache quanta and separate read/write price buckets. The sensitivity view sweeps cold, partial, and full cache reuse both with ordinary input pricing and with explicit cache-write pricing.
- A memory activation invalidates the actor cache only from the first changed projection segment onward; invalidated prefix volume is reported explicitly.
- Raw and observation watermarks are fractions of the usable actor-input budget, so changing model windows rescales them as required by issue #6. The 272k-window balanced policy is approximately 20k/40k/60k raw target/soft/hard.
- Observer rates start at 20% of actor-model rates.
- Observation text is 12% of retired raw tokens plus a 900-token active-task anchor; reflection output is 35% of folded memory.
- Pi conventional compaction is eligible only after a completed low-level run and keeps an approximately 20k-token exact tail.
- The local trace transform treats growth in provider-reported prompt tokens as new source-transcript volume. It is useful for shape, but it is not exact source tokenization.
- `safe/q` reports two counts: actor requests above `contextWindow - outputReserve`, then requests above an illustrative quality-sensitive threshold of 50% of safe input. Neither count proves provider failure or quality loss.
- The sensitivity surface sweeps observer price and compression ratio. Its broader robustness pass also sweeps model window, watermark policy, observer lag, cache reuse, and explicit cache-write pricing.

These assumptions are surfaced because the prototype's purpose is to find which uncertain variables can reverse the decision. Quality-sensitive context length is modeled as a threshold, not measured task quality: issue #9 owns acceptance thresholds, while #7 should identify the economic regimes those evaluations must cover.
