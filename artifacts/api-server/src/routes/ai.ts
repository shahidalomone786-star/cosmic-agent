import { Router, type IRouter, type Response } from "express";
import {
  SendAiMessageBody,
  SendAiMessageResponse,
  ListAiModelsResponse,
} from "@workspace/api-zod";
import { providerManager } from "../ai/provider-manager";
import { GroqProviderError } from "../ai/groq-provider";
import { retrieveRepositoryContext, type RepositoryRef } from "../repository/github-provider";

const router: IRouter = Router();

router.get("/ai/models", (_req, res) => {
  const provider = providerManager.getProvider();
  res.json(ListAiModelsResponse.parse(provider.getModels()));
});

router.post("/ai/chat", async (req, res) => {
  const parsed = SendAiMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid AI request." });
    return;
  }

  try {
    const provider = providerManager.getProvider();
    const result = await provider.chat(await withRepositoryContext(parsed.data));
    res.json(SendAiMessageResponse.parse(result));
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
    const result = await provider.stream(await withRepositoryContext(parsed.data), (token) => {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ done: true, response: result })}\n\n`);
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

async function withRepositoryContext<T extends { messages: Array<{ role: "user" | "assistant" | "system"; content: string }>; repositoryContext?: { repository: RepositoryRef; paths: string[] } }>(request: T): Promise<T> {
  if (!request.repositoryContext) return request;
  const question = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const context = await retrieveRepositoryContext(request.repositoryContext.repository, request.repositoryContext.paths, question).catch(() => "");
  if (!context) return request;
  return { ...request, messages: [...request.messages, { role: "system", content: `Repository: ${request.repositoryContext.repository.owner}/${request.repositoryContext.repository.name}\nBranch: ${request.repositoryContext.repository.branch}\nRelevant read-only source context:\n${context}` }] };
}

function publicProviderError(error: unknown): string {
  if (error instanceof GroqProviderError) return error.message;
  return "The AI provider is temporarily unavailable.";
}

export default router;