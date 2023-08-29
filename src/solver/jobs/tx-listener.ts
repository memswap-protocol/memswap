import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { verifyTypedData } from "@ethersproject/wallet";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MEMSWAP, MEMSWAP_WETH } from "../../common/addresses";
import { logger } from "../../common/logger";
import { Intent } from "../../common/types";
import { getEIP712Domain, getEIP712TypesForIntent } from "../../common/utils";
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

      const intentTypes = [
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint16",
        "uint16",
        "uint32",
        "bool",
        "uint128",
        "uint128",
        "uint16",
        "uint16",
        "bytes",
      ];

      // Try to decode any intent appended at the end of the calldata
      let restOfCalldata: string | undefined;
      let approvalTxHash: string | undefined;
      if (tx.data.startsWith("0x095ea7b3")) {
        const iface = new Interface([
          "function approve(address spender, uint256 amount)",
        ]);

        const spender = iface
          .decodeFunctionData("approve", tx.data)
          .spender.toLowerCase();
        if (spender === MEMSWAP[config.chainId]) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
          approvalTxHash = txHash;
        }
      } else if (
        tx.data.startsWith("0x28026ace") &&
        tx.to?.toLowerCase() === MEMSWAP_WETH[config.chainId]
      ) {
        const iface = new Interface([
          "function depositAndApprove(address spender, uint256 amount)",
        ]);

        const spender = iface
          .decodeFunctionData("depositAndApprove", tx.data)
          .spender.toLowerCase();
        if (spender === MEMSWAP[config.chainId]) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
          approvalTxHash = txHash;
        }
      } else if (
        tx.data.startsWith("0x4adb41f5") &&
        tx.to?.toLowerCase() === MEMSWAP[config.chainId]
      ) {
        const iface = new Interface([
          `function post(
            (
              address tokenIn,
              address tokenOut,
              address maker,
              address filler,
              address referrer,
              uint32 referrerFeeBps,
              uint32 referrerSurplusBps,
              uint32 deadline,
              bool isPartiallyFillable,
              uint128 amountIn,
              uint128 startAmountOut,
              uint128 expectedAmountOut,
              uint128 endAmountOut,
              bytes signature
            ) intent
          )`,
        ]);

        const result = iface.decodeFunctionData("post", tx.data);
        restOfCalldata = defaultAbiCoder.encode(intentTypes, result.intent);
      } else {
        restOfCalldata = tx.data;
      }

      let intent: Intent | undefined;
      if (restOfCalldata && restOfCalldata.length > 2) {
        try {
          const result = defaultAbiCoder.decode(intentTypes, restOfCalldata);

          intent = {
            tokenIn: result[0].toLowerCase(),
            tokenOut: result[1].toLowerCase(),
            maker: result[2].toLowerCase(),
            matchmaker: result[3].toLowerCase(),
            source: result[4].toLowerCase(),
            feeBps: result[5],
            surplusBps: result[6],
            deadline: result[7],
            isPartiallyFillable: result[8],
            amountIn: result[9].toString(),
            endAmountOut: result[10].toString(),
            startAmountBps: result[11],
            expectedAmountBps: result[12],
            signature: result[13].toLowerCase(),
          };
        } catch {
          // Skip errors
        }
      }

      if (intent) {
        // Check the signature first
        const signer = verifyTypedData(
          getEIP712Domain(config.chainId),
          getEIP712TypesForIntent(),
          intent,
          intent.signature
        );
        if (signer.toLowerCase() !== intent.maker) {
          logger.info(
            COMPONENT,
            `Invalid intent signature in transaction ${txHash}`
          );
          return;
        }

        await txSolver.addToQueue(intent, {
          approvalTxOrTxHash: approvalTxHash,
        });
      }
    } catch (error: any) {
      logger.error(COMPONENT, `Job failed: ${error} (${error.stack})`);
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