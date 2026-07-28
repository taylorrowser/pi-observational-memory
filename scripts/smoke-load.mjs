import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const pi = process.env.PI_BIN ?? "pi";
const packageRoot = resolve(".");
const result = spawnSync(
  pi,
  [
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--extension",
    packageRoot,
    "--list-models",
  ],
  { encoding: "utf8" },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

console.log(`Loaded ${packageRoot} with ${pi}`);
