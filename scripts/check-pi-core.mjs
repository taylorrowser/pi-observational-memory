import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRepository = "https://github.com/earendil-works/pi.git";
const piTag = "v0.81.1";
const piCommit = "20be4b18d4c57487f8993d2762bace129f0cf7c6";
const aiPackage = "@earendil-works/pi-ai@0.81.1";
const worktree = resolve(
  process.env.PI_CORE_WORKTREE ?? join(repositoryRoot, ".cache", "pi-core-0.81.1"),
);
const patch = join(repositoryRoot, "pi-core", "extension-usage.patch");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr);
      process.stdout.write(result.stdout);
    }
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
  return result.stdout?.trim() ?? "";
}

async function verifyRpcTotals() {
  const extensionPath = join(worktree, ".extension-usage-rpc-smoke.ts");
  writeFileSync(
    extensionPath,
    `export default function (pi) {
  pi.on("session_start", () => {
    pi.appendUsage({
      provider: "rpc-provider",
      model: "observer-model",
      operation: "observational-memory:observation",
      passId: "rpc-pass",
      usage: {
        input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }
      }
    });
  });
}\n`,
  );

  const child = spawn(
    process.execPath,
    [
      join(worktree, "packages", "coding-agent", "dist", "cli.js"),
      "--mode",
      "rpc",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--extension",
      extensionPath,
    ],
    { cwd: worktree, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const response = await new Promise((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResponse(new Error(`Timed out waiting for Pi RPC response: ${stderr}`));
    }, 15_000);
    child.once("error", rejectResponse);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      while (stdout.includes("\n")) {
        const newline = stdout.indexOf("\n");
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === "usage-check") {
          clearTimeout(timeout);
          resolveResponse(message);
        }
      }
    });
    child.stdin.write('{"id":"usage-check","type":"get_session_stats"}\n');
  });

  child.stdin.end();
  await new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code) => {
      if (code === 0) resolveClose();
      else rejectClose(new Error(`Pi RPC exited with ${code}: ${stderr}`));
    });
  });

  const expectedTokens = {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    total: 100,
  };
  if (
    response.success !== true ||
    JSON.stringify(response.data?.tokens) !== JSON.stringify(expectedTokens) ||
    response.data?.cost !== 1
  ) {
    throw new Error(`Unexpected Pi RPC usage totals: ${JSON.stringify(response)}`);
  }
}

function hydratePinnedModelData() {
  const downloadDir = mkdtempSync(join(tmpdir(), "pi-model-data-"));
  try {
    const packed = run(
      "npm",
      ["pack", aiPackage, "--pack-destination", downloadDir, "--silent"],
      { capture: true },
    );
    const tarball = packed.split("\n").at(-1);
    if (!tarball) throw new Error(`npm pack produced no tarball for ${aiPackage}`);
    run("tar", ["-xzf", join(downloadDir, tarball), "-C", downloadDir]);
    const target = join(worktree, "packages", "ai", "src", "providers", "data");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(join(downloadDir, "package", "dist", "providers", "data"), target, {
      recursive: true,
    });
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

rmSync(worktree, { recursive: true, force: true });
mkdirSync(dirname(worktree), { recursive: true });
run("git", ["clone", "--depth", "1", "--branch", piTag, piRepository, worktree]);
const actualCommit = run("git", ["rev-parse", "HEAD"], { cwd: worktree, capture: true });
if (actualCommit !== piCommit) {
  throw new Error(`Expected Pi ${piCommit}, cloned ${actualCommit}`);
}

hydratePinnedModelData();
run("git", ["apply", "--check", patch], { cwd: worktree });
run("git", ["apply", patch], { cwd: worktree });
run("git", ["diff", "--check"], { cwd: worktree });
run("npm", ["install", "--ignore-scripts"], { cwd: worktree });
run("./node_modules/.bin/tsgo", ["--noEmit"], { cwd: worktree });
for (const packageName of ["tui", "ai", "agent", "coding-agent"]) {
  const buildScript = packageName === "ai" ? "build:offline" : "build";
  run("npm", ["--prefix", `packages/${packageName}`, "run", buildScript], {
    cwd: worktree,
  });
}
run(
  "npm",
  [
    "--prefix",
    "packages/coding-agent",
    "test",
    "--",
    "test/suite/agent-session-runtime.test.ts",
    "test/agent-session-stats.test.ts",
    "test/footer-width.test.ts",
    "test/export-html-usage.test.ts",
    "test/extensions-runner.test.ts",
  ],
  { cwd: worktree },
);
await verifyRpcTotals();

console.log(`Verified Pi core usage patch against ${piTag} (${piCommit})`);
