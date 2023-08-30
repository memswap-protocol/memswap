import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { MATCHMAKER } from "../../common/addresses";
import { logger } from "../../common/logger";
import { Intent } from "../../common/types";
import {
  BLOCK_TIME,
  bn,
  getEIP712Domain,
  getEIP712TypesForAuthorization,
  getIntentHash,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import { Solution } from "../types";

const COMPONENT = "signature-release";

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
      topSolutions = topSolutions.filter(({ minAmountOut }) =>
        bn(bestSolution.minAmountOut)
          .sub(minAmountOut)
          .lte(bn(bestSolution.maxAmountIn).mul(10).div(10000))
      );

      // Authorize the solvers
      await Promise.all(
        topSolutions.map(
          async ({
            uuid,
            baseUrl,
            intentHash,
            authorizedSolver,
            maxAmountIn,
            minAmountOut,
          }) => {
            try {
              const authorization = {
                intentHash,
                authorizedSolver,
                maxAmountIn,
                minAmountOut,
                blockDeadline: deadlineBlock,
                isPartiallyFillable: false,
              };
              (authorization as any).signature =
                await matchmaker._signTypedData(
                  getEIP712Domain(config.chainId),
                  getEIP712TypesForAuthorization(),
                  authorization
                );

              await axios.post(`${baseUrl}/authorizations`, {
                uuid,
                authorization,
              });

              logger.info(
                COMPONENT,
                JSON.stringify({
                  intentHash,
                  message: `Submitted authorization to solver (baseUrl=${baseUrl})`,
                })
              );
            } catch (error: any) {
              logger.error(
                COMPONENT,
                JSON.stringify({
                  message: `Error submitting authorization to solver (baseUrl=${baseUrl})`,
                  error: error.response?.data ?? error,
                })
              );
            }
          }
        )
      );
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
  intent: Intent,
  approvalTxOrTxHash?: string
) => {
  if (intent.matchmaker !== MATCHMAKER[config.chainId]) {
    throw new Error("Intent not associated to current matchmaker");
  }

  const provider = new JsonRpcProvider(config.jsonUrl);
  const matchmaker = new Wallet(config.matchmakerPk);

  const blocksCount = 10;

  const latestBlock = await provider.getBlock("latest");
  const timestamp = latestBlock.timestamp + blocksCount * BLOCK_TIME;

  const startAmountOut = bn(intent.endAmountOut).add(
    bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
  );
  const minAmountOut = startAmountOut.sub(
    startAmountOut.sub(intent.endAmountOut).div(intent.deadline - timestamp)
  );

  await Promise.all(
    solvers.map(async ({ address, baseUrl }) => {
      const intentHash = getIntentHash(intent);
      const authorization = {
        intentHash,
        authorizedSolver: address,
        maxAmountIn: intent.amountIn,
        minAmountOut: minAmountOut.toString(),
        blockDeadline: latestBlock.number + blocksCount,
        isPartiallyFillable: false,
      };
      (authorization as any).signature = await matchmaker._signTypedData(
        getEIP712Domain(config.chainId),
        getEIP712TypesForAuthorization(),
        authorization
      );

      await axios.post(`${baseUrl}/authorizations`, {
        intent,
        approvalTxOrTxHash,
        authorization,
      });

      logger.info(
        COMPONENT,
        JSON.stringify({
          intentHash,
          message: `Submitted authorization to solver (solver=${address} baseUrl=${baseUrl})`,
        })
      );
    })
  );
};
