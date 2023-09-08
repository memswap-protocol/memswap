import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { verifyTypedData } from "@ethersproject/wallet";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MEMSWAP_ERC20, MEMSWAP_ERC721, WETH2 } from "../../common/addresses";
import { logger } from "../../common/logger";
import { IntentERC20, IntentERC721, Protocol } from "../../common/types";
import {
  getEIP712Domain,
  getEIP712TypesForIntent,
  isERC721Intent,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import * as txSolver from "./tx-solver-erc20";

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

      const intentTypesERC20 = [
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
      const intentTypesERC721 = [
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
        "bool",
        "uint256",
        "uint128",
        "uint128",
        "uint16",
        "uint16",
        "bool",
        "bytes",
      ];

      // TODO: Add support for ERC721 `post`

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
        if (
          [
            MEMSWAP_ERC20[config.chainId],
            MEMSWAP_ERC721[config.chainId],
          ].includes(spender)
        ) {
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
        if (
          [
            MEMSWAP_ERC20[config.chainId],
            MEMSWAP_ERC721[config.chainId],
          ].includes(spender)
        ) {
          restOfCalldata = "0x" + tx.data.slice(2 + 2 * (4 + 32 + 32));
          approvalTxOrTxHash = txHash;
        }
      } else if (
        tx.data.startsWith("0x4adb41f5") &&
        tx.to?.toLowerCase() === MEMSWAP_ERC20[config.chainId]
      ) {
        const iface = new Interface([
          `function post(
            (
              bool isBuy,
              address buyToken,
              address sellToken,
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
            )[] intents
          )`,
        ]);

        const result = iface.decodeFunctionData("post", tx.data);
        // TODO: Add support for multiple intents
        restOfCalldata = defaultAbiCoder.encode(
          intentTypesERC20,
          result.intents[0]
        );
      } else if (
        tx.data.startsWith("0x4adb41f5") &&
        tx.to?.toLowerCase() === MEMSWAP_ERC721[config.chainId]
      ) {
        const iface = new Interface([
          `function post(
              (
                bool isBuy,
                address buyToken,
                address sellToken,
                address maker,
                address matchmaker,
                address source,
                uint32 feeBps,
                uint32 surplusBps,
                uint32 startTime,
                uint32 endTime,
                uint256 nonce,
                bool isPartiallyFillable,
                bool hasCriteria,
                uint256 tokenIdOrCriteria,
                uint128 amount,
                uint128 endAmount,
                uint16 startAmountBps,
                uint16 expectedAmountBps,
                bool hasDynamicSignature,
                bytes signature
              )[] intents
            )`,
        ]);

        const result = iface.decodeFunctionData("post", tx.data);
        // TODO: Add support for multiple intents
        restOfCalldata = defaultAbiCoder.encode(
          intentTypesERC721,
          result.intents[0]
        );
      } else {
        restOfCalldata = tx.data;
      }

      let intent: IntentERC20 | IntentERC721 | undefined;
      if (restOfCalldata && restOfCalldata.length > 2) {
        // ERC20
        try {
          const result = defaultAbiCoder.decode(
            intentTypesERC20,
            restOfCalldata
          );

          intent = {
            isBuy: result[0],
            buyToken: result[1].toLowerCase(),
            sellToken: result[2].toLowerCase(),
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
          } as IntentERC20;
        } catch {
          // Skip errors
        }

        // ERC721
        try {
          const result = defaultAbiCoder.decode(
            intentTypesERC721,
            restOfCalldata
          );

          intent = {
            isBuy: result[0],
            buyToken: result[1].toLowerCase(),
            sellToken: result[2].toLowerCase(),
            maker: result[3].toLowerCase(),
            matchmaker: result[4].toLowerCase(),
            source: result[5].toLowerCase(),
            feeBps: result[6],
            surplusBps: result[7],
            startTime: result[8],
            endTime: result[9],
            nonce: result[10].toString(),
            isPartiallyFillable: result[11],
            hasCriteria: result[12],
            tokenIdOrCriteria: result[13].toLowerCase(),
            amount: result[14].toString(),
            endAmount: result[15].toString(),
            startAmountBps: result[16],
            expectedAmountBps: result[17],
            hasDynamicSignature: result[18],
            signature: result[19].toLowerCase(),
          } as IntentERC721;
        } catch {
          // Skip errors
        }
      }

      if (intent) {
        const protocol = isERC721Intent(intent)
          ? Protocol.ERC721
          : Protocol.ERC20;

        // Check the signature first
        const signer = verifyTypedData(
          getEIP712Domain(config.chainId, protocol),
          getEIP712TypesForIntent(protocol),
          intent,
          intent.signature
        );
        if (signer.toLowerCase() !== intent.maker) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Invalid intent signature in transaction",
              txHash,
              intent,
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
