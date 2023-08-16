import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import express from "express";

import { logger } from "../common/logger";
import { config } from "./config";
import * as jobs from "./jobs";
import { IntentFill } from "./types";

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
    new BullMQAdapter(jobs.txBatcher.queue),
    new BullMQAdapter(jobs.txHandler.queue),
  ],
  serverAdapter: serverAdapter,
});

app.use(express.json());
app.use("/admin/bullmq", serverAdapter.getRouter());

app.get("/lives", (_, res) => {
  return res.json({ message: "yes" });
});

app.post("/fills", async (req, res) => {
  const { preTxs, fill } = req.body as {
    preTxs: string[];
    fill: IntentFill;
  };

  if (!preTxs || !fill) {
    return res.status(400).json({ message: "Invalid params" });
  }

  await jobs.txHandler.addToQueue(preTxs, fill);

  return res.json({ message: "success" });
});

// Start app
app.listen(config.port, () => {});
