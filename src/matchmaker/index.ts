import { createBullBoard } from "@bull-board/api";
import { ExpressAdapter } from "@bull-board/express";
import express from "express";

import { logger } from "../common/logger";
import { Intent } from "../common/types";
import { config } from "./config";
import { handle } from "./solutions";

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
  queues: [],
  serverAdapter: serverAdapter,
});

app.use(express.json());
app.use("/admin/bullmq", serverAdapter.getRouter());

app.get("/lives", (_, res) => {
  return res.json({ message: "yes" });
});

app.post("/fills", async (req, res) => {
  const { intent, txs } = req.body as {
    intent: Intent;
    txs: string[];
  };

  if (!txs?.length) {
    return res.status(400).json({ message: "Invalid params" });
  }

  const result = await handle(intent, txs);
  if (result.status === "error") {
    return res.status(400).json({ error: result.error });
  } else if (result.status === "success") {
    return res.status(200).json({
      recheckIn: result.recheckIn,
      auth: result.auth,
    });
  }

  return res.json({ message: "success" });
});

// Start app
app.listen(config.port, () => {});
