# Pi Observational Memory

A Pi extension for session-scoped observational memory during long user turns.

The current implementation is an inert extension shell: it restores the selected session’s active ancestry, observes completed model-step events, and projects context unchanged.

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
