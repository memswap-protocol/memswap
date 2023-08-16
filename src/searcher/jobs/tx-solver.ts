import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { serialize } from "@ethersproject/transactions";
import { parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { BATCHER, FILLER, MEMSWAP } from "../../common/addresses";
import { logger } from "../../common/logger";
import { bn, isTxIncluded, now } from "../../common/utils";
import { Intent, IntentOrigin } from "../../common/types";
import { config } from "../config";
import { redis } from "../redis";
import * as solutions from "../solutions";

const COMPONENT = "tx-solver";

export const queue = new Queue(COMPONENT, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 30,
    removeOnComplete: 10000,
    removeOnFail: 10000,
  },
});

const worker = new Worker(
  COMPONENT,
  async (job) => {
    const { txHash, intent, intentOrigin } = job.data as {
      txHash: string;
      intent: Intent;
      intentOrigin: IntentOrigin;
    };

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);
      const searcher = new Wallet(config.searcherPk);

      if (intent.deadline <= now()) {
        logger.info(
          COMPONENT,
          `[${txHash}] Intent expired: ${intent.deadline} <= ${now()}`
        );
        return;
      }

      if (![AddressZero, FILLER, BATCHER].includes(intent.filler)) {
        logger.info(
          COMPONENT,
          `[${txHash}] Intent not fillable: ${intent.filler}`
        );
        return;
      }

      const tx = await provider.getTransaction(txHash);
      logger.info(COMPONENT, `[${tx.hash}] Triggering filling`);

      // TODO: Check if filler is authorized

      const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        new Wallet(config.flashbotsSignerPk),
        "https://relay-goerli.flashbots.net"
      );

      const latestBlock = await provider.getBlock("latest");

      const blockNumber = latestBlock.number + 1;
      const blockTimestamp = latestBlock.timestamp + 14;
      const currentBaseFee = await provider
        .getBlock("pending")
        .then((b) => b!.baseFeePerGas!);

      // TODO: Compute both of these dynamically
      const maxPriorityFeePerGas = parseUnits("10", "gwei");
      const gasLimit = 500000;

      const minimumAmountOut = bn(intent.startAmountOut).sub(
        bn(intent.startAmountOut)
          .sub(intent.endAmountOut)
          .div(intent.deadline - blockTimestamp)
      );

      const solution = await solutions.uniswapV3.solve(
        intent.tokenIn,
        intent.tokenOut,
        intent.amountIn,
        provider
      );
      if (!solution) {
        throw new Error("Could not generate solution");
      }

      if (solution.amountOut && solution.tokenOutToEthRate) {
        if (bn(solution.amountOut).lt(minimumAmountOut)) {
          logger.error(
            COMPONENT,
            `[${tx.hash}] Not enough amount out for maker (actual=${
              solution.amountOut
            }, minimum=${minimumAmountOut.toString()})`
          );
          return;
        }

        const fillerGrossProfitInETH = bn(solution.amountOut)
          .sub(minimumAmountOut)
          .mul(parseEther(solution.tokenOutToEthRate))
          .div(parseEther("1"));
        const fillerNetProfitInETH = fillerGrossProfitInETH.sub(
          currentBaseFee.add(maxPriorityFeePerGas).mul(gasLimit)
        );
        if (fillerNetProfitInETH.lt(parseEther("0.00001"))) {
          logger.error(
            COMPONENT,
            `[${
              tx.hash
            }] Not enough amount out for filler (profit=${fillerNetProfitInETH.toString()})`
          );
          return;
        }
      }

      const originTx = {
        signedTransaction: serialize(
          {
            to: tx.to,
            nonce: tx.nonce,
            gasLimit: tx.gasLimit,
            data: tx.data,
            value: tx.value,
            chainId: tx.chainId,
            type: tx.type,
            accessList: tx.accessList,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            maxFeePerGas: tx.maxFeePerGas,
          },
          {
            v: tx.v!,
            r: tx.r!,
            s: tx.s!,
          }
        ),
      };
      const skipOriginTransaction =
        intentOrigin === "approve" || intentOrigin === "deposit-and-approve"
          ? await isTxIncluded(tx.hash, provider)
          : true;

      const fillContract = FILLER;
      const fillData = new Interface([
        "function fill(address to, bytes data, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut)",
      ]).encodeFunctionData("fill", [
        solution.to,
        solution.data,
        intent.tokenIn,
        intent.amountIn,
        intent.tokenOut,
        minimumAmountOut,
      ]);

      if (intent.maker === BATCHER) {
        await axios.post(`${config.matchMakerBaseUrl}/fills`, {
          preTxs: skipOriginTransaction ? [] : [originTx.signedTransaction],
          fill: {
            intent,
            fillContract,
            fillData,
          },
        });

        logger.info(
          COMPONENT,
          `[${tx.hash}] Successfully relayed to match-maker`
        );
      } else {
        const fillerTx = {
          signer: searcher,
          transaction: {
            from: searcher.address,
            to: MEMSWAP,
            value: 0,
            data: new Interface([
              `
                function execute(
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
                )
              `,
            ]).encodeFunctionData("execute", [intent, fillContract, fillData]),
            type: 2,
            gasLimit,
            chainId: await provider.getNetwork().then((n) => n.chainId),
            maxFeePerGas: currentBaseFee.add(maxPriorityFeePerGas).toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          },
        };

        const signedBundle = await flashbotsProvider.signBundle(
          skipOriginTransaction ? [fillerTx] : [originTx, fillerTx]
        );

        const simulationResult: { results: [{ error?: string }] } =
          (await flashbotsProvider.simulate(signedBundle, blockNumber)) as any;
        if (simulationResult.results.some((r) => r.error)) {
          logger.error(
            COMPONENT,
            `[${tx.hash}] Simulation failed: ${JSON.stringify({
              simulationResult,
              fillerTx,
            })}`
          );
          return;
        }

        logger.info(
          COMPONENT,
          `[${tx.hash}] Trying to send bundle (${
            skipOriginTransaction ? "fill" : "approve-and-fill"
          }) for block ${blockNumber}`
        );

        const receipt = await flashbotsProvider.sendRawBundle(
          signedBundle,
          blockNumber
        );
        const hash = (receipt as any).bundleHash;

        logger.info(
          COMPONENT,
          `[${tx.hash}] Bundle ${hash} submitted in block ${blockNumber}, waiting...`
        );

        const waitResponse = await (receipt as any).wait();
        if (
          waitResponse === FlashbotsBundleResolution.BundleIncluded ||
          waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
        ) {
          logger.info(
            COMPONENT,
            `[${tx.hash}] Bundle ${hash} included in block ${blockNumber} (${
              waitResponse === FlashbotsBundleResolution.BundleIncluded
                ? "BundleIncluded"
                : "AccountNonceTooHigh"
            })`
          );
        } else {
          throw new Error(`[${tx.hash}] Bundle ${hash} not included in block`);
        }
      }
    } catch (error: any) {
      logger.error(
        COMPONENT,
        `Job failed: ${error.response?.data ? error.response.data : error}`
      );
      throw error;
    }
  },
  { connection: redis.duplicate() }
);
worker.on("error", (error) => {
  logger.error(COMPONENT, JSON.stringify({ data: `Worker errored: ${error}` }));
});

export const addToQueue = async (
  txHash: string,
  intent: Intent,
  intentOrigin: IntentOrigin
) => queue.add(randomUUID(), { txHash, intent, intentOrigin });
