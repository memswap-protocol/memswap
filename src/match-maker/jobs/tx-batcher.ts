import { Interface } from "@ethersproject/abi";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse } from "@ethersproject/transactions";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";
import cron from "node-cron";

import { BATCHER } from "../../common/addresses";
import { logger } from "../../common/logger";
import { isTxIncluded } from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import { BestFill } from "../types";

const COMPONENT = "tx-batcher";

cron.schedule(`*/10 * * * * *`, async () => {
  const keys = await redis.keys("match-maker:best-fill:");
  if (keys.length) {
    const bestFills: BestFill[] = await Promise.all(
      keys.map(async (key) => {
        const intentHash = key.split(":")[2];
        await redis.set(`${intentHash}:locked`, 1);
        return redis.get(key);
      })
    ).then((results) => results.filter(Boolean).map((r) => JSON.parse(r!)));

    await addToQueue(bestFills);
    await redis.del(keys);
  }
});

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
    const { bestFills } = job.data as {
      bestFills: BestFill[];
    };

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);
      const matchMaker = new Wallet(config.matchMakerPk);

      // Skip any pre-txs already included
      const uniquePreTxs = await Promise.all(
        [...new Set(bestFills.map(({ preTxs }) => preTxs).flat())].filter(
          async (preTx) => {
            const txHash = parse(preTx).hash!;
            return !(await isTxIncluded(txHash, provider));
          }
        )
      );

      const latestBlock = await provider.getBlock("latest");
      const currentBaseFee = await provider
        .getBlock("pending")
        .then((b) => b!.baseFeePerGas!);

      // TODO: Compute both of these dynamically
      const maxPriorityFeePerGas = parseUnits("10", "gwei");
      const gasLimit = 500000;

      const batchTxData = {
        from: matchMaker.address,
        to: BATCHER,
        data: new Interface([
          `
            function batch(
              (
                (
                  address maker,
                  address filler,
                  address tokenIn,
                  address tokenOut,
                  address referrer,
                  uint32 referrerFeeBps,
                  uint32 referrerSurplusBps,
                  uint32 deadline,
                  uint128 amountIn,
                  uint128 startAmountOut,
                  uint128 expectedAmountOut,
                  uint128 endAmountOut,
                  bytes signature
                ) intent,
                address fillContract,
                bytes fillData
              ) fills
            )
          `,
        ]).encodeFunctionData("batch", [
          bestFills.map(({ fill }) => [
            fill.intent,
            fill.fillContract,
            fill.fillData,
          ]),
        ]),
        value: 0,
        type: 2,
        gasLimit,
        chainId: await provider.getNetwork().then((n) => n.chainId),
        maxFeePerGas: currentBaseFee.add(maxPriorityFeePerGas).toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      };

      const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        new Wallet(
          "0x2000000000000000000000000000000000000000000000000000000000000000"
        ),
        "https://relay-goerli.flashbots.net"
      );

      const bundleTxs = [
        ...uniquePreTxs.map((tx) => ({ signedTransaction: tx })),
        {
          signer: matchMaker,
          transaction: batchTxData,
        },
      ];
      const signedBundle = await flashbotsProvider.signBundle(bundleTxs);

      const blockNumber = latestBlock.number + 1;
      const simulationResult: { results: [{ error?: string }] } =
        (await flashbotsProvider.simulate(signedBundle, blockNumber)) as any;
      if (simulationResult.results.some((r) => r.error)) {
        throw new Error("Simulation failed");
      }

      const receipt = await flashbotsProvider.sendRawBundle(
        signedBundle,
        blockNumber
      );
      const hash = (receipt as any).bundleHash;

      logger.info(
        COMPONENT,
        `Bundle ${hash} submitted in block ${blockNumber}, waiting...`
      );

      const waitResponse = await (receipt as any).wait();
      if (
        waitResponse === FlashbotsBundleResolution.BundleIncluded ||
        waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
      ) {
        logger.info(
          COMPONENT,
          `Bundle ${hash} included in block ${blockNumber} (${
            waitResponse === FlashbotsBundleResolution.BundleIncluded
              ? "BundleIncluded"
              : "AccountNonceTooHigh"
          })`
        );
      } else {
        throw new Error("Bundle not included in block");
      }
    } catch (error) {
      logger.error(COMPONENT, `Job failed: ${error}`);
      throw error;
    }
  },
  { connection: redis.duplicate() }
);
worker.on("error", (error) => {
  logger.error(COMPONENT, JSON.stringify({ data: `Worker errored: ${error}` }));
});

export const addToQueue = async (bestFills: BestFill[]) =>
  queue.add(randomUUID(), { bestFills });
