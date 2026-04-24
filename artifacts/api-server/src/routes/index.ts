import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chartRouter from "./chart";
import drawingsRouter from "./drawings";
import housingRouter from "./housing";
import recessionRouter from "./recession";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chartRouter);
router.use(drawingsRouter);
router.use(housingRouter);
router.use(recessionRouter);

export default router;
