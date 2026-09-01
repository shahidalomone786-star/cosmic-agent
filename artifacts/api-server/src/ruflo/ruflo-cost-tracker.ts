import type { AiChatRequest, AiChatResponse, AiProvider } from "../ai/ai-provider";

export type RufloBudgetLimits = {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSessionTokens: number;
  maxSessionCostUsd?: number;
  maxRequestCostUsd?: number;
  maxProviderRetries: number;
};

export const DEFAULT_RUFLO_BUDGET_LIMITS: RufloBudgetLimits = {
  maxInputTokens: 64_000,
  maxOutputTokens: 8_000,
  maxSessionTokens: 72_000,
  maxProviderRetries: 1,
};

export type RufloTokenPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

export type RufloUsageRecord = {
  provider: string;
  model: string;
  agentRole?: string;
  taskId?: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  costStatus: "estimated" | "unknown";
  exactTokens: boolean;
  timestamp: string;
};

export type RufloProviderModelTotals = {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  costStatus: "estimated" | "unknown";
};

export type RufloCostTotals = {
  sessionId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  costStatus: "estimated" | "unknown";
  providerModels: RufloProviderModelTotals[];
};

export type RufloRemainingBudget = {
  inputTokens: number;
  outputTokens: number;
  sessionTokens: number;
  sessionCostUsd: number | undefined;
  requestCostUsd: number | undefined;
  providerRetries: number;
};

export class RufloBudgetLimitError extends Error {
  constructor(
    readonly code:
      | "input_token_budget"
      | "output_token_budget"
      | "session_token_budget"
      | "session_cost_budget"
      | "request_cost_budget"
      | "provider_retry_budget"
      | "context_limit",
    message: string,
  ) {
    super(message);
    this.name = "RufloBudgetLimitError";
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateRequestInputTokens(request: AiChatRequest): number {
  return request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

export function normalizeRufloBudgetLimits(input?: Partial<RufloBudgetLimits>): RufloBudgetLimits {
  const configured = {
    maxInputTokens: envPositive("RUFLO_MAX_INPUT_TOKENS", DEFAULT_RUFLO_BUDGET_LIMITS.maxInputTokens),
    maxOutputTokens: envPositive("RUFLO_MAX_OUTPUT_TOKENS", DEFAULT_RUFLO_BUDGET_LIMITS.maxOutputTokens),
    maxSessionTokens: envPositive("RUFLO_MAX_SESSION_TOKENS", DEFAULT_RUFLO_BUDGET_LIMITS.maxSessionTokens),
    maxSessionCostUsd: envOptionalPositive("RUFLO_MAX_SESSION_COST_USD"),
    maxRequestCostUsd: envOptionalPositive("RUFLO_MAX_REQUEST_COST_USD"),
    maxProviderRetries: envPositive("RUFLO_MAX_PROVIDER_RETRIES", DEFAULT_RUFLO_BUDGET_LIMITS.maxProviderRetries),
  };
  return {
    maxInputTokens: boundedLimit(input?.maxInputTokens, configured.maxInputTokens, 1),
    maxOutputTokens: boundedLimit(input?.maxOutputTokens, configured.maxOutputTokens, 1),
    maxSessionTokens: boundedLimit(input?.maxSessionTokens, configured.maxSessionTokens, 1),
    maxSessionCostUsd: boundedOptionalLimit(input?.maxSessionCostUsd, configured.maxSessionCostUsd),
    maxRequestCostUsd: boundedOptionalLimit(input?.maxRequestCostUsd, configured.maxRequestCostUsd),
    maxProviderRetries: boundedLimit(input?.maxProviderRetries, configured.maxProviderRetries, 0),
  };
}

export class RufloCostTracker {
  private readonly records: RufloUsageRecord[] = [];
  private readonly pricing: ReadonlyMap<string, RufloTokenPricing>;
  readonly limits: RufloBudgetLimits;

  constructor(input: {
    limits?: Partial<RufloBudgetLimits>;
    pricing?: ReadonlyMap<string, RufloTokenPricing> | Record<string, RufloTokenPricing>;
  } = {}) {
    this.limits = normalizeRufloBudgetLimits(input.limits);
    this.pricing = input.pricing instanceof Map
      ? input.pricing
      : new Map(Object.entries(input.pricing ?? {}));
  }

  preflight(input: {
    sessionId: string;
    request: AiChatRequest;
    provider?: string;
    contextWindow?: number | null;
    requestedOutputTokens?: number;
    retryCount?: number;
  }): { inputTokens: number; requestedOutputTokens: number } {
    const inputTokens = estimateRequestInputTokens(input.request);
    const requestedOutputTokens = Math.max(
      1,
      Math.floor(input.requestedOutputTokens ?? input.request.maxOutputTokens ?? 2_048),
    );
    if (inputTokens > this.limits.maxInputTokens) {
      throw new RufloBudgetLimitError("input_token_budget", "The Ruflo input-token budget was reached.");
    }
    if (requestedOutputTokens > this.limits.maxOutputTokens) {
      throw new RufloBudgetLimitError("output_token_budget", "The Ruflo output-token budget was reached.");
    }
    if (input.contextWindow != null && inputTokens + requestedOutputTokens > input.contextWindow) {
      throw new RufloBudgetLimitError("context_limit", "The selected model cannot fit the requested context and output.");
    }
    if ((input.retryCount ?? 0) > this.limits.maxProviderRetries) {
      throw new RufloBudgetLimitError("provider_retry_budget", "The Ruflo provider retry budget was reached.");
    }

    const totals = this.getSessionTotals(input.sessionId);
    if (totals.totalTokens + inputTokens + requestedOutputTokens > this.limits.maxSessionTokens) {
      throw new RufloBudgetLimitError("session_token_budget", "The Ruflo session token budget was reached.");
    }
    if (this.limits.maxRequestCostUsd != null || this.limits.maxSessionCostUsd != null) {
      const pricing = input.provider
        ? this.pricing.get(`${input.provider}:${input.request.model}`) ?? this.pricing.get(input.request.model)
        : undefined;
      if (!pricing) {
        throw new RufloBudgetLimitError(
          this.limits.maxRequestCostUsd != null ? "request_cost_budget" : "session_cost_budget",
          "The Ruflo request cost cannot be evaluated because pricing is unavailable.",
        );
      }
      const requestCost = calculateEstimatedCost(inputTokens, requestedOutputTokens, pricing);
      if (this.limits.maxRequestCostUsd != null && requestCost > this.limits.maxRequestCostUsd) {
        throw new RufloBudgetLimitError("request_cost_budget", "The Ruflo request cost budget was reached.");
      }
      if (this.limits.maxSessionCostUsd != null) {
        if (totals.estimatedCostUsd == null || totals.estimatedCostUsd + requestCost > this.limits.maxSessionCostUsd) {
          throw new RufloBudgetLimitError("session_cost_budget", "The Ruflo session cost budget was reached.");
        }
      }
    }
    return { inputTokens, requestedOutputTokens };
  }

  record(input: {
    provider: AiProvider | string;
    model: string;
    agentRole?: string;
    taskId?: string;
    sessionId: string;
    request: AiChatRequest;
    response?: AiChatResponse;
    inputTokens?: number;
    outputTokens?: number;
    exactTokens?: boolean;
    timestamp?: string;
  }): RufloUsageRecord {
    const inputTokens = Math.max(0, Math.floor(input.inputTokens ?? (
      input.response?.usage?.inputTokens ?? estimateRequestInputTokens(input.request)
    )));
    const outputTokens = Math.max(0, Math.floor(input.outputTokens ?? (
      input.response?.usage?.outputTokens ?? estimateTokens(input.response?.content ?? "")
    )));
    const totalTokens = input.response?.usage?.totalTokens ?? inputTokens + outputTokens;
    const pricing = this.pricing.get(`${providerId(input.provider)}:${input.model}`) ?? this.pricing.get(input.model);
    const estimatedCostUsd = pricing
      ? calculateEstimatedCost(inputTokens, outputTokens, pricing)
      : undefined;
    const record: RufloUsageRecord = {
      provider: providerId(input.provider),
      model: input.model,
      agentRole: input.agentRole,
      taskId: input.taskId,
      sessionId: input.sessionId,
      inputTokens,
      outputTokens,
      totalTokens: Math.max(0, Math.floor(totalTokens)),
      estimatedCostUsd,
      costStatus: estimatedCostUsd == null ? "unknown" : "estimated",
      exactTokens: input.exactTokens ?? Boolean(input.response?.usage?.exact),
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    this.records.push(record);
    this.assertRecordedWithinBudget(record);
    return { ...record };
  }

  getRecords(sessionId?: string): RufloUsageRecord[] {
    return this.records
      .filter((record) => !sessionId || record.sessionId === sessionId)
      .map((record) => ({ ...record }));
  }

  getSessionTotals(sessionId: string): RufloCostTotals {
    return summarize(sessionId, this.getRecords(sessionId));
  }

  getRemainingBudget(sessionId: string): RufloRemainingBudget {
    const totals = this.getSessionTotals(sessionId);
    return {
      inputTokens: Math.max(0, this.limits.maxInputTokens - totals.inputTokens),
      outputTokens: Math.max(0, this.limits.maxOutputTokens - totals.outputTokens),
      sessionTokens: Math.max(0, this.limits.maxSessionTokens - totals.totalTokens),
      sessionCostUsd: this.limits.maxSessionCostUsd == null || totals.estimatedCostUsd == null
        ? this.limits.maxSessionCostUsd
        : Math.max(0, this.limits.maxSessionCostUsd - totals.estimatedCostUsd),
      requestCostUsd: this.limits.maxRequestCostUsd,
      providerRetries: this.limits.maxProviderRetries,
    };
  }

  assertRetryAllowed(retryCount: number): void {
    if (retryCount > this.limits.maxProviderRetries) {
      throw new RufloBudgetLimitError("provider_retry_budget", "The Ruflo provider retry budget was reached.");
    }
  }

  private assertRecordedWithinBudget(record: RufloUsageRecord): void {
    const totals = this.getSessionTotals(record.sessionId);
    if (totals.inputTokens > this.limits.maxInputTokens) {
      throw new RufloBudgetLimitError("input_token_budget", "The Ruflo input-token budget was reached.");
    }
    if (totals.outputTokens > this.limits.maxOutputTokens) {
      throw new RufloBudgetLimitError("output_token_budget", "The Ruflo output-token budget was reached.");
    }
    if (totals.totalTokens > this.limits.maxSessionTokens) {
      throw new RufloBudgetLimitError("session_token_budget", "The Ruflo session token budget was reached.");
    }
    if (this.limits.maxSessionCostUsd != null) {
      if (totals.estimatedCostUsd == null) {
        throw new RufloBudgetLimitError("session_cost_budget", "The Ruflo session cost cannot be evaluated because pricing is unavailable.");
      }
      if (totals.estimatedCostUsd > this.limits.maxSessionCostUsd) {
        throw new RufloBudgetLimitError("session_cost_budget", "The Ruflo session cost budget was reached.");
      }
    }
    if (this.limits.maxRequestCostUsd != null && record.estimatedCostUsd == null) {
      throw new RufloBudgetLimitError("request_cost_budget", "The Ruflo request cost cannot be evaluated because pricing is unavailable.");
    }
    if (this.limits.maxRequestCostUsd != null && record.estimatedCostUsd! > this.limits.maxRequestCostUsd) {
      throw new RufloBudgetLimitError("request_cost_budget", "The Ruflo request cost budget was reached.");
    }
  }
}

export function calculateEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: RufloTokenPricing,
): number {
  return (Math.max(0, inputTokens) * pricing.inputPerMillionUsd
    + Math.max(0, outputTokens) * pricing.outputPerMillionUsd) / 1_000_000;
}

function summarize(sessionId: string, records: RufloUsageRecord[]): RufloCostTotals {
  const providerModels = new Map<string, RufloProviderModelTotals>();
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let costKnown = true;
  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    totalTokens += record.totalTokens;
    if (record.estimatedCostUsd == null) costKnown = false;
    else estimatedCostUsd += record.estimatedCostUsd;
    const key = `${record.provider}:${record.model}`;
    const current = providerModels.get(key) ?? {
      provider: record.provider,
      model: record.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costStatus: "estimated" as const,
    };
    current.requests += 1;
    current.inputTokens += record.inputTokens;
    current.outputTokens += record.outputTokens;
    current.totalTokens += record.totalTokens;
    if (record.estimatedCostUsd == null) {
      current.costStatus = "unknown";
      delete current.estimatedCostUsd;
    } else if (current.costStatus !== "unknown") {
      current.estimatedCostUsd = (current.estimatedCostUsd ?? 0) + record.estimatedCostUsd;
    }
    providerModels.set(key, current);
  }
  return {
    sessionId,
    requests: records.length,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: costKnown ? estimatedCostUsd : undefined,
    costStatus: costKnown ? "estimated" : "unknown",
    providerModels: [...providerModels.values()],
  };
}

function providerId(provider: AiProvider | string): string {
  return typeof provider === "string" ? provider : provider.id;
}

function envPositive(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function envOptionalPositive(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedLimit(value: number | undefined, maximum: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value!))) : maximum;
}

function boundedOptionalLimit(value: number | undefined, maximum: number | undefined): number | undefined {
  if (maximum == null) return Number.isFinite(value) ? Math.max(0, value!) : undefined;
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value!)) : maximum;
}