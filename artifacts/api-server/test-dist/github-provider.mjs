// src/lib/logger.ts
import pino from "pino";
var isProduction = process.env.NODE_ENV === "production";
var logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']"
  ],
  ...isProduction ? {} : {
    transport: {
      target: "pino-pretty",
      options: { colorize: true }
    }
  }
});

// src/repository/github-resource-manager.ts
var LOW_REMAINING = 25;
var rateState = "unknown";
var remaining = null;
var limit = null;
var resetAt = null;
var cacheHits = 0;
var cacheMisses = 0;
function recordGitHubResponse(headers, status, message = "") {
  const headerRemaining = Number(headers.get("x-ratelimit-remaining"));
  const headerLimit = Number(headers.get("x-ratelimit-limit"));
  const headerReset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(headerRemaining)) remaining = headerRemaining;
  if (Number.isFinite(headerLimit)) limit = headerLimit;
  if (Number.isFinite(headerReset)) resetAt = headerReset * 1e3;
  const rateLimited = status === 429 || status === 403 && (remaining === 0 || /rate limit|secondary rate limit|abuse detection/i.test(message));
  if (rateLimited || remaining === 0) rateState = "exhausted";
  else if (remaining !== null && remaining <= LOW_REMAINING) rateState = "low";
  else if (status >= 200 && status < 400) rateState = "healthy";
}
function recordCacheHit() {
  cacheHits += 1;
}
function recordCacheMiss() {
  cacheMisses += 1;
}
function getGitHubResourceStatus() {
  const message = rateState === "healthy" ? "GitHub API: Healthy" : rateState === "low" ? "GitHub API: Rate limit low \u2014 using cache where possible" : rateState === "exhausted" ? "GitHub API: Rate limited \u2014 cached repository data available" : "GitHub API status is not known yet.";
  return {
    api: rateState,
    message,
    remaining,
    limit,
    resetAt,
    cache: {
      status: cacheHits > 0 ? "warm" : "cold",
      hits: cacheHits,
      misses: cacheMisses
    }
  };
}

// src/repository/context-manager.ts
var MAX_CONTEXT_CHARS = 64e3;
var MAX_FILE_CHARS = 12e3;
var lastContextStatus = { filesIncluded: 0, approximateChars: 0, chunked: false, lastWarnings: [] };
function chunkContext(path, content, budget) {
  const take = Math.min(MAX_FILE_CHARS, Math.max(0, budget));
  const text = content.slice(0, take);
  const lines = text.split("\n");
  return {
    text: `### ${path} (lines 1-${lines.length})
${text}`,
    startLine: 1,
    endLine: lines.length,
    chunked: content.length > text.length
  };
}
function recordContextStatus(status) {
  lastContextStatus = status;
}

// src/repository/github-provider.ts
var GITHUB_API = "https://api.github.com";
var MAX_FILE_BYTES = 24e4;
var BLOCKED = /(^|\/)(node_modules|dist|build|\.git|\.cache|coverage)(\/|$)/i;
var SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|crt))$/i;
var GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GITHUB_API_TOKEN;
var INDEX_TTL_MS = 10 * 60 * 1e3;
var REPOSITORY_CACHE = /* @__PURE__ */ new Map();
var FILE_CACHE = /* @__PURE__ */ new Map();
var BRANCH_SHA_CACHE = /* @__PURE__ */ new Map();
var SEARCH_CACHE = /* @__PURE__ */ new Map();
var METADATA_CACHE = /* @__PURE__ */ new Map();
var DIRECTORY_CACHE = /* @__PURE__ */ new Map();
var RepositoryError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function parseGitHubUrl(value) {
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new RepositoryError("invalid_url", "Invalid repository URL. Use https://github.com/owner/repository.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new RepositoryError("invalid_url", "Invalid repository URL. Use https://github.com/owner/repository.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parsed.search || parsed.hash) {
    throw new RepositoryError("invalid_url", "Invalid repository URL. Use https://github.com/owner/repository.");
  }
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");
  if (!owner || !name || owner === "." || owner === ".." || name === "." || name === ".." || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new RepositoryError("invalid_url", "Invalid repository URL. Use https://github.com/owner/repository.");
  }
  return { owner, name };
}
async function githubFetch(path, notFoundMessage) {
  const apiRoute = path.split("?", 1)[0];
  const diagnostic = {
    normalizedRepositoryUrl: repositoryUrlForApiRoute(apiRoute),
    hostname: "api.github.com",
    apiRoute
  };
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Cosmic-Agent-Read-Only"
    };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const response = await fetch(`${GITHUB_API}${path}`, { headers });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const rawBody = await response.text();
    const responseBody = parseGitHubJson(rawBody);
    recordGitHubResponse(response.headers, response.status, responseBody?.message);
    const safeCategory = classifyGitHubResponse(response.status, contentType, rawBody, responseBody);
    logger.info({ ...diagnostic, status: response.status, category: safeCategory }, "Repository GitHub response");
    if (safeCategory === "internal_route") {
      throw new RepositoryError("internal_route", "The repository service received an unexpected HTML response instead of GitHub API data.");
    }
    const rateRemaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 401) throw new RepositoryError("permission_denied", "GitHub authorization was rejected. Public repositories do not require a token.");
    if (response.status === 403 || response.status === 429) {
      const isRateLimit = response.status === 429 || rateRemaining === "0" || /rate limit/i.test(responseBody?.message ?? "");
      throw new RepositoryError(isRateLimit ? "rate_limited" : "permission_denied", isRateLimit ? "GitHub API rate limit reached. Please try again later." : "GitHub denied access to this repository.");
    }
    if (response.status === 404) throw new RepositoryError("file_not_found", notFoundMessage);
    if (response.status >= 500) throw new RepositoryError("service_unavailable", "GitHub service unavailable. Please try again later.");
    if (!response.ok) throw new RepositoryError("network", "GitHub API request failed. Please try again later.");
    return responseBody;
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    logger.warn({ ...diagnostic, category: "network" }, "GitHub read request failed");
    throw new RepositoryError("network", "GitHub service unavailable. Please try again later.");
  }
}
function parseGitHubJson(rawBody) {
  if (!rawBody.trim()) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
function classifyGitHubResponse(status, contentType, rawBody, responseBody) {
  const looksLikeHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(rawBody);
  if (looksLikeHtml) return "internal_route";
  if (status === 404) return "file_not_found";
  if (status === 401 || status === 403) {
    return status === 403 && (/rate limit/i.test(responseBody?.message ?? "") || responseBody?.message === void 0) ? "rate_limited" : "permission_denied";
  }
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unavailable";
  return status >= 200 && status < 300 ? "ok" : "network";
}
function repositoryUrlForApiRoute(apiRoute) {
  const match = apiRoute.match(/^\/repos\/([^/]+)\/([^/]+)/);
  if (!match) return "https://github.com/unknown/unknown";
  return `https://github.com/${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
}
async function connectRepository(url, branch) {
  const { owner, name } = parseGitHubUrl(url);
  const metadataKey = `${owner}/${name}`;
  const cachedMetadata = METADATA_CACHE.get(metadataKey);
  const repo = cachedMetadata && cachedMetadata.expiresAt > Date.now() ? (recordCacheHit(), cachedMetadata.repo) : await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    "Repository not found on GitHub."
  ).then((value) => {
    recordCacheMiss();
    METADATA_CACHE.set(metadataKey, { expiresAt: Date.now() + INDEX_TTL_MS, repo: value });
    return value;
  }).catch((error) => {
    if (error instanceof RepositoryError && error.code === "file_not_found") {
      throw new RepositoryError("repository_not_found", "Repository not found on GitHub.");
    }
    throw error;
  });
  const defaultBranch = repo.default_branch;
  const selectedBranch = branch?.trim() || defaultBranch;
  validateBranch(selectedBranch);
  await resolveBranchSha(owner, name, selectedBranch);
  return { id: String(repo.id), owner, name, branch: selectedBranch, defaultBranch, webUrl: repo.html_url };
}
function validateBranch(branch) {
  if (branch.length === 0 || branch.length > 255 || /[\u0000-\u001f\u007f ~^:?*\[\\]/.test(branch) || branch.includes("..") || branch.includes("@{") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock") || branch.includes("//")) {
    throw new RepositoryError("invalid_url", "Invalid branch. Use a valid GitHub branch name.");
  }
}
async function listTree(repository, path = "") {
  if (BLOCKED.test(path) || SECRET_FILE.test(path)) return [];
  const cacheKey = repositoryCacheKey(repository, path);
  const cached = DIRECTORY_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    recordCacheHit();
    return cached.entries;
  }
  recordCacheMiss();
  const ref = encodeURIComponent(repository.branch);
  const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  await resolveBranchSha(repository.owner, repository.name, repository.branch);
  const data = await githubFetch(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents${encodedPath}?ref=${ref}`, path ? "Directory not found on the selected branch." : "Repository tree not found on the selected branch.");
  const entries = data.filter((entry) => !BLOCKED.test(entry.path) && !SECRET_FILE.test(entry.path)).map((entry) => ({ path: entry.path, name: entry.name, type: entry.type === "dir" ? "directory" : "file", size: entry.size, language: languageFor(entry.name) })).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
  DIRECTORY_CACHE.set(cacheKey, { expiresAt: Date.now() + INDEX_TTL_MS, entries });
  return entries;
}
async function readRepositoryFile(repository, path) {
  if (BLOCKED.test(path) || SECRET_FILE.test(path)) throw new RepositoryError("permission_denied", "This file is protected from repository context.");
  const cacheKey = repositoryCacheKey(repository, path);
  const cached = FILE_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    recordCacheHit();
    return cached.file;
  }
  recordCacheMiss();
  await resolveBranchSha(repository.owner, repository.name, repository.branch);
  const data = await githubFetch(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(repository.branch)}`, "File not found on the selected branch.");
  if (data.type !== "file") throw new RepositoryError("file_not_found", "File not found on the selected branch.");
  if ((data.size ?? 0) > MAX_FILE_BYTES) throw new RepositoryError("too_large", "This file is larger than the safe context limit. Search for a symbol instead.");
  if (!data.content || data.encoding !== "base64") throw new RepositoryError("unsupported_binary", "This file is not a supported text file.");
  const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  const file = { path, language: languageFor(path), size: data.size ?? decoded.length, content: redactSecrets(decoded).slice(0, MAX_FILE_BYTES), truncated: decoded.length > MAX_FILE_BYTES };
  FILE_CACHE.set(cacheKey, { expiresAt: Date.now() + INDEX_TTL_MS, file });
  return file;
}
async function searchRepository(repository, query) {
  const safeQuery = query.trim();
  if (!safeQuery) return [];
  const searchKey = `${repositoryCacheKey(repository)}?${safeQuery.toLowerCase()}`;
  const cachedSearch = SEARCH_CACHE.get(searchKey);
  if (cachedSearch && cachedSearch.expiresAt > Date.now()) {
    recordCacheHit();
    return cachedSearch.results;
  }
  recordCacheMiss();
  const candidates = (await getRepositoryTree(repository)).filter((entry) => entry.type === "blob" && !BLOCKED.test(entry.path) && !SECRET_FILE.test(entry.path)).slice(0, 500);
  const results = [];
  for (const entry of candidates) {
    if (results.length >= 40) break;
    if (entry.path.toLowerCase().includes(safeQuery.toLowerCase())) {
      results.push({ path: entry.path, line: 1, context: "Filename match" });
      continue;
    }
    try {
      const file = await readRepositoryFile(repository, entry.path);
      const lines = file.content.split("\n");
      lines.forEach((line, index) => {
        if (results.length < 40 && line.toLowerCase().includes(safeQuery.toLowerCase())) results.push({ path: entry.path, line: index + 1, context: line.trim().slice(0, 180) });
      });
    } catch {
    }
  }
  SEARCH_CACHE.set(searchKey, { expiresAt: Date.now() + INDEX_TTL_MS, results });
  return results;
}
async function getRepositoryOverview(repository) {
  const cacheKey = repositoryCacheKey(repository);
  const cached = REPOSITORY_CACHE.get(cacheKey);
  if (cached?.overview && cached.expiresAt > Date.now()) {
    recordCacheHit();
    return cached.overview;
  }
  recordCacheMiss();
  const tree = await getRepositoryTree(repository);
  const files = tree.filter((entry) => entry.type === "blob" && !BLOCKED.test(entry.path) && !SECRET_FILE.test(entry.path)).map((entry) => ({ path: entry.path, category: classifyFile(entry.path), language: languageFor(entry.path), size: entry.size }));
  const contentCandidates = files.filter((file) => isUsefulForIndex(file)).slice(0, 90);
  const contents = /* @__PURE__ */ new Map();
  await Promise.all(contentCandidates.map(async (file) => {
    try {
      const result = await readRepositoryFile(repository, file.path);
      contents.set(file.path, result.content);
    } catch {
    }
  }));
  const classifiedFiles = files.map((file) => ({
    ...file,
    category: classifyFile(file.path, contents.get(file.path))
  }));
  const dependencies = buildDependencyGraph(classifiedFiles, contents);
  const overview = {
    repository,
    fileCount: classifiedFiles.length,
    sourceCount: classifiedFiles.filter((file) => ["react-component", "typescript-javascript", "api-server"].includes(file.category)).length,
    configCount: classifiedFiles.filter((file) => file.category === "configuration" || file.category === "package").length,
    testCount: classifiedFiles.filter((file) => file.category === "test").length,
    framework: detectFramework(contents, classifiedFiles),
    language: detectLanguage(classifiedFiles),
    packageManager: detectPackageManager(classifiedFiles),
    directories: majorDirectories(classifiedFiles),
    entryPoints: detectEntryPoints(classifiedFiles),
    authenticationFiles: classifiedFiles.filter((file) => file.category === "authentication").map((file) => file.path).slice(0, 12),
    apiFiles: classifiedFiles.filter((file) => file.category === "api-server").map((file) => file.path).slice(0, 12),
    databaseFiles: classifiedFiles.filter((file) => file.category === "database").map((file) => file.path).slice(0, 12),
    files: classifiedFiles,
    dependencies,
    architecture: buildArchitecture(classifiedFiles)
  };
  REPOSITORY_CACHE.set(cacheKey, { expiresAt: Date.now() + INDEX_TTL_MS, tree, overview });
  return overview;
}
async function retrieveRepositoryContext(repository, paths, question, contextBudget = MAX_CONTEXT_CHARS) {
  const overview = await getRepositoryOverview(repository);
  const requestedExplicit = [...new Set(paths.map((path) => path.replace(/^@/, "").trim()).filter(Boolean))];
  const explicit = resolveExplicitPaths(requestedExplicit, overview.files);
  const missingExplicit = requestedExplicit.filter((path) => !explicit.includes(path) && !overview.files.some((file) => file.path === path));
  const omittedExplicit = requestedExplicit.filter((path) => !explicit.includes(path) && !missingExplicit.includes(path));
  const ranked = rankFiles(question, overview.files).filter((file) => !explicit.includes(file.path));
  const selected = [...explicit.map((path) => overview.files.find((file) => file.path === path)).filter((file) => Boolean(file)), ...ranked].filter((file, index, all) => all.findIndex((candidate) => candidate.path === file.path) === index).slice(0, 8);
  const snippets = [
    [
      "Repository intelligence summary (ground truth from the indexed tree):",
      `- Repository: ${overview.repository.owner}/${overview.repository.name}`,
      `- Branch: ${overview.repository.branch}`,
      `- Framework: ${overview.framework}`,
      `- Primary language: ${overview.language}`,
      `- Package manager: ${overview.packageManager}`,
      `- Indexed files: ${overview.fileCount} total, ${overview.sourceCount} source, ${overview.configCount} configuration/package, ${overview.testCount} tests`,
      `- Architecture layers: ${overview.architecture.map((layer) => `${layer.layer} (${layer.paths.slice(0, 4).join(", ")})`).join("; ") || "none detected"}`,
      "",
      "Grounding rules: Use only this summary and the source excerpts below. Do not guess frameworks, authentication, routes, or data stores that are not evidenced here. If the excerpts do not establish a detail, say that it is not established. Cite exact file paths in backticks."
    ].join("\n")
  ];
  const warnings = [
    ...missingExplicit.length ? [`Explicit files not found or not readable: ${missingExplicit.join(", ")}`] : [],
    ...omittedExplicit.length ? [`Explicit files omitted because the bounded context budget was reached: ${omittedExplicit.join(", ")}`] : []
  ];
  if (warnings.length) snippets.push(`Context selection notice:
${warnings.join("\n")}`);
  const sources = [];
  let totalChars = 0;
  let chunked = false;
  for (const file of selected) {
    if (totalChars >= contextBudget) {
      if (explicit.includes(file.path) && !sources.some((source) => source.path === file.path)) {
        warnings.push(`Explicit file could not fit in the bounded context budget: ${file.path}`);
      }
      continue;
    }
    try {
      const result = await readRepositoryFile(repository, file.path);
      const content = result.content;
      const selectedChunk = chunkContext(result.path, content, contextBudget - totalChars);
      const range = relevantLineRange(content.split("\n"), question);
      snippets.push(selectedChunk.text);
      sources.push({ path: result.path, ...range ?? { startLine: selectedChunk.startLine, endLine: selectedChunk.endLine } });
      totalChars += selectedChunk.text.length;
      chunked ||= selectedChunk.chunked;
    } catch {
      if (explicit.includes(file.path)) warnings.push(`Explicit file could not be retrieved: ${file.path}`);
    }
  }
  const uniqueWarnings = [...new Set(warnings)];
  recordContextStatus({ filesIncluded: sources.length, approximateChars: totalChars, chunked, lastWarnings: uniqueWarnings });
  return { text: snippets.join("\n\n"), sources, warnings: uniqueWarnings, approximateChars: totalChars, chunked };
}
async function resolveBranchSha(owner, name, branch) {
  const cacheKey = `${owner}/${name}#${branch}`;
  const cached = BRANCH_SHA_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    recordCacheHit();
    return cached.sha;
  }
  recordCacheMiss();
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  const ref = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodedBranch}`,
    "Branch not found on the repository."
  ).catch((error) => {
    if (error instanceof RepositoryError && error.code === "file_not_found") {
      throw new RepositoryError("branch_not_found", "Branch not found on the repository.");
    }
    throw error;
  });
  if (!ref.object?.sha) throw new RepositoryError("branch_not_found", "Branch not found on the repository.");
  if (cached && cached.sha !== ref.object.sha) {
    const prefix = `${owner}/${name}#${branch}`;
    for (const key of [...REPOSITORY_CACHE.keys()]) if (key.startsWith(prefix)) REPOSITORY_CACHE.delete(key);
    for (const key of [...FILE_CACHE.keys()]) if (key.startsWith(prefix)) FILE_CACHE.delete(key);
    for (const key of [...SEARCH_CACHE.keys()]) if (key.startsWith(prefix)) SEARCH_CACHE.delete(key);
    for (const key of [...DIRECTORY_CACHE.keys()]) if (key.startsWith(prefix)) DIRECTORY_CACHE.delete(key);
  }
  BRANCH_SHA_CACHE.set(cacheKey, { expiresAt: Date.now() + INDEX_TTL_MS, sha: ref.object.sha });
  return ref.object.sha;
}
async function getRepositoryTree(repository) {
  const cacheKey = repositoryCacheKey(repository);
  const cached = REPOSITORY_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    recordCacheHit();
    return cached.tree;
  }
  recordCacheMiss();
  const branchSha = await resolveBranchSha(repository.owner, repository.name, repository.branch);
  const treeResponse = await githubFetch(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${encodeURIComponent(branchSha)}?recursive=1`, "Repository tree not found on the selected branch.");
  const tree = treeResponse.tree ?? [];
  REPOSITORY_CACHE.set(cacheKey, { expiresAt: Date.now() + INDEX_TTL_MS, tree });
  return tree;
}
function repositoryCacheKey(repository, path = "") {
  return `${repository.owner}/${repository.name}#${repository.branch}${path ? `/${path}` : ""}`;
}
function classifyFile(path, content = "") {
  const lower = path.toLowerCase();
  const text = content.toLowerCase();
  if (/(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb)$/.test(lower)) return "package";
  if (/(test|spec|__tests__|\.test\.|\.spec\.)/.test(lower)) return "test";
  if (/(readme|docs?\/|changelog|\.md$)/.test(lower)) return "documentation";
  if (/(^|\/)(\.env|.*\.(pem|key|p12|pfx|crt))/.test(lower)) return "configuration";
  if (/(vite|webpack|tsconfig|eslint|prettier|babel|config|\.replit|dockerfile)/.test(lower)) return "configuration";
  if (/(auth|login|session|identity|clerk|supabase)/.test(lower) || /(supabase\.auth|clerk|signIn|signOut|authcontext)/.test(text)) return "authentication";
  if (/(database|schema|migration|drizzle|prisma|sequelize|typeorm|supabase)/.test(lower) || /(drizzle|prisma|create table|database_url)/.test(text)) return "database";
  if (/(route|router|api|server|endpoint|controller|middleware)/.test(lower) || /(express\(|router\.(get|post|put|delete)|fetch\(|\/api\/)/.test(text)) return "api-server";
  if (/\.(css|scss|sass|less|styl)$/.test(lower)) return "styling";
  if (/\.(tsx|jsx)$/.test(lower)) return "react-component";
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) return "typescript-javascript";
  return "other";
}
function isUsefulForIndex(file) {
  return file.category !== "other" && file.category !== "documentation" && !file.path.toLowerCase().endsWith(".lock");
}
function detectFramework(contents, files) {
  const text = [...contents.values()].join("\n").toLowerCase();
  const paths = files.map((file) => file.path.toLowerCase()).join("\n");
  if (text.includes('"next"') || paths.includes("next.config")) return "Next.js";
  if (text.includes('"vite"') || paths.includes("vite.config")) return "React + Vite";
  if (text.includes('"express"')) return "Express";
  if (text.includes('"expo"')) return "Expo";
  if (text.includes('"react"')) return "React";
  return "Undetected";
}
function detectPackageManager(files) {
  const paths = new Set(files.map((file) => file.path.toLowerCase()));
  if (paths.has("pnpm-lock.yaml")) return "pnpm";
  if (paths.has("yarn.lock")) return "Yarn";
  if (paths.has("package-lock.json")) return "npm";
  if (paths.has("bun.lockb") || paths.has("bun.lock")) return "Bun";
  return "Undetected";
}
function detectLanguage(files) {
  const counts = /* @__PURE__ */ new Map();
  for (const file of files) if (file.language !== "text" && file.language !== "markdown" && file.language !== "json") counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Undetected";
}
function majorDirectories(files) {
  return [...new Set(files.map((file) => file.path.split("/")[0]).filter((path) => path && path !== "."))].slice(0, 20);
}
function detectEntryPoints(files) {
  const preferred = files.filter((file) => /(^|\/)(app|main|index|server)\.(tsx?|jsx?|mjs|cjs)$|(^|\/)src\/App\.tsx$/i.test(file.path));
  return preferred.map((file) => file.path).slice(0, 12);
}
function resolveExplicitPaths(paths, files) {
  const result = [];
  for (const requested of paths.slice(0, 8)) {
    const clean = requested.replace(/^@/, "").trim();
    const exact = files.find((file) => file.path === clean);
    const basename = files.find((file) => file.path.split("/").pop()?.toLowerCase() === clean.toLowerCase());
    const match = exact ?? basename;
    if (match && !result.includes(match.path)) result.push(match.path);
  }
  return result.slice(0, 5);
}
function rankFiles(question, files) {
  const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  return files.map((file) => {
    const path = file.path.toLowerCase();
    let score = 0;
    for (const term of terms) if (path.includes(term)) score += 5;
    if (terms.some((term) => ["auth", "login", "session"].includes(term)) && file.category === "authentication") score += 8;
    if (terms.some((term) => ["api", "route", "search", "endpoint"].includes(term)) && file.category === "api-server") score += 7;
    if (terms.some((term) => ["database", "data", "schema"].includes(term)) && file.category === "database") score += 7;
    if (file.category === "react-component" && terms.some((term) => ["homepage", "home", "component", "app", "architecture"].includes(term))) score += 3;
    if (file.path.toLowerCase().includes("app.")) score += 2;
    return { file, score };
  }).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path)).filter((item) => item.score > 0).map((item) => item.file).slice(0, 12);
}
function buildDependencyGraph(files, contents) {
  const known = new Set(files.map((file) => file.path));
  const edges = [];
  for (const file of files.filter((item) => contents.has(item.path)).slice(0, 120)) {
    const source = contents.get(file.path) ?? "";
    const imports = source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g);
    for (const match of imports) {
      const target = resolveRelativePath(file.path, match[1], known);
      if (target && target !== file.path && !edges.some((edge) => edge.from === file.path && edge.to === target)) edges.push({ from: file.path, to: target });
      if (edges.length >= 800) return edges;
    }
  }
  return edges;
}
function resolveRelativePath(from, imported, known) {
  if (!imported.startsWith(".")) return void 0;
  const base = from.split("/");
  base.pop();
  const parts = [...base, ...imported.split("/")].filter(Boolean);
  const normalized = [];
  for (const part of parts) part === ".." ? normalized.pop() : part !== "." && normalized.push(part);
  const stem = normalized.join("/");
  return [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.tsx`, `${stem}/index.js`].find((candidate) => known.has(candidate));
}
function buildArchitecture(files) {
  const groups = [
    ["Frontend", ["react-component", "typescript-javascript", "styling"]],
    ["Routes / API", ["api-server"]],
    ["Authentication", ["authentication"]],
    ["Database / Data", ["database"]],
    ["Configuration", ["configuration", "package"]],
    ["Tests / Docs", ["test", "documentation"]]
  ];
  return groups.map(([layer, categories]) => ({ layer, paths: files.filter((file) => categories.includes(file.category)).map((file) => file.path).slice(0, 8) })).filter((group) => group.paths.length > 0);
}
function relevantLineRange(lines, question) {
  const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3);
  const index = lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term)));
  if (index < 0) return void 0;
  return { startLine: index + 1, endLine: Math.min(lines.length, index + 18) };
}
function redactSecrets(content) {
  return content.replace(/(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})/g, "[REDACTED_SECRET]").replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE)[A-Z0-9_]*)\s*=\s*(['"]?)[^'"\n]+/gi, "$1=$2[REDACTED_SECRET]");
}
function languageFor(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  return { ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", css: "css", html: "html", json: "json", md: "markdown", yml: "yaml", yaml: "yaml", py: "python", go: "go", rs: "rust" }[extension ?? ""] ?? "text";
}
export {
  RepositoryError,
  classifyGitHubResponse,
  connectRepository,
  getGitHubResourceStatus,
  getRepositoryOverview,
  listTree,
  parseGitHubUrl,
  readRepositoryFile,
  retrieveRepositoryContext,
  searchRepository
};
