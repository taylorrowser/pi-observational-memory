#!/usr/bin/env node
// PROTOTYPE: interactive terminal shell around the pure economics model.

import readline from "node:readline";
import { compareStrategies, defaultConfig, POLICY_PRESETS } from "./model.mjs";
import { loadTraces } from "./session-traces.mjs";

const traces = loadTraces();
let traceIndex = 0;
let policyIndex = 1;
let windowIndex = 2;
let delayIndex = 1;
const windows = [64_000, 128_000, 272_000, 1_000_000];
const delays = [0, 2, 5, 10];

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatMoney(value) {
  return `$${value.toFixed(value >= 10 ? 2 : 3)}`;
}

function pad(value, width, align = "right") {
  const text = String(value);
  const spaces = " ".repeat(Math.max(0, width - text.length));
  return align === "left" ? text + spaces : spaces + text;
}

function sparkline(values, maxValue) {
  const bars = "▁▂▃▄▅▆▇█";
  const width = Math.min(52, values.length);
  const sampled = Array.from({ length: width }, (_, index) => {
    const sourceIndex = Math.min(
      values.length - 1,
      Math.floor((index / Math.max(1, width - 1)) * (values.length - 1)),
    );
    return values[sourceIndex] ?? 0;
  });
  return sampled
    .map((value) => bars[Math.min(7, Math.floor((value / Math.max(1, maxValue)) * 8))])
    .join("");
}

function render() {
  const trace = traces[traceIndex];
  const preset = POLICY_PRESETS[policyIndex];
  const config = defaultConfig(trace, {
    contextWindow: windows[windowIndex],
    observerDelayCalls: delays[delayIndex],
    ...preset,
  });
  const results = compareStrategies(trace, config);
  const safeInput = config.contextWindow - config.outputReserve;
  const finalRaw = trace.calls.reduce((sum, call) => sum + call.sourceDelta, 0);

  console.clear();
  console.log(`${bold}PROTOTYPE — Context economics explorer (#7)${reset}`);
  console.log(
    `${dim}Question: where do full replay, Pi compaction, and observational memory break even on cost, cache reuse, and context safety?${reset}\n`,
  );
  console.log(`${bold}Trace${reset}`);
  console.log(`  ${trace.name}`);
  console.log(`  ${dim}${trace.source} · ${trace.model}${reset}`);
  console.log(
    `  calls ${trace.calls.length} · inferred source ${formatTokens(finalRaw)} · fixed request ${formatTokens(config.fixedTokens)}`,
  );
  if (trace.observed) {
    console.log(
      `  observed full-history bill ${formatMoney(trace.observed.cost)} · cache read ${formatTokens(trace.observed.cacheRead)}`,
    );
  }

  console.log(`\n${bold}Policy state${reset}`);
  console.log(
    `  window ${formatTokens(config.contextWindow)} · safe actor input ${formatTokens(safeInput)} · observer lag ${config.observerDelayCalls} calls`,
  );
  console.log(
    `  ${preset.name}: raw ${formatTokens(config.rawTarget)} / ${formatTokens(config.rawSoft)} / ${formatTokens(config.rawHard)} target/soft/hard`,
  );
  console.log(
    `  observation ${formatTokens(config.observationTarget)} / ${formatTokens(config.observationHigh)} target/high · observer rates 20% of actor`,
  );

  console.log(`\n${bold}Outcome${reset}`);
  console.log(
    `  ${pad("strategy", 23, "left")} ${pad("actor fresh", 12)} ${pad("cache read", 11)} ${pad("memory I/O", 13)} ${pad("max ctx", 9)} ${pad("risk", 6)} ${pad("cost", 9)}`,
  );
  for (const result of results) {
    const memory = `${formatTokens(result.memoryInput)}/${formatTokens(result.memoryOutput)}`;
    console.log(
      `  ${pad(result.strategy, 23, "left")} ${pad(formatTokens(result.actorInput), 12)} ${pad(formatTokens(result.cacheRead), 11)} ${pad(memory, 13)} ${pad(formatTokens(result.maxContext), 9)} ${pad(result.overBudgetCalls, 6)} ${pad(formatMoney(result.totalCost), 9)}`,
    );
  }

  console.log(`\n${bold}Actor context over time${reset} ${dim}(scale: safe input ${formatTokens(safeInput)})${reset}`);
  for (const result of results) {
    console.log(
      `  ${pad(result.strategy, 23, "left")} ${sparkline(result.contextSeries, safeInput)} ${formatTokens(result.maxContext)}`,
    );
  }

  const [full, pi, om] = results;
  const delta = om.totalCost - full.totalCost;
  console.log(`\n${bold}What this run says${reset}`);
  console.log(
    `  • Observational memory ${delta <= 0 ? "saves" : "costs"} ${formatMoney(Math.abs(delta))} vs modeled full replay and performs ${om.contractions} observation/reflection activations.`,
  );
  console.log(
    `  • Pi performs ${pi.contractions} post-turn compactions; ${pi.overBudgetCalls} actor calls cross safe headroom before a legal post-run compaction point.`,
  );
  console.log(
    `  • Observational memory incurs ${om.hardWaits} hard wait${om.hardWaits === 1 ? "" : "s"} with the selected observer lag.`,
  );

  console.log(
    `\n${bold}[j/k]${reset}${dim} trace  ${reset}${bold}[p]${reset}${dim} policy  ${reset}${bold}[w]${reset}${dim} context window  ${reset}${bold}[d]${reset}${dim} observer lag  ${reset}${bold}[q]${reset}${dim} quit${reset}`,
  );
}

function rotate(value, change, length) {
  return (value + change + length) % length;
}

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", (_text, key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0);
  if (key.name === "j" || key.name === "down") traceIndex = rotate(traceIndex, 1, traces.length);
  if (key.name === "k" || key.name === "up") traceIndex = rotate(traceIndex, -1, traces.length);
  if (key.name === "p") policyIndex = rotate(policyIndex, 1, POLICY_PRESETS.length);
  if (key.name === "w") windowIndex = rotate(windowIndex, 1, windows.length);
  if (key.name === "d") delayIndex = rotate(delayIndex, 1, delays.length);
  render();
});

render();
