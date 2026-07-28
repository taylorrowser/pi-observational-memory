# Pi Observational Memory

A Pi extension for session-scoped observational memory during long user turns.

The extension watches completed model steps and remains inert below a built-in soft pressure watermark. Above it, the extension asynchronously observes the oldest complete source prefix with the current actor model, validates and persists the resulting memory, and activates it on the next safe context projection. The exact uncovered source tail remains unchanged, and committed memory replays after session reload.

Standalone Observer usage is attributed through the pinned Pi core capability documented in [`pi-core/README.md`](pi-core/README.md).

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
