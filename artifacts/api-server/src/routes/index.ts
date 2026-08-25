import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import repositoryRouter from "./repository";
import authRouter from "./auth";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(repositoryRouter);
router.use(authRouter);
router.use(settingsRouter);

export default router;
