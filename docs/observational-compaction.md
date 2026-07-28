# Observational Compaction for Pi

## Purpose

Preserve coding-task continuity when Pi compacts a long session, without creating a second memory subsystem.

The first version is a Pi extension that replaces only summary generation. Pi continues to own when compaction happens, which context is retained, how the session is persisted, how branches behave, how cancellation and overflow work, how usage is totaled, and what the user sees.

## Product claim

This design aims to produce a more continuity-preserving compaction summary than stock Pi. It does not promise universal cost savings, proactive contraction inside an uninterrupted low-level tool loop, cross-session memory, or exact automatic recall.

## Interface

The extension exposes no tool, command, shortcut, custom UI, custom session record, or public runtime interface. It registers one existing Pi hook:

```ts
pi.on("session_before_compact", observationalCompaction);
```

The hook consumes Pi's `SessionBeforeCompactEvent` and returns either:

```ts
undefined // use stock Pi compaction
```

or:

```ts
{
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage: Usage;
  };
}
```

This is the entire external interface. Tests exercise the same seam Pi uses.

## Responsibilities

The adapter performs five steps:

1. Read `previousSummary`, `messagesToSummarize`, `turnPrefixMessages`, `firstKeptEntryId`, `tokensBefore`, and `signal` from Pi's compaction preparation.
2. Convert and serialize the supplied messages with Pi's `convertToLlm()` and `serializeConversation()` utilities.
3. Request one structured summary from the current actor model using Pi's resolved authentication and abort signal.
4. Reject empty, aborted, or over-budget output.
5. Return the summary with Pi's cut point, token count, and model usage.

The summary prompt preserves:

- original goal and current objective;
- constraints and user preferences;
- completed work only when supported by user confirmation or durable artifacts;
- current work, blockers, and unresolved questions;
- key decisions and rationale;
- exact paths, commands, errors, URLs, quantities, and other action-sensitive details needed next;
- the next concrete action; and
- cumulative read and modified files when available.

Use Pi's existing structured headings (`Goal`, `Constraints & Preferences`, `Progress`, `Key Decisions`, `Next Steps`, `Critical Context`) rather than inventing a new protocol.

## Pi-owned behavior

The extension must not duplicate these Pi responsibilities:

| Concern | Owner |
| --- | --- |
| Threshold and overflow triggers | Pi compaction |
| Reserve and retained-tail sizing | Pi settings |
| Provider-valid cut selection | Pi compaction preparation |
| Exact retained context | Pi `CompactionEntry` / retained tail |
| Repeated summary folding | Pi previous-summary behavior |
| Source history and branch ancestry | Pi session JSONL tree |
| Tree, fork, clone, resume, reload | Pi session lifecycle |
| Cancellation and retry | Pi abort signal and compaction flow |
| Footer, loader, `/compact`, `/settings` | Pi UI |
| Cost and token totals | Pi compaction-result `usage` |
| Failure fallback | Stock Pi compaction |

## Failure behavior

The adapter is an optional improvement over a working Pi path.

Return no override when:

- the active model or authentication is unavailable;
- the compaction signal is aborted;
- serialization or the model call fails;
- output is empty or exceeds its output budget; or
- the result cannot be represented as an ordinary Pi compaction.

Pi then performs stock compaction. Do not add retries, alternate models, repair calls, degraded-memory records, incident history, or a fallback state machine in the first version.

## State and lifecycle

The module holds no session-scoped mutable state. It appends no custom entry and reconstructs nothing on startup.

A successful result becomes an ordinary Pi compaction entry. A failed invocation leaves no observational-memory artifact. Session replacement tears down the extension normally; a later session loads a fresh extension instance.

Because no separate state exists, branch correctness is inherited from Pi rather than implemented again.

## Configuration

The first version adds no settings. It uses the current actor model and Pi's existing compaction settings.

A separate Observer model, custom thresholds, provider policies, retry counts, and memory budgets are future options only after measurements show that they improve the quality/cost tradeoff enough to justify another interface.

## Verification

Before implementation handoff is considered successful:

1. Unit-test prompt construction from a previous summary, complete turns, and a split-turn prefix.
2. Integration-test successful return of summary, Pi cut point, token count, and usage.
3. Integration-test fallback on missing auth, cancellation, model error, empty output, and over-budget output.
4. Run a small paired set of long coding tasks against stock Pi compaction and inspect verified task outcomes, repeated tool work, lost constraints, false completion, maximum context, usage, and latency.

Do not build a benchmark platform first. Expand toward #9's formal acceptance standard only if the small paired evaluation justifies continuing.

## Evidence-gated future seam

The known missing capability is proactive contraction between provider calls inside one uninterrupted low-level tool loop. Pi currently compacts after the run or recovers after overflow.

Do not patch Pi or add a background projection scheduler for this case until end-to-end traces show a material task-success regression that stock overflow recovery and observational compaction cannot address. If that evidence appears, design the smallest pre-request contraction seam then, against a concrete failure.
