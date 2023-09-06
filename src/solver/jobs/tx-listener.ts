import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { verifyTypedData } from "@ethersproject/wallet";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MEMSWAP, WETH2 } from "../../common/addresses";
import { logger } from "../../common/logger";
import { Intent } from "../../common/types";
import { getEIP712Domain, getEIP712TypesForIntent } from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import * as txSolver from "./tx-solver";

const COMPONENT = "tx-listener";

// Listen to mempool transactions
const wsProvider = new WebSocketProvider(config.wsUrl);
if (!process.env.DEBUG_MODE) {
  wsProvider.on("pending", (txHash) => addToQueue(txHash));
}

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
        "uint8",
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint16",
        "uint16",
        "uint32",
        "uint32",
        "uint256",
        "bool",
        "uint128",
        "uint128",
        "uint16",
        "uint16",
        "bool",
        "bytes",
      ];

      // Try to decode any intent appended at the end of the calldata
      let restOfCalldata: string | undefined;
      let approvalTxOrTxHash: string | undefined;
      if (tx.data.startsWith("0x095ea7b3")) {
        const iface = new Interface([
          "function approve(address spender, uint256 amount)",
        ]);

        const spender = iface
          .decodeFunctionData("approve", tx.data)
          .spender.toLowerCase();
        if (spender === MEMSWAP[config.chainId]) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
          approvalTxOrTxHash = txHash;
        }
      } else if (
        tx.data.startsWith("0x28026ace") &&
        tx.to?.toLowerCase() === WETH2[config.chainId]
      ) {
        const iface = new Interface([
          "function depositAndApprove(address spender, uint256 amount)",
        ]);

        const spender = iface
          .decodeFunctionData("depositAndApprove", tx.data)
          .spender.toLowerCase();
        if (spender === MEMSWAP[config.chainId]) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
          approvalTxOrTxHash = txHash;
        }
      } else if (
        tx.data.startsWith("0x4adb41f5") &&
        tx.to?.toLowerCase() === MEMSWAP[config.chainId]
      ) {
        const iface = new Interface([
          `function post(
            (
              uint8 side,
              address tokenIn,
              address tokenOut,
              address maker,
              address matchmaker,
              address source,
              uint32 feeBps,
              uint32 surplusBps,
              uint32 startTime,
              uint32 endTime,
              uint256 nonce,
              bool isPartiallyFillable,
              uint128 amount,
              uint128 endAmount,
              uint16 startAmountBps,
              uint16 expectedAmountBps,
              bool hasDynamicSignature,
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
            side: result[0],
            tokenIn: result[1].toLowerCase(),
            tokenOut: result[2].toLowerCase(),
            maker: result[3].toLowerCase(),
            matchmaker: result[4].toLowerCase(),
            source: result[5].toLowerCase(),
            feeBps: result[6],
            surplusBps: result[7],
            startTime: result[8],
            endTime: result[9],
            nonce: result[10].toString(),
            isPartiallyFillable: result[11],
            amount: result[12].toString(),
            endAmount: result[13].toString(),
            startAmountBps: result[14],
            expectedAmountBps: result[15],
            hasDynamicSignature: result[16],
            signature: result[17].toLowerCase(),
          };
        } catch (error) {
          console.log(error);
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
            JSON.stringify({
              msg: "Invalid intent signature in transaction",
              txHash,
            })
          );
          return;
        }

        await txSolver.addToQueue(intent, {
          approvalTxOrTxHash,
        });
      }
    } catch (error: any) {
      logger.error(
        COMPONENT,
        JSON.stringify({ msg: "Job failed", error, stack: error.stack })
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 500 }
);
worker.on("error", (error) => {
  logger.error(COMPONENT, JSON.stringify({ msg: "Worker errored", error }));
});

export const addToQueue = async (txHash: string) =>
  queue.add(randomUUID(), { txHash });
