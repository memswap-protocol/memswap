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
import * as txSimulator from "@georgeroman/evm-tx-simulator";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

import {
  FILL_PROXY,
  MATCHMAKER,
  MEMSWAP,
  MEMSWAP_WETH,
  REGULAR_WETH,
} from "../../common/addresses";
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

      if (
        (intent.tokenIn === MEMSWAP_WETH && intent.tokenOut === REGULAR_WETH) ||
        (intent.tokenIn === REGULAR_WETH && intent.tokenOut === AddressZero)
      ) {
        logger.info(COMPONENT, `[${txHash}] Attempted to wrap / unwrap WETH`);
        return;
      }

      if (intent.deadline <= now()) {
        logger.info(
          COMPONENT,
          `[${txHash}] Intent expired: ${intent.deadline} <= ${now()}`
        );
        return;
      }

      if (![AddressZero, FILL_PROXY, MATCHMAKER].includes(intent.filler)) {
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
      const latestTimestamp = latestBlock.timestamp + 14;
      const latestBaseFee = await provider
        .getBlock("pending")
        .then((b) => b!.baseFeePerGas!);

      // TODO: Compute both of these dynamically
      const maxPriorityFeePerGas = parseUnits("10", "gwei");
      const gasLimit = 1000000;

      const minimumAmountOut = bn(intent.startAmountOut).sub(
        bn(intent.startAmountOut)
          .sub(intent.endAmountOut)
          .div(intent.deadline - latestTimestamp)
      );

      const solution = await solutions.zeroEx.solve(
        intent.tokenIn,
        intent.tokenOut,
        intent.amountIn
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
          latestBaseFee.add(maxPriorityFeePerGas).mul(gasLimit)
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

      const fill = {
        to: FILL_PROXY,
        data: new Interface([
          "function fill(address to, bytes data, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut)",
        ]).encodeFunctionData("fill", [
          solution.to,
          solution.data,
          intent.tokenIn,
          intent.amountIn,
          intent.tokenOut,
          minimumAmountOut,
        ]),
        amount: intent.amountIn,
      };

      const getFillerTx = async (intent: Intent, authFromMatchMaker?: any) => {
        const method = authFromMatchMaker
          ? "solveWithSignatureAuthorizationCheck"
          : intent.filler === MATCHMAKER
          ? "solveWithOnChainAuthorizationCheck"
          : "solve";

        return {
          signer: searcher,
          transaction: {
            from: searcher.address,
            to: MEMSWAP,
            value: 0,
            data: new Interface([
              `
              function ${method}(
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
                ) intent,
                (
                  address to,
                  bytes data,
                  uint128 amount
                ) solution${
                  authFromMatchMaker
                    ? `,
                        (
                          uint128 maximumAmountIn,
                          uint128 minimumAmountOut,
                          uint32 blockDeadline,
                          bool isPartiallyFillable
                        ),
                        bytes signature
                      `
                    : ""
                }
              )
            `,
            ]).encodeFunctionData(
              method,
              authFromMatchMaker
                ? [
                    intent,
                    fill,
                    authFromMatchMaker,
                    authFromMatchMaker?.signature,
                  ]
                : [intent, fill]
            ),
            type: 2,
            gasLimit,
            chainId: await provider.getNetwork().then((n) => n.chainId),
            maxFeePerGas: latestBaseFee.add(maxPriorityFeePerGas).toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          },
        };
      };

      let authFromMatchMaker: any;
      if (intent.filler === MATCHMAKER) {
        const signedFillerTx = await searcher.signTransaction(
          await getFillerTx(intent).then((tx) => tx.transaction)
        );

        let done = false;
        while (!done) {
          const response = await axios.post(
            `${config.matchMakerBaseUrl}/fills`,
            {
              intent,
              txs: [originTx.signedTransaction, signedFillerTx],
            }
          );

          if (response.data.recheckIn) {
            await new Promise((resolve) =>
              setTimeout(resolve, response.data.recheckIn * 1000)
            );
          } else {
            authFromMatchMaker = response.data.auth;
            done = true;
          }
        }

        if (!authFromMatchMaker) {
          throw new Error("No auth received");
        }
      }

      if (intent.filler !== MATCHMAKER || authFromMatchMaker) {
        const skipOriginTransaction =
          intentOrigin === "approve" || intentOrigin === "deposit-and-approve"
            ? await isTxIncluded(tx.hash, provider)
            : true;

        let useFlashbots = true;
        if (skipOriginTransaction) {
          useFlashbots = false;
        }
        if (Boolean(Number(process.env.FORCE_FLASHBOTS))) {
          useFlashbots = true;
        }

        logger.info(
          COMPONENT,
          `[${txHash}] ${
            useFlashbots ? "Using flashbots" : "Using a regular transaction"
          }`
        );

        const fillerTx = await getFillerTx(intent, authFromMatchMaker);
        if (useFlashbots) {
          const signedBundle = await flashbotsProvider.signBundle(
            skipOriginTransaction ? [fillerTx] : [originTx, fillerTx]
          );

          const targetBlock =
            (await provider.getBlock("latest").then((b) => b.number)) + 1;

          const simulationResult: { results: [{ error?: string }] } =
            (await flashbotsProvider.simulate(
              signedBundle,
              targetBlock
            )) as any;
          if (simulationResult.results.some((r) => r.error)) {
            logger.error(
              COMPONENT,
              `[${tx.hash}] Simulation failed: ${JSON.stringify({
                simulationResult,
                fillerTx,
              })}`
            );

            // We retry jobs for which the simulation failed
            throw new Error("Simulation failed");
          }

          logger.info(
            COMPONENT,
            `[${tx.hash}] Trying to send bundle (${
              skipOriginTransaction ? "fill" : "approve-and-fill"
            }) for block ${targetBlock}`
          );

          const receipt = await flashbotsProvider.sendRawBundle(
            signedBundle,
            targetBlock
          );
          const hash = (receipt as any).bundleHash;

          logger.info(
            COMPONENT,
            `[${tx.hash}] Bundle ${hash} submitted for block ${targetBlock}, waiting...`
          );

          const waitResponse = await (receipt as any).wait();
          if (
            waitResponse === FlashbotsBundleResolution.BundleIncluded ||
            waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
          ) {
            logger.info(
              COMPONENT,
              `[${tx.hash}] Bundle ${hash} included in block ${targetBlock} (${
                waitResponse === FlashbotsBundleResolution.BundleIncluded
                  ? "BundleIncluded"
                  : "AccountNonceTooHigh"
              })`
            );
          } else {
            throw new Error(
              `[${tx.hash}] Bundle ${hash} not included in block`
            );
          }
        } else {
          await txSimulator.getCallResult(
            {
              from: fillerTx.transaction.from,
              to: fillerTx.transaction.to,
              data: fillerTx.transaction.data,
              value: fillerTx.transaction.value,
              gas: fillerTx.transaction.gasLimit,
              gasPrice: fillerTx.transaction.maxFeePerGas,
            },
            provider
          );

          logger.info(
            COMPONENT,
            `[${tx.hash}] Trying to send solve transaction`
          );

          await searcher.sendTransaction(fillerTx.transaction);
        }
      }
    } catch (error: any) {
      logger.error(
        COMPONENT,
        `Job failed: ${
          error.response?.data ? JSON.stringify(error.response.data) : error
        } (${error.stack})`
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
