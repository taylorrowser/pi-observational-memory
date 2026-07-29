import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import observationalMemory from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = resolve(
  process.env.PI_CORE_WORKTREE ?? join(root, ".cache", "pi-core-0.81.1"),
);
const codingAgent = await import(
  pathToFileURL(join(piRoot, "packages/coding-agent/dist/index.js"))
);
const cacheAi = await import(
  pathToFileURL(join(piRoot, "packages/ai/dist/index.js"))
);
const cacheCompat = await import(
  pathToFileURL(join(piRoot, "packages/ai/dist/compat.js"))
);
const rootCompat = await import("@earendil-works/pi-ai/compat");

const {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  defineTool,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = codingAgent;
const { InMemoryCredentialStore } = cacheAi;
const { Type } = await import("typebox");

const modes = ["observational-memory", "full-history", "stock-compaction"];
const actorModel = { contextWindow: 4_000, maxTokens: 500 };
const alternateActorModel = { contextWindow: 7_000, maxTokens: 500 };
const actorSafetyReserve = Math.floor(
  (actorModel.contextWindow - actorModel.maxTokens) * 0.15,
);
const definitions = {
  short: { outputSizes: [], batchSize: Infinity },
  "steady-growth": {
    outputSizes: [4_500, 4_500, 500],
    batchSize: Infinity,
  },
  "bursty-tool-output": {
    outputSizes: [10_000, 500],
    batchSize: Infinity,
  },
  "uninterrupted-tool-loop": {
    outputSizes: [4_500, 4_500, 500],
    batchSize: Infinity,
  },
  "repeated-contraction": {
    outputSizes: [
      5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
      5_000, 5_000, 5_000, 500,
    ],
    batchSize: 1,
  },
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
  return true;
}

function textOf(message) {
  if (!message || typeof message !== "object" || !("content" in message)) {
    return "";
  }
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function contextText(context) {
  return context.messages.map(textOf).join("\n");
}

function contextTokens(context) {
  const messages = context.messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  const fixedInput = estimateTokens({
    role: "user",
    content: JSON.stringify({
      systemPrompt: context.systemPrompt ?? "",
      tools: context.tools ?? [],
    }),
    timestamp: 0,
  });
  return messages + fixedInput;
}

function memoryPayload(context) {
  return JSON.parse(textOf(context.messages.at(-1)));
}

function evidenceMarkers(value) {
  return [
    ...new Set(JSON.stringify(value).match(/EVIDENCE:[a-z-]+:\d+/g) ?? []),
  ];
}

function observerResponse(context) {
  const payload = memoryPayload(context);
  const markers = evidenceMarkers(payload.source);
  return rootCompat.fauxAssistantMessage(
    JSON.stringify({
      protocol: "observational-memory.observation",
      version: 1,
      passId: payload.passId,
      parentCommitId: payload.parentCommitId,
      coverage: payload.coverage,
      observations: [
        `Evidence: ${markers.join(", ") || "none"}. ${"continuity ".repeat(40)}`,
      ],
      activeTask: {
        originalIntent: "Run the acceptance task and write artifacts.",
        constraints: ["Execute each indexed step once."],
        decisions: ["Use acceptance_step."],
        verifiedProgress: markers.map((marker) => ({
          claim: `${marker} exists`,
          evidence: [marker],
        })),
        currentWork: ["Continue the tool loop."],
        blockers: [],
        unresolvedQuestions: [],
        nextMove: {
          owner: "assistant",
          action: "Execute the next step.",
        },
      },
    }),
  );
}

function reflectorResponse(context) {
  const payload = memoryPayload(context);
  return rootCompat.fauxAssistantMessage(
    JSON.stringify({
      protocol: "observational-memory.reflection",
      version: 1,
      passId: payload.passId,
      parentReflectionId: payload.parentReflection?.id ?? null,
      coverage: payload.coverage,
      reflectedHistory: [
        "Acceptance remains backed by exact EVIDENCE markers.",
      ],
    }),
  );
}

function providerConfig(faux) {
  return {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: "acceptance-key",
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      baseUrl: model.baseUrl,
    })),
  };
}

async function runScenario(name, mode) {
  const { outputSizes: sizes, batchSize } = definitions[name];
  const provider = `acceptance-${name}-${mode}`;
  const api = `acceptance:${name}:${mode}`;
  const models = [
    { id: "primary", ...actorModel },
    { id: "alternate", ...alternateActorModel },
  ];
  // Pi's patched runtime and the built extension resolve separate pi-ai copies.
  // Mirror one faux API across both so actor and memory calls share a model identity.
  const actorFaux = cacheCompat.registerFauxProvider({ provider, api, models });
  const memoryFaux = rootCompat.registerFauxProvider({ provider, api, models });
  const actorContexts = [];
  const toolCalls = [];
  const memoryCalls = { observation: 0, reflection: 0 };
  const hardWait = { count: 0, durationMs: 0, startedAt: undefined };
  const artifactDir = mkdtempSync(join(tmpdir(), `observational-memory-${name}-`));
  let actorStep = 0;
  let pausedAt;

  const actorResponse = (context) => {
    if (
      context.systemPrompt?.includes("context summarization assistant") ||
      contextText(context).includes("Summarize the prefix")
    ) {
      return cacheCompat.fauxAssistantMessage(
        "Stock Pi summary of completed acceptance steps.",
      );
    }
    actorContexts.push(context);
    if (
      actorStep > 0 &&
      actorStep < sizes.length &&
      actorStep % batchSize === 0 &&
      pausedAt !== actorStep
    ) {
      pausedAt = actorStep;
      return cacheCompat.fauxAssistantMessage(
        `BATCH_OK:${name}:${actorStep}`,
      );
    }
    if (pausedAt === actorStep) pausedAt = undefined;
    if (actorStep < sizes.length) {
      const index = actorStep++;
      return cacheCompat.fauxAssistantMessage(
        cacheCompat.fauxToolCall(
          "acceptance_step",
          { index },
          { id: `step-${index}` },
        ),
      );
    }
    return cacheCompat.fauxAssistantMessage(`ACCEPTANCE_OK:${name}`);
  };
  actorFaux.setResponses(Array.from({ length: 100 }, () => actorResponse));
  memoryFaux.setResponses(
    Array.from({ length: 100 }, () => (context) => {
      if (context.systemPrompt?.startsWith("You are the Observer")) {
        const response = observerResponse(context);
        memoryCalls.observation += 1;
        return response;
      }
      const response = reflectorResponse(context);
      memoryCalls.reflection += 1;
      return response;
    }),
  );

  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: mode === "stock-compaction",
      reserveTokens: 1_500,
      keepRecentTokens: 500,
    },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerProvider(provider, providerConfig(actorFaux));
  const chainedContext = (pi) => {
    pi.on("context", (event) => ({
      messages: [
        ...event.messages,
        { role: "user", content: "CHAINED_CONTEXT_SENTINEL", timestamp: 0 },
      ],
    }));
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    extensionFactories: [
      ...(mode === "observational-memory" ? [chainedContext, observationalMemory] : []),
    ],
    systemPromptOverride: () => "Complete the acceptance task exactly.",
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(root);
  const tool = defineTool({
    name: "acceptance_step",
    label: "Acceptance step",
    description: "Write one durable artifact and return exact evidence.",
    parameters: Type.Object({ index: Type.Number() }),
    execute: async (_callId, { index }) => {
      toolCalls.push(index);
      const marker = `EVIDENCE:${name}:${index}`;
      writeFileSync(join(artifactDir, `step-${index}.txt`), marker);
      return {
        content: [
          { type: "text", text: `${marker}\n${"x".repeat(sizes[index] ?? 0)}` },
        ],
        details: {},
      };
    },
  });
  const { session } = await createAgentSession({
    model: actorFaux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    customTools: [tool],
    tools: ["acceptance_step"],
  });
  session.agent.streamFunction = cacheCompat.streamSimple;
  const uiContext = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "setStatus") {
          return (_key, status) => {
            if (status === "waiting for memory" && hardWait.startedAt === undefined) {
              hardWait.count += 1;
              hardWait.startedAt = performance.now();
            } else if (
              status !== "waiting for memory" &&
              hardWait.startedAt !== undefined
            ) {
              hardWait.durationMs += performance.now() - hardWait.startedAt;
              hardWait.startedAt = undefined;
            }
          };
        }
        if (property === "onTerminalInput") return () => () => {};
        return () => undefined;
      },
    },
  );
  await session.bindExtensions({ uiContext });

  try {
    const compactStockWhenReady = async () => {
      if (mode !== "stock-compaction" || sizes.length === 0) return;
      try {
        await session.compact();
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            (error.message.includes("Nothing to compact") ||
              error.message.includes("Already compacted"))
          )
        ) {
          throw error;
        }
      }
    };
    await session.prompt(`Run acceptance scenario ${name}.`);
    let taskPromptCount = 1;
    await compactStockWhenReady();
    while (toolCalls.length < sizes.length) {
      invariant(
        taskPromptCount < 20,
        `${name}/${mode}: task stopped at ${toolCalls.length}/${sizes.length}; ${session.messages
          .slice(-3)
          .map((message) => `${message.role}:${textOf(message).slice(0, 40)}`)
          .join(" | ")}`,
      );
      await session.prompt(`CONTINUE:${name}:${toolCalls.length}`);
      taskPromptCount += 1;
      await compactStockWhenReady();
    }
    await Promise.resolve();
    await Promise.resolve();
    await session.prompt(`EXACT_TAIL:${name}`);
    const entries = sessionManager.getEntries();
    const projectedTexts = actorContexts.map(contextText);
    const activeContexts = projectedTexts.filter((text) =>
      text.includes("<observational-memory"),
    );
    const records = entries.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType?.startsWith("observational-memory:"),
    );
    const expectedCalls = sizes.map((_, index) => index);
    const artifactsPass = expectedCalls.every((index) => {
      const artifact = join(artifactDir, `step-${index}.txt`);
      return (
        existsSync(artifact) &&
        readFileSync(artifact, "utf8") === `EVIDENCE:${name}:${index}`
      );
    });
    const betweenModelStepActivation =
      activeContexts.length === 0 ||
      activeContexts.some((text) => !text.includes(`EXACT_TAIL:${name}`));
    const exactTailPreserved =
      sizes.length === 0 ||
      (mode === "observational-memory" ? activeContexts : projectedTexts).some(
        (text) => text.includes(`EXACT_TAIL:${name}`),
      );
    const canonicalSource = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => textOf(entry.message))
      .join("\n");
    const exactSourceRecovery = expectedCalls.every((index) =>
      canonicalSource.includes(`EVIDENCE:${name}:${index}`),
    );
    invariant(exactSourceRecovery, `${name}: canonical exact source was lost`);
    const usageEntries = entries.filter(
      (entry) => entry.type === "extension_usage",
    );
    const observationUsage = usageEntries
      .filter((entry) => entry.operation.endsWith(":observation"))
      .reduce((total, entry) => total + entry.usage.totalTokens, 0);
    const reflectionUsage = usageEntries
      .filter((entry) => entry.operation.endsWith(":reflection"))
      .reduce((total, entry) => total + entry.usage.totalTokens, 0);
    const attributedCalls =
      memoryCalls.observation + memoryCalls.reflection;
    const actorMaximumContext = Math.max(0, ...actorContexts.map(contextTokens));
    const safeHeadroom = actorContexts.every(
      (context) =>
        contextTokens(context) +
          actorModel.maxTokens +
          actorSafetyReserve <
        actorModel.contextWindow,
    );
    const uniqueCalls = new Set(toolCalls);
    const taskPassed =
      artifactsPass &&
      session.messages.map(textOf).join("\n").includes(`ACCEPTANCE_OK:${name}`) &&
      toolCalls.length === uniqueCalls.size;
    const stats = session.getSessionStats();
    const ledgerUsage = entries.reduce(
      (totals, entry) => {
        const usage =
          entry.type === "extension_usage" || entry.type === "compaction"
            ? entry.usage
            : entry.type === "message" && entry.message.role === "assistant"
              ? entry.message.usage
              : undefined;
        if (usage) {
          totals.input += usage.input;
          totals.output += usage.output;
          totals.cacheRead += usage.cacheRead;
          totals.cacheWrite += usage.cacheWrite;
          totals.total += usage.totalTokens;
        }
        return totals;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    );

    const chainedContextPassed =
      mode !== "observational-memory" ||
      projectedTexts.every((text) => text.includes("CHAINED_CONTEXT_SENTINEL"));
    const invariants = {
      safeHeadroom: invariant(
        safeHeadroom,
        `${name}/${mode}: unsafe actor request (${actorContexts
          .map(contextTokens)
          .join(", ")})`,
      ),
      completeModelSteps: invariant(
        records.every((entry) =>
          entry.data.validation.checks.includes("complete-response"),
        ),
        `${name}: incomplete boundary activated`,
      ),
      contiguousCoverage: invariant(
        records.every((entry) =>
          entry.data.validation.checks.some((check) => check.includes("contiguous")),
        ),
        `${name}: non-contiguous coverage activated`,
      ),
      validParentage: invariant(
        records.every(
          (entry) =>
            entry.data.parentCommitId === entry.data.lineage.parentCommitId ||
            entry.data.parentReflectionId ===
              entry.data.lineage.parentReflectionId,
        ),
        `${name}: invalid parentage activated`,
      ),
      atomicActivation: invariant(
        (activeContexts.length === 0 || records.length > 0) &&
          betweenModelStepActivation,
        `${name}: memory did not activate atomically between model steps`,
      ),
      evidenceBackedCompletion: invariant(
        artifactsPass,
        `${name}: completion lacked durable artifacts`,
      ),
      operationalDetail: invariant(
        exactTailPreserved && chainedContextPassed,
        `${name}: exact tail or chained context was not preserved`,
      ),
      usageExactlyOnce: invariant(
        usageEntries.length === attributedCalls &&
          new Set(usageEntries.map((entry) => entry.passId)).size ===
            usageEntries.length &&
          JSON.stringify(stats.tokens) === JSON.stringify(ledgerUsage),
        `${name}: Pi did not attribute every returned memory call exactly once`,
      ),
    };

    const lifecycle = {
      branchNavigation: false,
      modelSelection: false,
      explicitCompaction: false,
      chainedContextExtension: chainedContextPassed,
    };
    if (name === "repeated-contraction" && mode === "observational-memory") {
      const alternate = actorFaux.getModel("alternate");
      invariant(alternate, "Alternate acceptance model is missing");
      await session.setModel(alternate);
      await session.prompt("MODEL_SELECTION_SMOKE");
      const selectedModelResponse = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      lifecycle.modelSelection =
        session.model?.id === "alternate" &&
        selectedModelResponse?.model === "alternate";

      await session.compact();
      lifecycle.explicitCompaction = sessionManager
        .getEntries()
        .some((entry) => entry.type === "compaction");

      const branchTarget = entries.find(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      );
      invariant(branchTarget, "Acceptance branch target is missing");
      const navigation = await session.navigateTree(branchTarget.id, {
        summarize: false,
      });
      lifecycle.branchNavigation =
        !navigation.cancelled && sessionManager.getLeafId() === branchTarget.id;
    }

    return {
      mode,
      lifecycle,
      actorMaximumContext,
      observation: {
        activations: activeContexts.length,
        betweenModelSteps: betweenModelStepActivation,
        calls: memoryCalls.observation,
        usage: observationUsage,
      },
      reflection: {
        calls: memoryCalls.reflection,
        usage: reflectionUsage,
      },
      hardWait: {
        count: mode === "observational-memory" ? hardWait.count : 0,
        durationMs:
          mode === "observational-memory"
            ? Number(hardWait.durationMs.toFixed(3))
            : 0,
      },
      cacheReadTokens: entries
        .filter(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant",
        )
        .reduce(
          (sum, entry) => sum + entry.message.usage.cacheRead,
          0,
        ),
      exactTailPreserved,
      exactSourceRecovery,
      repeatedWork: toolCalls.length - uniqueCalls.size,
      uninterruptedToolLoop:
        name !== "uninterrupted-tool-loop" ||
        (toolCalls.length === sizes.length && taskPromptCount === 1),
      stockCompactions: entries.filter((entry) => entry.type === "compaction").length,
      taskOutcome: invariant(taskPassed, `${name}: task outcome failed`)
        ? "passed"
        : "failed",
      invariants,
    };
  } finally {
    session.dispose();
    actorFaux.unregister();
    memoryFaux.unregister();
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

function verifyFailureEvidence() {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "test/session-memory.test.ts",
      "test/reflection.test.ts",
      "test/hard-headroom.test.ts",
      "test/branching.test.ts",
      "test/lifecycle.test.ts",
      "--reporter=dot",
    ],
    { cwd: root, stdio: "inherit" },
  );
  invariant(result.status === 0, "Focused failure evidence did not pass");
  return [
    {
      name: "malformed-output",
      sourcePreserved: true,
      evidence: "hard-headroom: two invalid hard-paused attempts",
    },
    {
      name: "delayed-work",
      sourcePreserved: true,
      evidence: "branching: obsolete delayed response is fenced",
    },
    {
      name: "hard-pause-retry",
      sourcePreserved: true,
      evidence: "hard-headroom: identical frozen pass retries once",
    },
    {
      name: "cancellation",
      sourcePreserved: true,
      evidence: "hard-headroom: cancelled late response never activates",
    },
    {
      name: "terminal-stop",
      sourcePreserved: true,
      evidence: "hard-headroom: retry exhaustion aborts without coverage",
    },
  ];
}

async function verifySessionReplacement() {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  });
  const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: { extensionFactories: [observationalMemory] },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        noTools: "all",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: root,
    agentDir: root,
    sessionManager: SessionManager.inMemory(root),
  });
  await runtime.session.bindExtensions({});
  runtime.setRebindSession((session) => session.bindExtensions({}));
  const oldId = runtime.session.sessionId;
  try {
    const result = await runtime.newSession();
    return invariant(
      !result.cancelled && runtime.session.sessionId !== oldId,
      "Pi runtime session replacement failed",
    );
  } finally {
    await runtime.dispose();
  }
}

async function run() {
  const scenarios = [];
  for (const [name] of Object.entries(definitions)) {
    const runs = [];
    const scenarioModes =
      name === "repeated-contraction"
        ? ["observational-memory", "stock-compaction"]
        : modes;
    for (const mode of scenarioModes) runs.push(await runScenario(name, mode));
    scenarios.push({ name, runs });
  }

  const short = scenarios.find((scenario) => scenario.name === "short");
  invariant(short.runs[0].observation.activations === 0, "Short run activated memory");
  for (const scenario of scenarios.filter((item) => item.name !== "short")) {
    invariant(
      scenario.runs[0].observation.activations > 0,
      `${scenario.name}: no observation activated`,
    );
  }
  const repeated = scenarios.find(
    (scenario) => scenario.name === "repeated-contraction",
  );
  invariant(repeated.runs[0].reflection.calls > 0, "No reflection activated");

  const runtimeLifecycle = repeated.runs[0].lifecycle;
  invariant(runtimeLifecycle.branchNavigation, "Branch navigation smoke failed");
  invariant(runtimeLifecycle.modelSelection, "Model-selection smoke failed");
  invariant(runtimeLifecycle.explicitCompaction, "Explicit compaction smoke failed");
  invariant(
    runtimeLifecycle.chainedContextExtension,
    "Chained context-extension smoke failed",
  );
  const failures = verifyFailureEvidence();
  const sessionReplacement = await verifySessionReplacement();
  const report = {
    configurations: {
      node: process.version,
      pi: "0.81.1",
      piCommit: "20be4b18d4c57487f8993d2762bace129f0cf7c6",
      provider: "faux",
    },
    scenarios,
    failures,
    lifecycle: {
      branchNavigation: runtimeLifecycle.branchNavigation ? "passed" : "failed",
      modelSelection: runtimeLifecycle.modelSelection ? "passed" : "failed",
      sessionReplacement: sessionReplacement ? "passed" : "failed",
      explicitCompaction: runtimeLifecycle.explicitCompaction
        ? "passed"
        : "failed",
      chainedContextExtension: runtimeLifecycle.chainedContextExtension
        ? "passed"
        : "failed",
    },
    conclusions: [
      "Results apply only to this pinned deterministic configuration.",
      "The evidence demonstrates bounded actor context; it makes no universal cost or task-quality claim.",
    ],
  };
  const reportPath = join(root, ".cache", "acceptance-report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Acceptance evidence: ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
}

await run();
