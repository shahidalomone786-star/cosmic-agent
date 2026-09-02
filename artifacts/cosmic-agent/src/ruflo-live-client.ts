export type RufloSseEvent = {
  id: string;
  type: string;
  payload?: { session?: Record<string, unknown> };
};

export function parseRufloSseBlock(block: string): RufloSseEvent | undefined {
  let id = "";
  let type = "";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return undefined;
  try {
    const parsed = JSON.parse(data.join("\n")) as Omit<RufloSseEvent, "id" | "type"> & { id?: string; type?: string };
    return { ...parsed, id: id || parsed.id || "", type: type || parsed.type || "" };
  } catch {
    return undefined;
  }
}

export function acceptRufloLiveEvent(lastEventId: string, nextEventId: string): boolean {
  if (!nextEventId || !/^\d+$/.test(nextEventId) || !lastEventId || !/^\d+$/.test(lastEventId)) return true;
  return Number(nextEventId) > Number(lastEventId);
}