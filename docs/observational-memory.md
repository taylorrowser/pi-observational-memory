# Minimal Observational Memory for Pi

## Purpose

Preserve coding-task continuity during a long user turn by retiring completed model steps before the user turn settles, while adding as little machinery around Pi as possible.

Observational memory owns automatic context contraction while enabled. It observes between model steps and maintains incremental observations, reflections, and explicit current-task state; stock Pi compaction is not an automatic fallback.

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
6. If raw or total projected context reaches hard headroom before work is ready, pause before the next provider request and await the current pass. Retry that frozen pass once if it fails or validates incorrectly. Resume only after a valid projection is ready; if both attempts fail or the user cancels, preserve exact source and stop the run visibly.

Only one observation/reflection pipeline runs at a time. New model steps completed while it runs remain exact and are considered by the next pass. Soft-pressure failures wait for the next normal policy opportunity; the immediate retry is reserved for a hard pause.

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
| Explicit stock-compaction replay boundary | `session_compact` |
| Automatic stock-compaction guard | `session_before_compact` |
| Minimal status | `ctx.ui.setStatus()` |

The first version requires only the generic extension-usage attribution seam decided in #11, because background Observer and Reflector calls are not ordinary assistant, tool, or compaction calls. Existing `turn_end` and `context` hooks are sufficient for asynchronous work and hard pausing: a `context` handler may await the pass before returning the next provider projection, and `ctx.abort()` can stop visibly after retry exhaustion. No compaction, session-tree, or provider-request lifecycle seam is added.

## Architecture

### One package, one public interface

Ship one Pi extension package. Its only public interface is Pi's ordinary default extension factory:

```ts
export default function observationalMemory(pi: ExtensionAPI): void;
```

The factory registers hooks and creates one session-scoped `SessionMemory` module after `session_start`. There is no exported scheduler, journal, replay engine, policy object, store, command surface, or provider abstraction. A future second caller or implementation may justify another public seam; the first version does not invent one.

### One deep session module

`SessionMemory` owns replay, pressure policy, prefix selection, model calls, validation, retry, reflection, activation fencing, projection, status, and cancellation. The Pi hook adapter remains deliberately shallow and translates lifecycle events into four semantic operations:

```ts
interface SessionMemory {
  restore(snapshot: SessionSnapshot): void;
  observe(snapshot: SessionSnapshot, signal?: AbortSignal): void;
  project(snapshot: SessionSnapshot, messages: AgentMessage[]): Promise<AgentMessage[]>;
  dispose(): void;
}
```

- `restore` cancels stale work and reconstructs active memory from an ancestry snapshot. It is used at session start, successful tree navigation, and a compaction boundary.
- `observe` is non-blocking. It freezes and launches eligible work after `turn_end`, then returns without awaiting the provider.
- `project` is the sole activation seam. It revalidates ancestry, atomically appends ready records, performs reflection before exposing an oversized observation layer, enforces hard pause/retry, and returns the complete next actor message list.
- `dispose` fences the runtime and cancels work on shutdown or session replacement.

A small private host interface supplies model completion, custom-entry append, usage attribution, abort, and status effects. It is a real internal seam because production uses a Pi adapter and tests use an in-memory adapter. It is not exported from the package.

The interface is the test surface. Tests feed ancestry snapshots and context requests through `SessionMemory`; they do not test private scheduler, parser, or replay helpers directly.

### Pi event wiring

| Pi event | Adapter action |
| --- | --- |
| `session_start` | Create the module and `restore` from `getBranch()` |
| `turn_end` | Snapshot the now-complete branch and call non-blocking `observe` |
| `context` | Call `project`; await only when reflection or hard pressure requires it |
| `session_tree` | `restore` the destination ancestry; never wait for old work |
| `model_select` | Refresh the snapshot and budgets; committed memory remains valid |
| `session_before_compact` | Cancel automatic threshold/overflow compaction while observational memory owns contraction |
| `session_compact` | Treat an explicit successful Pi compaction as a replay boundary and `restore` |
| `session_shutdown` | `dispose` before the runtime is replaced |

An explicit user-invoked `/compact` remains a user override, not a fallback. Automatic threshold or overflow compaction is cancelled while observational memory is active. Under normal operation bounded projected usage prevents Pi's automatic threshold from being reached in the first place.

### Record protocol

Use two namespaced custom-entry types: `observational-memory/observation-v1` and `observational-memory/reflection-v1`. Because `pi.appendEntry()` does not return the new session entry ID, each record carries an extension-generated stable `recordId`; Pi's custom-entry `id` and `parentId` still establish physical ancestry.

Both records carry:

- protocol version and stable record ID;
- the latest active Pi compaction entry ID, or session root, that establishes the replay epoch;
- parent observation/reflection record IDs needed to validate lineage;
- producer provider/model, prompt version, pass correlation ID, timestamp, usage, and fidelity;
- an output token estimate and validation version; and
- only JSON-serializable data.

An observation commit additionally carries the ordered covered source-entry IDs, inclusive first/last IDs, ordered observations, optional item-level exact-source pointers, and one complete active-task anchor. A reflection generation carries its parent reflection ID, the exact contiguous observation record IDs it folds through, and one coherent reflected history.

The first version writes only normal-fidelity valid records. Invalid candidates are never persisted; unsupported or malformed persisted records are ignored during replay. Producer usage remains embedded for pass audit and budget policy, while Pi totals consume the separate usage-attribution entry described below.

### Source selection and projection

The module derives source identity from `sessionManager.getBranch()` and Pi's compaction-aware context entries, never from array positions alone. A frozen observation range ends only at the assistant entry plus every source-ordered terminal tool result reported by one completed `turn_end`; parallel completion order cannot split the range.

`project` builds one stable, ephemeral custom memory message containing reflection, newer observations, and the newest anchor, then places the exact uncovered source messages after it. It does not persist that projection. Branch summaries and compaction summaries retain their Pi provenance in the exact layer.

Context hooks chain across extensions. Before deleting covered messages, the adapter compares the corresponding Pi-built baseline with the incoming `context` messages and replaces only one exact, unambiguous covered sequence. If another extension has rewritten that sequence so it cannot be identified safely, observational memory retires nothing. At hard pressure such ambiguity stops visibly rather than risking source loss; below hard pressure the exact incoming context remains active.

The rendered memory block is byte-stable while active memory is unchanged. This avoids gratuitous prompt-prefix invalidation.

### Scheduling and activation

`turn_end` starts work by retaining its promise in the module and returning immediately. The serial pipeline owns one frozen pass and one `AbortController`; it never starts a second model call concurrently.

At the next `context` call:

1. activate a ready observation only after the lifecycle fence succeeds;
2. if the candidate observation layer crosses its high watermark, generate and validate the required reflection in the same serial pipeline before projecting it;
3. append complete observation and reflection records before returning their projection; and
4. if hard pressure is reached, keep the context handler pending until the pass succeeds, one retry succeeds, or cancellation/exhaustion stops the run.

Appending an observation and then its optional reflection is logically atomic at projection time. A process crash between the two appends may leave a valid observation without its reflection, but no oversized projection was sent; replay can reflect it before the next request. There is no multi-entry transaction or repair record.

### The one Pi core seam

Add one generic extension method backed by a first-class append-only session entry:

```ts
pi.appendUsage({
  usage,
  provider,
  model,
  operation: "observation" | "reflection",
  correlationId,
});
```

The concrete core type may permit namespaced operation strings for other extensions, but it must not create a model-visible message. Pi appends the entry to the current session ledger and includes it exactly once in the same totals used by the footer, `/session`, RPC, and exports. It does not count toward actor-context pressure.

Call `appendUsage` whenever a response reports usage, before candidate acceptance is decided, including rejected, stale, cancelled-after-response, and invalid candidates. The corresponding memory record may embed the same usage for provenance; custom-entry data remains ignored by Pi's aggregate to prevent double counting.

## Minimal user surface

Keep the UI smaller than the earlier #8 design:

- no always-present ready status;
- show a compact status only while observing, hard-paused, or stopped after retry exhaustion;
- no `/memory` inspector, shortcut, settings screen, incident history, or custom editor;
- use Pi's Escape/session lifecycle for cancellation;
- use ordinary user messages for corrections; the next observation updates the anchor; and
- expose no observe-now, pause, repair, or retry controls initially.

Add inspection or controls only when implementation debugging or user evidence demonstrates a recurring need.

## Failure behavior

While exact source still fits safely, failed or delayed work leaves the prior active memory plus exact uncovered tail in context.

At hard headroom:

1. show a compact paused-for-memory status and await the frozen pass;
2. retry the same pass once after failure, timeout, empty output, or invalid output; and
3. resume only with a valid safe projection, otherwise preserve exact source, abort the actor run, and show one explicit terminal error.

Do not invoke stock Pi compaction automatically. Do not add alternate-model ladders, semantic repair calls, background reconstruction, indefinite retries, or a multi-state incident system in the first version.

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

Before the next actor request, recompute usable input budget, raw watermarks, output allowance, and total projected headroom for the newly selected actor model. A smaller window may force a hard pause or another serial pass; a larger window does not resurrect covered exact source. Model selection by itself does not launch work below the soft watermark.

### Retries, failures, aborts, and cancellation

A terminal tool error belongs to a completed model step and may be observed; preserve decision-relevant failure evidence and never reinterpret it as completion. A retryable provider failure or aborted/partial assistant response does not establish an observation boundary. It remains exact until a later completed boundary can cover the contiguous range, at which point its failed or aborted status must remain explicit if retained.

Automatic actor retries do not rewind committed memory and do not invalidate a pass over an unchanged ancestor prefix. Propagate Pi's active abort signal into memory calls so Escape can cancel associated work; cancellation never erases prior commits. Memory-call failure, malformed or empty output, timeout, or cancellation commits nothing and leaves exact source active. Below hard pressure, later eligible work may try the normal policy again. During a hard pause, retry the same frozen pass once with the same actor model and policy; exhaustion or cancellation aborts the actor run visibly without advancing coverage.

### Stock-compaction boundary

Observational memory cancels Pi's automatic threshold and overflow compaction while enabled; stock compaction is not a recovery path. If a user explicitly completes Pi compaction, that entry is a replay boundary: cancel observational work frozen before it, let Pi's summary and retained tail own the active projection at that point, and do not reactivate earlier observational records while the compaction entry remains on active ancestry. Later observation may resume after the boundary with a fresh complete anchor.

Navigating to ancestry before that compaction entry naturally restores observational records valid at the earlier leaf. No degraded-history reconstruction or extra fallback record is required.

## Configuration

Start with one built-in policy scaled from the actor model's usable input budget. Do not expose user settings initially.

Use the current actor model for Observer and Reflector calls in the first prototype. A cheaper dedicated model, provider overrides, custom thresholds, budgets, and retry policy become interfaces only after the paired evaluation demonstrates a need.

## Verification

The smallest useful implementation evidence is:

1. deterministic tests that generated sequential and parallel tool batches are never split;
2. replay tests for contiguous coverage, one active reflection, newest-anchor selection, and stale-pass rejection;
3. lifecycle tests for tree navigation with and without a handoff, fork/clone, resume/reload, model change, retry, abort, and session replacement;
4. hard-pause tests showing retry, visible stop without coverage advance, automatic-compaction cancellation, and safe replay across an explicit stock-compaction boundary; and
5. a small paired end-to-end comparison with full history and stock Pi on long user turns containing many model steps.

Do not build a benchmark platform first. Expand toward #9's formal acceptance matrix only if the small paired evaluation justifies continuing.
