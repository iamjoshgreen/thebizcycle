import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chartRouter from "./chart";
import drawingsRouter from "./drawings";
import housingRouter from "./housing";
import recessionRouter from "./recession";
import cyclicalRouter from "./cyclical";
import gliRouter from "./gli";
import btcQuantileRouter from "./btcQuantile";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chartRouter);
router.use(drawingsRouter);
router.use(housingRouter);
router.use(recessionRouter);
router.use(cyclicalRouter);
router.use(gliRouter);
router.use(btcQuantileRouter);
router.use(settingsRouter);

export default router;
