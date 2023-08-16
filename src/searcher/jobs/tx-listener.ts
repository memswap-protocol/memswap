import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MEMSWAP, WETH2 } from "../../common/addresses";
import { logger } from "../../common/logger";
import { Intent, IntentOrigin } from "../../common/types";
import { config } from "../config";
import { redis } from "../redis";
import * as txSolver from "./tx-solver";

const COMPONENT = "tx-listener";

// Listen to mempool transactions
const wsProvider = new WebSocketProvider(config.wsUrl);
wsProvider.on("pending", (txHash) => addToQueue(txHash));

export const queue = new Queue(COMPONENT, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 5,
    removeOnComplete: 10000,
    removeOnFail: 10000,
  },
});

const worker = new Worker(
  COMPONENT,
  async (job) => {
    const { txHash } = job.data as {
      txHash: string;
    };

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);

      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.data || !tx.from) {
        return;
      }

      // Try to decode any intent appended at the end of the calldata
      let restOfCalldata: string | undefined;
      let intentOrigin: IntentOrigin = "unknown";
      if (tx.data.startsWith("0x095ea7b3")) {
        const iface = new Interface([
          "function approve(address spender, uint256 amount)",
        ]);
        const spender = iface
          .decodeFunctionData("approve", tx.data)
          .spender.toLowerCase();
        if (spender === MEMSWAP) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
          intentOrigin = "approve";
        }
      } else if (
        tx.data.startsWith("0x28026ace") &&
        tx.to?.toLowerCase() === WETH2
      ) {
        const iface = new Interface([
          "function depositAndApprove(address spender, uint256 amount)",
        ]);
        const spender = iface
          .decodeFunctionData("depositAndApprove", tx.data)
          .spender.toLowerCase();
        if (spender === MEMSWAP) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
          intentOrigin = "deposit-and-approve";
        }
      } else {
        restOfCalldata = tx.data;
      }

      let intent: Intent | undefined;
      if (restOfCalldata && restOfCalldata.length > 2) {
        try {
          const result = defaultAbiCoder.decode(
            [
              "address",
              "address",
              "address",
              "address",
              "address",
              "uint32",
              "uint32",
              "uint32",
              "uint128",
              "uint128",
              "uint128",
              "uint128",
              "bytes",
            ],
            restOfCalldata
          );

          intent = {
            maker: result[0].toLowerCase(),
            filler: result[1].toLowerCase(),
            tokenIn: result[2].toLowerCase(),
            tokenOut: result[3].toLowerCase(),
            referrer: result[4].toLowerCase(),
            referrerFeeBps: result[5],
            referrerSurplusBps: result[6],
            deadline: result[7],
            amountIn: result[8].toString(),
            startAmountOut: result[9].toString(),
            expectedAmountOut: result[10].toString(),
            endAmountOut: result[11].toString(),
            signature: result[12].toLowerCase(),
          };
        } catch {
          // Skip errors
        }
      }

      if (intent) {
        await txSolver.addToQueue(txHash, intent, intentOrigin);
      }
    } catch (error) {
      logger.error(COMPONENT, `Job failed: ${error}`);
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 500 }
);
worker.on("error", (error) => {
  logger.error(COMPONENT, JSON.stringify({ data: `Worker errored: ${error}` }));
});

export const addToQueue = async (txHash: string) =>
  queue.add(randomUUID(), { txHash });
