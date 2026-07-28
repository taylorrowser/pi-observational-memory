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
| Fallback replay boundary | `session_compact` |
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

## Lifecycle

The lifecycle uses **discard and replay**, not migration. Persist only observation commits and reflection generations. A materialized checkpoint, background-work record, branch-merge record, or repair log is not added.

### Authority and replay

The active root-to-leaf ancestry is the sole authority. On startup and after a leaf change, scan its custom entries in ancestry order and accept only records whose protocol version is supported and whose parent and coverage references resolve to an earlier contiguous prefix on that same ancestry.

Replay selects:

1. the newest valid reflection generation;
2. valid observation commits after the prefix folded by that reflection;
3. the complete active-task anchor from the newest valid observation commit; and
4. the exact source entries after the newest valid observation boundary.

An orphaned, malformed, mis-parented, or non-contiguous record is ignored and advances no coverage. Exact source remains available, so replay needs no repair record. Records on sibling branches and abandoned descendants are inactive even if they are physically newer in the JSONL file.

### Tree navigation and branch handoff

Successful `/tree` navigation does not wait for memory work. Cancel the one in-flight pass, discard any later result, and replay the destination ancestry before its next actor request.

Do not merge memory from the branch being left. Pi's optional branch summary is the only cross-branch handoff: when present on the destination ancestry, retain its `fromId` and producer provenance and treat its exact text as derived orientation. It cannot by itself verify completion or action-sensitive detail; the actor must recover the abandoned source or re-verify external state before relying on such claims. If the user chooses no Pi branch summary, observational memory carries nothing across the sibling-branch boundary.

This rule does not roll back filesystem effects. With no explicit handoff, the actor must inspect the current workspace just as it does under stock Pi tree navigation.

### Fork, clone, resume, reload, and replacement

Fork and clone inherit valid committed records only when Pi copied those records and every referenced source entry onto the new session's active path. Preserve inherited record identities and provenance; bind all later passes to the child session. Never copy an in-memory pass.

Resume and reload reconstruct from the selected session's active ancestry. A new empty session starts with no observational memory. On session replacement or shutdown, cancel live work and fence the old runtime before rebinding; no result may append through stale extension or session objects.

### In-flight work and activation fence

The one runtime-only pass freezes its session identity, launch leaf, active reflection/observation parents, next uncovered contiguous source range, producer policy, and token estimate. Ordinary descendant model steps may arrive while it runs and do not make it stale.

Immediately before append and activation in `context`, require all of the following:

- the launch leaf is still on the active ancestry;
- the frozen memory parents are still active;
- the frozen source range is still the next uncovered contiguous eligible prefix;
- every covered model step is complete, including all terminal tool results or errors; and
- the candidate passes protocol, output-budget, and source-reference validation.

Failure of any check discards the candidate and advances no boundary. Cancellation is best effort: a provider response that arrives afterward is still rejected by this fence. Usage reported for rejected, failed, stale, or cancelled calls is still attributed exactly once through #11's session-usage seam, but it never creates a memory commit.

### Model changes

Committed records are provider-agnostic and remain valid across actor-model changes. A pass already frozen under the previously active model may finish with that producer recorded; a model change alone does not make its source or parentage stale.

Before the next actor request, recompute usable input budget, raw watermarks, output allowance, and total projected headroom for the newly selected actor model. A smaller window may force a hard wait, another serial pass, or stock compaction; a larger window does not resurrect covered exact source. Model selection by itself does not launch work below the soft watermark.

### Retries, failures, aborts, and cancellation

A terminal tool error belongs to a completed model step and may be observed; preserve decision-relevant failure evidence and never reinterpret it as completion. A retryable provider failure or aborted/partial assistant response does not establish an observation boundary. It remains exact until a later completed boundary can cover the contiguous range, at which point its failed or aborted status must remain explicit if retained.

Automatic actor retries do not rewind committed memory and do not invalidate a pass over an unchanged ancestor prefix. Propagate Pi's active abort signal into memory calls so Escape can cancel associated work; cancellation never erases prior commits. Memory-call failure, malformed or empty output, timeout, or cancellation commits nothing and leaves exact source active. The first version adds no memory-specific retry ladder or user control: later eligible work may try the normal policy again, and hard-headroom failure falls through to stock Pi compaction.

### Stock-compaction boundary

A successful stock Pi compaction is a replay boundary. Cancel observational work frozen before it, let Pi's compaction summary and retained tail own the active projection at that point, and do not reactivate earlier observational records while the compaction entry remains on the active ancestry. Later observation may resume over completed model steps after the compaction boundary and create a fresh complete anchor.

Navigating to an ancestry before that compaction entry naturally restores the observational records valid at that earlier leaf. No degraded-history reconstruction or extra fallback record is required.

## Configuration

Start with one built-in policy scaled from the actor model's usable input budget. Do not expose user settings initially.

Use the current actor model for Observer and Reflector calls in the first prototype. A cheaper dedicated model, provider overrides, custom thresholds, budgets, and retry policy become interfaces only after the paired evaluation demonstrates a need.

## Verification

The smallest useful implementation evidence is:

1. deterministic tests that generated sequential and parallel tool batches are never split;
2. replay tests for contiguous coverage, one active reflection, newest-anchor selection, and stale-pass rejection;
3. lifecycle tests for tree navigation with and without a handoff, fork/clone, resume/reload, model change, retry, abort, and session replacement;
4. fallback tests showing no coverage advance on invalid work and safe replay across a stock-compaction boundary; and
5. a small paired end-to-end comparison with full history and stock Pi on long user turns containing many model steps.

Do not build a benchmark platform first. Expand toward #9's formal acceptance matrix only if the small paired evaluation justifies continuing.
