import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { JsonRpcProvider } from "@ethersproject/providers";
import * as Sdk from "@reservoir0x/sdk";
import cors from "cors";
import express from "express";

import { logger } from "../common/logger";
import { IntentERC20, IntentERC721 } from "../common/types";
import { config } from "./config";
import * as jobs from "./jobs";
import { redis } from "./redis";

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
    new BullMQAdapter(jobs.inventoryManager.queue),
    new BullMQAdapter(jobs.seaportSolver.queue),
    new BullMQAdapter(jobs.txListener.queue),
    new BullMQAdapter(jobs.txSolverERC20.queue),
    new BullMQAdapter(jobs.txSolverERC721.queue),
  ],
  serverAdapter: serverAdapter,
});

app.use(cors());
app.use(express.json());
app.use("/admin/bullmq", serverAdapter.getRouter());

// Common

app.get("/lives", (_req, res) => {
  return res.json({ message: "Yes" });
});

app.post("/tx-listener", async (req, res) => {
  const txHash = req.body.txHash as string;

  const provider = new JsonRpcProvider(config.jsonUrl);
  const tx = await provider.getTransaction(txHash);

  await jobs.txListener.addToQueue({
    to: tx.to ?? null,
    input: tx.data,
    hash: txHash,
  });

  return res.json({ message: "Success" });
});

app.post("/inventory-manager", async (req, res) => {
  const address = req.body.address as string;

  await jobs.inventoryManager.addToQueue(address, true);

  return res.json({ message: "Success" });
});

// ERC20

app.post("/erc20/intents", async (req, res) => {
  const intent = req.body.intent as IntentERC20;
  const approvalTxOrTxHash = req.body.approvalTxOrTxHash as string | undefined;

  await jobs.txSolverERC20.addToQueue(intent, { approvalTxOrTxHash });

  return res.json({ message: "Success" });
});

// ERC721

app.post("/erc721/intents", async (req, res) => {
  const intent = req.body.intent as IntentERC721;
  const approvalTxOrTxHash = req.body.approvalTxOrTxHash as string | undefined;

  await jobs.txSolverERC721.addToQueue(intent, { approvalTxOrTxHash });

  return res.json({ message: "Success" });
});

app.post("/erc721/seaport", async (req, res) => {
  const order = req.body.order as Sdk.SeaportBase.Types.OrderComponents;

  await jobs.seaportSolver.addToQueue(order);

  return res.json({ message: "Success" });
});

app.get("/erc721/seaport/status", async (req, res) => {
  const hash = req.query.hash as string;

  const status = await redis.get(`status:${hash}`);
  if (!status) {
    return res.json({ status: "unknown" });
  } else {
    return res.json(JSON.parse(status));
  }
});

// Start app
app.listen(config.port, () => {});
