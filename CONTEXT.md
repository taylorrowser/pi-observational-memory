# Observational Memory

This context describes the minimal Pi-native design for preserving continuity when a long session no longer fits in active model context.

## Language

**Source transcript**:
The exact, branch-scoped Pi session history. It remains the ground truth after compaction and keeps Pi’s normal tree, fork, clone, resume, and export behavior.
_Avoid_: Memory store, shadow transcript

**Active memory**:
The context Pi sends after compaction: one compaction summary followed by Pi’s retained exact tail. It is rebuilt by Pi from the active session branch rather than maintained as a separate projection.
_Avoid_: Continuation checkpoint, observation layer

**Observational compaction**:
Ordinary Pi compaction whose summary is generated with a continuity-focused prompt and, optionally, a cheaper or faster model. It uses Pi’s trigger, cut point, retained tail, compaction entry, cancellation, retry, usage accounting, and UI lifecycle.
_Avoid_: Background observation pipeline, memory subsystem

**Continuation state**:
The goal, constraints, verified progress, current work, blockers, key decisions, and next step that a compaction summary must preserve so the actor can continue without asking the user to reconstruct the task. It is summary content, not a separately persisted record.
_Avoid_: Active-task anchor, task sidecar

**Completion**:
A task state supported by explicit user confirmation or durable tool or artifact evidence. Intent, elapsed time, attempted work, or an unsupported assistant claim does not establish completion.
_Avoid_: Assumed completion, inferred completion

**Operational exactness**:
The requirement that action-sensitive details such as paths, commands, errors, URLs, and quantities remain exact in the retained tail or be preserved accurately in the compaction summary before they are used.
_Avoid_: Verbatim everything, automatic recall subsystem
