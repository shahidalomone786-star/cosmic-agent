// src/repository/context-manager.ts
var MAX_CONTEXT_CHARS = 64e3;
var RETRY_CONTEXT_CHARS = 32e3;
var MAX_FILE_CHARS = 12e3;
var lastContextStatus = { filesIncluded: 0, approximateChars: 0, chunked: false, lastWarnings: [] };
function chunkContext(path, content, budget, focus) {
  const take = Math.min(MAX_FILE_CHARS, Math.max(0, budget));
  const allLines = content.split("\n");
  if (content.length <= take) {
    return {
      text: `### ${path} (lines 1-${allLines.length})
${content}`,
      startLine: 1,
      endLine: allLines.length,
      chunked: false
    };
  }
  let start = focus ? Math.max(0, focus.startLine - 1) : 0;
  let end = focus ? Math.min(allLines.length, Math.max(focus.endLine, focus.startLine)) : allLines.length;
  const length = () => allLines.slice(start, end).join("\n").length;
  while (length() > take && end - start > 1) {
    if (start < Math.max(0, focus ? focus.startLine - 1 : 0)) start += 1;
    else end -= 1;
  }
  while (length() < take && (start > 0 || end < allLines.length)) {
    if (start > 0) start -= 1;
    if (length() >= take) break;
    if (end < allLines.length) end += 1;
  }
  const text = allLines.slice(start, end).join("\n").slice(0, take);
  return {
    text: `### ${path} (lines ${start + 1}-${Math.min(allLines.length, start + text.split("\n").length)})
${text}`,
    startLine: start + 1,
    endLine: Math.min(allLines.length, start + text.split("\n").length),
    chunked: true
  };
}
function recordContextStatus(status) {
  lastContextStatus = status;
}
function getContextResourceStatus() {
  return { ...lastContextStatus, lastWarnings: [...lastContextStatus.lastWarnings] };
}
export {
  MAX_CONTEXT_CHARS,
  MAX_FILE_CHARS,
  RETRY_CONTEXT_CHARS,
  chunkContext,
  getContextResourceStatus,
  recordContextStatus
};
