# Pi core compatibility patch

`extension-usage.patch` is a source patch against:

- Repository: <https://github.com/earendil-works/pi>
- Tag: `v0.81.1`
- Commit: `20be4b18d4c57487f8993d2762bace129f0cf7c6`

It adds `pi.appendUsage(...)`, a persisted, non-model-visible `extension_usage` session-ledger entry, and aggregates those entries through session/RPC statistics, the footer, usage breakdowns, and HTML exports. It also preserves an overflow-error response when an extension cancels automatic compaction, removing that response only after successful compact-and-retry recovery.

Run the reproducible verification from this repository:

```bash
npm run pi-core:check
```

The command clones the pinned source into `.cache/`, hydrates the exact published `@earendil-works/pi-ai@0.81.1` model data, applies the patch, type-checks it, runs the affected integration tests, and builds the affected Pi packages without regenerating model data from live catalogs.

Set `PI_CORE_WORKTREE` to use a different disposable checkout path. The command removes and recreates that path.
