import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";

import type {
  ExtensionUsageAttribution,
  ObservationRequest,
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
complete without durable evidence.`;

export function createPiHost(
  pi: ExtensionAPI,
  getContext: ContextProvider = () => undefined,
  completeModel: CompleteModel = completeSimple,
): SessionMemoryHost {
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
    async completeObservation(request, signal) {
      const context = getContext();
      if (!context) throw new Error("Observation model context is unavailable");
      const model = context.modelRegistry.find(
        request.actor.provider,
        request.actor.model,
      );
      if (!model) {
        throw new Error(
          `Actor model ${request.actor.provider}/${request.actor.model} is unavailable`,
        );
      }
      const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);

      const response = await completeModel(
        model,
        {
          systemPrompt: OBSERVER_PROMPT,
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                passId: request.passId,
                parentCommitId: request.parentCommitId,
                activeMemory: request.activeMemory ?? null,
                source: request.source.entries,
                coverage: { entryIds: request.source.entryIds },
              }),
              timestamp: 0,
            },
          ],
        },
        {
          ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
          ...(auth.headers ? { headers: auth.headers } : {}),
          ...(auth.env ? { env: auth.env } : {}),
          ...(signal ? { signal } : {}),
          maxTokens: request.pressure.observationOutputBudget,
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
    },
  };
}
