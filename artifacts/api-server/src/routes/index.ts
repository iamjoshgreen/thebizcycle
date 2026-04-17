import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chartRouter from "./chart";
import drawingsRouter from "./drawings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chartRouter);
router.use(drawingsRouter);

export default router;
