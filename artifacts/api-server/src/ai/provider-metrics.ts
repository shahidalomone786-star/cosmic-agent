import { logger } from "../lib/logger";

export type ProviderMetricInput = {
  provider: "groq" | "gemini";
  role?: string;
  keySlot: string;
  success: boolean;
  retryCount: number;
  rateLimited?: boolean;
  approximateInputChars: number;
  approximateOutputChars: number;
  durationMs: number;
};

type ProviderMetricTotals = {
  requests: number;
  successes: number;
  failures: number;
  retries: number;
  rateLimitEvents: number;
  inputChars: number;
  outputChars: number;
  durationMs: number;
};

const totals = new Map<string, ProviderMetricTotals>();
const keySlots = new Map<string, ProviderMetricTotals>();

function emptyTotals(): ProviderMetricTotals {
  return { requests: 0, successes: 0, failures: 0, retries: 0, rateLimitEvents: 0, inputChars: 0, outputChars: 0, durationMs: 0 };
}

function add(target: ProviderMetricTotals, input: ProviderMetricInput): void {
  target.requests += 1;
  target.successes += Number(input.success);
  target.failures += Number(!input.success);
  target.retries += input.retryCount;
  target.rateLimitEvents += Number(Boolean(input.rateLimited));
  target.inputChars += input.approximateInputChars;
  target.outputChars += input.approximateOutputChars;
  target.durationMs += Math.max(0, Math.round(input.durationMs));
}

export function recordProviderMetric(input: ProviderMetricInput): void {
  const providerKey = `${input.provider}:${input.role ?? "unknown"}`;
  const providerTotals = totals.get(providerKey) ?? emptyTotals();
  add(providerTotals, input);
  totals.set(providerKey, providerTotals);

  const slotKey = `${input.provider}:${input.keySlot}`;
  const slotTotals = keySlots.get(slotKey) ?? emptyTotals();
  add(slotTotals, input);
  keySlots.set(slotKey, slotTotals);

  logger.info({
    provider: input.provider,
    role: input.role ?? "unknown",
    keySlot: input.keySlot,
    success: input.success,
    retryCount: input.retryCount,
    rateLimited: Boolean(input.rateLimited),
    approximateInputChars: input.approximateInputChars,
    approximateOutputChars: input.approximateOutputChars,
    durationMs: Math.max(0, Math.round(input.durationMs)),
  }, "AI provider request telemetry");
}

export function getProviderMetrics(): {
  providers: Record<string, ProviderMetricTotals>;
  keySlots: Record<string, ProviderMetricTotals>;
} {
  return {
    providers: Object.fromEntries([...totals.entries()].map(([key, value]) => [key, { ...value }])),
    keySlots: Object.fromEntries([...keySlots.entries()].map(([key, value]) => [key, { ...value }])),
  };
}

export function resetProviderMetrics(): void {
  totals.clear();
  keySlots.clear();
}