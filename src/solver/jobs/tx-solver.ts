import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { serialize } from "@ethersproject/transactions";
import { formatEther, parseEther, parseUnits } from "@ethersproject/units";
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
import { Intent, IntentOrigin } from "../../common/types";
import { bn, getIntentHash, isTxIncluded, now } from "../../common/utils";
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
    const { intent, intentOrigin, txHash } = job.data as {
      txHash?: string;
      intent: Intent;
      intentOrigin: IntentOrigin;
    };

    try {
      const provider = new JsonRpcProvider(config.jsonUrl);
      const solver = new Wallet(config.solverPk);

      const intentHash = getIntentHash(intent);

      if (
        (intent.tokenIn === MEMSWAP_WETH && intent.tokenOut === REGULAR_WETH) ||
        (intent.tokenIn === REGULAR_WETH && intent.tokenOut === AddressZero)
      ) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            intentHash,
            txHash,
            message: "Attempted to wrap/unwrap WETH",
          })
        );
        return;
      }

      if (intent.deadline <= now()) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            intentHash,
            txHash,
            message: `Expired (now=${now()}, deadline=${intent.deadline})`,
          })
        );
        return;
      }

      if (![solver.address, AddressZero].includes(intent.matchmaker)) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            intentHash,
            txHash,
            message: `Unsupported matchmaker (matchmaker=${intent.matchmaker})`,
          })
        );
        return;
      }

      logger.info(
        COMPONENT,
        JSON.stringify({
          intentHash,
          txHash,
          message: "Generating solution",
        })
      );

      const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        new Wallet(config.flashbotsSignerPk),
        "https://relay-goerli.flashbots.net"
      );

      const latestBlock = await provider.getBlock("latest");
      const latestTimestamp = latestBlock.timestamp + 12;
      const latestBaseFee = await provider
        .getBlock("pending")
        .then((b) => b!.baseFeePerGas!);

      // TODO: Compute both of these dynamically
      const maxPriorityFeePerGas = parseUnits("10", "gwei");
      const gasLimit = 1000000;

      const startAmountOut = bn(intent.endAmountOut).add(
        bn(intent.endAmountOut).mul(intent.startAmountBps).div(10000)
      );
      const minAmountOut = startAmountOut.sub(
        startAmountOut
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
        if (bn(solution.amountOut).lt(minAmountOut)) {
          logger.error(
            COMPONENT,
            JSON.stringify({
              intentHash,
              txHash,
              message: `Solution not good enough (actualAmountOut=${
                solution.amountOut
              }, minAmountOut=${minAmountOut.toString()})`,
            })
          );
          return;
        }

        const fillerGrossProfitInETH = bn(solution.amountOut)
          .sub(minAmountOut)
          .mul(parseEther(solution.tokenOutToEthRate))
          .div(parseEther("1"));
        const fillerNetProfitInETH = fillerGrossProfitInETH.sub(
          latestBaseFee.add(maxPriorityFeePerGas).mul(gasLimit)
        );
        if (fillerNetProfitInETH.lt(parseEther("0.00001"))) {
          logger.error(
            COMPONENT,
            JSON.stringify({
              intentHash,
              txHash,
              message: `Insufficient solver profit (profit=${formatEther(
                fillerGrossProfitInETH
              )})`,
            })
          );
          return;
        }
      }

      const originTx = txHash
        ? await (async () => {
            const tx = await provider.getTransaction(txHash);
            return {
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
          })()
        : undefined;

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
          minAmountOut,
        ]),
        amount: intent.amountIn,
      };

      const getFillerTx = async (intent: Intent) => {
        const method =
          intent.matchmaker === MATCHMAKER
            ? "solveWithOnChainAuthorizationCheck"
            : "solve";

        return {
          signer: solver,
          transaction: {
            from: solver.address,
            to: MEMSWAP,
            value: 0,
            data: new Interface([
              `
              function ${method}(
                (
                  address tokenIn,
                  address tokenOut,
                  address maker,
                  address matchmaker,
                  address source,
                  uint16 feeBps,
                  uint16 surplusBps,
                  uint32 deadline,
                  bool isPartiallyFillable,
                  uint128 amountIn,
                  uint128 endAmountOut,
                  uint16 startAmountBps,
                  uint16 expectedAmountBps,
                  bytes signature
                ) intent,
                (
                  address to,
                  bytes data,
                  uint128 amount
                ) solution
              )
            `,
            ]).encodeFunctionData(method, [intent, fill]),
            type: 2,
            gasLimit,
            chainId: await provider.getNetwork().then((n) => n.chainId),
            maxFeePerGas: latestBaseFee.add(maxPriorityFeePerGas).toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          },
        };
      };

      if (intent.matchmaker !== MATCHMAKER) {
        const skipOriginTransaction =
          txHash && originTx && intentOrigin === "approval"
            ? await isTxIncluded(txHash, provider)
            : true;

        let useFlashbots = true;
        if (skipOriginTransaction) {
          useFlashbots = false;
        }
        if (Boolean(Number(process.env.FORCE_FLASHBOTS))) {
          useFlashbots = true;
        }

        const fillerTx = await getFillerTx(intent);
        if (useFlashbots) {
          const signedBundle = await flashbotsProvider.signBundle(
            skipOriginTransaction ? [fillerTx] : [originTx!, fillerTx]
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
              JSON.stringify({
                txHash,
                intentHash,
                message: "Simulation failed",
                simulationResult,
                fillerTx,
              })
            );

            // We retry jobs for which the simulation failed
            throw new Error("Simulation failed");
          }

          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              txHash,
              message: `Relaying solution using flashbots (targetBlock=${targetBlock})`,
            })
          );

          const receipt = await flashbotsProvider.sendRawBundle(
            signedBundle,
            targetBlock
          );
          const hash = (receipt as any).bundleHash;

          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              txHash,
              message: `Solution relayed using flashbots (targetBlock=${targetBlock}, bundleHash=${hash})`,
            })
          );

          const waitResponse = await (receipt as any).wait();
          if (
            waitResponse === FlashbotsBundleResolution.BundleIncluded ||
            waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
          ) {
            logger.info(
              COMPONENT,
              JSON.stringify({
                intentHash,
                txHash,
                message: `Solution included (targetBlock=${targetBlock}, bundleHash=${hash})`,
              })
            );
          } else {
            logger.info(
              COMPONENT,
              JSON.stringify({
                intentHash,
                txHash,
                message: `Solution not included (targetBlock=${targetBlock}, bundleHash=${hash})`,
              })
            );
          }
        } else {
          try {
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
          } catch {
            logger.error(
              COMPONENT,
              JSON.stringify({
                txHash,
                intentHash,
                message: "Simulation failed",
                fillerTx,
              })
            );

            // We retry jobs for which the simulation failed
            throw new Error("Simulation failed");
          }

          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              txHash,
              message: "Relaying solution using regular transaction",
            })
          );

          const txResponse = await solver
            .connect(provider)
            .sendTransaction(fillerTx.transaction);

          logger.info(
            COMPONENT,
            JSON.stringify({
              intentHash,
              txHash,
              message: `Solution included (txHash=${txResponse.hash})`,
            })
          );
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
  intent: Intent,
  intentOrigin: IntentOrigin,
  txHash?: string
) => queue.add(randomUUID(), { intent, intentOrigin, txHash });
