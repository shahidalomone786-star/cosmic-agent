// src/ai/context-budget.ts
var DEFAULT_BUDGET = 64e3;
function compact(value) {
  const seen = /* @__PURE__ */ new Set();
  return value.split("\n").map((line) => line.trimEnd()).filter((line) => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).join("\n");
}
function fitContext(items, budget = DEFAULT_BUDGET) {
  const safeBudget = Math.max(4e3, Math.min(budget, 128e3));
  const ranked = [...items].map((item) => ({ ...item, text: compact(item.text) })).filter((item) => item.text).sort((a, b) => Number(Boolean(b.explicit)) - Number(Boolean(a.explicit)) || b.relevance - a.relevance);
  const seen = /* @__PURE__ */ new Set();
  const included = [];
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
  const warnings = [];
  const chunked = included.some((item) => {
    const original = items.find((candidate) => candidate.key === item.key);
    return Boolean(original && item.text.length < original.text.length);
  });
  if (chunked || included.length < ranked.length) warnings.push("Context was compacted to stay within the model budget; explicit files were prioritized.");
  return { text: included.map((item) => item.text).join("\n\n"), approximateChars: chars, chunked, warnings, includedKeys: included.map((item) => item.key) };
}
function compactConversation(messages, maxMessages = 24) {
  if (messages.length <= maxMessages) return messages;
  const system = messages.filter((message) => message.role === "system").slice(0, 2);
  return [...system, ...messages.filter((message) => message.role !== "system").slice(-Math.max(1, maxMessages - system.length))];
}
export {
  compactConversation,
  fitContext
};
