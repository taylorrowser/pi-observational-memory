# Observational Memory

This context describes the minimal session-scoped design for preserving continuity during long Pi user turns.

## Language

**Source transcript**:
The exact, branch-scoped Pi session history. It remains ground truth after derived memory replaces older messages in active model context.
_Avoid_: Memory store, shadow transcript

**Active ancestry**:
The ordered root-to-leaf path selected in Pi's session tree. It is the sole authority for replaying memory history; records on sibling branches or abandoned descendants are inactive.
_Avoid_: Session-wide memory, latest file state

**Branch handoff**:
An explicit, provenance-carrying branch summary attached to the destination ancestry when Pi tree navigation intentionally carries orientation from the branch being left. It is derived context, not exact source evidence.
_Avoid_: Implicit memory merge, branch leakage

**User turn**:
One user message followed by all model/tool iterations needed to reach the final settled assistant response. A user turn may contain many model steps.
_Avoid_: Pi turn, model request

**Model step**:
One provider request, its assistant response, and the complete resulting tool-call batch, including every terminal tool result or error. Pi exposes this lifecycle through `turn_start` and `turn_end`.
_Avoid_: LLM turn, user turn

**Observation boundary**:
The seam after a model step has completed and before the next provider request. Only complete model steps may move from exact transcript context into derived memory.
_Avoid_: End of user turn, arbitrary message boundary

**Memory history**:
The observation commits and reflection generations persisted as custom entries on the Pi session branch. Replay of the active branch reconstructs active memory; no separate checkpoint file is authoritative.
_Avoid_: Sidecar, mutable memory record

**Observation commit**:
The atomic result of one Observer pass over a contiguous prefix of completed model steps. It contains ordered observations, a complete active-task anchor snapshot, source coverage, producer/usage provenance, and validity status.
_Avoid_: Summary blob, partial observer output

**Reflection**:
An immutable generation that folds the previous active reflection and a contiguous prefix of observations into denser historical context. Newer observations remain detailed.
_Avoid_: Observation, destructive rewrite

**Active-task anchor**:
The complete current-task snapshot stored inside every observation commit: original intent, constraints, verified progress, current work, blockers, unresolved questions, ownership of the next move, and next action. It is not a separate record stream.
_Avoid_: Patch chain, inferred task state

**Active memory**:
The context supplied to the actor: active reflection, newer observations, newest active-task anchor, and the exact source-transcript tail not covered by observations.
_Avoid_: Compaction summary, full transcript

**Hard pause**:
The state in which source or projected context has reached safe headroom and the next model request waits for a valid observational-memory projection. Exhausted retries or user cancellation ends the run without retiring exact source.
_Avoid_: Compaction fallback, background delay

**Completion**:
A task state supported by explicit user confirmation or durable tool or artifact evidence. Intent, elapsed time, attempted work, or an unsupported assistant claim does not establish completion.
_Avoid_: Assumed completion, inferred completion

**Operational exactness**:
The requirement that action-sensitive details remain exact in active memory or are recovered from traceable source before use.
_Avoid_: Verbatim everything, untraceable paraphrase
