import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MATCHMAKER } from "../../common/addresses";
import { logger } from "../../common/logger";
import { Authorization, IntentERC721, Protocol } from "../../common/types";
import {
  AVERAGE_BLOCK_TIME,
  bn,
  getEIP712Domain,
  getEIP712TypesForAuthorization,
  getIntentHash,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import { Solution } from "../types";

const COMPONENT = "signature-release-erc721";

export const queue = new Queue(COMPONENT, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 1,
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
      const matchmaker = new Wallet(config.matchmakerPk);

      const components = solutionKey.split(":");
      const deadlineBlock = Number(components[components.length - 1]) + 5;
      const latestBlock = await provider
        .getBlock("latest")
        .then((b) => b.number);
      if (latestBlock >= deadlineBlock) {
        throw new Error("Deadline block already passed");
      }

      // Fetch the top 5 solutions
      let topSolutions: Solution[] = await redis
        .zrange(solutionKey, 0, 4, "REV")
        .then((solutions) => solutions.map((s) => JSON.parse(s)));

      // Select the solutions which are within 0.01% of the best solution
      const bestSolution = topSolutions[0];
      topSolutions = topSolutions.filter(({ executeAmountToCheck }) =>
        bn(bestSolution.executeAmountToCheck)
          .sub(executeAmountToCheck)
          .lte(bn(bestSolution.executeAmountToCheck).mul(10).div(10000))
      );

      // Authorize the solvers
      await Promise.all(
        topSolutions.map(
          async ({
            uuid,
            baseUrl,
            intentHash,
            solver,
            fillAmountToCheck,
            executeAmountToCheck,
          }) => {
            try {
              const authorization: Authorization = {
                intentHash,
                solver,
                fillAmountToCheck,
                executeAmountToCheck,
                blockDeadline: deadlineBlock,
              };
              authorization.signature = await matchmaker._signTypedData(
                getEIP712Domain(config.chainId, Protocol.ERC721),
                getEIP712TypesForAuthorization(),
                authorization
              );

              await axios.post(`${baseUrl}/erc721/authorizations`, {
                uuid,
                authorization,
              });

              logger.info(
                COMPONENT,
                JSON.stringify({
                  msg: "Submitted authorization to solver",
                  intentHash,
                  baseUrl,
                })
              );
            } catch (error: any) {
              logger.error(
                COMPONENT,
                JSON.stringify({
                  msg: "Error submitting authorization to solver",
                  baseUrl,
                  error: error.response?.data ?? error,
                })
              );
            }
          }
        )
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

export const submitDirectlyToSolver = async (
  solvers: { address: string; baseUrl: string }[],
  intent: IntentERC721,
  approvalTxOrTxHash?: string
) => {
  if (intent.solver !== MATCHMAKER[config.chainId]) {
    throw new Error("Intent not associated to current matchmaker");
  }

  const provider = new JsonRpcProvider(config.jsonUrl);
  const matchmaker = new Wallet(config.matchmakerPk);

  const blocksCount = 20;

  const latestBlock = await provider.getBlock("latest");
  const timestamp = latestBlock.timestamp + blocksCount * AVERAGE_BLOCK_TIME;

  let executeAmountToCheck: string;
  if (intent.isBuy) {
    const endAmount = bn(intent.endAmount);
    const startAmount = endAmount.sub(
      endAmount.mul(intent.startAmountBps).div(10000)
    );

    executeAmountToCheck = startAmount
      .add(
        endAmount
          .sub(startAmount)
          .mul(timestamp - intent.startTime)
          .div(intent.endTime - intent.startTime)
      )
      .toString();
  }

  await Promise.all(
    solvers.map(async ({ address, baseUrl }) => {
      const intentHash = getIntentHash(intent);
      const authorization: Authorization = {
        intentHash,
        solver: address,
        fillAmountToCheck: intent.amount,
        executeAmountToCheck,
        blockDeadline: latestBlock.number + blocksCount,
      };
      authorization.signature = await matchmaker._signTypedData(
        getEIP712Domain(config.chainId, Protocol.ERC721),
        getEIP712TypesForAuthorization(),
        authorization
      );

      await axios.post(`${baseUrl}/erc721/authorizations`, {
        intent,
        approvalTxOrTxHash,
        authorization,
      });

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Submitted authorization directly to solver",
          approvalTxOrTxHash,
          intentHash,
          address,
          baseUrl,
        })
      );
    })
  );
};
