import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import cookieParser from "cookie-parser";
import { authMiddleware } from "./middlewares/auth-middleware";
import { enforceUserRateLimit, UserRateLimitError } from "./ruflo/phase13-governance";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);
app.use((req, res, next) => {
  if (!req.authUser || req.path.startsWith("/health") || req.path.startsWith("/auth/")) {
    next();
    return;
  }
  try {
    enforceUserRateLimit(req.authUser.id, "api");
    next();
  } catch (error) {
    if (error instanceof UserRateLimitError) {
      res.status(429).setHeader("Retry-After", error.retryAfterSeconds).json({ error: error.message, code: "rate_limited" });
      return;
    }
    next(error);
  }
});

app.use("/api", router);

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  const typedError = error as { status?: number; type?: string };
  if (typedError.type === "entity.too.large" && req.path.startsWith("/api/workspace/")) {
    res.status(413).json({ error: "File too large.", code: "payload_too_large" });
    return;
  }
  next(error);
});

export default app;
