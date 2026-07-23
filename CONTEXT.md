# Observational Memory

This context describes how a long-running coding agent preserves continuity when its full session history no longer fits in active model context.

## Language

**Active memory**:
The continuity-critical information supplied directly to the acting agent. Supporting detail may remain outside active memory when the agent can recognize the need for it and recover it before acting.
_Avoid_: Summary, full memory

**Source transcript**:
The exact session messages and tool trace from which observational memory is derived. It remains the ground truth for details that compressed memory omits.
_Avoid_: Memory blob, summary

**Observation**:
An observer-generated, prioritized account of completed session activity that remains in active memory after its source transcript leaves model context. It preserves actionable meaning and links to exact supporting detail when that detail is not carried directly.
_Avoid_: Summary blob, transcript copy

**Reflection**:
A versioned re-condensation of older observations that preserves their continuity-relevant state while allowing increasingly outcome-oriented compression. Recent observations remain more detailed.
_Avoid_: New observation, destructive rewrite

**Active-task anchor**:
Explicit continuity state for a top-level task, including its original intent, applicable constraints, current work, verified outcomes, unresolved questions, blockers, and next action. It survives contraction even when the original user message no longer remains exact in context.
_Avoid_: Suggested response, generic summary

**Completion**:
A task state indicating that an intended outcome was achieved, supported by explicit user confirmation or durable tool or artifact evidence. Intent, elapsed time, attempted work, or an unsupported assistant claim does not establish completion.
_Avoid_: Assumed completion, inferred completion

**Prospective memory note**:
An actor-authored note created during the normal agent loop to identify information that should survive later observation, together with its relevance and source provenance. It raises retention priority but does not by itself verify the note’s claims.
_Avoid_: Self-summary, pinned fact

**Memory document**:
A durable Markdown sidecar, normally created by the observer during contraction, that preserves bulky or poorly compressible context outside active memory. Its linked observation states what it contains and when the acting agent should consult it.
_Avoid_: Observation, source transcript, dump file

**Provider-valid agent batch**:
The smallest context unit that may move across an observation boundary: one assistant output, its complete parallel tool-call batch, every terminal result or error, and any provider-coupled reasoning state. An incomplete batch cannot be observed and retired.
_Avoid_: Message boundary, arbitrary token boundary

**Degraded memory**:
Active memory produced by a safe fallback after normal observation fails or cannot complete in time. It remains usable but carries an inspectable status identifying the failure, fallback, and possible fidelity loss.
_Avoid_: Normal memory, silent fallback

**Operational exactness**:
The requirement that action-sensitive details survive verbatim in active memory or be recovered from a traceable source before use. Semantic paraphrase is acceptable only when wording or values cannot change the resulting action.
_Avoid_: Verbatim everything, gist-only memory
