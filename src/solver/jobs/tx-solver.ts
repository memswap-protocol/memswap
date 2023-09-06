import { Interface, defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parse, serialize } from "@ethersproject/transactions";
import { parseEther, parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleRawTransaction,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import * as txSimulator from "@georgeroman/evm-tx-simulator";
import axios from "axios";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";

// Monkey-patch the flashbots bundle provider to support relaying via bloxroute
import "../monkey-patches/flashbots-bundle-provider";

import {
  SOLUTION_PROXY,
  MATCHMAKER,
  WETH2,
  WETH9,
} from "../../common/addresses";
import { logger } from "../../common/logger";
import { Authorization, Intent, Side, Solution } from "../../common/types";
import {
  bn,
  getAuthorizationHash,
  getIntentHash,
  isIntentFilled,
  isTxIncluded,
  now,
} from "../../common/utils";
import { config } from "../config";
import { redis } from "../redis";
import * as solutions from "../solutions";
import { BuySolutionData, SellSolutionData } from "../types";
import { getFlashbotsProvider } from "../utils";

const COMPONENT = "tx-solver";

const BLOCK_TIME = 15;

// Warm-up
getFlashbotsProvider();

export const queue = new Queue(COMPONENT, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 10000,
    removeOnFail: 10000,
  },
});

const worker = new Worker(
  COMPONENT,
  async (job) => {
    const { intent, approvalTxOrTxHash, existingSolution, authorization } =
      job.data as {
        intent: Intent;
        approvalTxOrTxHash?: string;
        existingSolution?: Solution;
        authorization?: Authorization;
      };

    try {
      const perfTime1 = performance.now();

      const provider = new JsonRpcProvider(config.jsonUrl);
      const flashbotsProvider = await getFlashbotsProvider();

      const perfTime12 = performance.now();

      const solver = new Wallet(config.solverPk);
      const intentHash = getIntentHash(intent);

      if (await isIntentFilled(intent, config.chainId, provider)) {
        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Filled",
            intentHash,
            approvalTxOrTxHash,
          })
        );
        return;
      }

      const perfTime2 = performance.now();

      // Starting tip is 1 gwei
      let maxPriorityFeePerGas = parseUnits("1", "gwei");

      // TODO: Compute this dynamically
      const gasLimit = 1000000;

      // Approximations for gas used by memswap logic and gas used by swap logic
      const memswapGas = 150000;
      const defaultGas = 200000;

      let solution: Solution;
      if (existingSolution) {
        // Reuse existing solution

        solution = existingSolution;
      } else {
        // Check and generate solution

        if (
          (intent.tokenIn === WETH2[config.chainId] &&
            intent.tokenOut === WETH9[config.chainId]) ||
          (intent.tokenIn === WETH9[config.chainId] &&
            intent.tokenOut === AddressZero)
        ) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Attempted to wrap/unwrap WETH",
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        if (intent.startTime > now()) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Not started",
              now: now(),
              startTime: intent.startTime,
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        if (intent.endTime <= now()) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Expired",
              now: now(),
              endTime: intent.endTime,
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        if (
          ![solver.address, AddressZero, MATCHMAKER[config.chainId]].includes(
            intent.matchmaker
          )
        ) {
          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Unsupported matchmaker",
              matchmaker: intent.matchmaker,
              intentHash,
              approvalTxOrTxHash,
            })
          );
          return;
        }

        logger.info(
          COMPONENT,
          JSON.stringify({
            msg: "Generating solution",
            intentHash,
            approvalTxOrTxHash,
          })
        );

        const latestBlock = await provider.getBlock("latest");
        const latestTimestamp = latestBlock.timestamp + BLOCK_TIME;
        const latestBaseFee = await provider
          .getBlock("pending")
          .then((b) => b!.baseFeePerGas!);

        if (intent.side === Side.SELL) {
          const endAmount = intent.endAmount;
          const startAmount = bn(endAmount).add(
            bn(endAmount).mul(intent.startAmountBps).div(10000)
          );

          let minAmountOut = startAmount.sub(
            startAmount
              .sub(endAmount)
              .mul(latestTimestamp - intent.startTime)
              .div(intent.endTime - intent.startTime)
          );

          const { data: solutionDetails } = (await solutions.uniswap.solve(
            intent,
            intent.amount,
            provider
          )) as { data: SellSolutionData };

          const gasConsumed = bn(memswapGas)
            .add(solutionDetails.gasUsed ?? defaultGas)
            .toString();

          if (bn(solutionDetails.minAmountOut).lt(minAmountOut)) {
            logger.error(
              COMPONENT,
              JSON.stringify({
                msg: "Solution not good enough",
                solutionAmountOut: solutionDetails.minAmountOut,
                minAmountOut: minAmountOut.toString(),
                intentHash,
                approvalTxOrTxHash,
              })
            );
            return;
          }

          const tokenOutDecimals = await solutions.uniswap
            .getToken(intent.tokenOut, provider)
            .then((t) => t.decimals);
          const grossProfitInTokenOut = bn(solutionDetails.minAmountOut).sub(
            minAmountOut
          );
          const grossProfitInETH = grossProfitInTokenOut
            .mul(parseEther("1"))
            .div(
              parseUnits(solutionDetails.tokenOutToEthRate, tokenOutDecimals)
            );

          const gasFee = latestBaseFee
            .add(maxPriorityFeePerGas)
            .mul(gasConsumed);
          const netProfitInETH = grossProfitInETH.sub(gasFee);

          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Profit breakdown",
              solutionDetails,
              minAmountOut: minAmountOut.toString(),
              grossProfitInTokenOut: grossProfitInTokenOut.toString(),
              grossProfitInETH: grossProfitInETH.toString(),
              netProfitInETH: netProfitInETH.toString(),
              gasConsumed,
              gasFee: gasFee.toString(),
            })
          );

          if (config.chainId === 1 && netProfitInETH.lte(0)) {
            logger.error(
              COMPONENT,
              JSON.stringify({
                msg: "Insufficient solver profit",
                intentHash,
                approvalTxOrTxHash,
              })
            );
            return;
          }

          if (netProfitInETH.gt(0)) {
            // Assume other solvers compete for the same intent and so increase the
            // tip to the block builder as much as possible while we're profitable.
            // This will also result in the bundles being included faster.
            const minTipIncrement = parseUnits("0.01", "gwei");
            const gasPerTipIncrement = minTipIncrement.mul(gasConsumed);

            // Deduct from the 40% of the profit
            const minTipUnits = netProfitInETH
              .mul(4000)
              .div(10000)
              .div(gasPerTipIncrement);
            maxPriorityFeePerGas = maxPriorityFeePerGas.add(
              minTipIncrement.mul(minTipUnits)
            );

            // Give 50% of the profit back to the user
            minAmountOut = minAmountOut.add(
              netProfitInETH
                .mul(5000)
                .div(10000)
                .mul(
                  parseUnits(
                    solutionDetails.tokenOutToEthRate,
                    tokenOutDecimals
                  )
                )
                .div(parseEther("1"))
            );

            // The rest of 10% from the profit is kept

            logger.info(
              COMPONENT,
              JSON.stringify({
                msg: "Tip increment",
                intentHash,
                gasPerTipIncrement: gasPerTipIncrement.toString(),
                minTipUnits: minTipUnits.toString(),
                maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
                newMaxPriorityFeePerGas: maxPriorityFeePerGas
                  .add(minTipIncrement.mul(minTipUnits))
                  .toString(),
              })
            );
          }

          solution = {
            data: defaultAbiCoder.encode(
              ["(address to, bytes data, uint256 value)[]"],
              [solutionDetails.calls]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [minAmountOut.toString()],
          };
        } else {
          const endAmount = intent.endAmount;
          const startAmount = bn(endAmount).sub(
            bn(endAmount).mul(intent.startAmountBps).div(10000)
          );
          const expectedAmount = bn(endAmount).sub(
            bn(endAmount).mul(intent.expectedAmountBps).div(10000)
          );

          let maxAmountIn = startAmount.add(
            bn(endAmount)
              .sub(startAmount)
              .mul(latestTimestamp - intent.startTime)
              .div(intent.endTime - intent.startTime)
          );

          // We need to subtract any fees from `maxAmountIn`
          if (intent.feeBps) {
            maxAmountIn = maxAmountIn.sub(
              maxAmountIn.mul(intent.feeBps).div(10000)
            );
          }
          if (intent.surplusBps && maxAmountIn.lt(expectedAmount)) {
            maxAmountIn = maxAmountIn.sub(
              expectedAmount.sub(maxAmountIn).mul(intent.surplusBps).div(10000)
            );
          }

          const { data: solutionDetails } = (await solutions.uniswap.solve(
            intent,
            intent.amount,
            provider
          )) as { data: BuySolutionData };

          const gasConsumed = bn(memswapGas)
            .add(solutionDetails.gasUsed ?? defaultGas)
            .toString();

          if (bn(solutionDetails.maxAmountIn).gt(maxAmountIn)) {
            logger.error(
              COMPONENT,
              JSON.stringify({
                msg: "Solution not good enough",
                solutionAmountIn: solutionDetails.maxAmountIn,
                maxAmountIn: maxAmountIn.toString(),
                intentHash,
                approvalTxOrTxHash,
              })
            );
            return;
          }

          const tokenInDecimals = await solutions.uniswap
            .getToken(intent.tokenIn, provider)
            .then((t) => t.decimals);
          const grossProfitInTokenIn = bn(solutionDetails.maxAmountIn).sub(
            maxAmountIn
          );
          const grossProfitInETH = grossProfitInTokenIn
            .mul(parseEther("1"))
            .div(parseUnits(solutionDetails.tokenInToEthRate, tokenInDecimals));

          const gasFee = latestBaseFee
            .add(maxPriorityFeePerGas)
            .mul(gasConsumed);
          const netProfitInETH = grossProfitInETH.sub(gasFee);

          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Profit breakdown",
              solutionDetails,
              maxAmountIn: maxAmountIn.toString(),
              grossProfitInTokenIn: grossProfitInTokenIn.toString(),
              grossProfitInETH: grossProfitInETH.toString(),
              netProfitInETH: netProfitInETH.toString(),
              gasConsumed,
              gasFee: gasFee.toString(),
            })
          );

          if (config.chainId === 1 && netProfitInETH.lte(0)) {
            logger.error(
              COMPONENT,
              JSON.stringify({
                msg: "Insufficient solver profit",
                intentHash,
                approvalTxOrTxHash,
              })
            );
            return;
          }

          if (netProfitInETH.gt(0)) {
            // Assume other solvers compete for the same intent and so increase the
            // tip to the block builder as much as possible while we're profitable.
            // This will also result in the bundles being included faster.
            const minTipIncrement = parseUnits("0.01", "gwei");
            const gasPerTipIncrement = minTipIncrement.mul(gasConsumed);

            // Deduct from the 40% of the profit
            const minTipUnits = netProfitInETH
              .mul(4000)
              .div(10000)
              .div(gasPerTipIncrement);
            maxPriorityFeePerGas = maxPriorityFeePerGas.add(
              minTipIncrement.mul(minTipUnits)
            );

            // Give 50% of the profit back to the user
            maxAmountIn = maxAmountIn.sub(
              netProfitInETH
                .mul(5000)
                .div(10000)
                .mul(
                  parseUnits(solutionDetails.tokenInToEthRate, tokenInDecimals)
                )
                .div(parseEther("1"))
            );

            // The rest of 10% from the profit is kept

            logger.info(
              COMPONENT,
              JSON.stringify({
                msg: "Tip increment",
                intentHash,
                gasPerTipIncrement: gasPerTipIncrement.toString(),
                minTipUnits: minTipUnits.toString(),
                maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
                newMaxPriorityFeePerGas: maxPriorityFeePerGas
                  .add(minTipIncrement.mul(minTipUnits))
                  .toString(),
              })
            );
          }

          solution = {
            data: defaultAbiCoder.encode(
              ["(address to, bytes data, uint256 value)[]"],
              [solutionDetails.calls]
            ),
            fillAmounts: [intent.amount],
            executeAmounts: [maxAmountIn.toString()],
          };
        }
      }

      const perfTime3 = performance.now();

      let approvalTx: FlashbotsBundleRawTransaction | undefined;
      let approvalTxHash: string | undefined;
      if (approvalTxOrTxHash && approvalTxOrTxHash.length === 66) {
        // We have a transaction hash
        const tx = await provider.getTransaction(approvalTxOrTxHash);
        approvalTx = {
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
        approvalTxHash = approvalTxOrTxHash;
      } else if (approvalTxOrTxHash) {
        // We have a signed transaction
        approvalTx = { signedTransaction: approvalTxOrTxHash };
        approvalTxHash = parse(approvalTxOrTxHash).hash!;
      }

      // Just in case, set to 30% more than the pending block's base fee
      const estimatedBaseFee = await provider
        .getBlock("pending")
        .then((b) =>
          b!.baseFeePerGas!.add(b!.baseFeePerGas!.mul(3000).div(10000))
        );

      const perfTime4 = performance.now();

      const getFillerTx = async (
        intent: Intent,
        authorization?: Authorization
      ) => {
        let method: string;
        if (intent.matchmaker === MATCHMAKER[config.chainId] && authorization) {
          // For relaying
          method = "solveWithSignatureAuthorizationCheck";
        } else if (intent.matchmaker === MATCHMAKER[config.chainId]) {
          // For matchmaker submission
          method = "solveWithOnChainAuthorizationCheck";
        } else {
          // For relaying
          method = "solve";
        }

        return {
          signedTransaction: await solver.signTransaction({
            from: solver.address,
            to: SOLUTION_PROXY[config.chainId],
            value: 0,
            data: new Interface([
              `
                function ${method}(
                  (
                    uint8 side,
                    address tokenIn,
                    address tokenOut,
                    address maker,
                    address matchmaker,
                    address source,
                    uint16 feeBps,
                    uint16 surplusBps,
                    uint32 startTime,
                    uint32 endTime,
                    bool isPartiallyFillable,
                    uint128 amount,
                    uint128 endAmount,
                    uint16 startAmountBps,
                    uint16 expectedAmountBps,
                    bool hasDynamicSignature,
                    bytes signature
                  )[] intents,
                  (
                    bytes data,
                    uint128[] fillAmounts,
                    uint128[] executeAmounts
                  ) solution${
                    authorization
                      ? `,
                        (
                          (
                            uint128 fillAmountToCheck,
                            uint128 executeAmountToCheck,
                            uint32 blockDeadline
                          ) authorization,
                          bytes signature
                        )[] auths
                      `
                      : ""
                  }
                )
              `,
            ]).encodeFunctionData(
              method,
              method === "solveWithSignatureAuthorizationCheck"
                ? [
                    [intent],
                    solution,
                    [{ authorization, signature: authorization!.signature }],
                  ]
                : [[intent], solution]
            ),
            type: 2,
            nonce: await provider.getTransactionCount(solver.address),
            gasLimit,
            chainId: config.chainId,
            maxFeePerGas: estimatedBaseFee.add(maxPriorityFeePerGas).toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          }),
        };
      };

      // Whether to include the approval transaction in the bundle
      const includeApprovalTx =
        approvalTxHash && !(await isTxIncluded(approvalTxHash, provider));

      // If specified and the conditions allow it, use direct transactions rather than relays
      let useRelay = true;
      if (
        !includeApprovalTx &&
        Boolean(Number(process.env.RELAY_DIRECTLY_WHEN_POSSIBLE))
      ) {
        useRelay = false;
      }

      const relayMethod = process.env.BLOXROUTE_AUTH
        ? relayViaBloxroute
        : relayViaFlashbots;

      const perfTime5 = performance.now();

      if (intent.matchmaker !== MATCHMAKER[config.chainId]) {
        // Solve directly

        if (useRelay) {
          // If the approval transaction is still pending, include it in the bundle
          const fillerTx = await getFillerTx(intent);
          const txs = includeApprovalTx ? [approvalTx!, fillerTx] : [fillerTx];

          const targetBlock =
            (await provider.getBlock("latest").then((b) => b.number)) + 1;

          // Relay
          await relayMethod(
            intentHash,
            provider,
            flashbotsProvider,
            txs,
            targetBlock
          );
        } else {
          // At this point, for sure the approval transaction was already included, so we can skip it
          const fillerTx = await getFillerTx(intent);

          // Relay
          await relayViaTransaction(
            intentHash,
            provider,
            fillerTx.signedTransaction
          );
        }
      } else {
        // Solve via matchmaker

        if (!authorization) {
          // We don't have an authorization so first we must request it

          logger.info(
            COMPONENT,
            JSON.stringify({
              msg: "Submitting solution to matchmaker",
              intentHash,
              txHash: approvalTxHash,
            })
          );

          const fillerTx = await getFillerTx(intent);
          const txs = includeApprovalTx
            ? [approvalTx!.signedTransaction, fillerTx.signedTransaction]
            : [fillerTx.signedTransaction];

          // Generate a random uuid for the request
          const uuid = randomUUID();

          await redis.set(
            `solver:${uuid}`,
            JSON.stringify({ intent, approvalTxOrTxHash, solution }),
            "EX",
            BLOCK_TIME * 4
          );

          await axios.post(`${config.matchmakerBaseUrl}/solutions`, {
            uuid,
            baseUrl: config.solverBaseUrl,
            intent,
            txs,
          });
        } else {
          // We do have an authorization so all we have to do is relay the transaction

          const targetBlock =
            (await provider.getBlock("latest").then((b) => b.number)) + 1;
          if (targetBlock > authorization.blockDeadline) {
            // If the authorization deadline was exceeded we need to request another authorization
            await job.updateData({
              ...job.data,
              authorization: undefined,
            });

            throw new Error("Authorization deadline exceeded");
          }

          if (useRelay) {
            // If the approval transaction is still pending, include it in the bundle
            const fillerTx = await getFillerTx(intent, authorization);
            const txs = includeApprovalTx
              ? [approvalTx!, fillerTx]
              : [fillerTx];

            // Relay
            await relayMethod(
              intentHash,
              provider,
              flashbotsProvider,
              txs,
              targetBlock
            );
          } else {
            // At this point, for sure the approval transaction was already included, so we can skip it
            const fillerTx = await getFillerTx(intent, authorization);

            // Relay
            await relayViaTransaction(
              intentHash,
              provider,
              fillerTx.signedTransaction
            );
          }
        }
      }

      const perfTime6 = performance.now();

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Performance measurements for tx-solver",
          time1: (perfTime2 - perfTime1) / 1000,
          time12: (perfTime12 - perfTime1) / 1000,
          time22: (perfTime2 - perfTime12) / 1000,
          time2: (perfTime3 - perfTime2) / 1000,
          time3: (perfTime4 - perfTime3) / 1000,
          time4: (perfTime5 - perfTime4) / 1000,
          time5: (perfTime6 - perfTime5) / 1000,
        })
      );
    } catch (error: any) {
      logger.error(
        COMPONENT,
        JSON.stringify({
          msg: "Job failed",
          error: error.response?.data
            ? JSON.stringify(error.response.data)
            : error,
          stack: error.stack,
        })
      );
      throw error;
    }
  },
  { connection: redis.duplicate(), concurrency: 10 }
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

export const addToQueue = async (
  intent: Intent,
  options?: {
    approvalTxOrTxHash?: string;
    existingSolution?: Solution;
    authorization?: Authorization;
  },
  delay?: number
) =>
  queue.add(
    randomUUID(),
    {
      intent,
      approvalTxOrTxHash: options?.approvalTxOrTxHash,
      existingSolution: options?.existingSolution,
      authorization: options?.authorization,
    },
    {
      delay: delay ? delay * 1000 : undefined,
      jobId:
        getIntentHash(intent) +
        (options?.authorization
          ? getAuthorizationHash(options.authorization)
          : ""),
    }
  );

// Relay methods

const relayViaTransaction = async (
  intentHash: string,
  provider: JsonRpcProvider,
  tx: string
) => {
  const parsedTx = parse(tx);
  try {
    await txSimulator.getCallResult(
      {
        from: parsedTx.from!,
        to: parsedTx.to!,
        data: parsedTx.data,
        value: parsedTx.value,
        gas: parsedTx.gasLimit,
        gasPrice: parsedTx.maxFeePerGas!,
      },
      provider
    );
  } catch {
    logger.error(
      COMPONENT,
      JSON.stringify({
        msg: "Simulation failed",
        intentHash,
        parsedTx,
      })
    );

    throw new Error("Simulation failed");
  }

  logger.info(
    COMPONENT,
    JSON.stringify({
      msg: "Relaying using regular transaction",
      intentHash,
    })
  );

  const txResponse = await provider.sendTransaction(tx).then((tx) => tx.wait());

  logger.info(
    COMPONENT,
    JSON.stringify({
      msg: "Transaction included",
      intentHash,
      txHash: txResponse.transactionHash,
    })
  );
};

const relayViaFlashbots = async (
  intentHash: string,
  provider: JsonRpcProvider,
  flashbotsProvider: FlashbotsBundleProvider,
  txs: FlashbotsBundleRawTransaction[],
  targetBlock: number
) => {
  const signedBundle = await flashbotsProvider.signBundle(txs);

  const simulationResult: { error?: string; results: [{ error?: string }] } =
    (await flashbotsProvider.simulate(signedBundle, targetBlock)) as any;
  if (simulationResult.error || simulationResult.results.some((r) => r.error)) {
    logger.error(
      COMPONENT,
      JSON.stringify({
        msg: "Bundle simulation failed",
        intentHash,
        simulationResult,
        txs,
      })
    );

    throw new Error("Bundle simulation failed");
  }

  const receipt = await flashbotsProvider.sendRawBundle(
    signedBundle,
    targetBlock
  );
  const hash = (receipt as any).bundleHash;

  logger.info(
    COMPONENT,
    JSON.stringify({
      msg: "Bundle relayed using flashbots",
      intentHash,
      targetBlock,
      bundleHash: hash,
    })
  );

  const waitResponse = await (receipt as any).wait();
  if (
    waitResponse === FlashbotsBundleResolution.BundleIncluded ||
    waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
  ) {
    if (
      await isTxIncluded(
        parse(txs[txs.length - 1].signedTransaction).hash!,
        provider
      )
    ) {
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Bundle included",
          intentHash,
          targetBlock,
          bundleHash: hash,
        })
      );
    } else {
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Bundle not included",
          intentHash,
          targetBlock,
          bundleHash: hash,
        })
      );

      throw new Error("Bundle not included");
    }
  } else {
    logger.info(
      COMPONENT,
      JSON.stringify({
        msg: "Bundle not included",
        intentHash,
        targetBlock,
        bundleHash: hash,
      })
    );

    throw new Error("Bundle not included");
  }
};

const relayViaBloxroute = async (
  intentHash: string,
  provider: JsonRpcProvider,
  flashbotsProvider: FlashbotsBundleProvider,
  txs: FlashbotsBundleRawTransaction[],
  targetBlock: number
) => {
  // Simulate via flashbots
  const signedBundle = await flashbotsProvider.signBundle(txs);
  const simulationResult: { error?: string; results: [{ error?: string }] } =
    (await flashbotsProvider.simulate(signedBundle, targetBlock)) as any;
  if (simulationResult.error || simulationResult.results.some((r) => r.error)) {
    logger.error(
      COMPONENT,
      JSON.stringify({
        msg: "Bundle simulation failed",
        intentHash,
        simulationResult,
        txs,
      })
    );

    throw new Error("Bundle simulation failed");
  }

  logger.info(
    COMPONENT,
    JSON.stringify({
      msg: "Bloxroute debug",
      params: {
        id: "1",
        method: "blxr_submit_bundle",
        params: {
          transaction: txs.map((tx) => tx.signedTransaction.slice(2)),
          block_number: "0x" + targetBlock.toString(16),
          mev_builders: {
            bloxroute: "",
            flashbots: "",
            builder0x69: "",
            beaverbuild: "",
            buildai: "",
            all: "",
          },
        },
      },
    })
  );

  const receipt = await (flashbotsProvider as any).blxrSubmitBundle(
    txs,
    targetBlock
  );
  const hash = (receipt as any).bundleHash;

  logger.info(
    COMPONENT,
    JSON.stringify({
      msg: "Bundle relayed using bloxroute",
      intentHash,
      targetBlock,
      bundleHash: hash,
    })
  );

  const waitResponse = await (receipt as any).wait();
  if (
    waitResponse === FlashbotsBundleResolution.BundleIncluded ||
    waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
  ) {
    if (
      await isTxIncluded(
        parse(txs[txs.length - 1].signedTransaction).hash!,
        provider
      )
    ) {
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Bundle included",
          intentHash,
          targetBlock,
          bundleHash: hash,
        })
      );
    } else {
      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Bundle not included",
          intentHash,
          targetBlock,
          bundleHash: hash,
        })
      );

      throw new Error("Bundle not included");
    }
  } else {
    logger.info(
      COMPONENT,
      JSON.stringify({
        msg: "Bundle not included",
        intentHash,
        targetBlock,
        bundleHash: hash,
      })
    );

    throw new Error("Bundle not included");
  }
};
