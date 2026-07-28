# Minimal Observational Memory for Pi

## Purpose

Preserve coding-task continuity during a long user turn by retiring completed model steps before the user turn settles, while adding as little machinery around Pi as possible.

Pi's normal compaction remains the fallback. Observational memory is distinct because it can observe between model steps and maintains incremental observations, reflections, and explicit current-task state.

## Timing model

A **user turn** begins with one user message and ends with the final settled assistant response. It may contain many **model steps**.

A model step is:

1. one provider request;
2. its assistant response; and
3. the complete resulting tool-call batch, including every terminal result or error.

Pi's extension `turn_end` event marks a completed model step. Pi's `context` event runs before the next provider request. Observational memory may produce work after `turn_end` and may activate validated work in `context`. It never retires an in-flight assistant response or an incomplete tool batch.

## Active context

The actor receives, in order:

1. the active reflection, if any;
2. observations newer than that reflection;
3. the newest active-task anchor; and
4. the exact source-transcript tail not covered by observations.

The exact Pi session branch remains canonical and is never destructively rewritten.

## Persisted records

Use only two extension-owned custom entry types:

### Observation commit

One atomic custom entry containing:

- the contiguous source-entry range covered;
- ordered free-form observations;
- one complete active-task anchor snapshot;
- producer model/prompt version and usage; and
- validation/fidelity status.

The active-task anchor is part of the commit, not a third record stream.

### Reflection generation

One atomic custom entry containing:

- the previous reflection identity, if any;
- the contiguous observation prefix folded;
- one coherent reflected history; and
- producer model/prompt version and usage.

The newest valid generation on the active branch is active. Older generations remain audit history but are not sent to the actor.

No materialized continuation checkpoint, memory document, sidecar, claim graph, correction record, or incident record is added in the first version.

## Pipeline

The extension has one serial pipeline per active session runtime.

1. At `turn_end`, measure the exact uncovered tail. If it crosses the soft threshold and no pass is running, freeze the oldest contiguous prefix of completed model steps that would restore the configured target.
2. Run one background Observer call over that frozen prefix plus current derived memory.
3. Validate the complete candidate. Invalid, cancelled, stale, or truncated output advances no coverage.
4. At the next `context` event after validation, append and activate the observation commit atomically.
5. If active observations exceed their high threshold, fold the oldest contiguous prefix into one reflection generation before exposing an oversized projection.
6. If raw or total projected context reaches hard headroom before work is ready, wait for the current pass up to a fixed bound. On failure or timeout, use stock Pi compaction.

Only one observation/reflection pipeline runs at a time. New model steps completed while it runs remain exact and are considered by the next pass.

## Pi seams

The extension uses existing Pi interfaces wherever possible:

| Concern | Pi seam |
| --- | --- |
| Completed model-step boundary | `turn_end` |
| Pre-provider activation and context projection | `context` |
| Branch persistence | `pi.appendEntry()` custom entries |
| Startup/resume reconstruction | `session_start` + `sessionManager.getBranch()` |
| Tree navigation reconstruction | `session_tree` |
| Session replacement cleanup | `session_shutdown` |
| Model changes | `model_select` |
| Fallback | `ctx.compact()` / stock compaction |
| Minimal status | `ctx.ui.setStatus()` |

The first version should require only the generic extension-usage attribution seam decided in #11, because background Observer and Reflector calls are not ordinary assistant, tool, or compaction calls. No new compaction, session-tree, or provider-request lifecycle seam is assumed.

## Minimal user surface

Keep the UI smaller than the earlier #8 design:

- no always-present ready status;
- show a compact status only while observing, waiting at hard headroom, or after stock-compaction fallback;
- no `/memory` inspector, shortcut, settings screen, incident history, or custom editor;
- use Pi's Escape/session lifecycle for cancellation;
- use ordinary user messages for corrections; the next observation updates the anchor; and
- expose no observe-now, pause, repair, or retry controls initially.

Add inspection or controls only when implementation debugging or user evidence demonstrates a recurring need.

## Failure behavior

While exact source still fits safely, failed or delayed work leaves the prior active memory plus exact uncovered tail in context.

At hard headroom:

1. wait a bounded time for the one in-flight pass;
2. if it cannot produce a valid safe projection, invoke stock Pi compaction; and
3. show a compact fallback status for the resulting session state.

Do not add alternate Observer ladders, semantic repair calls, background reconstruction, or a multi-state incident system in the first version.

## Lifecycle rule

Derived memory is branch-scoped because its custom entries live on the Pi session tree. Reconstruct only from active-branch ancestry. Cancel and discard in-flight work whenever tree navigation, session replacement, reload, or shutdown invalidates its frozen parent. Never copy in-memory pipeline state across runtimes.

Detailed lifecycle cases remain in #13; the design goal is discard-and-replay rather than migration.

## Configuration

Start with one built-in policy scaled from the actor model's usable input budget. Do not expose user settings initially.

Use the current actor model for Observer and Reflector calls in the first prototype. A cheaper dedicated model, provider overrides, custom thresholds, budgets, and retry policy become interfaces only after the paired evaluation demonstrates a need.

## Verification

The smallest useful implementation evidence is:

1. deterministic tests that generated sequential and parallel tool batches are never split;
2. replay tests for contiguous coverage, one active reflection, newest-anchor selection, and stale-pass rejection;
3. lifecycle tests for tree navigation, resume, reload, model change, abort, and session replacement;
4. fallback tests showing no coverage advance on invalid work and safe stock compaction at hard headroom; and
5. a small paired end-to-end comparison with full history and stock Pi on long user turns containing many model steps.

Do not build a benchmark platform first. Expand toward #9's formal acceptance matrix only if the small paired evaluation justifies continuing.
