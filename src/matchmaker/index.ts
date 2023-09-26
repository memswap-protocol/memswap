import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import axios from "axios";
import express from "express";
import cors from "cors";

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
    new BullMQAdapter(jobs.submissionERC20.queue),
    new BullMQAdapter(jobs.submissionERC721.queue),
  ],
  serverAdapter: serverAdapter,
});

app.use(cors());
app.use(express.json());
app.use("/admin/bullmq", serverAdapter.getRouter());

// Common

app.get("/lives", (_, res) => {
  return res.json({ message: "yes" });
});

// ERC20

app.post("/erc20/intents/private", async (req, res) => {
  let { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC20;
  };

  if (approvalTxOrTxHash && !approvalTxOrTxHash.startsWith("0x")) {
    approvalTxOrTxHash = "0x" + approvalTxOrTxHash;
  }

  if (!config.knownSolversERC20.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Forward to a single solver
  const [solver] = config.knownSolversERC20.slice(0, 1);
  await axios.post(`${solver.split(" ")[0]}/erc20/intents`, {
    intent,
    approvalTxOrTxHash,
  });

  return res.json({ message: "Success" });
});

app.post("/erc20/intents/public", async (req, res) => {
  const { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC20;
  };

  if (!config.knownSolversERC20.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Forward to all solvers
  await Promise.all(
    config.knownSolversERC20.map(async (solver) =>
      axios.post(`${solver.split(" ")[0]}/erc20/intents`, {
        intent,
        approvalTxOrTxHash,
      })
    )
  );

  // TODO: Relay via bloxroute

  return res.json({ message: "Success" });
});

app.post("/erc20/solutions", async (req, res) => {
  const { intent, txs } = req.body as {
    intent: IntentERC20;
    txs: string[];
  };

  if (!intent || !txs?.length) {
    return res.status(400).json({ message: "Invalid parameters" });
  }

  const result = await solutions.erc20.process(intent, txs);
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
  let { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC721;
  };

  if (approvalTxOrTxHash && !approvalTxOrTxHash.startsWith("0x")) {
    approvalTxOrTxHash = "0x" + approvalTxOrTxHash;
  }

  if (!config.knownSolversERC721.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Forward to a single solver
  const [solver] = config.knownSolversERC721.slice(0, 1);
  await axios.post(`${solver.split(" ")[0]}/erc721/intents`, {
    intent,
    approvalTxOrTxHash,
  });

  return res.json({ message: "Success" });
});

app.post("/erc721/intents/public", async (req, res) => {
  const { approvalTxOrTxHash, intent } = req.body as {
    approvalTxOrTxHash?: string;
    intent: IntentERC721;
  };

  if (!config.knownSolversERC721.length) {
    return res.status(400).json({ error: "No known solvers" });
  }

  // Forward to all solvers
  await Promise.all(
    config.knownSolversERC721.map(async (solver) =>
      axios.post(`${solver.split(" ")[0]}/erc721/intents`, {
        intent,
        approvalTxOrTxHash,
      })
    )
  );

  // TODO: Relay via bloxroute

  return res.json({ message: "Success" });
});

app.post("/erc721/solutions", async (req, res) => {
  const { intent, txs } = req.body as {
    intent: IntentERC721;
    txs: string[];
  };

  if (!intent || !txs?.length) {
    return res.status(400).json({ message: "Invalid parameters" });
  }

  const result = await solutions.erc721.process(intent, txs);
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
