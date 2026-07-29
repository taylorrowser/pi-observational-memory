# Pi Observational Memory

A Pi extension for session-scoped observational memory during long user turns.

The extension watches completed model steps and remains inert below a built-in soft pressure watermark. Above it, the extension asynchronously observes the oldest complete source prefix with the current actor model, validates and persists the resulting memory, and activates it on the next safe context projection. When active observations reach their high watermark, the projection waits for one validated reflection generation that folds the oldest contiguous observations toward their target. Replay selects only the newest valid reflection, newer observations, the newest active-task anchor, and the exact uncovered source tail.

The built-in policy derives every threshold from the actor model's usable input budget: raw target 50%, soft pressure 60%, hard pressure 85%, observation target 15%, and observation high pressure 25%. Observer and Reflector output budgets are capped at 10% of usable input or the model's maximum output, whichever is smaller. Before each actor request, the hard gate checks both the exact uncovered source and the complete projected request, including the effective system prompt, active tool schemas, actor output allowance, and the remaining 15% safety reserve.

Normal observation shows a compact status only while work is running. At hard pressure, the next actor request visibly waits while serial memory work restores safe headroom. A failed or invalid frozen pass is retried exactly once; exhaustion or cancellation preserves exact source, aborts the actor run, and leaves an explicit terminal status rather than falling back to stock compaction.

The selected root-to-leaf Pi ancestry is the sole replay authority. Successful tree navigation cancels obsolete work and reconstructs the destination immediately, so sibling or abandoned memory cannot leak. A Pi branch summary is the only explicit cross-branch handoff; when covered, it remains structurally labeled as derived orientation with its source and producer provenance, never exact completion evidence. Forks and clones preserve copied committed identities and provenance, while all new work binds to the child session and no in-memory pass migrates.

Context hooks compose conservatively. Covered Pi-built source is replaced only when its canonical messages occur as one exact, unambiguous sequence in the incoming chained context. Messages inserted outside that sequence retain their order. Rewritten, missing, duplicated, reordered, or interleaved source is preserved exactly; under hard pressure the actor stops visibly rather than deleting ambiguous or third-party context.

Standalone Observer and Reflector usage is attributed through the pinned Pi core capability documented in [`pi-core/README.md`](pi-core/README.md).

## Development

Requires Node.js 22.19 or newer and Pi 0.81.1.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke
npm run pi-core:check
```

`npm run smoke` builds the package and loads its Pi package manifest in the installed `pi` CLI without making a provider request. Set `PI_BIN` to test a specific Pi executable.

`npm run pi-core:check` clones the declared Pi version into `.cache/`, applies the standalone extension-usage patch, and runs its typecheck, integration tests, and offline build. See [`pi-core/README.md`](pi-core/README.md).

## Load locally

```bash
npm run build
pi --extension .
```
