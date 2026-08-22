import { Router, type IRouter, type Response } from "express";
import { AgentToolError, getAgentSession, getAgentToolDefinitions, runAgentSession, type AgentRunInput } from "../ai/agent-runtime";
import {
  SendAiMessageBody,
  SendAiMessageResponse,
  ListAiModelsResponse,
  GetAiResourcesResponse,
} from "@workspace/api-zod";
import { providerManager } from "../ai/provider-manager";
import { GroqProviderError } from "../ai/groq-provider";
import { retrieveRepositoryContext, type RepositoryContextResult, type RepositoryRef } from "../repository/github-provider";
import { CreateChangeProposalBody, CreateChangeProposalResponse } from "@workspace/api-zod";
import { createChangeProposal, ProposalError, type ChangeProposal } from "../ai/change-proposal";
import { commitProposal, executeProposal, getCommitReview, getPushReview, pushProposal, registerProposal, undoProposal, PatchExecutionError } from "../repository/patch-executor";
import { GitHubWriteProviderError } from "../repository/github-write-provider";
import { groqKeyManager } from "../ai/groq-key-manager";
import { getGitHubResourceStatus } from "../repository/github-resource-manager";
import { getContextResourceStatus, RETRY_CONTEXT_CHARS } from "../repository/context-manager";

const router: IRouter = Router();

router.get("/ai/agent/tools", (_req, res) => {
  res.json(getAgentToolDefinitions());
});

router.post("/ai/agent/sessions", async (req, res) => {
  const body = req.body as Partial<AgentRunInput>;
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const paths = Array.isArray(body.paths) ? body.paths.filter((path): path is string => typeof path === "string") : [];
  if (!task || !model) {
    res.status(400).json({ error: "An agent task and approved model are required.", code: "invalid_request" });
    return;
  }
  try {
    const session = await runAgentSession(providerManager.getProvider(), { task, model, repository: body.repository, paths });
    res.status(201).json(session);
  } catch (error) {
    if (error instanceof AgentToolError) {
      res.status(error.code === "approval_required" ? 403 : 400).json({ error: error.message, code: error.code });
      return;
    }
    sendProposalError(res, error);
  }
});

router.get("/ai/agent/sessions/:sessionId", (req, res) => {
  const session = getAgentSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Agent session not found.", code: "not_found" });
    return;
  }
  res.json(session);
});

router.get("/ai/models", (_req, res) => {
  const provider = providerManager.getProvider();
  res.json(ListAiModelsResponse.parse(provider.getModels()));
});

router.get("/ai/resources", (_req, res) => {
  const provider = providerManager.getProvider();
  const health = provider.healthCheck();
  const keyStatus = groqKeyManager.getStatus();
  const github = getGitHubResourceStatus();
  res.json(GetAiResourcesResponse.parse({
    ai: {
      provider: "groq",
      status: health.available ? "healthy" : keyStatus.configured > 0 ? "limited" : "unavailable",
      configuredKeyCount: keyStatus.configured,
      availableKeyCount: keyStatus.available,
      keys: keyStatus.keys.map(({ id, status, cooldownUntil, rateLimitCount }) => ({ id, status, cooldownUntil, rateLimitCount })),
    },
    github,
    context: getContextResourceStatus(),
  }));
});

router.post("/ai/change-proposal", async (req, res) => {
  const parsed = CreateChangeProposalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Select readable repository files and describe the change you want to preview.", code: "invalid_request" });
    return;
  }

  try {
    const provider = providerManager.getProvider();
    const proposal = await createChangeProposal(
      provider,
      parsed.data.model,
      parsed.data.request,
      parsed.data.repositoryContext.repository as RepositoryRef,
      parsed.data.repositoryContext.paths,
    );
    registerProposal(proposal, parsed.data.repositoryContext.repository as RepositoryRef);
    res.json(CreateChangeProposalResponse.parse(proposal));
  } catch (error) {
    sendProposalError(res, error);
  }
});

router.post("/ai/change-proposal/execute", async (req, res) => {
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  if (!proposalId) { res.status(400).json({ error: "Approval requires a valid proposal.", code: "invalid_proposal" }); return; }
  try {
    res.json(await executeProposal(proposalId));
  } catch (error) {
    sendExecutionError(res, error);
  }
});

router.post("/ai/change-proposal/undo", async (req, res) => {
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  if (!proposalId) { res.status(400).json({ error: "Undo requires a valid proposal.", code: "invalid_proposal" }); return; }
  try {
    await undoProposal(proposalId);
    res.json({ status: "undone", proposalId, message: "The exact pre-apply contents were restored locally." });
  } catch (error) {
    sendExecutionError(res, error);
  }
});

router.post("/ai/change-proposal/commit-review", async (req, res) => {
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  if (!proposalId) { res.status(400).json({ error: "Commit review requires a valid proposal.", code: "invalid_proposal" }); return; }
  try { res.json(await getCommitReview(proposalId)); } catch (error) { sendExecutionError(res, error); }
});

router.post("/ai/change-proposal/commit", async (req, res) => {
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  const message = typeof req.body?.message === "string" ? req.body.message : "";
  if (!proposalId) { res.status(400).json({ error: "Commit approval requires a valid proposal.", code: "invalid_proposal" }); return; }
  try { res.json(await commitProposal(proposalId, message)); } catch (error) { sendExecutionError(res, error); }
});

router.post("/ai/change-proposal/push-review", async (req, res) => {
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  if (!proposalId) { res.status(400).json({ error: "Push review requires a valid proposal.", code: "invalid_proposal" }); return; }
  try { res.json(getPushReview(proposalId)); } catch (error) { sendExecutionError(res, error); }
});

router.post("/ai/change-proposal/push", async (req, res) => {
  const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId.trim() : "";
  if (!proposalId) { res.status(400).json({ error: "Push approval requires a valid proposal.", code: "invalid_proposal" }); return; }
  try { res.json(await pushProposal(proposalId)); } catch (error) { sendExecutionError(res, error); }
});

router.post("/ai/chat", async (req, res) => {
  const parsed = SendAiMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid AI request." });
    return;
  }

  try {
    const provider = providerManager.getProvider();
    let prepared = await withRepositoryContext(parsed.data);
    let result;
    try {
      result = await provider.chat(prepared);
    } catch (error) {
      if (!(error instanceof GroqProviderError) || error.code !== "context_limit" || !parsed.data.repositoryContext) throw error;
      prepared = await withRepositoryContext(parsed.data, RETRY_CONTEXT_CHARS);
      result = await provider.chat(prepared);
    }
    res.json(SendAiMessageResponse.parse({ ...result, repositoryContext: prepared.repositoryContextUsed }));
  } catch (error) {
    sendProviderError(res, error);
  }
});

router.post("/ai/chat/stream", async (req, res) => {
  const parsed = SendAiMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid AI request." });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const provider = providerManager.getProvider();
    let prepared = await withRepositoryContext(parsed.data);
    let result;
    const emitToken = (token: string) => {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    };
    try {
      result = await provider.stream(prepared, emitToken);
    } catch (error) {
      if (!(error instanceof GroqProviderError) || error.code !== "context_limit" || !parsed.data.repositoryContext) throw error;
      prepared = await withRepositoryContext(parsed.data, RETRY_CONTEXT_CHARS);
      result = await provider.stream(prepared, emitToken);
    }
    res.write(`data: ${JSON.stringify({ done: true, response: { ...result, repositoryContext: prepared.repositoryContextUsed } })}\n\n`);
    res.write("data: [DONE]\n\n");
  } catch (error) {
    res.write(
      `event: error\ndata: ${JSON.stringify({ error: publicProviderError(error) })}\n\n`,
    );
  } finally {
    res.end();
  }
});

function sendProviderError(
  res: Response,
  error: unknown,
): void {
  const status =
    error instanceof GroqProviderError && error.code === "rate_limited"
      ? 429
      : error instanceof GroqProviderError &&
          ["not_configured", "temporary_failure", "timeout"].includes(error.code)
        ? 503
        : 400;
  res.status(status).json({ error: publicProviderError(error) });
}

type PreparedAiRequest = {
  model: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  temperature?: number | null;
  repositoryContext?: { repository: RepositoryRef; paths: string[] };
  repositoryContextUsed?: {
    paths: string[];
    sources: Array<{ path: string; startLine?: number; endLine?: number }>;
    warnings?: string[];
    approximateChars?: number;
    chunked?: boolean;
  };
};

async function withRepositoryContext(request: PreparedAiRequest, contextBudget?: number): Promise<PreparedAiRequest> {
  if (!request.repositoryContext) return request;
  const question = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const context = await retrieveRepositoryContext(request.repositoryContext.repository, request.repositoryContext.paths, question, contextBudget).catch((): RepositoryContextResult => ({
    text: [
      "Repository evidence is currently unavailable because the read-only source service could not retrieve the repository.",
      "Do not infer or invent framework, package manager, entry point, authentication, database, or architecture details.",
      "Tell the user that repository evidence is unavailable and ask them to retry later.",
    ].join("\n"),
    sources: [],
    warnings: ["Repository evidence is unavailable; no source context was sent."],
    approximateChars: 0,
    chunked: false,
  }));
  return {
    ...request,
    repositoryContextUsed: { paths: context.sources.map((source) => source.path), sources: context.sources, warnings: context.warnings, approximateChars: context.approximateChars, chunked: context.chunked },
    messages: [...request.messages, { role: "system", content: `Repository: ${request.repositoryContext.repository.owner}/${request.repositoryContext.repository.name}\nBranch: ${request.repositoryContext.repository.branch}\nRelevant read-only source context:\n${context.text}` }],
  };
}

function publicProviderError(error: unknown): string {
  if (error instanceof GroqProviderError) return error.message;
  return "The AI provider is temporarily unavailable.";
}

function sendProposalError(res: Response, error: unknown): void {
  if (error instanceof ProposalError) {
    const status =
      error.code === "rate_limited" ? 429 :
      ["protected_file", "permission_denied"].includes(error.code) ? 403 :
      error.code === "file_not_found" ? 404 :
      ["binary_file", "too_large"].includes(error.code) ? 422 :
      error.code === "service_unavailable" ? 503 : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  sendProviderError(res, error);
}

function sendExecutionError(res: Response, error: unknown): void {
  if (error instanceof GitHubWriteProviderError) {
    res.status(error.code === "conflict" ? 409 : 503).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof PatchExecutionError) {
    const status = error.code === "stale_file" ? 409 : ["protected_file", "unsafe_path"].includes(error.code) ? 403 : ["binary_file", "too_large", "validation_failed"].includes(error.code) ? 422 : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(422).json({ error: "Execution failed and any partial changes were rolled back.", code: "validation_failed" });
}

export default router;