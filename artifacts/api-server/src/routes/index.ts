import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import repositoryRouter from "./repository";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(repositoryRouter);

export default router;
