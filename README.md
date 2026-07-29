# Pi Observational Memory

A Pi extension for session-scoped observational memory during long user turns.

The extension watches completed model steps and remains inert below a built-in soft pressure watermark. Above it, the extension asynchronously observes the oldest complete source prefix with the current actor model, validates and persists the resulting memory, and activates it on the next safe context projection. When active observations reach their high watermark, the projection waits for one validated reflection generation that folds the oldest contiguous observations toward their target. Replay selects only the newest valid reflection, newer observations, the newest active-task anchor, and the exact uncovered source tail.

The built-in policy derives every threshold from the actor model's usable input budget: raw target 50%, soft pressure 60%, hard pressure 85%, observation target 15%, and observation high pressure 25%. Observer and Reflector output budgets are capped at 10% of usable input or the model's maximum output, whichever is smaller.

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
