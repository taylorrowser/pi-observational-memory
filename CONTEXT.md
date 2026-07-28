# Observational Memory

This context describes how a long-running coding agent preserves continuity when its full session history no longer fits in active model context.

## Language

**Active memory**:
The continuity-critical information supplied directly to the acting agent. Its ordered historical view consists of the latest active reflection, newer observations not covered by that reflection, and the exact source-transcript suffix not covered by those observations, alongside the active-task anchor. Supporting detail may remain outside active memory when the agent can recognize the need for it and recover it before acting.
_Avoid_: Summary, full memory

**Source transcript**:
The exact session messages and tool trace from which observational memory is derived. It remains the ground truth for details that compressed memory omits.
_Avoid_: Memory blob, summary

**Memory history**:
The ordered, branch-scoped observation and reflection records within the persisted Pi session history. It is the authoritative history of derived memory: immutable records use monotonic coverage boundaries, and deterministic replay rebuilds the continuation checkpoint. A materialized checkpoint is only a disposable projection.
_Avoid_: Separate memory store, mutable memory record, checkpoint cache

**Continuation checkpoint**:
The reconstructible active-memory state sufficient to recover the user’s actionable position when the same Pi session is resumed, reloaded, forked, or navigated. It is a disposable projection of the active session-history branch, not an authority of its own. It preserves continuity without requiring the full source transcript to be reread; the source transcript remains necessary for exact historical reconstruction.
_Avoid_: Separate authoritative file, full transcript, portable cross-session memory

**Observation commit**:
The atomic result of one observer pass: the covered source-transcript boundary, an ordered list of observations, a complete active-task anchor snapshot, and provenance and fidelity status. The source range becomes covered only when the entire commit validates.
_Avoid_: Partial observer output, independently advanced observation

**Observation**:
An immutable, ordered free-form item within a typed observation commit that accounts for completed session activity while preserving actionable meaning and linking to exact supporting detail when needed. Observations retain chronology and explicitly narrate priority, authorship, semantic status, corrections, reversals, and unresolved conflicts when relevant; they do not require machine-readable claim-level supersession links.
_Avoid_: Fully schematized fact, summary blob, transcript copy

**Reflection**:
An immutable generation containing one coherent, increasingly outcome-oriented historical text plus structural metadata. It is produced by folding the current active reflection, if any, together with a contiguous prefix of newer observations. Once atomically committed, it becomes the one active reflection and replaces those inputs in the active projection without altering memory history; remaining newer observations stay more detailed. It does not replace the active-task anchor. Truncated, invalid, or over-budget output is not a reflection and does not advance the coverage boundary.
_Avoid_: New observation, complete checkpoint, multiple active reflection segments, destructive rewrite

**Active-task anchor**:
The first-class current-state portion of a continuation checkpoint. Every committed observation carries a complete replacement snapshot, and replay selects the newest snapshot. It includes a top-level task’s original intent, applicable constraints, current work, verified outcomes, unresolved questions, blockers, ownership of the next move, and next action. It survives contraction even when the original user message no longer remains exact in context.
_Avoid_: Patch chain, suggested response, generic summary

**Completion**:
A task state indicating that an intended outcome was achieved, supported by explicit user confirmation or durable tool or artifact evidence. Intent, elapsed time, attempted work, or an unsupported assistant claim does not establish completion.
_Avoid_: Assumed completion, inferred completion

**Prospective memory note**:
An actor-authored note created during the normal agent loop to identify information that should survive later observation, together with its relevance and source provenance. It raises retention priority but does not by itself verify the note’s claims.
_Avoid_: Self-summary, pinned fact

**Provider-valid agent batch**:
The smallest context unit that may move across an observation boundary: one assistant output, its complete parallel tool-call batch, every terminal result or error, and any provider-coupled reasoning state. An incomplete batch cannot be observed and retired.
_Avoid_: Message boundary, arbitrary token boundary

**Degraded memory**:
Active memory produced by a safe fallback after normal observation fails or cannot complete in time. It remains usable but carries an inspectable status identifying the failure, fallback, and possible fidelity loss.
_Avoid_: Normal memory, silent fallback

**Operational exactness**:
The requirement that action-sensitive details survive verbatim in active memory or be recovered from a traceable source before use. Semantic paraphrase is acceptable only when wording or values cannot change the resulting action.
_Avoid_: Verbatim everything, gist-only memory
