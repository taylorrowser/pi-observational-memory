# Pi context lifecycle and control seams

> Provenance. This note targets the downstream `pi-v0.81.1-patch.3` release bundle. Its release metadata points at upstream `earendil-works/pi` tag `v0.81.1`, commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`, package version `0.81.1`.[^release-json] I used that pinned upstream commit as the readable source/test companion for core behavior, plus the complete local downstream docs/examples shipped in the release bundle.[^release-doc-index]

## Short answer

Pi measures usable context from the **last successful assistant usage it has seen**, plus a heuristic estimate for any trailing messages after that usage point.[^agent-session-context-usage][^compaction-estimate] It checks compaction in **two places only**: (1) after a low-level agent run ends, before deciding whether to retry / compact / continue, and (2) immediately before accepting a new top-level prompt, using the last assistant message so aborted turns can still trigger compaction.[^agent-session-run-loop][^agent-session-post-run][^agent-session-preprompt-check] It does **not** proactively compact before each provider request inside the tool loop; inside the loop, the extension seam is `context`/provider hooks, not compaction.[^extensions-lifecycle][^sdk-stream-hooks]

The footer/context percentage can legitimately reach or exceed 100% because the display uses `estimate.tokens / contextWindow`, while the threshold uses `contextWindow - reserveTokens`; Pi only compacts after a turn finishes or an overflow is detected, so it can already be over the full window (or close enough that provider-side accounting says it is) before compaction runs.[^agent-session-context-usage][^compaction-shouldcompact][^compaction-doc-threshold]

For observational memory, Pi already exposes enough seams to build a **branch-scoped, session-scoped, append-only memory journal** plus **per-call context rewriting**: persist hidden state with `pi.appendEntry()`, reconstruct it on `session_start`, inject or rewrite model-visible memory in `context`, trigger observation from `turn_end`/`agent_settled`, and survive `/tree`, `/fork`, `/clone`, `/resume`, and reload via the session tree / replacement lifecycle.[^extensions-append-entry][^extensions-session-start][^extensions-context-hook][^extensions-agent-settled][^extensions-session-replacement][^session-manager-branch-copy]

The main seam I found that is still missing for an ambient observational-memory design is **generic usage accounting for extension-initiated model calls outside tool results and compaction**. Pi totals currently aggregate assistant usage, `toolResult.usage`, and compaction / branch-summary usage; there is no general extension API to append arbitrary usage to the session ledger.[^usage-totals][^extensions-tool-usage]

## 1. Exact lifecycle: when context is rebuilt, measured, compacted, and settled

### 1.1 The active run stays “streaming” until retries, compaction, and queued continuations are done

`AgentSession._runAgentPrompt()` marks the run active, calls `agent.prompt(messages)`, then loops `while (await this._handlePostAgentRun()) await this.agent.continue()`. Only in the `finally` block does it clear the per-turn system-prompt override, flush pending bash messages, and emit `agent_settled`.[^agent-session-run-loop] The docs describe the same distinction: `agent_end` means one low-level run ended, but Pi may still auto-retry, auto-compact-and-retry, or process queued follow-ups; `agent_settled` means none of that remains.[^extensions-agent-settled]

So, relative to the ticket’s timing questions:

- **Provider requests inside one agent/tool loop** happen before `agent_end`, and potentially multiple times per run because the agent may call tools and continue.[^extensions-lifecycle]
- **Queued steering/follow-up messages** are still part of the same “busy” period; `ctx.isIdle()` stays false until they drain.[^extensions-isidle]
- **Automatic retry and auto-compaction retry** also keep the run non-idle until `agent_settled`.[^extensions-isidle][^agent-session-run-loop]

### 1.2 Compaction checks happen after the run, and once more before a fresh top-level prompt

Post-run handling is explicit:

1. capture the last assistant message;
2. if it is retryable, schedule retry first;
3. if retries are exhausted, emit `auto_retry_end` failure;
4. run `_checkCompaction(msg)`;
5. if nothing else is needed, return whether the agent itself still has queued messages from `agent_end` handlers.[^agent-session-post-run]

`prompt()` does one extra preflight compaction check before it adds the next user message: it finds the last assistant message and calls `_checkCompaction(lastAssistant, false)` specifically to “catch aborted responses”.[^agent-session-preprompt-check]

That means:

- **After each low-level assistant/tool run:** retry decision first, then compaction check.[^agent-session-post-run]
- **Before a brand-new top-level user turn while idle:** one more compaction check based on the prior assistant message, including aborted turns.[^agent-session-preprompt-check]
- **Not before each provider request inside an ongoing turn:** there is no `_checkCompaction()` call in the per-request path; the per-request seams are `context`, `before_provider_headers`, `before_provider_request`, and `after_provider_response`.[^sdk-stream-hooks][^extensions-lifecycle]

### 1.3 Overflow recovery and threshold compaction are different flows

`_checkCompaction()` documents two cases: overflow and threshold.[^agent-session-check-compaction]

- **Overflow path.** If the current model matches the assistant message’s provider/model and `isContextOverflow(...)` says the message overflowed, Pi treats it as overflow recovery. If the message already finished with `stopReason === "stop"`, it compacts but does **not** retry. Otherwise it removes the trailing error assistant from in-memory context and runs auto-compaction with `willRetry = true`.[^agent-session-check-compaction]
- **Threshold path.** Otherwise Pi computes `contextTokens` from assistant usage, or, for error/all-zero usage messages, from the last valid post-compaction usage plus trailing estimates. If `shouldCompact(contextTokens, contextWindow, settings)` is true, Pi auto-compacts with `reason: "threshold"` and `willRetry = false`.[^agent-session-check-compaction][^compaction-estimate][^compaction-shouldcompact]

Important details for exact timing:

- Pi skips stale pre-compaction messages by comparing assistant timestamps to the latest compaction entry timestamp.[^agent-session-check-compaction]
- Pi skips overflow recovery if the overflow message came from a **different model** than the current one, so a switch to a larger-context model does not inherit a smaller model’s overflow.[^agent-session-check-compaction]
- Overflow recovery is one-shot per user message. `_overflowRecoveryAttempted` is reset on a new user message start or a successful assistant response; the second overflow emits a failure notice instead of looping forever.[^agent-session-message-persist][^agent-session-check-compaction][^test-overflow-once]

### 1.4 Queued messages and settlement around compaction

For threshold compaction, `_runAutoCompaction()` returns `this.agent.hasQueuedMessages()` after compacting, so the enclosing `_runAgentPrompt()` loop will continue if agent-level queues still contain pending messages.[^agent-session-auto-compaction] The pinned test suite explicitly covers the case where `session.pendingMessageCount === 0` but `session.agent.hasQueuedMessages() === true`; auto-compaction must still return `true` so the loop resumes.[^test-queue-resume]

User-visible queue semantics are documented separately: steering messages are delivered after the current assistant turn finishes its tool calls; follow-ups are delivered only after the agent finishes all work.[^readme-message-queue]

## 2. When usage is measured and why context can exceed 100%

### 2.1 The measurement model

`getContextUsage()` uses the active model’s `contextWindow`, refuses to guess if there is no model/window, and then:

- after compaction, returns `{ tokens: null, percent: null }` until it sees a **post-compaction successful assistant usage**;
- otherwise runs `estimateContextTokens(this.messages)` and computes `percent = (estimate.tokens / contextWindow) * 100`.[^agent-session-context-usage]

`estimateContextTokens()` itself uses the **last valid assistant usage** when one exists, then adds heuristic estimates for trailing messages after that point; if there is no usable assistant usage at all, it estimates the entire message list heuristically.[^compaction-estimate]

### 2.2 Why >100% is expected, not a bug

The threshold and the display use different denominators:

- auto-compaction threshold: `contextTokens > contextWindow - reserveTokens`.[^compaction-shouldcompact][^compaction-doc-threshold]
- footer/context percentage: `estimate.tokens / contextWindow * 100`.[^agent-session-context-usage]

So Pi can show:

- **well under 100% but already “near compaction”** because `reserveTokens` is intentionally held back for the next response; with default `reserveTokens = 16384`, the threshold fires before the raw window is full.[^settings-compaction][^compaction-doc-threshold]
- **at or above 100%** because Pi only checks threshold after a run ends or before the next prompt, and because overflow detection can also rely on provider-reported usage / overflow errors after the fact.[^agent-session-post-run][^agent-session-check-compaction]

`keepRecentTokens` is a separate cut-point budget, not a threshold; it controls how much recent material survives summarization once compaction is happening.[^compaction-doc-process][^settings-compaction]

### 2.3 Which usage/cost buckets Pi totals

Pi’s totals include:

- assistant message usage;
- nested usage attached to `toolResult` messages;
- usage attached to `compaction` or `branch_summary` entries.[^usage-totals]

The docs promise the same for tools (“return `usage` and Pi includes it in footer, `/session`, and RPC totals”) and for custom compaction / tree summaries (“usage” is optional and included in totals).[^extensions-tool-usage][^extensions-compaction-events][^compaction-doc-hooks]

## 3. What each extension seam can and cannot safely do

### 3.1 Context and provider seams

- **`before_agent_start`** can inject persistent custom messages and replace the turn’s system prompt before the run begins.[^extensions-before-agent]
- **`context`** fires before **each** LLM call with a deep copy of messages; it is the right seam for per-call, non-persistent pruning or synthetic memory injection.[^extensions-context-hook]
- **`before_provider_headers`** mutates headers in place; it runs once per provider request, and transport retries reuse the same headers instead of re-firing the hook.[^extensions-provider-hooks]
- **`before_provider_request`** sees the already-serialized provider payload and may replace it. Those payload edits are *not* reflected by `ctx.getSystemPrompt()`.[^extensions-provider-hooks][^extensions-get-system-prompt]
- **`after_provider_response`** sees status + headers before stream consumption.[^extensions-provider-hooks]

Safe / unsafe summary:

- Safe for observational memory: `context`-level memory injection, provider-payload inspection, provider-header tracing.[^extensions-context-hook][^provider-payload-example]
- Unsafe as a persistence mechanism: `context`/provider hooks do not write session state; they only affect one request path.[^extensions-context-hook][^extensions-append-entry]

### 3.2 Message and tool seams

- **`message_end`** may replace the finalized message, but the role must stay the same.[^extensions-message-events] In readable source, Pi mutates the finalized message object in place so later state/persistence stay aligned.[^agent-session-message-replace]
- **`tool_call`** can mutate validated tool input in place and block execution; Pi does **not** re-validate after mutation, and sibling tool results from the same assistant message are not guaranteed to be present in `ctx.sessionManager`.[^extensions-tool-call]
- **`tool_result`** can patch `content`, `details`, `isError`, and `usage`; it is also the main accounted seam for nested model calls because that usage is persisted on the tool result.[^extensions-tool-result][^extensions-tool-usage]
- `ctx.signal` is normally available in active turn hooks (`tool_call`, `tool_result`, `message_update`, `turn_end`) so nested abort-aware fetch/model work can be cancelled with Esc.[^extensions-signal]

### 3.3 Turn, compaction, and session seams

- **`turn_end`** is a good trigger point for heuristic observation because the assistant message and tool results for that turn are finalized.[^extensions-turn-events]
- **`agent_settled`** is better when the memory policy must run only after retries, compaction, and queued follow-ups are exhausted.[^extensions-agent-settled][^agent-session-run-loop]
- **`session_before_compact` / `session_compact`** can cancel compaction or provide a custom summary, and Pi emits `reason` (`manual` / `threshold` / `overflow`) plus `willRetry` so an extension can distinguish ordinary summarization from overflow recovery.[^extensions-compaction-events][^compaction-doc-hooks]
- **`session_before_tree` / `session_tree`** can cancel tree navigation or substitute a custom branch summary.[^extensions-tree-events][^compaction-doc-tree]
- **Session replacement APIs (`newSession`, `fork`, `switchSession`)** are intentionally command-only because calling them from event handlers can deadlock; after replacement, the old session-bound objects are stale and only the `withSession` context is safe.[^extensions-command-context][^extensions-session-replacement]

### 3.4 Persistence and context visibility

- `pi.appendEntry(customType, data)` persists branch-scoped extension state that **does not** enter model context.[^extensions-append-entry]
- `pi.sendMessage(...)` appends a persistent `custom_message` that **does** participate in model context.[^extensions-send-message][^session-format-custom-message]
- `pi.sendUserMessage(...)` always creates a real user turn; while streaming, it must be delivered as `steer` or `followUp`.[^extensions-send-user-message]

That gives an observational-memory extension two workable patterns:

1. **Hidden journal + synthesized context**: persist structured memory state with `appendEntry`, reconstruct it on `session_start`, and inject a synthesized memory message in `context` on every provider call.[^extensions-append-entry][^extensions-session-start][^extensions-context-hook]
2. **Persistent visible memory messages**: write `custom_message` entries via `sendMessage`, then prune/supersede them in `context` if only the newest memory note should reach the model.[^extensions-send-message][^extensions-context-hook]

## 4. Persistence, branching, forks, trees, retries, cancellation, and model switches

### 4.1 Branch / fork / clone / tree behavior

The session tree is path-based. `buildContextEntries()` walks the current leaf path and, when a compaction entry exists, keeps the compaction entry plus the kept suffix and later entries; `buildSessionContext()` then projects those entries into actual model messages and separately derives model / thinking state from the path.[^session-manager-context-build]

Fork/clone persistence is path-copy based. `createBranchedSession()` copies the active root-to-leaf path into a new session file, filtering only label entries; custom entries, custom messages, compactions, branch summaries, model changes, and thinking-level changes stay in the copied path.[^session-manager-branch-copy]

`/tree` summaries are attached at the navigation point, not globally. The pinned tests verify root, nested-user, and assistant-target placement, and verify that aborting summarization leaves the session unchanged.[^test-tree-summary-placement]

### 4.2 Retries and cancellation

Automatic retry happens before compaction in post-run handling, with exponential backoff and an abortable sleep; retry removes the trailing error assistant from in-memory context but leaves it in session history.[^agent-session-post-run][^agent-session-retry]

Manual `session.abort()` aborts retry and the agent, then waits for full idle; branch summarization and compaction have their own abort controllers and surface aborted results instead of mutating the session.[^agent-session-abort][^test-tree-summary-placement][^agent-session-auto-compaction]

### 4.3 Model switches

Pi records model changes in session history and rebuilds the effective model from the active path on restore.[^session-manager-context-build] `model_select` fires on explicit set, model cycling, and restore.[^extensions-model-select][^agent-session-model-select]

Overflow recovery is model-sensitive: Pi refuses to compact because of a stale overflow from a different model than the one now selected.[^agent-session-check-compaction]

## 5. Prompt-cache consequences of context mutation

Two separate mechanisms matter:

1. **session-derived affinity / routing keys** such as OpenAI `prompt_cache_key`, `session_id`, `x-client-request-id`, `x-session-affinity`, and provider-specific variants; these are derived from the session id and cache-retention settings, not from the message content.[^sdk-stream-hooks][^openai-cache-source][^openai-cache-test][^models-cache-doc]
2. **content-based cacheable prefixes / cache markers** such as Anthropic-style `cache_control` on the system prompt, last tool definition, and last user/assistant text content.[^anthropic-cache-source][^models-cache-doc][^custom-provider-cache-doc]

Implications for observational memory:

- Reusing the same session id helps requests route to the same provider-side cache bucket, but **it does not make mutated prompts cache-hit** if the cached prefix itself changes.[^openai-cache-source][^models-cache-doc]
- Any extension that rewrites system prompt, tool definitions, or transcript content per turn can reduce prompt-cache reuse, because those fields are exactly where Pi places cache markers for Anthropic-style caching and where provider payload equality matters for OpenAI-style prefix caching.[^anthropic-cache-source][^openai-cache-source][^custom-provider-cache-doc]
- Pi’s own changelog treats prompt stability as cache-sensitive: the release explicitly removed volatile date/time prompt content to keep prompt prefixes cacheable across reloads and resumed sessions.[^changelog-cache]

So the safe observational-memory strategy is: keep the synthesized memory block **stable when nothing meaningful changed**, and avoid rewriting unrelated prefix content on every turn.

## 6. Sufficiency for observational memory, and the one seam that still looks missing

### 6.1 What is already sufficient

For a session-scoped observational-memory extension, Pi already gives enough to:

- observe after each turn (`turn_end`) or only after full settlement (`agent_settled`);[^extensions-turn-events][^extensions-agent-settled]
- measure current context pressure (`ctx.getContextUsage()`);[^extensions-context-usage]
- trigger compaction proactively (`ctx.compact()` / custom compaction hooks);[^extensions-compact][^compaction-example-trigger][^compaction-doc-hooks]
- persist branch-scoped hidden state (`pi.appendEntry()`);[^extensions-append-entry]
- reconstruct that state on reload / replacement (`session_start`, `sessionManager.getEntries()`);[^extensions-session-start][^extensions-append-entry]
- inject ephemeral or persistent model-visible memory (`context`, `sendMessage`);[^extensions-context-hook][^extensions-send-message]
- start a follow-up run when needed (`sendUserMessage`, commands, replacement-session `withSession`);[^extensions-send-user-message][^extensions-session-replacement]
- survive tree/fork/clone/new-session behavior because the session model is tree/path based, not linear.[^session-manager-context-build][^session-manager-branch-copy]

That is enough for an **append-only memory journal + synthesized current-memory block** design without a core patch.

### 6.2 The seam that still looks missing

The missing seam is **generic, non-tool usage attribution**.

Today Pi totals only aggregate assistant usage, `toolResult.usage`, and compaction / branch-summary usage.[^usage-totals] The docs give accounted paths for nested model usage in tools and compaction, but not for arbitrary extension work kicked off from `turn_end`, `agent_settled`, `session_start`, or commands.[^extensions-tool-usage][^extensions-compaction-events]

So if observational memory performs its own background model call from an event hook, you currently have three options:

1. accept invisible cost/tokens in Pi’s footer and session totals;
2. route the observation through a tool-like path so usage can be returned on a `toolResult`; or
3. request a Pi core seam that lets extensions append standalone usage records.

That is the only core gap I found that looks both real and precisely specifiable from this research.

## Bottom line

Pi’s context lifecycle is late-bound and turn-oriented: rebuild context from the active session path, run `context`/provider hooks before each provider request, measure context from last valid assistant usage plus trailing estimates, then check retry and compaction only after the run ends (plus one pre-prompt aborted-turn check).[^session-manager-context-build][^sdk-stream-hooks][^compaction-estimate][^agent-session-post-run][^agent-session-preprompt-check]

For observational memory, the existing seams are strong enough to ship a branch-scoped, append-only journal with synthesized per-call memory. The main design constraint is cache stability, and the main core seam still missing is generic accounted usage for extension-initiated model calls outside tool/compaction paths.[^changelog-cache][^usage-totals]

[^release-json]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/release.json:1-15`.
[^release-doc-index]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/index.md:1-40`.
[^readme-message-queue]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/README.md:220-231`.
[^settings-compaction]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/settings.md:109-131`.
[^models-cache-doc]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/models.md:406-459`.
[^custom-provider-cache-doc]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/custom-provider.md:256-262,763-763`.
[^provider-payload-example]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/examples/extensions/provider-payload.ts:1-16`.
[^compaction-example-trigger]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/examples/extensions/trigger-compact.ts:1-40`.
[^extensions-lifecycle]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:277-349`.
[^extensions-session-start]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:394-434`.
[^extensions-before-agent]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:540-558`.
[^extensions-agent-settled]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:560-572`.
[^extensions-turn-events]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:574-588`.
[^extensions-message-events]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:590-614`.
[^extensions-context-hook]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:650-660`.
[^extensions-provider-hooks]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:662-708`.
[^extensions-tool-call]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:753-767`.
[^extensions-tool-result]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:816-847`.
[^extensions-signal]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:997-1016`.
[^extensions-isidle]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1022-1034`.
[^extensions-context-usage]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1044-1054`.
[^extensions-compact]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1055-1068`.
[^extensions-get-system-prompt]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1071-1102`.
[^extensions-command-context]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1086-1206`.
[^extensions-session-replacement]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1240-1305`.
[^extensions-send-message]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1400-1421`.
[^extensions-send-user-message]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1423-1449`.
[^extensions-append-entry]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1451-1460`.
[^extensions-model-select]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:715-731`.
[^extensions-compaction-events]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:453-484`.
[^extensions-tree-events]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:486-507`.
[^extensions-tool-usage]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/extensions.md:1975-1978`.
[^compaction-doc-threshold]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/compaction.md:25-44`.
[^compaction-doc-process]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/compaction.md:41-79,85-119`.
[^compaction-doc-hooks]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/compaction.md:275-348`.
[^compaction-doc-tree]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/compaction.md:349-367`.
[^session-format-custom-message]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/docs/session-format.md:300-304,354-364`.
[^sdk-stream-hooks]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/sdk.ts#L302-L360`.
[^agent-session-run-loop]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1059-L1070`.
[^agent-session-post-run]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1073-L1100`.
[^agent-session-preprompt-check]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1195-L1200`.
[^agent-session-message-persist]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L623-L650`.
[^agent-session-message-replace]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L693-L707`.
[^agent-session-context-usage]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L3154-L3198`.
[^agent-session-check-compaction]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1940-L2040`.
[^agent-session-auto-compaction]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L2043-L2216`.
[^agent-session-retry]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L2673-L2739`.
[^agent-session-abort]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1537-L1551`.
[^agent-session-model-select]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1557-L1568`.
[^compaction-estimate]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/compaction/compaction.ts#L191-L249`.
[^compaction-shouldcompact]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/compaction/compaction.ts#L160-L165`.
[^session-manager-context-build]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/session-manager.ts#L362-L469`.
[^session-manager-branch-copy]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/session-manager.ts#L1096-L1118,L1381-L1448`.
[^usage-totals]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/usage-totals.ts#L22-L60`.
[^openai-cache-source]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/ai/src/api/openai-completions.ts#L551-L596`.
[^anthropic-cache-source]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/ai/src/api/anthropic-messages.ts#L896-L999`.
[^openai-cache-test]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/ai/test/openai-completions-prompt-cache.test.ts#L115-L262`.
[^test-queue-resume]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts#L59-L124`.
[^test-overflow-once]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts#L146-L188`.
[^test-tree-summary-placement]: `https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/agent-session-tree-navigation.test.ts#L78-L205`.
[^changelog-cache]: `/Users/taylorrowser/Library/Application Support/pi-wait-for-user/releases/pi-v0.81.1-patch.3/CHANGELOG.md:174-175,1340-1415,1493-1493,2047-2047`.
