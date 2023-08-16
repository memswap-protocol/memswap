import { Interface } from "@ethersproject/abi";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse } from "@ethersproject/transactions";
import { Wallet } from "@ethersproject/wallet";
import { getCallTraces, getStateChange } from "@georgeroman/evm-tx-simulator";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { BATCHER } from "../../common/addresses";
import { logger } from "../../common/logger";
import { bn, getEIP712Domain, getEIP712Types, now } from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import { BestFill, IntentFill } from "../types";

const COMPONENT = "tx-handler";

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
    const { preTxs, fill } = job.data as {
      preTxs: string[];
      fill: IntentFill;
    };

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);
      const matchMaker = new Wallet(config.matchMakerPk);

      const chainId = await provider.getNetwork().then((n) => n.chainId);
      const intentHash = _TypedDataEncoder.hash(
        getEIP712Domain(chainId),
        getEIP712Types(),
        fill.intent
      );

      if (fill.intent.deadline <= now()) {
        logger.info(
          COMPONENT,
          `[${intentHash}] Intent expired: ${fill.intent.deadline} <= ${now()}`
        );
        return;
      }

      const traces = await getCallTraces(
        [
          ...preTxs.map((tx) => {
            const parsedTx = parse(tx);
            return {
              ...parsedTx,
              from: parsedTx.from!,
              to: parsedTx.to!,
              gas: parsedTx.gasLimit,
              gasPrice: (parsedTx.gasPrice ?? parsedTx.maxFeePerGas)!,
            };
          }),
          {
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
              [fill.intent, fill.fillContract, fill.fillData],
            ]),
            value: 0,
            gas: 2000000,
            gasPrice: await provider.getFeeData().then((f) => f.gasPrice!),
          },
        ],
        provider
      );

      const fillTrace = traces[0];
      if (fillTrace.error) {
        logger.info(
          COMPONENT,
          `[${intentHash}] Fill transaction reverted: ${fillTrace.error}`
        );
        return;
      }

      const stateChange = getStateChange(fillTrace);
      const amountReceived =
        stateChange[fill.intent.maker.toLowerCase()].tokenBalanceState[
          `erc20:${fill.intent.tokenOut.toLowerCase()}`
        ];

      const lockKey = `${intentHash}:locked`;
      if (await redis.get(lockKey)) {
        logger.info(COMPONENT, `[${intentHash}] Already processed`);
        return;
      }

      const bestFillKey = `match-maker:best-fill:${intentHash}`;
      const bestFill: BestFill | undefined = await redis
        .get(bestFillKey)
        .then((bf) => (bf ? JSON.parse(bf) : undefined));

      if (!bestFill || bn(bestFill.amountReceived).lt(amountReceived)) {
        await redis.set(
          bestFillKey,
          JSON.stringify({
            preTxs,
            fill,
            amountReceived,
          }),
          "EX",
          2 * 60
        );
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

export const addToQueue = async (preTxs: string[], fill: IntentFill) =>
  queue.add(randomUUID(), { preTxs, fill });
