import { Interface } from "@ethersproject/abi";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MEMSWAP_ERC721 } from "../../common/addresses";
import { logger } from "../../common/logger";
import { getFlashbotsProvider, relayViaBloxroute } from "../../common/tx";
import {
  MATCHMAKER_AUTHORIZATION_GAS,
  getIntentHash,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import { Solution } from "../types";

const COMPONENT = "submission-erc721";

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
    const { solutionKey } = job.data as {
      solutionKey: string;
    };

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);
      const flashbotsProvider = await getFlashbotsProvider();

      const matchmaker = new Wallet(config.matchmakerPk);

      const components = solutionKey.split(":");
      const targetBlock = Number(components[components.length - 1]);
      const latestBlock = await provider
        .getBlock("latest")
        .then((b) => b.number);
      if (latestBlock >= targetBlock) {
        throw new Error("Deadline block already passed");
      }

      // Fetch the top solution
      const [solution] = await redis
        .zrange(solutionKey, 0, 0, "REV")
        .then((solutions) => solutions.map((s) => JSON.parse(s) as Solution));

      const maxPriorityFeePerGas = parseUnits("1", "gwei");

      // Just in case, set to 30% more than the pending block's base fee
      const estimatedBaseFee = await provider
        .getBlock("pending")
        .then((b) =>
          b!.baseFeePerGas!.add(b!.baseFeePerGas!.mul(3000).div(10000))
        );

      const authorizationTx = await matchmaker.signTransaction({
        to: MEMSWAP_ERC721[config.chainId],
        data: new Interface([
          `
            function authorize(
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
                bool isIncentivized,
                bool isCriteriaOrder,
                uint256 tokenIdOrCriteria,
                uint128 amount,
                uint128 endAmount,
                uint16 startAmountBps,
                uint16 expectedAmountBps,
                bytes signature
              )[] intents,
              (
                uint128 fillAmountToCheck,
                uint128 executeAmountToCheck,
                uint32 blockDeadline
              )[] auths,
              address solver
            )
          `,
        ]).encodeFunctionData("authorize", [
          [solution.intent],
          [
            {
              fillAmountToCheck: solution.fillAmountToCheck,
              executeAmountToCheck: solution.executeAmountToCheck,
              blockDeadline: targetBlock,
            },
          ],
          solution.solver,
        ]),
        value: 0,
        type: 2,
        nonce: await provider.getTransactionCount(matchmaker.address),
        chainId: config.chainId,
        gasLimit: MATCHMAKER_AUTHORIZATION_GAS,
        maxFeePerGas: estimatedBaseFee.add(maxPriorityFeePerGas).toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      });

      await relayViaBloxroute(
        getIntentHash(solution.intent),
        provider,
        flashbotsProvider,
        [authorizationTx, ...solution.txs].map((tx) => ({
          signedTransaction: tx,
        })),
        [],
        targetBlock,
        COMPONENT
      );
    } catch (error: any) {
      logger.error(
        COMPONENT,
        JSON.stringify({
          msg: "Job failed",
          error,
          stack: error.stack,
        })
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 500 }
);
worker.on("error", (error) => {
  logger.error(
    COMPONENT,
    JSON.stringify({
      msg: "Worker errored",
      error,
    })
  );
});

export const addToQueue = async (solutionKey: string, delay: number) => {
  await lock(solutionKey);
  await queue.add(
    randomUUID(),
    { solutionKey },
    { jobId: solutionKey, delay: delay * 1000 }
  );
};

export const lock = async (solutionKey: string) =>
  redis.set(`${solutionKey}:locked`, "1");

export const isLocked = async (solutionKey: string) =>
  Boolean(await redis.get(`${solutionKey}:locked`));
