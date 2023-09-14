import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { JsonRpcProvider } from "@ethersproject/providers";
import { verifyTypedData } from "@ethersproject/wallet";
// import { Alchemy, AlchemySubscription, Network } from "alchemy-sdk";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";
import Websocket from "ws";

import { MEMSWAP_ERC20, MEMSWAP_ERC721, MEMETH } from "../../common/addresses";
import { logger } from "../../common/logger";
import { IntentERC20, IntentERC721, Protocol } from "../../common/types";
import {
  getEIP712Domain,
  getEIP712TypesForIntent,
  isERC721Intent,
} from "../../common/utils";
import { config } from "../config";
import * as jobs from "../jobs";
import { redis } from "../redis";

const COMPONENT = "tx-listener";

type AlchemyPendingTx = {
  hash: string;
  input: string;
  to: string | null;
};

if (!process.env.DEBUG_MODE) {
  // Listen to pending transactions

  // Via Alchemy
  // const alchemyWs = new Alchemy({
  //   apiKey: config.alchemyApiKey,
  //   network: config.chainId ? Network.ETH_MAINNET : Network.ETH_GOERLI,
  // }).ws;
  // alchemyWs.on(
  //   {
  //     method: AlchemySubscription.PENDING_TRANSACTIONS,
  //   },
  //   (tx: AlchemyPendingTx) => addToQueue(tx)
  // );

  // Via Bloxroute
  if (config.bloxrouteAuth) {
    const bloxrouteWs = new Websocket("wss://api.blxrbdn.com/ws", {
      headers: {
        Authorization: config.bloxrouteAuth,
      },
    });
    bloxrouteWs.on("open", () => {
      bloxrouteWs.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "subscribe",
          params: [
            "pendingTxs",
            {
              include: ["tx_hash", "tx_contents.input", "tx_contents.to"],
            },
          ],
        })
      );
    });
    bloxrouteWs.on("message", async (msg) => {
      const parsedMsg = JSON.parse(msg.toString());

      if (parsedMsg.params?.result) {
        const data = parsedMsg.params.result;
        await addToQueue({
          hash: data.txHash,
          to: data.txContents.to,
          input: data.txContents.input,
        });
      }
    });
  }

  // Listen to included transactions

  const provider = new JsonRpcProvider(config.jsonUrl);
  provider.on("block", async (block: number) => {
    const blockWithTxs = await provider.getBlockWithTransactions(block);
    await Promise.all(
      blockWithTxs.transactions.map((tx) =>
        addToQueue({
          to: tx.to ?? null,
          input: tx.data,
          hash: tx.hash,
        })
      )
    );
  });
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
    const tx = job.data as AlchemyPendingTx;

    try {
      const intentTypesERC20 = [
        "bool",
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint16",
        "uint16",
        "uint32",
        "uint32",
        "bool",
        "bool",
        "uint128",
        "uint128",
        "uint16",
        "uint16",
        "bytes",
      ];
      const intentTypesERC721 = [
        "bool",
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint16",
        "uint16",
        "uint32",
        "uint32",
        "bool",
        "bool",
        "bool",
        "uint256",
        "uint128",
        "uint128",
        "uint16",
        "uint16",
        "bytes",
      ];

      // TODO: Add support for ERC721 `post`

      // Try to decode any intent appended at the end of the calldata
      let restOfCalldata: string | undefined;
      let approvalTxOrTxHash: string | undefined;
      if (tx.input.startsWith("0x095ea7b3")) {
        const iface = new Interface([
          "function approve(address spender, uint256 amount)",
        ]);

        const spender = iface
          .decodeFunctionData("approve", tx.input)
          .spender.toLowerCase();
        if (
          [
            MEMSWAP_ERC20[config.chainId],
            MEMSWAP_ERC721[config.chainId],
          ].includes(spender)
        ) {
          restOfCalldata = "0x" + tx.input.slice(2 + 2 * (4 + 32 + 32));
          approvalTxOrTxHash = tx.hash;
        }
      } else if (
        tx.input.startsWith("0x28026ace") &&
        tx.to?.toLowerCase() === MEMETH[config.chainId]
      ) {
        const iface = new Interface([
          "function depositAndApprove(address spender, uint256 amount)",
        ]);

        const spender = iface
          .decodeFunctionData("depositAndApprove", tx.input)
          .spender.toLowerCase();
        if (
          [
            MEMSWAP_ERC20[config.chainId],
            MEMSWAP_ERC721[config.chainId],
          ].includes(spender)
        ) {
          restOfCalldata = "0x" + tx.input.slice(2 + 2 * (4 + 32 + 32));
          approvalTxOrTxHash = tx.hash;
        }
      } else if (
        tx.input.startsWith("0x4cd6d7bf") &&
        tx.to?.toLowerCase() === MEMSWAP_ERC20[config.chainId]
      ) {
        const iface = new Interface([
          `function post(
            (
              bool isBuy,
              address buyToken,
              address sellToken,
              address maker,
              address solver,
              address source,
              uint16 feeBps,
              uint16 surplusBps,
              uint32 startTime,
              uint32 endTime,
              bool isPartiallyFillable,
              bool isSmartOrder,
              uint128 amount,
              uint128 endAmount,
              uint16 startAmountBps,
              uint16 expectedAmountBps,
              bytes signature
            )[] intents
          )`,
        ]);

        const result = iface.decodeFunctionData("post", tx.input);
        // TODO: Add support for multiple intents
        restOfCalldata = defaultAbiCoder.encode(
          intentTypesERC20,
          result.intents[0]
        );
      } else if (
        // TODO: Fix 4byte value
        tx.input.startsWith("0x4adb41f5") &&
        tx.to?.toLowerCase() === MEMSWAP_ERC721[config.chainId]
      ) {
        const iface = new Interface([
          `function post(
              (
                bool isBuy,
                address buyToken,
                address sellToken,
                address maker,
                address solver,
                address source,
                uint16 feeBps,
                uint16 surplusBps,
                uint32 startTime,
                uint32 endTime,
                bool isPartiallyFillable,
                bool isSmartOrder,
                bool isCriteriaOrder,
                uint256 tokenIdOrCriteria,
                uint128 amount,
                uint128 endAmount,
                uint16 startAmountBps,
                uint16 expectedAmountBps,
                bytes signature
              )[] intents
            )`,
        ]);

        const result = iface.decodeFunctionData("post", tx.input);
        // TODO: Add support for multiple intents
        restOfCalldata = defaultAbiCoder.encode(
          intentTypesERC721,
          result.intents[0]
        );
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
            solver: result[4].toLowerCase(),
            source: result[5].toLowerCase(),
            feeBps: result[6],
            surplusBps: result[7],
            startTime: result[8],
            endTime: result[9],
            nonce: "0",
            isPartiallyFillable: result[10],
            isSmartOrder: result[11],
            amount: result[12].toString(),
            endAmount: result[13].toString(),
            startAmountBps: result[14],
            expectedAmountBps: result[15],
            signature: result[16].toLowerCase(),
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
            solver: result[4].toLowerCase(),
            source: result[5].toLowerCase(),
            feeBps: result[6],
            surplusBps: result[7],
            startTime: result[8],
            endTime: result[9],
            nonce: "0",
            isPartiallyFillable: result[10],
            isSmartOrder: result[11],
            isCriteriaOrder: result[12],
            tokenIdOrCriteria: result[13].toString(),
            amount: result[14].toString(),
            endAmount: result[15].toString(),
            startAmountBps: result[16],
            expectedAmountBps: result[17],
            signature: result[18].toLowerCase(),
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
              txHash: tx.hash,
              intent,
            })
          );
          return;
        }

        if (isERC721Intent(intent)) {
          await jobs.txSolverERC721.addToQueue(intent as IntentERC721, {
            approvalTxOrTxHash,
          });
        } else {
          await jobs.txSolverERC20.addToQueue(intent as IntentERC20, {
            approvalTxOrTxHash,
          });
        }
      }
    } catch (error: any) {
      logger.error(
        COMPONENT,
        JSON.stringify({ msg: "Job failed", error, stack: error.stack })
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 2000 }
);
worker.on("error", (error) => {
  logger.error(COMPONENT, JSON.stringify({ msg: "Worker errored", error }));
});

export const addToQueue = async (tx: AlchemyPendingTx) =>
  queue.add(randomUUID(), tx);
