import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";

import type {
  ExtensionUsageAttribution,
  ObservationRequest,
  ReflectionRequest,
  SessionMemoryHost,
} from "./session-memory.js";

type UsageCapablePi = ExtensionAPI & {
  appendUsage(attribution: ExtensionUsageAttribution): void;
};

type ContextProvider = () => ExtensionContext | undefined;
type CompleteModel = typeof completeSimple;

const OBSERVER_PROMPT = `You are the Observer for observational memory.
Return only one JSON object, without Markdown fences, in this exact shape:
{
  "protocol": "observational-memory.observation",
  "version": 1,
  "passId": <copy request.passId>,
  "parentCommitId": <copy request.parentCommitId>,
  "coverage": { "entryIds": <copy request.coverage.entryIds> },
  "observations": [<nonempty ordered free-form strings>],
  "activeTask": {
    "originalIntent": <nonempty string>,
    "constraints": [<strings>],
    "decisions": [<strings>],
    "verifiedProgress": [{ "claim": <string>, "evidence": [<strings>] }],
    "currentWork": [<strings>],
    "blockers": [<strings>],
    "unresolvedQuestions": [<strings>],
    "nextMove": { "owner": "user" | "assistant" | "shared", "action": <nonempty string> }
  }
}
The activeTask is a complete replacement snapshot, not a patch. Preserve semantic status, provenance,
uncertainty, corrections, reversals, unresolved conflicts, and operationally exact paths, symbols,
commands, code, errors, URLs, quantities, versions, and requirements. Do not claim attempted work is
complete without durable evidence. Treat branch_summary entries only as derived orientation. Retain their
source provenance (id and fromId) and producer provenance (fromHook). Branch-summary claims are not exact
source evidence and must not establish completion or action-sensitive details without independent exact evidence.
Treat a toolResult with isError true as terminal failure evidence, never as successful work. Preserve retryable
provider errors and aborted, truncated, or partial assistant responses with their exact unsuccessful status.`;

const REFLECTOR_PROMPT = `You are the Reflector for observational memory.
Return only one JSON object, without Markdown fences, in this exact shape:
{
  "protocol": "observational-memory.reflection",
  "version": 1,
  "passId": <copy request.passId>,
  "parentReflectionId": <copy request.parentReflection.id or null>,
  "coverage": { "observationIds": <copy request.coverage.observationIds> },
  "reflectedHistory": [<nonempty ordered coherent history strings>]
}
Fold the prior reflection, when present, and every supplied observation into increasingly
outcome-oriented history. Preserve semantic status, provenance, uncertainty, corrections,
reversals, unresolved conflicts, and operationally exact details. Do not invent completion.`;

export function createPiHost(
  pi: ExtensionAPI,
  getContext: ContextProvider = () => undefined,
  completeModel: CompleteModel = completeSimple,
): SessionMemoryHost {
  async function completeMemory(
    actor: ObservationRequest["actor"],
    systemPrompt: string,
    payload: unknown,
    maxTokens: number,
    signal?: AbortSignal,
  ) {
    const context = getContext();
    if (!context) throw new Error("Memory model context is unavailable");
    const model = context.modelRegistry.find(actor.provider, actor.model);
    if (!model) {
      throw new Error(
        `Actor model ${actor.provider}/${actor.model} is unavailable`,
      );
    }
    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    const response = await completeModel(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload),
            timestamp: 0,
          },
        ],
      },
      {
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(auth.env ? { env: auth.env } : {}),
        ...(signal ? { signal } : {}),
        maxTokens,
      },
    );

    return {
      text: response.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join(""),
      usage: response.usage,
      provider: response.provider,
      model: response.model,
      stopReason: response.stopReason,
    };
  }

  return {
    appendEntry(customType, data) {
      pi.appendEntry(customType, data);
    },
    attributeUsage(attribution) {
      (pi as UsageCapablePi).appendUsage(attribution);
    },
    estimateTokens(messages) {
      return messages.reduce(
        (total, message) => total + estimateTokens(message),
        0,
      );
    },
    completeObservation(request, signal) {
      return completeMemory(
        request.actor,
        OBSERVER_PROMPT,
        {
          passId: request.passId,
          parentCommitId: request.parentCommitId,
          activeMemory: request.activeMemory ?? null,
          source: request.source.entries,
          coverage: { entryIds: request.source.entryIds },
        },
        request.pressure.observationOutputBudget,
        signal,
      );
    },
    completeReflection(request: ReflectionRequest, signal) {
      return completeMemory(
        request.actor,
        REFLECTOR_PROMPT,
        {
          passId: request.passId,
          parentReflection: request.parentReflection,
          coverage: request.coverage,
          observations: request.observations,
        },
        request.pressure.reflectionOutputBudget,
        signal,
      );
    },
    setStatus(status) {
      getContext()?.ui.setStatus("observational-memory", status);
    },
    abortActor(message) {
      const context = getContext();
      if (!context) return;
      if (message) context.ui.notify(message, "error");
      context.abort();
    },
  };
}
