# Pi Observational Memory

A Pi extension for session-scoped observational memory during long user turns.

The extension watches completed model steps. With the production defaults, it asynchronously observes the oldest complete source prefix once uncovered exact messages reach 80,000 tokens, contracting that layer toward 20,000 tokens. It activates validated memory during background maintenance or the next safe context projection. Once active observations reach 40,000 tokens, maintenance or projection folds the oldest contiguous observations toward a 20,000-token target through one validated reflection. Replay selects only the newest valid reflection, newer observations, the newest active-task anchor, and the exact uncovered source tail.

Those configured start thresholds and contraction targets override the lower-level model-relative fallback policy. Callers without settings derive raw target 50%, soft pressure 60%, observation target 15%, and observation high pressure 25% from the actor model's usable input budget. With configured production settings, hard safety blocks at 200,000 tokens of complete projected actor input, clamped to the selected model's context window. That input includes the effective system prompt, active tool schemas, rendered observations and reflection, and exact uncovered messages; it does not reserve the actor's entire maximum-output allowance. Callers without settings retain the fallback hard threshold of 85% of usable actor input. Observer output is capped at 10% of usable input or the model's maximum output; configured production reflection output is capped at 5,000 tokens per generation.

Normal observation shows a compact status only while work is running. At hard pressure, the next actor request visibly waits only while that projection is actually blocked by serial memory work. If the actor stops while session-owned observation or reflection continues, the waiting label clears back to `observing` or `reflecting`; it clears entirely when memory work finishes. If Pi's live context drifts from the durable session representation, memory reconstructs and safely projects the durable branch instead of aborting solely because strict composition failed. A failed or invalid frozen pass is retried exactly once; exhaustion or cancellation preserves exact source, aborts the actor run, and leaves an explicit terminal status rather than falling back to stock compaction. Exhaustion notifications classify both failed attempts without retaining full observer output.

The selected root-to-leaf Pi ancestry is the sole replay authority. Successful tree navigation cancels obsolete work and reconstructs the destination immediately, so sibling or abandoned memory cannot leak. A Pi branch summary is the only explicit cross-branch handoff; when covered, it remains structurally labeled as derived orientation with its source and producer provenance, never exact completion evidence. Forks and clones preserve copied committed identities and provenance, while all new work binds to the child session and no in-memory pass migrates.

Context hooks compose conservatively. Covered Pi-built source is replaced only when its canonical messages occur as one exact, unambiguous sequence in the incoming chained context. Messages inserted outside that sequence retain their order. Below hard pressure, rewritten, missing, duplicated, reordered, or interleaved live context is preserved unchanged. Under hard pressure, the durable session branch becomes the recovery authority: live-only rewrites or inserted extension context may be replaced by canonical persisted source when that source can be made safe; otherwise the actor stops visibly rather than sending an over-limit request.

Actor-model changes recompute every pressure and request-headroom budget without invalidating committed memory or changing its producer provenance. Completed passes frozen under an earlier model may still activate when their ancestry and coverage remain valid. Failed, aborted, and partial assistant responses remain exact until a later complete boundary, and terminal tool failures remain explicitly failed evidence.

Observational memory cancels Pi's proactive threshold compaction. Explicit `/compact` performs a synchronous observational compaction toward the configured 20k exact-message target and reflects when the observation layer crosses its configured threshold. Pi's normal overflow compaction remains a last-resort fallback if a provider rejects a request despite the extension's headroom checks; that stock compaction starts a fresh replay epoch where Pi's summary and retained tail become authoritative. Navigating before that compaction entry restores the earlier valid observational epoch. Session replacement and shutdown fence old work before rebinding, and responses returned after that fence append no memory to a new session.

Observer and Reflector usage is retained on persisted memory records for audit. If Pi exposes standalone extension-usage support, the calls are also included in its stock footer and `/session` totals. Published Pi versions through 0.84.1 do not expose that API or aggregate custom usage entries, so they retain a dedicated append-only usage entry for audit but do not include it in stock overall cost.

## Install

Install directly from Git as a normal Pi package:

```bash
pi install git:github.com/taylorrowser/pi-observational-memory
```

For a project-local installation:

```bash
pi install git:github.com/taylorrowser/pi-observational-memory -l
```

Restart Pi after installation. Use `pi list` to confirm the package and `pi config` to enable or disable it.

To try a local checkout without installing it:

```bash
npm ci
pi --extension .
```

## Use and limitations

Observational memory is ambient. Pi shows message, observation, and reflection token-layer metrics in one extension status line; progress may exceed 100% while a layer remains above its configured threshold. Reaching the message threshold starts background maintenance. The same line appends distinct `observing` or `reflecting` activity, along with `compacting memory` and hard-headroom waiting states when applicable. While the actor is running, the first Escape remains Pi's actor interrupt and background memory continues. After Pi becomes idle, a later Escape stops active background memory without activating partial output. If the one hard-pause retry is exhausted, Pi stops visibly and preserves exact source.

Commands:

- `/compact` — force observational compaction toward the message target, then reflect if warranted;
- `/stock-compact` — deliberately run Pi's stock summary compaction and start a fresh replay epoch;
- `/memory on|off` — enable or disable new memory work without deleting or expanding active projected memory;
- `/memory-settings` — edit global or trusted-project settings in a validated JSON editor;
- `/observations` — inspect and append a correction to an observation;
- `/reflection` — inspect and append a correction to the active reflection.

Settings are stored in `~/.pi/agent/observational-memory.json` or the trusted project’s `.pi/observational-memory.json`. Project values override global values. Defaults are:

```json
{
  "enabled": true,
  "debugLogging": false,
  "messageTokensTarget": 20000,
  "messageTokensStartObservation": 80000,
  "hardHeadroomTokens": 200000,
  "observationTokensTarget": 20000,
  "observationTokensStartReflection": 40000,
  "reflectionTokensMax": 5000
}
```

### Memory lifecycle

1. On startup or resume, after completed turns, and after the agent settles, a session-owned background coordinator checks the estimated tokens in uncovered exact messages. It starts when that message layer reaches the configured threshold; fixed system-prompt and tool-schema tokens do not trigger it early. It freezes the oldest uncovered prefix ending at a complete assistant response or completed tool-call set and asks the actor model to retire enough source toward the message target. The coordinator continues catch-up independently after the actor finishes or is interrupted.
2. The observer result is validated and held as ready. It does not replace source immediately. The coordinator or a later context projection persists and activates it only if session lineage, source coverage, ancestry, and context composition still match unambiguously.
3. Projection renders the active reflection, observations not already folded into it, the current task anchor, and the exact uncovered source tail.
4. When active, unfolded observations reach the reflection threshold, the background coordinator or projection generates a reflection over the oldest contiguous observation prefix. Background maintenance safely activates each observation before reflecting and continues serially until no work is due. It folds enough whole observation commits to move toward the observation target. Manual `/compact` performs observations serially until the message layer reaches its target, then repeats reflection while warranted.
5. Independently of the layer thresholds, each actor projection passes a complete-input hard-headroom gate. With production settings, the gate counts the system prompt, tool schemas, rendered observation/reflection memory, and uncovered messages against the 200k limit. A live-context composition mismatch first falls back to the canonical durable branch, reconciles memory lineage from persisted records when necessary, and then uses the normal hard-pressure coordinator to wait for or launch memory work until the recovered projection fits below the gate. This preserves committed memory and the exact persisted tail, but may replace live-only upstream extension context. A terminal state can resume if later memory or a reduced input makes projection safe. Ambiguous durable source or exhausted memory retries still abort fail-closed rather than sending an over-limit request.

Targets and limits must be positive integers; each target must be lower than its corresponding start threshold. The 80k message and 40k observation values start work, while the 20k values guide contraction; none is a hard retained-layer cap. Observations retire whole completed model/tool steps and reflections fold whole observation commits, so boundaries can overshoot a target. A layer can also remain above its start threshold while work runs, awaits safe activation, or has no complete boundary available. `reflectionTokensMax` limits one generated reflection response, not the total lifetime of the reflection layer.

For large tool results, the observer retains task-relevant findings plus literal retrieval breadcrumbs such as source entry IDs, tool names and commands, paths, symbols, and distinctive errors or literals. When detail is omitted from memory, the observation identifies that the exact source remains recoverable from the session JSONL with `rg`.

Edits and usage records are append-only. Disabling memory immediately stops new work while retaining any already-active projected memory, so it cannot unsafely expand a large context; re-enabling reuses the validated replay epoch and catches up normally. Stock overflow compaction remains the emergency escape hatch. Derived memory remains fallible, exact source remains canonical, and the extension makes no universal cost, latency, or task-quality claim.

Set `debugLogging` to `true` to append bounded `observational-memory:event` lifecycle records to the session JSONL and show actionable TUI notifications. Routine maintenance-requested and maintenance-started events, plus settled checks that create zero observations and zero reflections, remain persisted for diagnosis but do not notify. Events cover maintenance, observation, reflection, retry, hard-headroom waiting, and cancellation outcomes, with reason codes, layer metrics and thresholds, pass IDs, attempt numbers, and coverage counts where applicable. They have their own runtime timestamps and never include prompts, source content, or raw model responses. Debug events are always excluded from observer source, replay memory, and actor context. The default is `false`; when disabled, no lifecycle event entries or debug notifications are produced.

## Cost simulation

[`docs/cost-simulation.md`](docs/cost-simulation.md) records the reproducible GPT 5.6 Sol Monte Carlo comparison with stock Pi compaction. It covers the corrected 272k stock-compaction counterfactual, empirical workload fitting, provider pricing, actor prompt-cache invalidation, perfect/warm/no-cache sensitivities, results, and limitations. That historical run used the earlier 40k message-start policy; it must be rerun before its results are attributed to the current 80k/200k policy.

## Acceptance evidence

`npm run acceptance` is the repeatable clean-checkout acceptance command. It builds and smoke-loads the extension, runs the deterministic suite, and then runs five paired faux-provider scenarios through the installed stock Pi SDK runtime:

- short/no activation;
- steady context growth;
- bursty oversized tool output;
- one uninterrupted tool loop; and
- repeated observation/reflection contraction.

Each scenario compares observational memory, exact full-history replay, and stock Pi compaction where applicable. The harness enforces safe actor headroom and valid atomic coverage, writes and evaluates durable tool artifacts, verifies an exact uncovered tail and canonical-source recovery, and reports actor maximum context, observation/reflection usage, hard-wait count and duration, cache reads, repeated work, compactions, and task outcome separately. Focused failure and real-runtime lifecycle smokes cover malformed or delayed work, retry, cancellation, terminal stop, branch navigation, model selection, session replacement, explicit compaction, and chained context extensions.

The auditable JSON report is written to `.cache/acceptance-report.json`. It reports memory-call usage from persisted observation and reflection records; stock Pi's session totals do not include that background usage. Results apply only to the deterministic faux-provider configuration and demonstrate bounded-context behavior, not general model quality or economics.

## Development

Requires Node.js 22.19 or newer and Pi 0.81.1 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke
npm run acceptance
```

`npm run smoke` builds the package and loads its Pi package manifest in the installed `pi` CLI without making a provider request. Set `PI_BIN` to test a specific Pi executable. `npm run acceptance` exercises the extension through the installed stock Pi SDK runtime.

## Load locally

```bash
npm run build
pi --extension .
```
