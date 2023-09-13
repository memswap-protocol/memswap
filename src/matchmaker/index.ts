import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import express from "express";

import { logger } from "../common/logger";
import { IntentERC20, IntentERC721 } from "../common/types";
import { config } from "./config";
import * as jobs from "./jobs";
import * as solutions from "./solutions";

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
    new BullMQAdapter(jobs.signatureReleaseERC20.queue),
    new BullMQAdapter(jobs.signatureReleaseERC721.queue),
  ],
  serverAdapter: serverAdapter,
});

app.use(express.json());
app.use("/admin/bullmq", serverAdapter.getRouter());

// Common

app.get("/lives", (_, res) => {
  return res.json({ message: "yes" });
});

// ERC20

app.post("/erc20/intents/private", async (req, res) => {
  const { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC20;
  };

  if (!config.knownSolvers.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Send to a single solver
  await jobs.signatureReleaseERC20.submitDirectlyToSolver(
    config.knownSolvers.slice(0, 1).map((s) => {
      const [address, baseUrl] = s.split(" ");
      return { address, baseUrl };
    }),
    intent,
    approvalTxOrTxHash
  );

  return res.json({ message: "Success" });
});

app.post("/erc20/intents/public", async (req, res) => {
  const { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC20;
  };

  if (!config.knownSolvers.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Send to all solvers
  await jobs.signatureReleaseERC20.submitDirectlyToSolver(
    config.knownSolvers.map((s) => {
      const [address, baseUrl] = s.split(" ");
      return { address, baseUrl };
    }),
    intent,
    approvalTxOrTxHash
  );

  // TODO: Relay via bloxroute

  return res.json({ message: "Success" });
});

app.post("/erc20/solutions", async (req, res) => {
  const { uuid, baseUrl, intent, txs } = req.body as {
    uuid: string;
    baseUrl: string;
    intent: IntentERC20;
    txs: string[];
  };

  if (!uuid || !baseUrl || !intent || !txs?.length) {
    return res.status(400).json({ message: "Invalid parameters" });
  }

  const result = await solutions.erc20.process(uuid, baseUrl, intent, txs);
  if (result.status === "error") {
    return res.status(400).json({ error: result.error });
  } else if (result.status === "success") {
    return res.status(200).json({
      message: "Success",
    });
  }

  return res.json({ message: "success" });
});

// ERC721

app.post("/erc721/intents/private", async (req, res) => {
  const { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC721;
  };

  if (!config.knownSolvers.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Send to a single solver
  await jobs.signatureReleaseERC721.submitDirectlyToSolver(
    config.knownSolvers.slice(0, 1).map((s) => {
      const [address, baseUrl] = s.split(" ");
      return { address, baseUrl };
    }),
    intent,
    approvalTxOrTxHash
  );

  return res.json({ message: "Success" });
});

app.post("/erc721/intents/public", async (req, res) => {
  const { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC721;
  };

  if (!config.knownSolvers.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Send to all solvers
  await jobs.signatureReleaseERC721.submitDirectlyToSolver(
    config.knownSolvers.map((s) => {
      const [address, baseUrl] = s.split(" ");
      return { address, baseUrl };
    }),
    intent,
    approvalTxOrTxHash
  );

  // TODO: Relay via bloxroute

  return res.json({ message: "Success" });
});

app.post("/erc721/solutions", async (req, res) => {
  const { uuid, baseUrl, intent, txs } = req.body as {
    uuid: string;
    baseUrl: string;
    intent: IntentERC721;
    txs: string[];
  };

  if (!uuid || !baseUrl || !intent || !txs?.length) {
    return res.status(400).json({ message: "Invalid parameters" });
  }

  const result = await solutions.erc721.process(uuid, baseUrl, intent, txs);
  if (result.status === "error") {
    return res.status(400).json({ error: result.error });
  } else if (result.status === "success") {
    return res.status(200).json({
      message: "Success",
    });
  }

  return res.json({ message: "success" });
});

// Start app
app.listen(config.port, () => {});
