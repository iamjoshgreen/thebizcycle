import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chartRouter from "./chart";
import drawingsRouter from "./drawings";
import housingRouter from "./housing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chartRouter);
router.use(drawingsRouter);
router.use(housingRouter);

export default router;
