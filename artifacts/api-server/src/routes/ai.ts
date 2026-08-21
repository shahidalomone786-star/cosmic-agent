import { Router, type IRouter, type Response } from "express";
import {
  SendAiMessageBody,
  SendAiMessageResponse,
  ListAiModelsResponse,
} from "@workspace/api-zod";
import { providerManager } from "../ai/provider-manager";
import { GroqProviderError } from "../ai/groq-provider";
import { retrieveRepositoryContext, type RepositoryContextResult, type RepositoryRef } from "../repository/github-provider";
import { CreateChangeProposalBody, CreateChangeProposalResponse } from "@workspace/api-zod";
import { createChangeProposal, ProposalError } from "../ai/change-proposal";

const router: IRouter = Router();

router.get("/ai/models", (_req, res) => {
  const provider = providerManager.getProvider();
  res.json(ListAiModelsResponse.parse(provider.getModels()));
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
    res.json(CreateChangeProposalResponse.parse(proposal));
  } catch (error) {
    sendProposalError(res, error);
  }
});

router.post("/ai/chat", async (req, res) => {
  const parsed = SendAiMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid AI request." });
    return;
  }

  try {
    const provider = providerManager.getProvider();
    const prepared = await withRepositoryContext(parsed.data);
    const result = await provider.chat(prepared);
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
    const prepared = await withRepositoryContext(parsed.data);
    const result = await provider.stream(prepared, (token) => {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    });
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
  repositoryContextUsed?: { paths: string[]; sources: Array<{ path: string; startLine?: number; endLine?: number }> };
};

async function withRepositoryContext(request: PreparedAiRequest): Promise<PreparedAiRequest> {
  if (!request.repositoryContext) return request;
  const question = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const context = await retrieveRepositoryContext(request.repositoryContext.repository, request.repositoryContext.paths, question).catch((): RepositoryContextResult => ({
    text: [
      "Repository evidence is currently unavailable because the read-only source service could not retrieve the repository.",
      "Do not infer or invent framework, package manager, entry point, authentication, database, or architecture details.",
      "Tell the user that repository evidence is unavailable and ask them to retry later.",
    ].join("\n"),
    sources: [],
  }));
  return {
    ...request,
    repositoryContextUsed: { paths: context.sources.map((source) => source.path), sources: context.sources },
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

export default router;