import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import express from "express";

import { logger } from "../common/logger";
import { Authorization, Intent } from "../common/types";
import { config } from "./config";
import * as jobs from "./jobs";
import { redis } from "./redis";
import { CachedSolution } from "./types";

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

app.post("/intents", async (req, res) => {
  const intent = req.body.intent as Intent;
  await jobs.txSolver.addToQueue(intent);

  return res.json({ message: "Success" });
});

app.post("/authorizations", async (req, res) => {
  const uuid = req.body.uuid as string;
  const authorization = req.body.authorization as Authorization;

  const cachedSolution: CachedSolution | undefined = await redis
    .get(uuid)
    .then((r) => (r ? JSON.parse(r) : undefined));
  if (!cachedSolution) {
    return res.status(400).json({ error: "Could not find request" });
  }

  await jobs.txSolver.addToQueue(cachedSolution.intent, {
    approvalTxHash: cachedSolution.approvalTxHash,
    existingSolution: cachedSolution.solution,
    authorization,
  });

  // TODO: Respond with signed transaction instead
  return res.json({ message: "Success" });
});

// Start app
app.listen(config.port, () => {});
