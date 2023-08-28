import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import express from "express";

import { logger } from "../common/logger";
import { config } from "./config";
import * as jobs from "./jobs";

// Log unhandled errors
process.on("unhandledRejection", (error) => {
  logger.error(
    "process",
    JSON.stringify({ data: `Unhandled rejection: ${error}` })
  );
});

// Initialize app
const app = express();

// Initialize BullMQ dashboard
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/bullmq");
createBullBoard({
  queues: [
    new BullMQAdapter(jobs.txListener.queue),
    new BullMQAdapter(jobs.txSolver.queue),
  ],
  serverAdapter: serverAdapter,
});

app.use(express.json());
app.use("/admin/bullmq", serverAdapter.getRouter());

app.get("/lives", (_req, res) => {
  return res.json({ message: "Yes" });
});

app.post("/intents", (req) => {
  jobs.txSolver.addToQueue(req.body.intent, "irrelevant");
});

app.post("/authorizations", (req, res) => {});

// Start app
app.listen(config.port, () => {});
