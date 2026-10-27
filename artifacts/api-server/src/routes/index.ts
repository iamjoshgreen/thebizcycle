import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chartRouter from "./chart";
import drawingsRouter from "./drawings";
import housingRouter from "./housing";
import recessionRouter from "./recession";
import cyclicalRouter from "./cyclical";
import gliRouter from "./gli";
import btcQuantileRouter from "./btcQuantile";
import rateShockRouter from "./rateShock";
import settingsRouter from "./settings";
import authRouter from "./auth";
import adminRouter from "./admin";
import billingRouter from "./billing";
import { requireAuth, requireSubscription } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminRouter);
router.use(billingRouter);

// Everything below needs a login, and a subscription when the paywall switch is on.
router.use(requireAuth, requireSubscription);
router.use(chartRouter);
router.use(drawingsRouter);
router.use(housingRouter);
router.use(recessionRouter);
router.use(cyclicalRouter);
router.use(gliRouter);
router.use(btcQuantileRouter);
router.use(rateShockRouter);
router.use(settingsRouter);

export default router;
