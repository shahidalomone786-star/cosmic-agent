import type {
  AiChatRequest,
  AiChatResponse,
  AiModel,
  AiProvider,
  ProviderHealth,
} from "../ai/ai-provider";
import { GroqProviderError } from "../ai/groq-provider";
import {
  RufloBudgetLimitError,
  RufloCostTracker,
  type RufloBudgetLimits,
  type RufloCostTotals,
  type RufloTokenPricing,
} from "./ruflo-cost-tracker";

export type RufloCapabilityClass = "light" | "medium" | "heavy";
export type RufloProviderFailureClass =
  | "timeout"
  | "rate_limit"
  | "authentication/configuration"
  | "unavailable"
  | "context_limit"
  | "budget_limit"
  | "unknown";

export type RufloProviderAvailability = {
  provider: string;
  health: ProviderHealth;
  models: AiModel[];
};

export type RufloRouteCandidate = {
  provider: AiProvider;
  model: AiModel;
};

export type RufloRoutingDecision = {
  capability: RufloCapabilityClass;
  primary: RufloRouteCandidate;
  fallbacks: RufloRouteCandidate[];
  reason: string;
  availableProviders: RufloProviderAvailability[];
};

export class RufloRoutingError extends Error {
  constructor(
    readonly code: "no_compatible_model" | "requested_model_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RufloRoutingError";
  }
}

export class RufloProviderGatewayError extends Error {
  constructor(
    readonly failures: Array<{
      provider: string;
      model: string;
      classification: RufloProviderFailureClass;
    }>,
    message = "All compatible Ruflo providers failed safely.",
  ) {
    super(message);
    this.name = "RufloProviderGatewayError";
  }
}

export type RufloProviderAttempt = {
  provider: string;
  model: string;
  capability: RufloCapabilityClass;
  fallbackUsed: boolean;
  classification?: RufloProviderFailureClass;
};

export class RufloModelRouter {
  constructor(private readonly providers: readonly AiProvider[]) {}

  discover(): RufloProviderAvailability[] {
    return this.providers.map((provider) => ({
      provider: provider.id,
      health: provider.healthCheck(),
      models: provider.getModels().map((model) => ({
        ...model,
        capabilities: [...model.capabilities],
        capabilityClasses: model.capabilityClasses ? [...model.capabilityClasses] : undefined,
      })),
    }));
  }

  select(input: {
    task: string;
    capability?: RufloCapabilityClass;
    requestedModel?: string;
    contextTokens?: number;
    outputTokens?: number;
    remainingTokens?: number;
  }): RufloRoutingDecision {
    const capability = input.capability ?? inferRufloCapability(input.task);
    const contextTokens = Math.max(0, Math.floor(input.contextTokens ?? 0));
    const outputTokens = Math.max(1, Math.floor(input.outputTokens ?? 2_048));
    const availableProviders = this.discover();
    const candidates = availableProviders.flatMap((availability) => {
      if (!availability.health.available) return [];
      return availability.models
        .filter((model) => model.enabled && supportsCapability(model, capability))
        .filter((model) => model.contextWindow == null || contextTokens + outputTokens <= model.contextWindow)
        .filter((model) => input.remainingTokens == null || model.contextWindow == null || contextTokens + outputTokens <= input.remainingTokens)
        .map((model) => ({
          provider: this.providers.find((provider) => provider.id === availability.provider)!,
          model,
        }));
    });
    if (!candidates.length) {
      throw new RufloRoutingError(
        "no_compatible_model",
        `No available configured model can safely handle a ${capability} Ruflo task with the current context and budget.`,
      );
    }

    const requested = input.requestedModel
      ? candidates.find((candidate) => candidate.model.id === input.requestedModel)
      : undefined;
    const sorted = [...candidates].sort((a, b) => compareCandidates(a, b, capability));
    const primary = requested ?? sorted[0];
    const fallbacks = sorted.filter((candidate) =>
      candidate.provider.id !== primary.provider.id || candidate.model.id !== primary.model.id,
    ).slice(0, 3);
    const reason = requested
      ? `Requested model ${requested.model.id} is available for ${capability} capability; fallbacks are ordered by suitability and cost tier.`
      : `${capability.toUpperCase()} capability selected the ${primary.model.id} model as the ${costLabel(primary)} suitable option; fallbacks are bounded to ${fallbacks.length}.`;
    return { capability, primary, fallbacks, reason, availableProviders };
  }
}

export class RufloProviderGateway implements AiProvider {
  readonly id: AiProvider["id"];
  private readonly candidates: RufloRouteCandidate[];

  constructor(
    readonly decision: RufloRoutingDecision,
    readonly tracker: RufloCostTracker,
    private readonly context: {
      sessionId: string;
      taskId?: string;
      capability: RufloCapabilityClass;
      agentRole?: string;
      onAttempt?: (attempt: RufloProviderAttempt) => void;
    },
  ) {
    this.id = decision.primary.provider.id;
    this.candidates = [decision.primary, ...decision.fallbacks];
  }

  getModels(): AiModel[] {
    return this.candidates.flatMap((candidate) => candidate.provider.getModels());
  }

  healthCheck(): ProviderHealth {
    return this.decision.primary.provider.healthCheck();
  }

  getSessionTotals(): RufloCostTotals {
    return this.tracker.getSessionTotals(this.context.sessionId);
  }

  getRemainingBudget() {
    return this.tracker.getRemainingBudget(this.context.sessionId);
  }

  async chat(request: AiChatRequest): Promise<AiChatResponse> {
    return this.run(request, false);
  }

  async stream(request: AiChatRequest, onToken: (token: string) => void): Promise<AiChatResponse> {
    return this.run(request, true, onToken);
  }

  private async run(
    request: AiChatRequest,
    streaming: boolean,
    onToken?: (token: string) => void,
  ): Promise<AiChatResponse> {
    const failures: RufloProviderGatewayError["failures"] = [];
    let retries = 0;
    for (let index = 0; index < this.candidates.length; index += 1) {
      const candidate = this.candidates[index];
      const maxAttempts = index === 0 ? this.tracker.limits.maxProviderRetries + 1 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        this.tracker.assertRetryAllowed(retries);
        const candidateRequest = { ...request, model: candidate.model.id };
        let estimate: { inputTokens: number; requestedOutputTokens: number };
        try {
          estimate = this.tracker.preflight({
            sessionId: this.context.sessionId,
            request: candidateRequest,
            provider: candidate.provider.id,
            contextWindow: candidate.model.contextWindow,
            requestedOutputTokens: candidateRequest.maxOutputTokens ?? 2_048,
            retryCount: retries,
          });
        } catch (error) {
          if (error instanceof RufloBudgetLimitError) {
            this.context.onAttempt?.({
              provider: candidate.provider.id,
              model: candidate.model.id,
              capability: this.context.capability,
              fallbackUsed: index > 0,
              classification: "budget_limit",
            });
            throw error;
          }
          throw error;
        }
        try {
          const response = streaming
            ? await candidate.provider.stream(candidateRequest, (token) => onToken?.(token))
            : await candidate.provider.chat(candidateRequest);
          this.tracker.record({
            provider: candidate.provider,
            model: response.model || candidate.model.id,
            agentRole: this.context.agentRole ?? request.role,
            taskId: this.context.taskId,
            sessionId: this.context.sessionId,
            request: candidateRequest,
            response,
            inputTokens: response.usage?.inputTokens ?? estimate.inputTokens,
            outputTokens: response.usage?.outputTokens,
          });
          this.context.onAttempt?.({
            provider: candidate.provider.id,
            model: candidate.model.id,
            capability: this.context.capability,
            fallbackUsed: index > 0,
          });
          return response;
        } catch (error) {
          const classification = classifyRufloProviderFailure(error);
          failures.push({ provider: candidate.provider.id, model: candidate.model.id, classification });
          this.tracker.record({
            provider: candidate.provider,
            model: candidate.model.id,
            agentRole: this.context.agentRole ?? request.role,
            taskId: this.context.taskId,
            sessionId: this.context.sessionId,
            request: candidateRequest,
            inputTokens: estimate.inputTokens,
            outputTokens: 0,
          });
          this.context.onAttempt?.({
            provider: candidate.provider.id,
            model: candidate.model.id,
            capability: this.context.capability,
            fallbackUsed: index > 0,
            classification,
          });
          if (error instanceof RufloBudgetLimitError) throw error;
          if (streaming && isStreamingOutput(error)) throw error;
          if (classification === "context_limit" || classification === "authentication/configuration") break;
          if (attempt + 1 < maxAttempts) retries += 1;
          else break;
        }
      }
    }
    throw new RufloProviderGatewayError(failures);
  }
}

export function classifyRufloProviderFailure(error: unknown): RufloProviderFailureClass {
  if (error instanceof RufloBudgetLimitError) return "budget_limit";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "timeout") return "timeout";
  if (code === "rate_limited") return "rate_limit";
  if (code === "invalid_configuration" || code === "not_configured") return "authentication/configuration";
  if (code === "context_limit") return "context_limit";
  if (code === "model_unavailable" || code === "temporary_failure") return "unavailable";
  if (error instanceof GroqProviderError && error.retryable) return "unavailable";
  return "unknown";
}

export function inferRufloCapability(task: string): RufloCapabilityClass {
  if (/(architecture|complex|multi[- ]file|recovery|deep|system design)/i.test(task)) return "heavy";
  if (/(classif|extract|summar|simple review|triage|label)/i.test(task)) return "light";
  return "medium";
}

function supportsCapability(model: AiModel, capability: RufloCapabilityClass): boolean {
  if (model.capabilityClasses?.length) return model.capabilityClasses.includes(capability);
  if (capability === "light") return model.capabilities.includes("fast") || model.capabilities.length > 0;
  if (capability === "medium") return model.capabilities.includes("coding") || model.capabilities.includes("reasoning");
  return model.capabilities.includes("reasoning") && (model.strength ?? 1) >= 2;
}

function compareCandidates(a: RufloRouteCandidate, b: RufloRouteCandidate, capability: RufloCapabilityClass): number {
  const aStrength = a.model.strength ?? (a.model.capabilities.includes("reasoning") ? 2 : 1);
  const bStrength = b.model.strength ?? (b.model.capabilities.includes("reasoning") ? 2 : 1);
  const aCost = costRank(a.model.costTier);
  const bCost = costRank(b.model.costTier);
  if (capability === "light" && aCost !== bCost) return aCost - bCost;
  if (capability === "heavy" && aStrength !== bStrength) return bStrength - aStrength;
  if (capability === "medium" && aStrength !== bStrength) return Math.abs(aStrength - 2) - Math.abs(bStrength - 2);
  return bStrength - aStrength || a.model.id.localeCompare(b.model.id);
}

function costRank(tier: AiModel["costTier"]): number {
  return tier === "low" ? 0 : tier === "medium" ? 1 : tier === "high" ? 2 : 1;
}

function costLabel(candidate: RufloRouteCandidate): string {
  return candidate.model.costTier ? `${candidate.model.costTier}-cost` : "lowest-known-cost";
}

function isStreamingOutput(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "streamOutputStarted" in error && error.streamOutputStarted === true);
}

export type { RufloBudgetLimits, RufloTokenPricing };