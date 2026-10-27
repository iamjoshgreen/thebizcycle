import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { webhookHandler } from "./routes/billing";
import { loadUser } from "./lib/auth";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);

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
// Stripe needs the raw body for signature checks: mount before express.json().
app.post("/api/stripe/webhook", ...webhookHandler);

app.use(cors({ origin: false }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(loadUser);
app.use("/api", router);

export default app;
