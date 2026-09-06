import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import cookieParser from "cookie-parser";
import { authMiddleware } from "./middlewares/auth-middleware";

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
