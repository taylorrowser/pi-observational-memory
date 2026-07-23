# Understand Mastra’s observational memory design

Researched on 2026-07-23 against the current `mastra-ai/mastra` `main` snapshot at commit [`cadd3a276f8e0026e3c84cffe935538419cb890c`](https://github.com/mastra-ai/mastra/commit/cadd3a276f8e0026e3c84cffe935538419cb890c). This note uses first-party Mastra docs, source, tests/examples, changelog entries, and Mastra’s in-repo benchmark harness/configs only. Treat prompt wording, defaults, and experimental scope behavior here as versioned implementation details, not timeless theory. [OM docs][om-docs] [memory overview][memory-overview] [memory changelog OM][chg-om] [memory changelog async][chg-async]

## Executive answer

Mastra’s “observational memory” (OM) is not ordinary chat summarization. It is a layered memory protocol in which the main actor keeps a **recent exact raw tail** of messages, while a separate **Observer** incrementally turns older raw transcript into a durable **observation log**, and a separate **Reflector** periodically rewrites that log into denser **reflection generations** when the observation layer itself gets too large. Continuity is improved not just by compression, but by also extracting and reinjecting explicit **`current-task`** and **`suggested-response`** hints, preserving recent verbatim turns, and optionally retaining source ranges plus a `recall` tool for exact raw recovery. [om-index][om-index] [om-docs][om-docs] [observer-prompt][observer-prompt] [reflector-prompt][reflector-prompt] [get-context][get-context] [sync-persist][sync-persist]

The core idea looks portable: **compress old context into a durable, incrementally updated second transcript; keep a raw recency tail; preserve explicit continuity state; and only re-condense when the compressed layer itself grows too large**. Many other details are Mastra-specific and currently unstable: XML prompt/output format, priority emojis, default Gemini models and temperatures, exact token thresholds/ratios, prompt-cache TTL heuristics, thread-metadata storage for continuity hints, and resource-scope multi-thread behavior, which the docs still mark experimental. [observer-prompt][observer-prompt] [om-defaults][om-defaults] [om-docs-scopes][om-docs-scopes] [om-ctor][om-ctor]

## Source snapshot and stability caveats

- OM is documented as added in `@mastra/memory@1.1.0`; async buffering became the default in `1.2.0`; token-tiered observer/reflector routing via `ModelByInputTokens` was added in `1.10.0`. That means any “how Mastra works” statement needs a version/date qualifier. [OM docs][om-docs] [chg-om][chg-om] [chg-async][chg-async] [om-docs-model-tier][om-docs-model-tier]
- The current docs still describe `scope: 'resource'` as **experimental**, warn that it can mix simultaneous thread continuity in awkward ways, and note that async buffering is unsupported there. [om-docs-scopes][om-docs-scopes] [om-docs-async][om-docs-async] [voice-memory-example][voice-memory-example]
- The prompts, thresholds, retry budget, and default models are all directly encoded in source and changelog, so later work should treat them as **current implementation choices**, not abstract necessities. [observer-prompt][observer-prompt] [reflector-prompt][reflector-prompt] [om-defaults][om-defaults] [retry][retry]

## 1. Conceptual distinction: raw conversation vs observations vs reflected/updated memory

| Layer | What it is | Fidelity | Who produces it | What the main model sees |
| --- | --- | --- | --- | --- |
| Raw conversation | Persisted user/assistant/tool messages in threads/resources | Exact | The normal agent loop and memory persistence | Under OM, only the **unobserved** tail is loaded into active context; before first observation, that can still be the whole backlog. [message-history][message-history] [get-context][get-context] |
| Observations | A durable free-form log distilled from raw messages | Lossy but task-oriented | Observer | The actor sees **active observations** as injected system context, plus reinjected continuity metadata. [om-index][om-index] [OM docs][om-docs] [get-context][get-context] |
| Reflections | A denser rewrite of accumulated observations when observations themselves get too large | Lossier than observations, intended to preserve essentials | Reflector | The actor sees the latest active generation; older generations remain history in storage. [OM docs][om-docs] [reflector-prompt][reflector-prompt] [inmemory-om][inmemory-om] |
| Working memory | Separate small structured or markdown state for always-relevant facts | Structured, not transcript-like | Main agent or OM-managed extractor | Optional additional context; not the same thing as OM reflections. [working-memory-docs][working-memory-docs] [om-docs-working-memory][om-docs-working-memory] |

Three distinctions matter most:

1. **Raw conversation is the canonical transcript.** OM depends on stored raw history, and retrieval mode can point observations back to source message ranges. [message-history][message-history] [OM docs][om-docs] [om-constants][om-constants]
2. **Observations are not “memory updates” in the working-memory sense.** They are a free-form event log, optimized for continuity and recency-aware reasoning, not a small schema-first scratchpad. The docs explicitly position working memory as small structured state and OM as long-running event memory. [working-memory-docs][working-memory-docs] [om-docs-compare][om-docs-compare]
3. **Reflections are not just new observations.** Reflection creates a new memory generation from the observation log, incrementing `generationCount`, rather than merely appending more observation lines. [reflector-prompt][reflector-prompt] [inmemory-om][inmemory-om]

A useful translation for Pi is:

- **raw conversation** = exact transcript/tool trace,
- **observations** = compressed narrative/event memory,
- **reflected memory** = compressed memory-of-memory,
- **updated memory** = separate structured state such as user/project facts, if you want that layer at all. [OM docs][om-docs] [working-memory-docs][working-memory-docs]

## 2. Roles, prompts, and what each sub-agent is for

### Observer

Mastra’s own source describes a three-agent architecture: **Actor** sees observations plus recent unobserved messages, **Observer** extracts observations when history exceeds threshold, and **Reflector** condenses observations when they exceed threshold. [om-index][om-index]

The Observer prompt frames itself as “the memory consciousness of an AI assistant” and says its observations may become “the ONLY information the assistant has about past interactions.” It is required to output XML-structured `<observations>`, `<current-task>`, and `<suggested-response>` (plus optional `<thread-title>`), and in single-thread mode it is told **not** to emit thread markup because thread attribution is handled externally. [observer-prompt][observer-prompt]

The Observer’s extraction instructions are opinionated, not generic theory: distinguish user assertions from questions, preserve dates and roles, keep unusual wording, preserve concrete assistant outputs, track completed work with `✅`, and prefer concrete outcomes over workflow meta-noise. Those instructions are clearly part of Mastra’s present product philosophy, but their exact wording and formatting conventions are incidental to this implementation. [observer-prompt][observer-prompt]

The Observer also receives prior continuity metadata: previous observations, prior `current-task`, prior `suggested-response`, optional prior thread title, and prior extractor values. When previous observations were truncated for budget reasons, the prompt explicitly says “The main agent still has full memory context outside this observer window.” [observer-task-prompt][observer-task-prompt]

### Reflector

The Reflector prompt is also framed as a memory-consciousness role, but one level up: it “reflect[s] on all the observations,” reorganizes them, draws connections, tries to notice when the agent got off track, and is warned that its reflection may become “THE ENTIRE memory system.” It is instructed to preserve dates, completion markers, resolved outcomes, and user assertions, while condensing older observations more aggressively than newer ones. [reflector-prompt][reflector-prompt]

The Reflector has explicit compression escalation logic. If a reflection remains too large, the system retries with stronger compression guidance levels rather than silently accepting overlong output. That escalation is implementation-specific, but the deeper invariant is important: **reflection is allowed to become more abstract than observation, but it is still supposed to preserve the information needed to continue the work.** [reflector-prompt][reflector-prompt] [om-docs-model-note][om-docs-model-note]

## 3. Lifecycle and timing

## 3.1 Thread scope (default): asynchronous when possible

Current docs and source agree on the default thread-scoped lifecycle:

- observe when raw message history reaches **30k** tokens by default,
- reflect when active observations reach **40k** tokens by default,
- buffer observation work every **20%** of `messageTokens` by default,
- activate buffered observations at **80%** removal / **20%** retention by default,
- start buffered reflection at **50%** of the reflection threshold by default. [om-defaults][om-defaults] [OM docs][om-docs] [om-docs-async][om-docs-async] [chg-async][chg-async]

With async buffering enabled, the Observer can pre-compute buffered chunks during conversation growth, then activate those chunks instantly once the threshold is crossed; if buffering falls behind, `blockAfter` forces a synchronous observation as a last resort. [om-docs-async][om-docs-async] [om-ctor][om-ctor] [inmemory-om][inmemory-om]

Mastra also supports **early activation** before the normal token threshold, keyed either to idle time (`activateAfterIdle`) or to a provider/model change (`activateOnProviderChange`). The docs explicitly tie this to prompt-cache economics: activate before the next uncached request so the next prompt uses a smaller compressed prefix. [OM docs][om-docs] [om-docs-async][om-docs-async]

## 3.2 Resource scope: synchronous and experimental

Resource scope shares observations across all threads for a resource, but the docs still mark it experimental and warn that each thread becomes a “perspective on all threads for the resource.” The docs also warn that all unobserved messages across all threads are processed together and can therefore be slow. [om-docs-scopes][om-docs-scopes]

The source goes further: unless the user explicitly tries to configure async behavior (which later validation rejects), the constructor disables async buffering in resource scope. The docs likewise state that async buffering is automatically disabled there. [om-ctor][om-ctor] [om-docs-async][om-docs-async]

That is why the first-party voice-agent example describes OM as running **inline** in resource scope: once unobserved messages cross `messageTokens`, the Observer blocks the turn, so the example raises the threshold and prefers off-call summarization for user experience reasons. [voice-memory-example][voice-memory-example] [voice-readme][voice-readme]

## 3.3 Manual and end-of-sequence operations

Mastra exposes manual `observe()`, `activate()`, `buffer()`, `reflect()`, and `finalize()` style APIs. `finalize()` waits for in-flight buffering, activates any remaining chunks, observes if still needed, and then reflects if needed, producing a clean terminal state; the LongMemEval configs also include a distinct “shortcut OM” variant that does a single final pass rather than full in-loop OM. [om-ctor][om-ctor] [finalize][finalize] [longmemeval-config][longmemeval-config]

This matters because it separates **theory** from **deployment policy**. The theory is layered compression with continuity hints. The deployment policy can still choose “observe continuously,” “observe in background chunks,” or “do one explicit finalize at the end.” [finalize][finalize] [longmemeval-config][longmemeval-config]

## 4. Buffer, tail, activation, and observer-window behavior

Mastra has two distinct “tail” mechanisms.

### 4.1 Actor raw-tail retention after activation

Buffered observation activation is not “replace everything older than threshold.” The storage activation logic computes a target boundary, prefers an over-boundary that gets below the retention floor, but falls back if that would overshoot too hard or leave too little raw context. It explicitly enforces a minimum remaining raw tail of `min(1000 tokens, retentionFloor)` and keeps only the **most recent activated chunk’s** continuity hints. [inmemory-om][inmemory-om] [om-docs-async][om-docs-async]

So the actor’s continuity claim is partly structural: **old raw transcript can be removed, but a recent exact tail remains.** That is much closer to “recency tail + compressed past” than to a one-shot summary swap. [om-index][om-index] [inmemory-om][inmemory-om]

### 4.2 Observer previous-observation tail truncation

`observation.previousObserverTokens` controls how much prior observation history the **Observer** itself sees on later passes. The docs say the default is about **2000** tokens of recent observations; the source implements this by optionally replacing already-reflected head content with the buffered reflection summary, then tail-truncating to budget while preferentially keeping recent lines and important older `🔴` / `✅` lines. [om-docs-async][om-docs-async] [chg-prev-obs][chg-prev-obs] [observer-context-opt][observer-context-opt]

This is an optimization, not a core invariant. The invariant is that the Observer does **not** need the full raw history or even the full past observation log each time; it needs just enough prior compressed state plus the new raw delta. [observer-task-prompt][observer-task-prompt] [observer-context-opt][observer-context-opt]

## 5. Persistence and update semantics

### 5.1 What is persisted

OM requires a storage adapter and currently only works with Mastra adapters that implement observational-memory support (`pg`, `libsql`, `mongodb`, `convex` in current docs). The storage record stores active observations, buffered chunks, buffered reflection state, thresholds/config, timestamps, token counts, flags like `isObserving` / `isReflecting`, and generation history. [OM docs][om-docs] [inmemory-om][inmemory-om]

### 5.2 Observation updates vs reflection generations

A synchronous observation updates the current record in place: it writes new `activeObservations`, token count, `lastObservedAt`, resets pending message tokens, and stores `observedMessageIds` as a safeguard against immediate re-observation. [inmemory-om][inmemory-om] [sync-persist][sync-persist]

Async buffering does **not** immediately rewrite active memory. It appends buffered chunks containing observations plus metadata like `suggestedContinuation`, `currentTask`, `threadTitle`, and extractor outputs; those chunks become active only when activation runs. [async-buffer-strategy][async-buffer-strategy] [inmemory-om][inmemory-om]

Reflection is different again: a successful reflection creates a **new generation** with `originType: 'reflection'` and incremented `generationCount`. Buffered reflection activation also creates a new generation after replacing reflected head lines with the buffered reflection and keeping any newer unreflected tail. [inmemory-om][inmemory-om] [reflector-runner][reflector-runner]

That “new generation on reflection” behavior feels essential. It means “memory-of-memory” updates are treated as durable version boundaries, not just more appends to the same live record. [inmemory-om][inmemory-om]

### 5.3 Continuity metadata is stored separately from observation text

A subtle but important implementation choice: when the Observer returns `<current-task>` and `<suggested-response>`, the parser strips those out of stored observation text and writes them into thread metadata instead; later, OM reinjects them dynamically beside the observation block. The same mechanism carries thread-title and extracted values. [parse-observer-output][parse-observer-output] [sync-persist][sync-persist] [get-context][get-context] [format-observation-context][format-observation-context]

This is one reason Mastra’s continuity behavior is stronger than a plain summary blob: the system is not relying on the model to rediscover the active task from prose alone. It stores explicit continuity state as a side channel. [parse-observer-output][parse-observer-output] [sync-persist][sync-persist]

### 5.4 Working-memory update semantics stay separate

Working memory is still its own feature with its own semantics: schema-based working memory deep-merges objects, replaces arrays, and uses `null` deletion; template-based working memory uses replace semantics. OM can manage working memory by attaching a `WorkingMemoryExtractor`, defaulting `workingMemory.agentManaged` to `false`, and defaulting `workingMemory.useStateSignals` to `true` for better prompt-cache behavior. [working-memory-docs][working-memory-docs] [om-docs-working-memory][om-docs-working-memory]

So “reflected memory” and “updated memory” are not the same thing in Mastra. Reflections are the compressed long-term event log; working-memory updates are a separate structured state channel. [working-memory-docs][working-memory-docs] [om-docs-compare][om-docs-compare]

## 6. What context the main model actually receives over time

With OM enabled, Mastra suppresses the ordinary `MessageHistory` processor and lets OM handle history loading/saving itself, but it still auto-adds working memory and semantic recall if you configured them. That means OM **replaces raw-history loading**, not every other memory layer. [core-memory-processors][core-memory-processors] [create-om-processor][create-om-processor]

In the default OM path, the actor receives:

1. base agent instructions and other system messages,
2. OM observation system messages (possibly split into cache-stable chunks),
3. optional “other threads” blocks in resource scope,
4. `<observations>` plus reinjected `<current-task>` / `<suggested-response>` / extracted values,
5. a synthetic `om-continuation` reminder injected as a user message containing `<system-reminder>...`,
6. only the **unobserved raw messages** after `lastObservedAt`,
7. plus working-memory and/or semantic-recall context if those features are enabled. [processor-inject][processor-inject] [get-context][get-context] [format-observation-context][format-observation-context] [core-memory-processors][core-memory-processors] [working-memory-docs][working-memory-docs]

Two nuances matter:

- Before a thread has ever been observed, `lastObservedAt` is null, so OM still loads the full raw backlog; compression starts only after threshold crossing. [get-context][get-context] [OM docs][om-docs]
- Retrieval mode changes the actor’s memory surface again by keeping observation-group ranges visible in context and registering a `recall` tool for exact raw recovery. [om-constants][om-constants] [OM docs][om-docs]

A concise mental model is: **the actor sees “compressed past + exact recent tail + explicit continuity hints,” not “a summary instead of history.”** [om-index][om-index] [get-context][get-context] [processor-inject][processor-inject]

## 7. Why Mastra claims better continuity than ordinary summarization/compaction

Mastra’s claim is plausible, but the mechanism is more specific than “summaries are shorter.”

1. **Incremental, append-oriented compression.** Observations are appended to a stable log instead of recomputing a single whole-thread summary on every turn. [OM docs][om-docs] [inmemory-om][inmemory-om]
2. **Recency is preserved exactly.** The actor keeps a raw recent tail after activation instead of jumping straight from full transcript to one prose summary. [om-docs-async][om-docs-async] [inmemory-om][inmemory-om]
3. **Continuity is explicit.** `current-task` and `suggested-response` are extracted, persisted, and reinjected as dedicated context, so open work survives context shrink without relying on the model to infer it. [observer-prompt][observer-prompt] [parse-observer-output][parse-observer-output] [sync-persist][sync-persist]
4. **Reflection is a second layer, not the first.** Mastra only reflects after the observation layer itself becomes too large, so most continuity decisions happen at the observation granularity first. [OM docs][om-docs] [reflector-runner][reflector-runner]
5. **Exact recovery is optional.** Retrieval mode lets the actor recover source wording, chronology, or tool output that the observation compressed away. [OM docs][om-docs] [om-constants][om-constants]
6. **Cache stability is a design target.** Observations append behind stable message-boundary delimiters, are reinjected as separate system chunks, and can activate on idle/provider change to line up with prompt-cache reuse windows. [OM docs][om-docs] [format-observation-context][format-observation-context] [inmemory-om][inmemory-om]

There is also a sharp difference between OM and Mastra’s own one-shot summarization APIs. The voice-agent example explicitly says `summarizeThread()` reuses Observer plumbing but runs **outside** the OM lifecycle: nothing is observed, buffered, or activated, and the result goes only where the extractor hook sends it. That is basically “ordinary summarization,” and Mastra itself treats it as a separate concern from observational memory. [voice-memory-example][voice-memory-example]

## 8. Failure handling

Observation and reflection do **not** fail the same way.

- Transient transport-class observer/reflector failures are retried with an internal backoff wrapper: up to 8 retries / 9 total attempts, exponential delays starting at 1s and capped at 120s, for a worst-case wait of about 247 seconds before final failure. [retry][retry]
- Degenerate repetition output is detected; the Observer is rerun once, then fails if the retry is still degenerate. [observer-runner][observer-runner]
- Current changelog and tests say **synchronous observation failures throw**, while **async buffered observation failures remain non-fatal**. In the agent loop, a sync observation failure becomes an abort/tripwire response rather than a normal assistant answer; the tests assert empty text plus persisted failure markers. [chg-sync-fail][chg-sync-fail] [observation-failure-test][observation-failure-test]
- Reflection is more forgiving: synchronous reflection failures emit failure markers and log errors, but unless the abort signal fired they do not kill the actor turn. [reflector-runner][reflector-runner]

This asymmetry seems deliberate. If observation fails, the actor may be about to continue with stale context, so Mastra errs on the side of aborting the turn. If reflection fails, the actor can still continue using the current observation layer, so Mastra logs and carries on. [chg-sync-fail][chg-sync-fail] [reflector-runner][reflector-runner]

## 9. Token, latency, cache, and cost claims — and what evidence is missing

### What Mastra claims

Mastra’s docs and changelog make several explicit product claims:

- OM compresses history by roughly **5–40×**. [OM docs][om-docs] [chg-om][chg-om]
- Stable observation context improves **prompt cacheability** and therefore reduces cost. [OM docs][om-docs]
- Smaller context means faster responses and less “context rot.” [OM docs][om-docs] [memory-overview][memory-overview]
- In practical terms OM can replace message history and even working memory, and it is said to have greater accuracy and lower cost than semantic recall. [om-docs-compare][om-docs-compare]
- `previousObserverTokens` reduces observer input-token cost on long-running threads. [chg-prev-obs][chg-prev-obs] [observer-context-opt][observer-context-opt]
- Async buffering “keeps agents responsive” by making activation instant when the threshold is hit. [chg-async][chg-async] [om-docs-async][om-docs-async]

### What the first-party evidence actually supports

- The **mechanism** behind cacheability is clearly present in source: message-boundary delimiters for observation chunks, splitting context into separate system chunks, early activation keyed to provider cache TTL, and provider-change activation. [format-observation-context][format-observation-context] [OM docs][om-docs] [inmemory-om][inmemory-om]
- The **mechanism** behind lower observer cost is also clear: `previousObserverTokens` truncates observer input, and `ModelByInputTokens` can choose cheaper models for smaller inputs. [observer-context-opt][observer-context-opt] [om-docs-model-tier][om-docs-model-tier]
- The only concrete first-party latency figure I found is in the voice-agent example, which says a reasoning observer model (`gpt-5-mini`) measured about **25s** of inline stall in resource scope, motivating a cheaper observer and off-call summarization. That is an example-specific measurement, not a general benchmark. [voice-memory-example][voice-memory-example] [voice-readme][voice-readme]
- The repo includes a substantial **LongMemEval** harness plus many OM experiment configs (baseline OM, larger observer batches, prompt A/Bs, “shortcut OM”, pattern-recognition variants), so Mastra is clearly benchmarking OM internally. But in this repo snapshot I found the harness/configuration surface, not checked-in result tables that would substantiate the docs’ cost/accuracy claims. [longmemeval-readme][longmemeval-readme] [longmemeval-config][longmemeval-config]

### Practical conclusion on evidence

Mastra provides strong first-party evidence for **the design mechanism** and weak first-party evidence for **the magnitude of the outcomes**. The docs’ continuity/cache/cost story is believable and consistent with the implementation, but later Pi work should not treat “5–40× compression,” “lower cost than semantic recall,” or “better continuity” as already-proven quantitative facts unless we either reproduce Mastra’s internal evals or run our own. [chg-om][chg-om] [om-docs-compare][om-docs-compare] [longmemeval-readme][longmemeval-readme]

## 10. Essential invariants vs Mastra-specific choices

### Likely essential invariants

- **Separate the actor from memory-updating passes.** The main task model should not also be responsible for compressing its own history. [om-index][om-index] [observer-prompt][observer-prompt]
- **Keep exact recent context plus compressed older context.** Do not force a choice between “full history” and “one summary blob.” [get-context][get-context] [inmemory-om][inmemory-om]
- **Persist explicit continuity state** (`current-task`, likely an equivalent to `suggested-response`, maybe thread title / extracted state) separately from prose observations. [parse-observer-output][parse-observer-output] [sync-persist][sync-persist]
- **Treat reflection as a second-order rewrite of observations, not just more observations.** [reflector-prompt][reflector-prompt] [inmemory-om][inmemory-om]
- **Have an exact-recovery path** if compressed memory must sometimes recover wording or chronology. Mastra uses retrieval-mode observation groups plus a recall tool; Pi need not copy that exact shape, but some equivalent is likely important. [OM docs][om-docs] [om-constants][om-constants]
- **Make compression incremental and durable.** The benefit comes from updating a stable compressed memory over time, not from repeatedly recomputing one-off summaries. [OM docs][om-docs] [inmemory-om][inmemory-om]

### Likely Mastra-specific / changeable choices

- XML tags, emoji priority markers, and the exact Observer/Reflector prompt wording. [observer-prompt][observer-prompt] [reflector-prompt][reflector-prompt]
- The default thresholds (`30k`, `40k`, `0.2`, `0.8`, `0.5`, `1.2`) and default models (`google/gemini-2.5-flash`). [om-defaults][om-defaults] [chg-async][chg-async]
- The use of **thread metadata** as the store for continuity hints. Pi may prefer a separate session-memory object. [sync-persist][sync-persist] [get-context][get-context]
- `shareTokenBudget`, `ModelByInputTokens`, prompt-cache TTL heuristics, and temporal gap markers. Useful ideas, but not theory-level requirements. [om-ctor][om-ctor] [om-docs-model-tier][om-docs-model-tier] [OM docs][om-docs]
- Resource-scope multi-thread batching and its experimental semantics. Pi should not inherit those assumptions uncritically. [om-docs-scopes][om-docs-scopes] [om-ctor][om-ctor]
- The exact failure contract of “abort actor turn on sync observation failure, but not on reflection failure.” That is a product choice about user experience and safety, not a conceptual necessity. [observation-failure-test][observation-failure-test] [reflector-runner][reflector-runner]

## Bottom line for the Pi wayfinding ticket

Mastra’s observational memory design is best understood as **session memory by layered transcript compression**:

- raw transcript remains the ground truth,
- old raw turns become observations,
- large observation logs become reflections,
- the actor always keeps a recent exact tail,
- continuity is reinforced by explicit task/continuation metadata,
- optional structured working memory remains a separate channel,
- optional retrieval restores exact source text when compression is too lossy. [om-index][om-index] [get-context][get-context] [OM docs][om-docs] [working-memory-docs][working-memory-docs]

That layered shape, not the specific prompt text or model defaults, is the part most worth carrying forward into Pi. [om-index][om-index] [observer-prompt][observer-prompt] [reflector-prompt][reflector-prompt]

## References

[om-docs]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/observational-memory.mdx#L9-L110
[memory-overview]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/overview.mdx#L13-L24
[message-history]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/message-history.mdx#L13-L32
[working-memory-docs]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/working-memory.mdx#L13-L21
[om-docs-working-memory]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/observational-memory.mdx#L331-L355
[om-docs-compare]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/observational-memory.mdx#L801-L810
[om-docs-scopes]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/observational-memory.mdx#L570-L615
[om-docs-async]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/observational-memory.mdx#L685-L799
[om-docs-model-tier]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/observational-memory.mdx#L530-L568
[om-docs-model-note]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/docs/src/content/en/docs/memory/observational-memory.mdx#L522-L526
[om-index]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/index.ts#L1-L12
[om-defaults]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/constants.ts#L1-L40
[om-constants]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/constants.ts#L43-L121
[om-ctor]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observational-memory.ts#L368-L603
[observer-context-opt]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observational-memory.ts#L1388-L1577
[format-observation-context]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observational-memory.ts#L1579-L1658
[finalize]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observational-memory.ts#L2795-L2846
[get-context]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/index.ts#L1520-L1650
[create-om-processor]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/index.ts#L3077-L3158
[core-memory-processors]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/core/src/memory/memory.ts#L760-L946
[processor-inject]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/processor.ts#L80-L335
[observer-prompt]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observer-agent.ts#L375-L488
[observer-task-prompt]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observer-agent.ts#L1175-L1475
[observer-runner]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observer-runner.ts#L247-L355
[reflector-prompt]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/reflector-agent.ts#L30-L178
[reflector-runner]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/reflector-runner.ts#L1063-L1255
[parse-observer-output]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observer-agent.ts#L1446-L1475
[sync-persist]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observation-strategies/sync.ts#L190-L243
[async-buffer-strategy]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/observation-strategies/async-buffer.ts#L1-L225
[inmemory-om]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/core/src/storage/domains/memory/inmemory.ts#L880-L1184
[retry]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/retry.ts#L1-L208
[observation-failure-test]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/__tests__/om-error-and-persistence.test.ts#L330-L457
[transient-retry-test]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/src/processors/observational-memory/__tests__/transient-retry.test.ts#L274-L372
[voice-memory-example]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/examples/voice-agent/src/mastra/memory.ts#L7-L149
[voice-readme]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/examples/voice-agent/README.md#L68-L81
[longmemeval-readme]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/explorations/longmemeval/README.md#L1-L120
[longmemeval-config]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/explorations/longmemeval/src/config.ts#L495-L740
[chg-om]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/CHANGELOG.md#L2776-L2808
[chg-async]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/CHANGELOG.md#L2589-L2637
[chg-prev-obs]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/CHANGELOG.md#L2024-L2033
[chg-sync-fail]: https://github.com/mastra-ai/mastra/blob/cadd3a276f8e0026e3c84cffe935538419cb890c/packages/memory/CHANGELOG.md#L1516-L1516
