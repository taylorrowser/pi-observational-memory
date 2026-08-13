# Pi Observational Memory

A Pi extension for session-scoped observational memory during long user turns.

The extension watches completed model steps. With the production defaults, it asynchronously observes the oldest complete source prefix once uncovered exact messages reach 40,000 tokens, contracting that layer toward 20,000 tokens. It activates validated memory during background maintenance or the next safe context projection. Once active observations reach 40,000 tokens, maintenance or projection folds the oldest contiguous observations toward a 20,000-token target through one validated reflection. Replay selects only the newest valid reflection, newer observations, the newest active-task anchor, and the exact uncovered source tail.

Those configured start thresholds and contraction targets override the lower-level model-relative fallback policy. Callers without settings derive raw target 50%, soft pressure 60%, observation target 15%, and observation high pressure 25% from the actor model's usable input budget. Hard safety is always model-relative: hard pressure is 85% of usable actor input, with the remaining 15% reserved. Observer output is capped at 10% of usable input or the model's maximum output; configured production reflection output is capped at 5,000 tokens per generation. Before each actor request, the hard gate checks both the exact uncovered source and the complete projected request, including the effective system prompt, active tool schemas, actor output allowance, and safety reserve.

Normal observation shows a compact status only while work is running. At hard pressure, the next actor request visibly waits while serial memory work restores safe headroom. A failed or invalid frozen pass is retried exactly once; exhaustion or cancellation preserves exact source, aborts the actor run, and leaves an explicit terminal status rather than falling back to stock compaction. Exhaustion notifications classify both failed attempts without retaining full observer output.

The selected root-to-leaf Pi ancestry is the sole replay authority. Successful tree navigation cancels obsolete work and reconstructs the destination immediately, so sibling or abandoned memory cannot leak. A Pi branch summary is the only explicit cross-branch handoff; when covered, it remains structurally labeled as derived orientation with its source and producer provenance, never exact completion evidence. Forks and clones preserve copied committed identities and provenance, while all new work binds to the child session and no in-memory pass migrates.

Context hooks compose conservatively. Covered Pi-built source is replaced only when its canonical messages occur as one exact, unambiguous sequence in the incoming chained context. Messages inserted outside that sequence retain their order. Rewritten, missing, duplicated, reordered, or interleaved source is preserved exactly; under hard pressure the actor stops visibly rather than deleting ambiguous or third-party context.

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
  "messageTokensTarget": 20000,
  "messageTokensStartObservation": 40000,
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
5. Independently of those configurable thresholds, each actor projection passes a model-relative hard-headroom gate. At hard pressure, memory work becomes blocking, retries one failed frozen observation, and aborts fail-closed with exact source preserved if safe headroom cannot be restored.

Targets must be positive integers; each target must be lower than its corresponding start threshold. The 40k values start work and the 20k values guide contraction; none is a hard retained-layer cap. Observations retire whole completed model/tool steps and reflections fold whole observation commits, so boundaries can overshoot a target. A layer can also remain above its start threshold while work runs, awaits safe activation, or has no complete boundary available. `reflectionTokensMax` limits one generated reflection response, not the total lifetime of the reflection layer.

Edits and usage records are append-only. Disabling memory immediately stops new work while retaining any already-active projected memory, so it cannot unsafely expand a large context; re-enabling reuses the validated replay epoch and catches up normally. Stock overflow compaction remains the emergency escape hatch. Derived memory remains fallible, exact source remains canonical, and the extension makes no universal cost, latency, or task-quality claim.

## Cost simulation

[`docs/cost-simulation.md`](docs/cost-simulation.md) records the reproducible GPT 5.6 Sol Monte Carlo comparison with stock Pi compaction. It covers the corrected 272k stock-compaction counterfactual, empirical workload fitting, provider pricing, actor prompt-cache invalidation, perfect/warm/no-cache sensitivities, results, and limitations.

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
