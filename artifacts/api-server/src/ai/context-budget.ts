export type ContextItem = {
  key: string;
  text: string;
  relevance: number;
  explicit?: boolean;
};

export type ContextBudgetResult = {
  text: string;
  approximateChars: number;
  chunked: boolean;
  warnings: string[];
  includedKeys: string[];
};

const DEFAULT_BUDGET = 64_000;

function compact(value: string): string {
  const seen = new Set<string>();
  return value.split("\n").map((line) => line.trimEnd()).filter((line) => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).join("\n");
}

export function fitContext(items: ContextItem[], budget = DEFAULT_BUDGET): ContextBudgetResult {
  const safeBudget = Math.max(4_000, Math.min(budget, 128_000));
  const ranked = [...items]
    .map((item) => ({ ...item, text: compact(item.text) }))
    .filter((item) => item.text)
    .sort((a, b) => Number(Boolean(b.explicit)) - Number(Boolean(a.explicit)) || b.relevance - a.relevance);
  const seen = new Set<string>();
  const included: ContextItem[] = [];
  let chars = 0;
  for (const item of ranked) {
    if (seen.has(item.key)) continue;
    const remaining = safeBudget - chars;
    if (remaining < 200) break;
    const text = item.text.slice(0, remaining);
    included.push({ ...item, text });
    seen.add(item.key);
    chars += text.length;
    if (text.length < item.text.length) break;
  }
  const warnings: string[] = [];
  const chunked = included.some((item) => {
    const original = items.find((candidate) => candidate.key === item.key);
    return Boolean(original && item.text.length < original.text.length);
  });
  if (chunked || included.length < ranked.length) warnings.push("Context was compacted to stay within the model budget; explicit files were prioritized.");
  return { text: included.map((item) => item.text).join("\n\n"), approximateChars: chars, chunked, warnings, includedKeys: included.map((item) => item.key) };
}

export function compactConversation<T extends { role: string; content: string }>(messages: T[], maxMessages = 24): T[] {
  if (messages.length <= maxMessages) return messages;
  const system = messages.filter((message) => message.role === "system").slice(0, 2);
  return [...system, ...messages.filter((message) => message.role !== "system").slice(-Math.max(1, maxMessages - system.length))];
}