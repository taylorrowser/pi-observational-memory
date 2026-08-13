# Pi Observational Memory

A Pi extension for session-scoped observational memory during long user turns.

The extension watches completed model steps and remains inert below a built-in soft pressure watermark. Above it, the extension asynchronously observes the oldest complete source prefix with the current actor model, validates and persists the resulting memory, and activates it on the next safe context projection. When active observations reach their high watermark, the projection waits for one validated reflection generation that folds the oldest contiguous observations toward their target. Replay selects only the newest valid reflection, newer observations, the newest active-task anchor, and the exact uncovered source tail.

The built-in policy derives every threshold from the actor model's usable input budget: raw target 50%, soft pressure 60%, hard pressure 85%, observation target 15%, and observation high pressure 25%. Observer and Reflector output budgets are capped at 10% of usable input or the model's maximum output, whichever is smaller. Before each actor request, the hard gate checks both the exact uncovered source and the complete projected request, including the effective system prompt, active tool schemas, actor output allowance, and the remaining 15% safety reserve.

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

Observational memory is ambient. Pi shows message, observation, and reflection token-layer metrics in the extension status line; displayed threshold progress saturates at 100%. While work runs it also shows `observing`, `compacting memory`, or a hard-headroom waiting status. Pressing Escape cancels the actor and current memory work without activating partial output. If the one hard-pause retry is exhausted, Pi stops visibly and preserves exact source.

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

Targets must be positive integers; each target must be lower than its corresponding start threshold. Edits and usage records are append-only. Disabling memory immediately stops new work while retaining any already-active projected memory, so it cannot unsafely expand a large context; re-enabling reuses the validated replay epoch and catches up normally. Stock overflow compaction remains the emergency escape hatch. Derived memory remains fallible, exact source remains canonical, and the extension makes no universal cost, latency, or task-quality claim.

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
